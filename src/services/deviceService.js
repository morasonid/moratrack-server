'use strict';

const logger             = require('../logger');
const supabase           = require('../supabase');
const state              = require('../state');
const { broadcastAsset } = require('./broadcastService');
const { updateAssetState, updateAssetHeartbeat } = require('./assetService');

const NEGATIVE_CACHE_TTL_MS = 60 * 1000;

// ── Validators & Normalizers ───────────────────────────────────────────────

/**
 * Validasi koordinat GPS.
 * Berlaku untuk semua protokol: Concox, Sinotrack, HQ, Teltonika, Android.
 *
 * Menolak:
 *   - null / undefined / NaN / Infinity
 *   - lat/lng = 0,0 (koordinat null island — Gulf of Guinea, bukan posisi valid)
 *   - Nilai di luar range fisik GPS
 */
function isValidCoord(lat, lng) {
    if (typeof lat !== 'number' || typeof lng !== 'number') return false;
    if (!isFinite(lat) || !isFinite(lng))                   return false;
    if (lat < -90  || lat > 90)                             return false;
    if (lng < -180 || lng > 180)                            return false;
    if (lat === 0  && lng === 0)                            return false;
    return true;
}

/**
 * Normalisasi field time dari semua protokol.
 *
 * Concox  : sudah UTC ISO string dari parser
 * Sinotrack: sudah UTC ISO string dari parser
 * HQ      : sudah UTC ISO string dari hqParseDateTime()
 * Teltonika: sudah UTC ISO string dari new Date(tsMs).toISOString()
 * Android : bisa berbagai format — perlu normalisasi paling ketat
 *
 * Support:
 *   - ISO 8601 UTC      : "2026-03-20T05:00:00.000Z"
 *   - ISO 8601 lokal    : "2026-03-20T12:00:00+07:00"
 *   - Unix ms (number)  : 1742443200000
 *   - Unix s  (number)  : 1742443200
 *   - null / undefined  : fallback ke server time
 *
 * Return: ISO 8601 UTC string, selalu valid.
 */
function normalizeTime(raw) {
    if (raw == null) return new Date().toISOString();

    if (typeof raw === 'number') {
        // Deteksi seconds vs milliseconds: Unix seconds < 1e10
        const ms = raw < 1e10 ? raw * 1000 : raw;
        const d  = new Date(ms);
        if (!isNaN(d.getTime())) return d.toISOString();
    }

    if (typeof raw === 'string') {
        const d = new Date(raw);
        if (!isNaN(d.getTime())) return d.toISOString();
    }

    // Fallback ke server time
    logger.warn('DEVICE', 'time field invalid — using server time', { raw });
    return new Date().toISOString();
}

/**
 * Normalisasi speed — pastikan non-negatif dan finite.
 * Semua protokol kirim speed sebagai angka positif (km/h),
 * tapi Teltonika kadang kirim nilai aneh saat GPS belum stabil.
 */
function normalizeSpeed(raw) {
    if (typeof raw !== 'number' || !isFinite(raw) || raw < 0) return 0;
    return raw;
}

/**
 * Normalisasi course — range 0–359.
 * Concox, Sinotrack, HQ, Teltonika, Android semua pakai derajat 0-360.
 */
function normalizeCourse(raw) {
    if (typeof raw !== 'number' || !isFinite(raw)) return 0;
    return ((raw % 360) + 360) % 360;
}

// ── Device management ──────────────────────────────────────────────────────

/**
 * Daftarkan device ke database jika belum ada.
 */
async function ensureDevice(identifier, protocol = null) {
    const { error } = await supabase
        .from('devices')
        .upsert(
            { identifier, protocol },
            { onConflict: 'identifier', ignoreDuplicates: true }
        );

    if (error) {
        logger.error('DEVICE', 'ensureDevice failed', { identifier, error: error.message });
    }
}

/**
 * Resolve identifier → { deviceUuid, assetId, timeoutSeconds }
 *
 * Side effect: mengisi state.assetDevices[assetId] = identifier
 * sehingga command routing bisa pakai assetId.
 */
async function getAssetIdByDevice(deviceId) {
    if (!deviceId) return {};

    if (state.deviceToAsset.has(deviceId)) {
        const cached = state.deviceToAsset.get(deviceId);

        // positive cache — device sudah ter-link ke asset
        if (cached !== null && cached !== undefined) {
            // Cek apakah ini entry "no asset" yang masih dalam TTL
            if (cached._noAsset) {
                const expiry = state.deviceCacheExpiry.get(deviceId) ?? 0;
                if (Date.now() < expiry) return cached; // return { deviceUuid, assetId: null }
                // expired, ulangi lookup
                state.deviceToAsset.delete(deviceId);
                state.deviceCacheExpiry.delete(deviceId);
            } else {
                return cached; // positive cache normal
            }
        } else {
            // null = device tidak ditemukan di DB sama sekali
            const expiry = state.deviceCacheExpiry.get(deviceId) ?? 0;
            if (Date.now() < expiry) return {};
            // expired, ulangi lookup
            state.deviceToAsset.delete(deviceId);
            state.deviceCacheExpiry.delete(deviceId);
        }
    }

    // Step 1: identifier → device UUID + timeout_seconds
    const { data: device, error: deviceError } = await supabase
        .from('devices')
        .select('id, timeout_seconds')
        .eq('identifier', deviceId)
        .maybeSingle();

    if (deviceError) {
        logger.error('DEVICE', 'Device lookup failed', { deviceId, error: deviceError.message });
        return {};
    }

    if (!device) {
        logger.warn('DEVICE', 'Device not found', { deviceId });
        state.deviceToAsset.set(deviceId, null);
        state.deviceCacheExpiry.set(deviceId, Date.now() + NEGATIVE_CACHE_TTL_MS);
        return {};
    }

    // Step 2: device UUID → asset_id (hanya yang aktif)
    const { data: assetDevice, error: assetError } = await supabase
        .from('asset_devices')
        .select('asset_id')
        .eq('device_id', device.id)
        .eq('is_active', true)
        .is('removed_at', null)
        .maybeSingle();

    if (assetError) {
        logger.error('DEVICE', 'Asset lookup failed', { deviceId, error: assetError.message });
        return { deviceUuid: device.id, timeoutSeconds: device.timeout_seconds ?? 300 };
    }

    const assetId        = assetDevice?.asset_id ?? null;
    const timeoutSeconds = device.timeout_seconds ?? 300;
    const result         = { deviceUuid: device.id, assetId, timeoutSeconds };

    if (!assetId) {
        // Device terdaftar tapi belum di-link ke asset
        // Simpan di cache dengan flag _noAsset dan TTL — otomatis retry setelah expired
        logger.debug('DEVICE', 'Device not linked to any asset — will retry', { deviceId });
        const noAssetResult = { deviceUuid: device.id, assetId: null, timeoutSeconds, _noAsset: true };
        state.deviceToAsset.set(deviceId, noAssetResult);
        state.deviceCacheExpiry.set(deviceId, Date.now() + NEGATIVE_CACHE_TTL_MS);
        return noAssetResult; // return deviceUuid supaya posisi tetap tersimpan
    }

    // Positive cache — hanya kalau sudah ter-link ke asset
    state.deviceToAsset.set(deviceId, result);

    // isi reverse mapping untuk command routing
    state.assetDevices.set(assetId, deviceId);

    return result;
}

/**
 * Update device_last_activity.
 * Dipanggil setiap packet posisi masuk.
 */
async function updateLastActivity(deviceUuid, { lat, lng, protocol, ip, port }) {
    if (!deviceUuid) return;

    const { error } = await supabase
        .from('device_last_activity')
        .upsert({
            device_id          : deviceUuid,
            last_packet_at     : new Date().toISOString(),
            last_position_at   : new Date().toISOString(),
            last_lat           : lat      ?? null,
            last_lng           : lng      ?? null,
            connection_status  : 'online',
            connection_protocol: protocol ?? null,
            last_ip            : ip       ?? null,
            last_port          : port     ?? null,
            updated_at         : new Date().toISOString(),
        }, { onConflict: 'device_id' });

    if (error) {
        logger.error('DEVICE', 'updateLastActivity failed', { deviceUuid, error: error.message });
    }
}



/**
 * Handle parsed location packet dari semua protokol.
 * Dipanggil setelah validasi dan normalisasi di onLocationPacket.
 */
async function handleLocation(packet) {
    const {
        deviceId,
        lat,
        lng,
        altitude,
        speed,
        course,
        time,
        ignition,
        battery,
        attributes,
        protocol,
        satellites,
        isEvent,
        eventType,
    } = packet;

    const { deviceUuid, assetId } = await getAssetIdByDevice(deviceId);

    if (!deviceUuid) {
        logger.warn('DEVICE', 'Position dropped — device not registered', { deviceId });
        return {};
    }

    // Bangun attributes — merge dari parser + tambahan internal
    const builtAttributes = {
        ...(attributes ?? {}),
        ...(typeof satellites === 'number' ? { satellites } : {}),
        ...(isEvent   ? { is_event  : true      } : {}),
        ...(eventType ? { event_type: eventType } : {}),
    };

    const position = {
        device_id  : deviceUuid,
        asset_id   : assetId   ?? null,
        latitude   : lat,
        longitude  : lng,
        altitude   : altitude  ?? null,
        speed      : speed     ?? null,
        course     : course    ?? null,
        time,
        ignition   : ignition  ?? null,
        battery    : battery   ?? null,
        attributes : Object.keys(builtAttributes).length > 0 ? builtAttributes : null,
    };

    // selalu simpan history selama device terdaftar
    const { data: inserted, error: insertError } = await supabase
        .from('positions')
        .insert(position)
        .select('id')
        .single();

    if (insertError) {
        logger.error('DEVICE', 'Position insert failed', { deviceId, error: insertError.message });
    } else {
        logger.info('DEVICE', 'Position saved', {
            deviceId,
            assetId    : assetId ?? null,
            positionId : inserted?.id ?? null,
            latitude   : lat,
            longitude  : lng,
            speed,
            time,
        });
    }

    const positionId = inserted?.id ?? null;

    // Simpan positionId terakhir ke memory — dipakai oleh alarm handler
    if (positionId && !isEvent) {
        const deviceSt = state.deviceState.get(deviceId) || {};
        state.deviceState.set(deviceId, { ...deviceSt, lastPositionId: positionId });
    }

    // update device_last_activity
    // Ambil ip & port dari state yang disimpan saat LOGIN
    const connState = state.deviceState.get(deviceId) || {};
    await updateLastActivity(deviceUuid, { lat, lng, protocol, ip: connState.ip ?? null, port: connState.port ?? null });

    // broadcast & state update hanya kalau sudah di-link ke asset
    if (!assetId) return { positionId, deviceUuid, assetId };

    // Jangan update asset state dari event position
    if (!isEvent) {
        // Update raw sensor data — client will decide movement logic based on asset type
        await updateAssetState(assetId, position);

        broadcastAsset(assetId, {
            type      : 'location',
            asset_id  : assetId,
            latitude  : lat,
            longitude : lng,
            altitude  : altitude ?? null,
            speed,
            course,
            time,
            ignition  : ignition ?? null,
            battery   : battery  ?? null,
            status    : 'online',
        });
    }

    return { positionId, deviceUuid, assetId };
}

/**
 * Pintu masuk tunggal dari semua protokol parser.
 *
 * Validasi dan normalisasi dilakukan di sini — satu tempat untuk
 * semua protokol (Concox, Sinotrack, HQ, Teltonika, Android).
 * Parser tidak perlu duplikasi logika validasi.
 */
async function onLocationPacket(packet) {
    if (!packet || !packet.deviceId) return {};

    const lat = packet.lat ?? packet.latitude  ?? null;
    const lng = packet.lng ?? packet.longitude ?? null;

    // Validasi koordinat — berlaku untuk semua protokol
    if (!isValidCoord(lat, lng)) {
        logger.warn('DEVICE', 'Invalid coordinates — packet dropped', {
            deviceId : packet.deviceId,
            lat,
            lng,
            protocol : packet.protocol ?? 'unknown',
        });
        return {};
    }

    // Normalisasi semua field — berlaku untuk semua protokol
    const normalized = {
        ...packet,
        lat    : lat,
        lng    : lng,
        time   : normalizeTime(packet.time ?? packet.timestamp ?? packet.ts ?? null),
        speed  : normalizeSpeed(packet.speed),
        course : normalizeCourse(packet.course ?? packet.heading ?? 0),
    };

    return await handleLocation(normalized);
}

module.exports = {
    ensureDevice,
    getAssetIdByDevice,
    updateLastActivity,
    handleLocation,
    onLocationPacket,
    updateAssetHeartbeat,
};