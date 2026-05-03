'use strict';

/**
 * Sinotrack parser — ST-901 / ST-906 / ST-210 series
 * Port default: 5013
 *
 * Protokol Sinotrack sangat mirip GT06 (Concox) dengan perbedaan:
 *
 * 1. LOGIN packet (0x01) — IMEI dikirim sebagai string ASCII 15 digit,
 *    bukan BCD encoded seperti Concox.
 *
 * 2. GPS packet (0x22) — format berbeda dari Concox:
 *    [78 78][len][0x22][date:3B][time:3B][lat:4B][lng:4B][speed:1B][course:2B]
 *    [MCC:2B][MNC:1B][LAC:2B][CellID:3B][signal:1B][voltage:1B][lang:1B]
 *    [serial:2B][crc:2B][0D 0A]
 *
 * 3. Heartbeat (0x23) — mirip Concox status packet
 *
 * 4. GPS + LBS combined (0x25) — GPS + cell tower info dalam satu packet
 *
 * Referensi: Sinotrack ST-901 protocol document v1.x
 *
 * ── Packet format umum ────────────────────────────────────────────────────
 *  [78 78][length:1B][protocol:1B][payload...][serial:2B][crc:2B][0D 0A]
 *  totalLen = length + 5  (sama dengan Concox short packet)
 */

const logger             = require('../logger');
const state              = require('../state');
const device             = require('../services/deviceService');
const monitor            = require('../services/monitorService');
const { resolveCommand } = require('../services/commandService');

// ── Protocol constants ─────────────────────────────────────────────────────
const PROTOCOL_LOGIN     = 0x01;

const PROTOCOL_GPS       = 0x22;
const PROTOCOL_HEARTBEAT = 0x23;
const PROTOCOL_GPS_LBS   = 0x25;
const PROTOCOL_ALARM     = 0x26;
const PROTOCOL_CMD_ACK   = 0x15;

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

function battVoltToPercent(raw) {
    if (raw >= 0xE0) return 100;
    if (raw >= 0xC0) return 80;
    if (raw >= 0xA0) return 60;
    if (raw >= 0x80) return 40;
    if (raw >= 0x60) return 20;
    return 5;
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

// ── GPS coordinate parser ──────────────────────────────────────────────────
function parseCoord(raw, isPositive) {
    const deg = Math.floor(raw / 1000000);
    const min = (raw % 1000000) / 10000;
    const val = deg + (min / 60);
    return isPositive ? val : -val;
}

// ── Frame extractor (Sinotrack binary) ───────────────────────────────────
function detect(buffer) {
    if (buffer.length < 2) return false;
    // Sinotrack binary: 0x78 0x78
    if (buffer[0] === 0x78 && buffer[1] === 0x78) return true;
    // HQ / Huiqi text protocol: dimulai dengan '*' (0x2A)
    if (buffer[0] === 0x2A) return true;
    return false;
}

function extractFrame(buffer) {
    if (buffer.length < 5) return null;
    const len      = buffer[2];
    const totalLen = len + 5;
    if (buffer.length < totalLen) return null;
    return {
        packet : buffer.slice(0, totalLen),
        rest   : buffer.slice(totalLen),
    };
}

// ── HQ Protocol (Huiqi/TK) ────────────────────────────────────────────────
// Format: *HQ,IMEI,TYPE,...*checksum#
// Dipakai oleh ST903(M) dan berbagai OEM tracker China

function hqCalcChecksum(raw) {
    const start = raw.indexOf('*') + 1;
    const end   = raw.lastIndexOf('*');
    if (start <= 0 || end <= start) return null;
    let xor = 0;
    for (let i = start; i < end; i++) xor ^= raw.charCodeAt(i);
    return xor.toString(16).toUpperCase().padStart(2, '0');
}

function hqValidateChecksum(raw) {
    const starCount = (raw.match(/\*/g) || []).length;
    // Format tanpa checksum: *HQ,...# (hanya 1 bintang di awal)
    if (starCount <= 1) return true;
    // Format dengan checksum: *HQ,...*CS# (2 bintang)
    const lastStar   = raw.lastIndexOf('*');
    const hash       = raw.lastIndexOf('#');
    const received   = raw.slice(lastStar + 1, hash !== -1 ? hash : undefined).toUpperCase();
    const calculated = hqCalcChecksum(raw);
    if (!calculated) return false;
    return received === calculated;
}

function hqNmeaToDecimal(nmea, direction) {
    if (!nmea || nmea === '') return null;
    const dot    = nmea.indexOf('.');
    const degLen = dot - 2;
    const deg    = parseFloat(nmea.slice(0, degLen));
    const min    = parseFloat(nmea.slice(degLen));
    let val      = deg + min / 60;
    if (direction === 'S' || direction === 'W') val = -val;
    return parseFloat(val.toFixed(6));
}

function hqParseDateTime(dateStr, timeStr) {
    try {
        const dd  = dateStr.slice(0, 2);
        const mm  = dateStr.slice(2, 4);
        const yy  = dateStr.slice(4, 6);
        const hh  = timeStr.slice(0, 2);
        const min = timeStr.slice(2, 4);
        const ss  = timeStr.slice(4, 6);
        return new Date(`20${yy}-${mm}-${dd}T${hh}:${min}:${ss}Z`).toISOString();
    } catch {
        return new Date().toISOString();
    }
}

function hqBattToPercent(raw) {
    const v = parseInt(raw, 10) || 0;
    if (v >= 6) return 100;
    if (v >= 5) return 80;
    if (v >= 4) return 60;
    if (v >= 3) return 40;
    if (v >= 2) return 20;
    return 5;
}

function hqBuildCommand(imei, cmd, param = '') {
    const body = param ? `HQ,${imei},${cmd},${param}` : `HQ,${imei},${cmd}`;
    let xor    = 0;
    for (const c of body) xor ^= c.charCodeAt(0);
    const cs = xor.toString(16).toUpperCase().padStart(2, '0');
    return `*${body}*${cs}#\r\n`;
}

function hqDetect(buffer) {
    return buffer.length >= 3 && buffer[0] === 0x2A;
}

function hqExtractFrame(buffer) {
    const str    = buffer.toString('utf8');
    let endIdx   = str.indexOf('#');
    if (endIdx === -1) endIdx = str.indexOf('\n');
    if (endIdx === -1) return null;
    const frame = str.slice(0, endIdx + 1).trim();
    // Strip leading \r\n supaya frame berikutnya tidak gagal di hqDetect
    const rest  = Buffer.from(str.slice(endIdx + 1).replace(/^[\r\n]+/, ''), 'utf8');
    return { frame, rest };
}

async function hqHandleFrame(raw, socket, context) {
    logger.debug('HQ_RAW', 'FRAME_IN', raw);

    if (!hqValidateChecksum(raw)) {
        logger.warn('HQ', 'Checksum invalid — frame dropped', { raw });
        return;
    }

    // Jika hanya 1 bintang (format tanpa checksum), inner = isi antara * dan #
    const starCount = (raw.match(/\*/g) || []).length;
    const endPos    = starCount > 1 ? raw.lastIndexOf('*') : raw.lastIndexOf('#');
    const inner     = raw.slice(1, endPos);
    const fields    = inner.split(',');

    if (fields[0] !== 'HQ' || fields.length < 2) {
        logger.warn('HQ', 'Invalid frame format', { raw });
        return;
    }

    const imei    = fields[1].replace(/\D/g, '');
    const msgType = (fields[2] ?? '').toUpperCase();

    if (!context.deviceId) context.deviceId = imei;

    // ── Auto-register device jika belum ada ───────────────────────────────
    // ST903(M) dan beberapa firmware HQ tidak kirim LINK/LOGIN packet,
    // langsung kirim data — pastikan device terdaftar di DB
    await device.ensureDevice(imei, 'hq');
    if (!state.deviceSockets.has(imei)) {
        state.deviceSockets.set(imei, {
            socket,
            type: 'hq',
            sendCommand(rawCommand, resolve, timeout) {
                state.pendingCommands.set(imei, { resolve, timeout });
                socket.write(hqBuildCommand(imei, rawCommand));
                logger.info('HQ_SEND', 'Command sent', { imei, cmd: rawCommand });
            },
        });
        monitor.ensureDevice(imei);
        // Simpan ip & port ke state untuk updateLastActivity
        const hqAutoSt = state.deviceState.get(imei) || {};
        state.deviceState.set(imei, {
            ...hqAutoSt,
            ip   : socket.remoteAddress ?? null,
            port : socket.remotePort    ?? null,
        });
        logger.info('HQ', 'AUTO-REGISTERED', { imei, ip: socket.remoteAddress });
    }
    monitor.markSeen(imei);

    // ── LINK / LOGIN ──────────────────────────────────────────────────────
    if (msgType === 'LINK') {
        context.deviceId = imei;

        state.deviceSockets.set(imei, {
            socket,
            type: 'hq',
            sendCommand(rawCommand, resolve, timeout) {
                state.pendingCommands.set(imei, { resolve, timeout });
                socket.write(hqBuildCommand(imei, rawCommand));
                logger.info('HQ_SEND', 'Command sent', { imei, cmd: rawCommand });
            },
        });

        await device.ensureDevice(imei, 'hq');
        monitor.ensureDevice(imei);
        monitor.markSeen(imei);

        // Simpan ip & port ke state untuk updateLastActivity
        const hqSt = state.deviceState.get(imei) || {};
        state.deviceState.set(imei, {
            ...hqSt,
            ip   : socket.remoteAddress ?? null,
            port : socket.remotePort    ?? null,
        });

        socket.write(hqBuildCommand(imei, 'LINK'));
        logger.info('HQ', 'LOGIN', { imei, ip: socket.remoteAddress });
        return;
    }

    if (!context.deviceId) {
        logger.warn('HQ', `${msgType} before LOGIN — dropped`, { imei });
        return;
    }

    monitor.markSeen(imei);

    // ── GPS / LOCATION ────────────────────────────────────────────────────
    // V0/V1/V2 = format standar, V8 = format extended dengan LBS + baterai
    // V6 = registration packet (ICCID SIM card), V3/V4 = varian lain
    if (msgType === 'V6') {
        // Packet registrasi SIM — field terakhir adalah ICCID
        const iccid = fields[fields.length - 1] ?? null;
        logger.info('HQ', 'V6 SIM registration', { imei, iccid, fieldCount: fields.length });
        return;
    }

    if (msgType === 'V1' || msgType === 'V2' || msgType === 'V0' || msgType === 'V8') {
        // fields: [0]=HQ,[1]=IMEI,[2]=msgType,[3]=time,[4]=status,
        //         [5]=lat,[6]=NS,[7]=lng,[8]=EW,[9]=speed(knots),[10]=course,[11]=date
        // V8 ext: [12]=flags,[13]=MCC,[14]=MNC,[15]=LAC,[16]=CID,
        //         [17]=HDOP,[18]=sats,[19]=signal,[20]=batt%
        const timeStr = fields[3];
        const status  = fields[4];   // A=valid, V=invalid/acquiring
        const latNMEA = fields[5];
        const latDir  = fields[6];
        const lngNMEA = fields[7];
        const lngDir  = fields[8];
        // ST-903 kirim speed dalam knots — konversi ke km/h
        const speedKnots = parseFloat(fields[9])  || 0;
        const speed      = parseFloat((speedKnots * 1.852).toFixed(2));
        const course  = parseFloat(fields[10]) || 0;
        const dateStr = fields[11];

        const isV8    = msgType === 'V8';
        const battRaw = isV8 ? parseInt(fields[20], 10) || null : null;
        const signal  = isV8 ? parseInt(fields[19], 10) || 0    : 0;
        const sats    = isV8 ? parseInt(fields[18], 10) || 0    : 0;
        const hdop    = isV8 ? parseFloat(fields[17]) || null   : null;

        // Update device state dari V8 jika ada baterai
        if (isV8 && battRaw !== null) {
            const prev = state.deviceState.get(imei) || {};
            state.deviceState.set(imei, { ...prev, batt_level: battRaw, signal, sats, hdop });
        }

        // GPS belum fix — update lastSeen supaya device tidak dianggap offline,
        // tapi skip simpan lokasi ke DB
        if (status === 'V') {
            monitor.markSeen(imei);
            logger.debug('HQ', 'GPS not fixed (V)', { imei, sats, signal });
            return;
        }

        const lat = hqNmeaToDecimal(latNMEA, latDir);
        const lng = hqNmeaToDecimal(lngNMEA, lngDir);
        const ts  = hqParseDateTime(dateStr, timeStr);

        if (lat === null || lng === null) {
            logger.warn('HQ', 'Invalid coordinates', { imei, latNMEA, lngNMEA });
            return;
        }

        const st = state.deviceState.get(imei) || {};

        logger.debug('HQ', 'GPS', { imei, lat, lng, speed, course, ts, sats, signal });

        await device.onLocationPacket({
            deviceId   : imei,
            lat,
            lng,
            speed,
            course,
            time       : ts,
            battery    : st.batt_level ?? null,
            satellites : sats > 0 ? sats : null,
            attributes : hdop !== null ? { hdop } : undefined,
            protocol   : 'hq',
        });
        return;
    }

    // ── HEARTBEAT ─────────────────────────────────────────────────────────
    if (msgType === 'HTBT' || msgType === 'KEEP') {
        const voltRaw = fields[3] ?? '0';
        const signal  = parseInt(fields[4], 10) || 0;
        const acc     = (fields[7] ?? '0') === '1' ? 'ON' : 'OFF';

        const prev = state.deviceState.get(imei) || {};
        state.deviceState.set(imei, {
            ...prev,
            batt_level : hqBattToPercent(voltRaw),
            signal,
            acc,
        });

        logger.info('HQ', 'HEARTBEAT', { imei, batt_level: hqBattToPercent(voltRaw), signal, acc });
        socket.write(hqBuildCommand(imei, 'HTBT'));
        return;
    }

    // ── ALARM ─────────────────────────────────────────────────────────────
    if (msgType === 'ALARM' || msgType === 'SOS') {
        const alarmType = fields[3] ?? 'unknown';
        const alarmMap  = {
            '1': 'SOS / Panic', '2': 'Power cut',    '3': 'Vibration',
            '4': 'Enter geo-fence', '5': 'Exit geo-fence', '6': 'Over speed',
            '7': 'Low battery',  '8': 'ACC on',       '9': 'ACC off',
            '10': 'Illegal ignition',
        };
        logger.info('HQ', 'ALARM', { imei, alarmType, alarmDesc: alarmMap[alarmType] ?? `Unknown (${alarmType})` });
        socket.write(hqBuildCommand(imei, 'ACK', alarmType));
        return;
    }

    // ── COMMAND ACK ───────────────────────────────────────────────────────
    if (msgType === 'ACK' || msgType === 'RESP') {
        const content = fields.slice(3).join(',');
        logger.info('HQ', 'CMD_ACK', { imei, content });
        resolveCommand(imei, true);
        return;
    }

    logger.debug('HQ', `Unknown message type: ${msgType}`, { imei, raw });
}

async function hqProcessBuffer(buffer, socket, context) {
    while (buffer.length > 0) {
        if (!hqDetect(buffer)) {
            let found = -1;
            for (let i = 1; i < buffer.length; i++) {
                if (buffer[i] === 0x2A) { found = i; break; }
            }
            if (found === -1) {
                logger.warn('HQ', 'No valid header — buffer cleared', { deviceId: context.deviceId });
                buffer = Buffer.alloc(0);
                break;
            }
            buffer = buffer.slice(found);
            continue;
        }

        const extracted = hqExtractFrame(buffer);
        if (!extracted) break;

        buffer = extracted.rest;
        await hqHandleFrame(extracted.frame, socket, context);
    }
    return buffer;
}

// ── Packet handler ────────────────────────────────────────────────────────
async function handlePacket(packet, socket, context) {
    logger.debug('SINOTRACK_RAW', 'PACKET_IN', toHex(packet));

    if (!validateCRC(packet)) {
        logger.warn('SINOTRACK', 'CRC invalid — packet dropped', { raw: toHex(packet) });
        return;
    }

    const protocol = packet[3];
    const serial   = packet.readUInt16BE(packet.length - 6);

    // ── LOGIN (0x01) ───────────────────────────────────────────────────────
    if (protocol === PROTOCOL_LOGIN) {
        const imei       = packet.slice(4, 19).toString('ascii').replace(/\D/g, '');
        context.deviceId = imei;

        state.deviceSockets.set(imei, {
            socket,
            type: 'sinotrack',
            sendCommand(rawCommand, resolve, timeout) {
                state.pendingCommands.set(imei, { resolve, timeout });
                const cmdBuf     = Buffer.from(rawCommand);
                const ser        = state.getNextSerial(imei);
                const body       = Buffer.concat([
                    Buffer.from([0x80, cmdBuf.length, 0x00, 0x00, 0x00, 0x01]),
                    cmdBuf,
                    Buffer.from([(ser >> 8) & 0xff, ser & 0xff]),
                ]);
                const lenByte    = body.length + 2;
                const bodyForCRC = Buffer.concat([Buffer.from([lenByte]), body]);
                const crc        = getCRC16(bodyForCRC);
                const pkt = Buffer.concat([
                    Buffer.from([0x78, 0x78]),
                    bodyForCRC,
                    Buffer.from([(crc >> 8) & 0xff, crc & 0xff]),
                    Buffer.from([0x0d, 0x0a]),
                ]);
                socket.write(pkt);
                logger.info('SINOTRACK_SEND', 'Command sent', { imei, cmd: rawCommand });
            },
        });

        await device.ensureDevice(imei, 'sinotrack');
        monitor.ensureDevice(imei);
        monitor.markSeen(imei);

        // Simpan ip & port ke state untuk updateLastActivity
        const sinoSt = state.deviceState.get(imei) || {};
        state.deviceState.set(imei, {
            ...sinoSt,
            ip   : socket.remoteAddress ?? null,
            port : socket.remotePort    ?? null,
        });

        socket.write(buildACK(PROTOCOL_LOGIN, serial));
        logger.info('SINOTRACK', 'LOGIN', { imei, ip: socket.remoteAddress });
    }

    // ── HEARTBEAT (0x23) ──────────────────────────────────────────────────
    else if (protocol === PROTOCOL_HEARTBEAT) {
        if (!context.deviceId) return;

        monitor.markSeen(context.deviceId);

        const voltRaw = packet[4];
        const signal  = packet[5];

        const prev = state.deviceState.get(context.deviceId) || {};
        state.deviceState.set(context.deviceId, {
            ...prev,
            batt_level   : battVoltToPercent(voltRaw),
            batt_voltage : +(3.4 + (voltRaw / 255) * 0.8).toFixed(2),
            signal,
        });

        logger.info('SINOTRACK', 'HEARTBEAT', {
            deviceId   : context.deviceId,
            batt_level : battVoltToPercent(voltRaw),
            signal,
        });

        socket.write(buildACK(PROTOCOL_HEARTBEAT, serial));
    }

    // ── GPS (0x22) ────────────────────────────────────────────────────────
    else if (protocol === PROTOCOL_GPS) {
        if (!context.deviceId) {
            logger.warn('SINOTRACK', '0x22 GPS before LOGIN — dropped');
            return;
        }

        monitor.markSeen(context.deviceId);

        const year   = 2000 + packet[4];
        const month  = packet[5];
        const day    = packet[6];
        const hour   = packet[7];
        const min    = packet[8];
        const sec    = packet[9];
        const ts     = new Date(Date.UTC(year, month - 1, day, hour, min, sec)).toISOString();

        const latRaw     = packet.readUInt32BE(10);
        const lngRaw     = packet.readUInt32BE(14);
        const speed      = packet[18];
        const courseWord = packet.readUInt16BE(19);
        const course     = courseWord & 0x03ff;
        const isEast     = !!(courseWord & 0x0400);
        const isNorth    = !!(courseWord & 0x0800);
        const isGpsFix   = !!(courseWord & 0x1000); // bit 12 = GPS fix valid

        const lat     = parseCoord(latRaw, isNorth);
        const lng     = parseCoord(lngRaw, isEast);
        const voltRaw = packet[26] ?? 0;
        const st      = state.deviceState.get(context.deviceId) || {};

        // GPS belum fix — koordinat dari cache device, skip insert ke positions
        if (!isGpsFix) {
            logger.debug('SINOTRACK', '0x22 GPS not fixed — skipped', {
                deviceId : context.deviceId,
                ts,
            });
            return;
        }

        logger.debug('SINOTRACK', '0x22 GPS', {
            deviceId   : context.deviceId,
            lat, lng, speed, course,
            hemisphere : `${isNorth ? 'N' : 'S'} ${isEast ? 'E' : 'W'}`,
            ts,
        });

        await device.onLocationPacket({
            deviceId     : context.deviceId,
            lat,
            lng,
            speed,
            course,
            time         : ts,
            battery      : st.batt_level ?? battVoltToPercent(voltRaw),
            protocol     : 'sinotrack',
        });
    }

    // ── GPS + LBS (0x25) ──────────────────────────────────────────────────
    else if (protocol === PROTOCOL_GPS_LBS) {
        if (!context.deviceId) return;

        monitor.markSeen(context.deviceId);

        const year   = 2000 + packet[4];
        const month  = packet[5];
        const day    = packet[6];
        const hour   = packet[7];
        const min    = packet[8];
        const sec    = packet[9];
        const ts     = new Date(Date.UTC(year, month - 1, day, hour, min, sec)).toISOString();

        const latRaw     = packet.readUInt32BE(10);
        const lngRaw     = packet.readUInt32BE(14);
        const speed      = packet[18];
        const courseWord = packet.readUInt16BE(19);
        const course     = courseWord & 0x03ff;
        const isEast     = !!(courseWord & 0x0400);
        const isNorth    = !!(courseWord & 0x0800);
        const isGpsFix   = !!(courseWord & 0x1000); // bit 12 = GPS fix valid

        const lat = parseCoord(latRaw, isNorth);
        const lng = parseCoord(lngRaw, isEast);
        const st  = state.deviceState.get(context.deviceId) || {};

        // GPS belum fix — koordinat dari cache device, skip insert ke positions
        if (!isGpsFix) {
            logger.debug('SINOTRACK', '0x25 GPS+LBS not fixed — skipped', {
                deviceId : context.deviceId,
                ts,
            });
            return;
        }

        logger.debug('SINOTRACK', '0x25 GPS+LBS', {
            deviceId   : context.deviceId,
            lat, lng, speed, course,
            hemisphere : `${isNorth ? 'N' : 'S'} ${isEast ? 'E' : 'W'}`,
        });

        await device.onLocationPacket({
            deviceId : context.deviceId,
            lat,
            lng,
            speed,
            course,
            time     : ts,
            battery  : st.batt_level ?? null,
            protocol : 'sinotrack',
        });
    }

    // ── ALARM (0x26) ──────────────────────────────────────────────────────
    else if (protocol === PROTOCOL_ALARM) {
        if (!context.deviceId) return;

        monitor.markSeen(context.deviceId);

        const alarmType = packet[4];
        logger.info('SINOTRACK', 'ALARM', {
            deviceId  : context.deviceId,
            alarmType : `0x${alarmType.toString(16).padStart(2, '0')}`,
        });

        socket.write(buildACK(PROTOCOL_ALARM, serial));
    }

    // ── COMMAND ACK (0x15) ─────────────────────────────────────────────────
    else if (protocol === PROTOCOL_CMD_ACK) {
        try {
            const subLen    = packet[4];
            const content   = packet.slice(5, 5 + subLen).toString().trim();
            const ackSerial = packet.readUInt16BE(5 + subLen);

            logger.info('SINOTRACK', 'CMD_ACK', {
                deviceId: context.deviceId, content, serial: ackSerial,
            });

            const pending = state.pendingCommands.get(context.deviceId);
            if (pending && pending.serial === ackSerial) {
                resolveCommand(context.deviceId, true);
            } else {
                logger.warn('SINOTRACK', 'CMD_ACK serial mismatch', {
                    deviceId : context.deviceId,
                    received : ackSerial,
                    expected : pending?.serial ?? 'none',
                });
            }
        } catch (e) {
            logger.error('SINOTRACK', '0x15 parse error', { error: e.message });
        }
    }

    // ── Unknown ────────────────────────────────────────────────────────────
    else {
        logger.debug('SINOTRACK', `Unknown protocol 0x${protocol.toString(16).padStart(2, '0')}`, {
            deviceId : context.deviceId,
            raw      : toHex(packet),
        });
    }
}

// ── Buffer processor (auto-routing Sinotrack binary + HQ) ─────────────────
// Simpan protokol yang sudah terdeteksi per-socket (hanya deteksi sekali)
const socketProtocol = new WeakMap();

async function processBuffer(buffer, socket, context) {

    // ── Deteksi protokol jika belum diketahui ─────────────────────────────
    if (!socketProtocol.has(socket)) {
        if (buffer.length < 2) return buffer;

        if (buffer[0] === 0x78 && buffer[1] === 0x78) {
            logger.info('SINOTRACK', 'Protocol detected: SINOTRACK binary', {
                deviceId: context.deviceId ?? 'unknown',
            });
            socketProtocol.set(socket, 'sinotrack');

        } else if (buffer[0] === 0x2A) {
            logger.info('SINOTRACK', 'Protocol detected: HQ text', {
                deviceId: context.deviceId ?? 'unknown',
            });
            socketProtocol.set(socket, 'hq');

        } else {
            logger.warn('SINOTRACK', 'Protocol mismatch — connection dropped', {
                expected : 'sinotrack or hq',
                hex      : buffer.slice(0, 8).toString('hex'),
            });
            socket.destroy();
            return Buffer.alloc(0);
        }
    }

    // ── Route ke parser yang sesuai ───────────────────────────────────────
    if (socketProtocol.get(socket) === 'hq') {
        return hqProcessBuffer(buffer, socket, context);
    }

    // ── Sinotrack binary path (original logic) ────────────────────────────
    while (buffer.length >= 5) {
        if (!detect(buffer)) {
            let found = -1;
            for (let i = 1; i < buffer.length - 1; i++) {
                if (buffer[i] === 0x78 && buffer[i + 1] === 0x78) { found = i; break; }
            }
            if (found === -1) {
                logger.warn('SINOTRACK', 'No valid header — buffer cleared', {
                    deviceId: context.deviceId,
                });
                buffer = Buffer.alloc(0);
                break;
            }
            buffer = buffer.slice(found);
            continue;
        }
        const frame = extractFrame(buffer);
        if (!frame) break;
        buffer = frame.rest;
        await handlePacket(frame.packet, socket, context);
    }
    return buffer;
}

module.exports = { detect, processBuffer };