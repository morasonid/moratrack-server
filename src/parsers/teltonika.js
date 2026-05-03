'use strict';

const logger             = require('../logger');
const state              = require('../state');
const device             = require('../services/deviceService');
const monitor            = require('../services/monitorService');
const { resolveCommand } = require('../services/commandService');
const { updateAssetHeartbeat } = require('../services/assetService');

const CODEC8    = 0x08;
const CODEC8EXT = 0x8E;

// ── CRC16 IBM/ANSI ────────────────────────────────────────────────────────
function calcCRC16(buffer) {
    let crc = 0;
    for (const b of buffer) {
        crc ^= b;
        for (let i = 0; i < 8; i++) {
            crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : (crc >> 1);
        }
    }
    return crc;
}

function validateCRC(buf, dataStart, dataEnd, expectedCRC) {
    return calcCRC16(buf.slice(dataStart, dataEnd)) === expectedCRC;
}

function toHex(buf) {
    return buf.toString('hex').match(/.{1,2}/g).join(' ');
}

// ── IO parser ─────────────────────────────────────────────────────────────
function parseIO(buf, offset, isExt) {
    const idSize = isExt ? 2 : 1;
    const ioMap  = {};

    offset += idSize;
    offset += isExt ? 2 : 1;

    for (const valSize of [1, 2, 4, 8]) {
        const count = isExt ? buf.readUInt16BE(offset) : buf[offset];
        offset += isExt ? 2 : 1;

        for (let i = 0; i < count; i++) {
            const id = isExt ? buf.readUInt16BE(offset) : buf[offset];
            offset  += idSize;

            let val;
            if      (valSize === 1) val = buf[offset];
            else if (valSize === 2) val = buf.readUInt16BE(offset);
            else if (valSize === 4) val = buf.readUInt32BE(offset);
            else                   val = buf.readBigUInt64BE(offset);

            ioMap[id] = val;
            offset   += valSize;
        }
    }

    return { ioMap, offset };
}

// ── AVL Record parser ─────────────────────────────────────────────────────
function parseRecord(buf, offset, isExt) {
    try {
        const tsHigh = buf.readUInt32BE(offset);
        const tsLow  = buf.readUInt32BE(offset + 4);
        const ts     = new Date(tsHigh * 0x100000000 + tsLow).toISOString();
        offset += 8;

        offset += 1; // priority

        const lngRaw = buf.readInt32BE(offset); offset += 4;
        const latRaw = buf.readInt32BE(offset); offset += 4;
        const alt    = buf.readInt16BE(offset);  offset += 2;
        const course = buf.readUInt16BE(offset); offset += 2;
        const sats   = buf[offset];              offset += 1;
        const speed  = buf.readUInt16BE(offset); offset += 2;

        const { ioMap, offset: newOffset } = parseIO(buf, offset, isExt);
        offset = newOffset;

        const record = {
            ts,
            lat          : latRaw / 10000000,
            lng          : lngRaw / 10000000,
            alt,
            course,
            satellites   : sats,
            speed,
            io           : ioMap,
            ignition     : ioMap[239] === 1,
            batt_level   : typeof ioMap[113] === 'number' ? ioMap[113]       : null,
            batt_voltage : typeof ioMap[67]  === 'number' ? ioMap[67] / 1000 : null,
        };

        return { record, offset };
    } catch (e) {
        logger.warn('TELTONIKA', 'Record parse error', { error: e.message });
        return null;
    }
}

// ── Data packet parser ────────────────────────────────────────────────────
function parseDataPacket(buf) {
    if (buf.length < 10) return null;

    const dataLength  = buf.readUInt32BE(0);
    const totalLen    = 4 + dataLength + 4;
    if (buf.length < totalLen) return null;

    const codecId = buf[4];
    const isExt   = codecId === CODEC8EXT;

    if (codecId !== CODEC8 && codecId !== CODEC8EXT) {
        logger.warn('TELTONIKA', `Unknown codec 0x${codecId.toString(16)}`);
        return null;
    }

    const recCount1   = buf[5];
    const expectedCRC = buf.readUInt32BE(4 + dataLength);

    if (!validateCRC(buf, 4, 4 + dataLength, expectedCRC)) {
        logger.warn('TELTONIKA', 'CRC invalid');
        return null;
    }

    const records = [];
    let offset = 6;

    for (let i = 0; i < recCount1; i++) {
        const result = parseRecord(buf, offset, isExt);
        if (!result) break;
        records.push(result.record);
        offset = result.offset;
    }

    const recCount2 = buf[offset];
    if (recCount1 !== recCount2) {
        logger.warn('TELTONIKA', 'Record count mismatch', { recCount1, recCount2 });
    }

    return { records, codecId, recCount: recCount1 };
}

// ── Frame extractor ───────────────────────────────────────────────────────
function detect(buffer) {
    if (buffer.length < 2) return false;
    if (buffer[0] === 0x00 && buffer[1] === 0x0F) return true;
    if (buffer.length >= 4 &&
        buffer[0] === 0x00 && buffer[1] === 0x00 &&
        buffer[2] === 0x00 && buffer[3] === 0x00) return true;
    return false;
}

function extractFrame(buffer) {
    if (buffer.length < 2) return null;

    if (buffer[0] === 0x00 && buffer[1] === 0x0F) {
        const totalLen = 17;
        if (buffer.length < totalLen) return null;
        return { type: 'imei', packet: buffer.slice(0, totalLen), rest: buffer.slice(totalLen) };
    }

    if (buffer.length < 8) return null;
    if (buffer[0] !== 0x00 || buffer[1] !== 0x00 ||
        buffer[2] !== 0x00 || buffer[3] !== 0x00) return null;

    const dataLength = buffer.readUInt32BE(4);
    const totalLen   = 4 + 4 + dataLength + 4;
    if (buffer.length < totalLen) return null;

    return { type: 'data', packet: buffer.slice(0, totalLen), rest: buffer.slice(totalLen) };
}

// ── Packet handlers ───────────────────────────────────────────────────────
async function handleImeiPacket(packet, socket, context) {
    const imei       = packet.slice(2).toString('ascii').trim();
    context.deviceId = imei;

    state.deviceSockets.set(imei, {
        socket,
        type: 'teltonika',
        sendCommand(rawCommand, resolve, timeout) {
            state.pendingCommands.set(imei, { resolve, timeout });
            socket.write(rawCommand);
            logger.info('TELTONIKA_SEND', 'Command sent', { imei });
        },
    });

    await device.ensureDevice(imei, 'teltonika');
    monitor.ensureDevice(imei);
    monitor.markSeen(imei);

    // Simpan ip & port ke state untuk updateLastActivity
    const telSt = state.deviceState.get(imei) || {};
    state.deviceState.set(imei, {
        ...telSt,
        ip   : socket.remoteAddress ?? null,
        port : socket.remotePort    ?? null,
    });

    socket.write(Buffer.from([0x01]));
    logger.info('TELTONIKA', 'IMEI received', { imei, ip: socket.remoteAddress });
}

async function handleDataPacket(packet, socket, context) {
    if (!context.deviceId) {
        logger.warn('TELTONIKA', 'Data packet before IMEI — dropped');
        socket.write(Buffer.from([0x00, 0x00, 0x00, 0x00]));
        return;
    }

    logger.debug('TELTONIKA_RAW', 'PACKET_IN', toHex(packet));

    const result = parseDataPacket(packet.slice(4));

    if (!result) {
        socket.write(Buffer.from([0x00, 0x00, 0x00, 0x00]));
        return;
    }

    logger.debug('TELTONIKA', `Codec ${result.codecId === CODEC8EXT ? '8Ext' : '8'} — ${result.recCount} records`, {
        deviceId: context.deviceId,
    });

    monitor.markSeen(context.deviceId);

    for (const rec of result.records) {
        if (rec.lat === 0 && rec.lng === 0) continue;

        // GPS belum fix — satellites = 0 berarti tidak ada fix
        if (rec.satellites === 0) {
            logger.debug('TELTONIKA', 'GPS not fixed — skipped', {
                deviceId : context.deviceId,
                ts       : rec.ts,
            });
            continue;
        }

        const st = state.deviceState.get(context.deviceId) || {};

        await device.onLocationPacket({
            deviceId   : context.deviceId,
            lat        : rec.lat,
            lng        : rec.lng,
            speed      : rec.speed,
            course     : rec.course,
            altitude   : rec.alt,
            time       : rec.ts,
            ignition   : rec.ignition,
            battery    : rec.batt_level ?? st.batt_level ?? null,
            satellites : rec.satellites > 0 ? rec.satellites : null,
            attributes : rec.io ? { io: rec.io } : null,
            protocol   : 'teltonika',
        });
    }

    // Update asset status dari heartbeat (data packet received)
    const { assetId } = await device.getAssetIdByDevice(context.deviceId);
    if (assetId) {
        await updateAssetHeartbeat(assetId);
    }

    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(result.recCount, 0);
    socket.write(ack);
    logger.debug('TELTONIKA', 'Data ACK sent', { deviceId: context.deviceId, records: result.recCount });
}

// ── Buffer processor ──────────────────────────────────────────────────────
async function processBuffer(buffer, socket, context) {
    while (buffer.length >= 2) {
        const frame = extractFrame(buffer);
        if (!frame) break;

        buffer = frame.rest;

        if (frame.type === 'imei') {
            await handleImeiPacket(frame.packet, socket, context);
        } else if (frame.type === 'data') {
            await handleDataPacket(frame.packet, socket, context);
        }
    }

    return buffer;
}

module.exports = { detect, processBuffer };