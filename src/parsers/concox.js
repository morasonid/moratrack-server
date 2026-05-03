'use strict';

const logger             = require('../logger');
const state              = require('../state');
const device             = require('../services/deviceService');
const monitor            = require('../services/monitorService');
const { resolveCommand } = require('../services/commandService');
const { updateAssetHeartbeat } = require('../services/assetService');
const supabase           = require('../supabase');

// ── Coordinate factor ─────────────────────────────────────────────────────
/**
 * Concox mengirim koordinat sebagai UInt32 (selalu positif).
 * Sign dikonfigurasi via lat_factor / lng_factor di tabel devices.
 */
async function applyCoordFactor(payload, deviceId) {
    const { data } = await supabase
        .from('devices')
        .select('lat_factor, lng_factor')
        .eq('identifier', deviceId)
        .maybeSingle();

    if (!data) return payload;

    if (data.lat_factor === -1 || data.lat_factor === 1) payload.lat *= data.lat_factor;
    if (data.lng_factor === -1 || data.lng_factor === 1) payload.lng *= data.lng_factor;

    return payload;
}

// ── Protocol constants ─────────────────────────────────────────────────────
const PROTOCOL_LOGIN    = 0x01;
const PROTOCOL_GPS_1    = 0x12;
const PROTOCOL_GPS_2    = 0x22;
const PROTOCOL_STATUS   = 0x23;
const PROTOCOL_CMD_ACK  = 0x15;
const PROTOCOL_CMD_SEND = 0x80;

const HEADER_SHORT = 0x78;
const HEADER_LONG  = 0x79;

// ── CRC16 X25 ─────────────────────────────────────────────────────────────
function getCRC16(buffer) {
    let crc = 0xffff;
    for (const b of buffer) {
        crc ^= b;
        for (let i = 0; i < 8; i++) {
            crc = (crc & 1) ? (crc >> 1) ^ 0x8408 : (crc >> 1);
        }
    }
    return crc ^ 0xffff;
}

function validateCRC(packet) {
    try {
        const content    = packet.slice(2, packet.length - 4);
        const received   = packet.readUInt16BE(packet.length - 4);
        const calculated = getCRC16(content);
        return received === calculated;
    } catch {
        return false;
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function toHex(buf) {
    return buf.toString('hex').match(/.{1,2}/g).join(' ');
}

function parseIMEI(buf) {
    let imei = '';
    for (const b of buf) {
        imei += ((b >> 4) & 0x0f).toString();
        imei += (b & 0x0f).toString();
    }
    return imei.replace(/^0/, '');
}

function battRawToVolt(raw) {
    const v = 3.049 + (raw * 0.007);
    return +Math.min(4.20, Math.max(3.60, v)).toFixed(2);
}

function battRawToPercent(raw) {
    const v = battRawToVolt(raw);

    // Kurva discharge LiPo 3.7V standar
    const curve = [
        [3.60,   0],
        [3.67,   5],
        [3.70,  10],
        [3.73,  20],
        [3.77,  30],
        [3.80,  40],
        [3.85,  50],
        [3.90,  60],
        [3.95,  70],
        [4.00,  75],
        [4.05,  80],
        [4.10,  85],
        [4.15,  90],
        [4.18,  95],
        [4.20, 100],
    ];

    if (v <= curve[0][0]) return curve[0][1];
    if (v >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];

    for (let i = 0; i < curve.length - 1; i++) {
        const [v0, p0] = curve[i];
        const [v1, p1] = curve[i + 1];
        if (v >= v0 && v <= v1) {
            const ratio = (v - v0) / (v1 - v0);
            return Math.round(p0 + ratio * (p1 - p0));
        }
    }

    return 0;
}

// ── Frame extractor ───────────────────────────────────────────────────────
function detect(buffer) {
    if (buffer.length < 2) return false;
    return (buffer[0] === HEADER_SHORT && buffer[1] === HEADER_SHORT) ||
           (buffer[0] === HEADER_LONG  && buffer[1] === HEADER_LONG);
}

function extractFrame(buffer) {
    if (buffer.length < 2) return null;

    const isLong = buffer[0] === HEADER_LONG && buffer[1] === HEADER_LONG;

    if (isLong) {
        if (buffer.length < 6) return null;
        const len      = buffer.readUInt16BE(2);
        const totalLen = 2 + 2 + len + 2;
        if (buffer.length < totalLen) return null;
        return { packet: buffer.slice(0, totalLen), rest: buffer.slice(totalLen), isLong: true };
    } else {
        if (buffer.length < 5) return null;
        const len      = buffer[2];
        const totalLen = 2 + 1 + len + 2;
        if (buffer.length < totalLen) return null;
        return { packet: buffer.slice(0, totalLen), rest: buffer.slice(totalLen), isLong: false };
    }
}

// ── ACK builder ───────────────────────────────────────────────────────────
function buildACK(protocol, serial) {
    const body = Buffer.from([
        0x05, protocol,
        (serial >> 8) & 0xff,
        serial & 0xff,
    ]);
    const crc = getCRC16(body);
    return Buffer.from([
        0x78, 0x78,
        ...body,
        (crc >> 8) & 0xff, crc & 0xff,
        0x0d, 0x0a,
    ]);
}

// ── Command builder ───────────────────────────────────────────────────────
function buildCommandPacket(deviceId, rawCommand) {
    const serial = state.getNextSerial(deviceId);
    const cmdBuf = Buffer.from(rawCommand);

    const bodyContent = Buffer.concat([
        Buffer.from([PROTOCOL_CMD_SEND]),
        Buffer.from([cmdBuf.length]),
        Buffer.from([0x00, 0x00, 0x00, 0x01]),
        cmdBuf,
        Buffer.from([(serial >> 8) & 0xff, serial & 0xff]),
    ]);

    const lenByte    = bodyContent.length + 2;
    const bodyForCRC = Buffer.concat([Buffer.from([lenByte]), bodyContent]);
    const crc        = getCRC16(bodyForCRC);

    const packet = Buffer.concat([
        Buffer.from([0x78, 0x78]),
        bodyForCRC,
        Buffer.from([(crc >> 8) & 0xff, crc & 0xff]),
        Buffer.from([0x0d, 0x0a]),
    ]);

    return { packet, serial };
}

// ── Packet handler ────────────────────────────────────────────────────────
async function handlePacket(packet, isLong, socket, context) {
    logger.debug('CONCOX_RAW', 'PACKET_IN', toHex(packet));

    if (!validateCRC(packet)) {
        logger.warn('CONCOX', 'CRC invalid — packet dropped', { raw: toHex(packet) });
        return;
    }

    const pOff     = isLong ? 4 : 3;
    const protocol = packet[pOff];
    const serial   = packet.readUInt16BE(packet.length - 6);

    // ── LOGIN (0x01) ───────────────────────────────────────────────────────
    if (protocol === PROTOCOL_LOGIN) {
        const deviceId   = parseIMEI(packet.slice(pOff + 1, pOff + 9));
        context.deviceId = deviceId;

        state.deviceSockets.set(deviceId, {
            socket,
            type: 'concox',
            sendCommand(rawCommand, resolve, timeout) {
                const { packet: pkt, serial: s } = buildCommandPacket(deviceId, rawCommand);
                state.pendingCommands.set(deviceId, { resolve, timeout, serial: s });
                socket.write(pkt);
                logger.info('CONCOX_SEND', 'Command sent', {
                    deviceId, cmd: rawCommand, hex: toHex(pkt),
                });
            },
        });

        await device.ensureDevice(deviceId, 'concox');
        monitor.ensureDevice(deviceId);
        monitor.markSeen(deviceId);

        // Simpan ip & port ke state untuk updateLastActivity
        const concoxSt = state.deviceState.get(deviceId) || {};
        state.deviceState.set(deviceId, {
            ...concoxSt,
            ip   : socket.remoteAddress ?? null,
            port : socket.remotePort    ?? null,
        });

        socket.write(buildACK(PROTOCOL_LOGIN, serial));
        logger.info('CONCOX', 'LOGIN', { deviceId, ip: socket.remoteAddress });
    }

    // ── STATUS (0x23) ──────────────────────────────────────────────────────
    else if (protocol === PROTOCOL_STATUS) {
        if (!context.deviceId) return;
        monitor.markSeen(context.deviceId);

        const acc     = packet[pOff + 2] === 0x01;
        const battRaw = packet[pOff + 3];

        const prev = state.deviceState.get(context.deviceId) || {};
        state.deviceState.set(context.deviceId, {
            ...prev,
            batt_level   : battRawToPercent(battRaw),
            batt_voltage : battRawToVolt(battRaw),
            acc,
        });

        logger.info('CONCOX', 'STATUS', {
            deviceId     : context.deviceId,
            acc,
            batt_level   : battRawToPercent(battRaw),
            batt_voltage : battRawToVolt(battRaw),
        });

        // Update asset status dari heartbeat
        const { assetId } = await device.getAssetIdByDevice(context.deviceId);
        if (assetId) {
            await updateAssetHeartbeat(assetId);
        }

        socket.write(buildACK(PROTOCOL_STATUS, serial));
    }

    // ── GPS (0x12 / 0x22) ──────────────────────────────────────────────────
    else if (protocol === PROTOCOL_GPS_1 || protocol === PROTOCOL_GPS_2) {
        if (!context.deviceId) {
            logger.warn('CONCOX', `0x${protocol.toString(16)} GPS before LOGIN — dropped`);
            return;
        }
        if (isLong) {
            logger.warn('CONCOX', `0x${protocol.toString(16)} GPS in long packet — skipped`);
            return;
        }

        monitor.markSeen(context.deviceId);

        // parse datetime — offset absolut dari byte 0 (short packet)
        // [4]=year, [5]=month, [6]=day, [7]=hour, [8]=min, [9]=sec
        const year   = 2000 + packet[4];
        const month  = packet[5];
        const day    = packet[6];
        const hour   = packet[7];
        const min    = packet[8];
        const sec    = packet[9];
        const ts     = new Date(Date.UTC(year, month - 1, day, hour, min, sec)).toISOString();

        // GPS info byte [10]:
        //   bit 7-4 = satellite count
        //   bit 3   = GPS fix valid (1 = fix, 0 = no fix / koordinat dari cache)
        //   bit 2,1 = TIDAK RELIABLE untuk sign koordinat saat device bergerak
        //             (terbukti nilai berubah-ubah tidak konsisten dengan posisi nyata)
        //   bit 0   = GPS position fix method
        //
        // Sign koordinat diambil dari lat_factor/lng_factor di tabel devices.
        const gpsInfo    = packet[10];
        const satellites = (gpsInfo >> 4) & 0x0f;
        const isGpsFix   = !!(gpsInfo & 0x08);

        // GPS belum fix — koordinat dari cache device, skip insert ke positions
        if (!isGpsFix) {
            logger.debug('CONCOX', `0x${protocol.toString(16)} GPS not fixed — skipped`, {
                deviceId : context.deviceId,
                satellites,
                ts,
            });
            return;
        }

        const lat_raw    = packet.readUInt32BE(11);
        const lng_raw    = packet.readUInt32BE(15);
        const speed      = packet[19];
        const courseWord = packet.readUInt16BE(20);
        const course     = courseWord & 0x03ff;

        // Sign koordinat dari lat_factor/lng_factor di tabel devices
        // Concox mengirim koordinat sebagai UInt32 (selalu positif)
        let loc = await applyCoordFactor(
            { lat: lat_raw / 1800000, lng: lng_raw / 1800000 },
            context.deviceId
        );

        const st = state.deviceState.get(context.deviceId) || {};

        logger.debug('CONCOX', `0x${protocol.toString(16)} GPS`, {
            deviceId   : context.deviceId,
            lat: loc.lat, lng: loc.lng, speed, course, ts, satellites,
        });

        await device.onLocationPacket({
            deviceId   : context.deviceId,
            lat        : loc.lat,
            lng        : loc.lng,
            speed,
            course,
            time       : ts,
            battery    : st.batt_level ?? null,
            satellites,
            protocol   : 'concox',
        });
    }

    // ── COMMAND ACK (0x15) ─────────────────────────────────────────────────
    else if (protocol === PROTOCOL_CMD_ACK) {
        try {
            const subLen    = packet[pOff + 1];
            const content   = packet.slice(pOff + 2, pOff + 2 + subLen).toString().trim();
            const ackSerial = packet.readUInt16BE(pOff + 2 + subLen);

            logger.info('CONCOX', 'CMD_ACK', {
                deviceId: context.deviceId, content, serial: ackSerial,
            });

            const pending = state.pendingCommands.get(context.deviceId);
            if (pending && pending.serial === ackSerial) {
                resolveCommand(context.deviceId, true);
            } else {
                logger.warn('CONCOX', 'CMD_ACK serial mismatch', {
                    deviceId : context.deviceId,
                    received : ackSerial,
                    expected : pending?.serial ?? 'none',
                });
            }
        } catch (e) {
            logger.error('CONCOX', '0x15 parse error', { error: e.message });
        }
    }

    else {
        logger.debug('CONCOX', `Unknown protocol 0x${protocol.toString(16).padStart(2, '0')}`, {
            deviceId: context.deviceId, isLong, raw: toHex(packet),
        });
    }
}

// ── Buffer processor ──────────────────────────────────────────────────────
async function processBuffer(buffer, socket, context) {
    while (buffer.length >= 5) {
        if (!detect(buffer)) {
            let found = -1;
            for (let i = 1; i < buffer.length - 1; i++) {
                if ((buffer[i] === HEADER_SHORT && buffer[i + 1] === HEADER_SHORT) ||
                    (buffer[i] === HEADER_LONG  && buffer[i + 1] === HEADER_LONG)) {
                    found = i;
                    break;
                }
            }
            if (found === -1) {
                logger.warn('CONCOX', 'No valid header found — buffer cleared', {
                    deviceId: context.deviceId,
                });
                buffer = Buffer.alloc(0);
                break;
            }
            logger.warn('CONCOX', `Skipping ${found} garbage bytes`, {
                deviceId: context.deviceId,
            });
            buffer = buffer.slice(found);
            continue;
        }

        const frame = extractFrame(buffer);
        if (!frame) break;

        buffer = frame.rest;
        await handlePacket(frame.packet, frame.isLong, socket, context);
    }
    return buffer;
}

module.exports = { detect, processBuffer };