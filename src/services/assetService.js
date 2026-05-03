'use strict';

const supabase = require('../supabase');
const logger   = require('../logger');

/**
 * Update realtime state asset dari position packet.
 * Dipanggil setiap ada GPS packet dengan position valid.
 *
 * Server tracks:
 *   - connectivity status (online via packet)
 *   - raw sensor data (speed, ignition, odometer, location)
 *
 * Client (Flutter) decides movement logic based on asset type:
 *   - Vehicle: engine + odometer
 *   - Mobile: GPS speed + location delta
 *   - Tracker: location delta only
 *
 * @param {string} assetId
 * @param {object} position - { device_id, latitude, longitude, speed, ignition, time, ... }
 */
async function updateAssetState(assetId, position) {
    if (!assetId) return;

    const { error } = await supabase
        .from('asset_states')
        .upsert({
            asset_id   : assetId,
            device_id  : position.device_id  ?? null,
            latitude   : position.latitude,
            longitude  : position.longitude,
            speed      : position.speed      ?? null,
            ignition   : position.ignition   ?? null,
            status     : 'online',  // ← connectivity only
            last_update: position.time,
        });

    if (error) {
        logger.error('ASSET', 'asset_state update failed', { assetId, error: error.message });
    }
}

/**
 * Update asset status dari heartbeat.
 * Heartbeat = device masih online, just mark status='online'.
 *
 * Concox: STATUS packet (0x23)
 * Teltonika: data packet dengan records
 * Android: PING
 * Sinotrack/HQ: position packet (no separate heartbeat)
 *
 * NOTE: Movement logic (active/idle) delegated to client based on asset capabilities
 * @param {string} assetId
 */
async function updateAssetHeartbeat(assetId) {
    if (!assetId) return;

    const { error } = await supabase
        .from('asset_states')
        .update({
            status: 'online',  // ← connectivity only
        })
        .eq('asset_id', assetId);

    if (error) {
        logger.error('ASSET', 'heartbeat status update failed', { assetId, error: error.message });
    }
}

/**
 * Insert event ke tabel events.
 * Trigger di DB akan otomatis insert notifications ke semua user yang punya akses asset.
 *
 * @param {string} assetId
 * @param {string} deviceUuid  - UUID dari tabel devices
 * @param {string} eventType   - 'alarm' | 'geofence_enter' | 'geofence_exit' |
 *                               'ignition_on' | 'ignition_off' | 'online' | 'offline' |
 *                               'overspeed' | 'low_battery' | 'power_cut'
 * @param {object} eventData   - data tambahan bebas format (jsonb)
 * @param {number} positionId  - opsional, id dari tabel positions
 */
async function insertEvent(assetId, deviceUuid, eventType, eventData = {}, positionId = null) {
    if (!assetId || !eventType) return;

    const { error } = await supabase
        .from('events')
        .insert({
            asset_id   : assetId,
            device_id  : deviceUuid  ?? null,
            position_id: positionId  ?? null,
            event_type : eventType,
            event_data : eventData,
        });

    if (error) {
        logger.error('ASSET', 'insertEvent failed', { assetId, error: error.message });
    }
}

module.exports = {
    updateAssetState,
    updateAssetHeartbeat,
    insertEvent,
};