'use strict';

const logger = require('../logger');
const state  = require('../state');

const deviceService = require('../services/deviceService');
const monitor       = require('../services/monitorService');

const { resolveCommand } = require('../services/commandService');
const { updateAssetHeartbeat } = require('../services/assetService');

/**
 * Protokol Android/iOS agent (text-based, newline-delimited):
 *
 * LOGIN:<device_id>\n
 * PING\n
 * OK\n | RESULT:<data>\n
 * {...JSON...}\n
 */

// ── Detect protocol ─────────────────────────────────────────────────

// HTTP method signatures yang umum dipakai scanner internet
const HTTP_METHODS = ['GET ', 'POST', 'HEAD', 'PUT ', 'DELE', 'OPTI', 'PATC'];

function detect(buffer) {
    if (buffer.length < 4) return false;
    const first = buffer[0];
    // Harus printable ASCII
    if (first < 0x20 || first > 0x7e) return false;
    // Tolak jika 4 byte pertama cocok dengan HTTP method (port scanner)
    const prefix = buffer.slice(0, 4).toString('ascii');
    if (HTTP_METHODS.some(m => prefix.startsWith(m))) return false;
    return true;
}

// ── Line processor ─────────────────────────────────────────────────

async function processLine(line, socket, context) {
    if (!line) return;

    // ── LOGIN ─────────────────────────────────────────────────────

    if (line.startsWith('LOGIN:')) {
        const deviceId = line.split(':')[1]?.trim();

        if (!deviceId) {
            logger.warn('ANDROID', 'LOGIN with empty deviceId');
            return;
        }

        context.deviceId = deviceId;

        // daftarkan ke database jika belum ada
        await deviceService.ensureDevice(deviceId, 'android');

        state.deviceSockets.set(deviceId, {
            socket,
            type: 'android',
            sendCommand(rawCommand, resolve, timeout) {
                state.pendingCommands.set(deviceId, { resolve, timeout });
                socket.write(rawCommand + '\n');
                logger.info('ANDROID_SEND', 'Command sent', { deviceId, cmd: rawCommand });
            }
        });

        // init runtime state di memory
        monitor.ensureDevice(deviceId);
        monitor.markSeen(deviceId);

        const ip   = socket.remoteAddress;
        const port = socket.remotePort;

        // Simpan ip & port ke state untuk updateLastActivity
        const androidSt = state.deviceState.get(deviceId) || {};
        state.deviceState.set(deviceId, {
            ...androidSt,
            ip,
            port,
        });

        socket.write('LOGIN:OK\n');
        logger.info('ANDROID', 'LOGIN', { deviceId, ip });

        return;
    }

    // ── PING / heartbeat ───────────────────────────────────────────

    if (line === 'PING') {
        if (!context.deviceId) return;

        monitor.markSeen(context.deviceId);

        // Update asset status dari heartbeat (PING received)
        const { assetId } = await deviceService.getAssetIdByDevice(context.deviceId);
        if (assetId) {
            await updateAssetHeartbeat(assetId);
        }

        socket.write('PONG\n');
        logger.debug('ANDROID', 'PING → PONG', { deviceId: context.deviceId });

        return;
    }

    // ── Command ACK ─────────────────────────────────────────────────

    if (line === 'OK' || line.startsWith('RESULT:')) {
        if (!context.deviceId) return;

        resolveCommand(context.deviceId, true);
        logger.info('ANDROID', 'CMD_ACK', { deviceId: context.deviceId, line });

        return;
    }

    // ── JSON location payload ───────────────────────────────────────

    if (line.startsWith('{')) {
        if (!context.deviceId) return;

        try {
            const json = JSON.parse(line);

            monitor.markSeen(context.deviceId);

            // Normalisasi field name alias — support berbagai format app Android:
            //   lat / latitude, lng / longitude / lon
            //   time / timestamp / ts
            //   course / heading
            //   altitude / alt
            //   battery / batt_level
            // Validasi koordinat, time, speed, course dilakukan di deviceService.onLocationPacket
            await deviceService.onLocationPacket({
                deviceId   : context.deviceId,
                lat        : json.lat        ?? json.latitude  ?? null,
                lng        : json.lng        ?? json.longitude ?? json.lon ?? null,
                speed      : json.speed      ?? null,
                course     : json.course     ?? json.heading   ?? null,
                time       : json.time       ?? json.timestamp ?? json.ts ?? null,
                altitude   : json.altitude   ?? json.alt       ?? null,
                ignition   : json.ignition   ?? null,
                battery    : json.battery    ?? json.batt_level ?? null,
                satellites : json.satellites ?? json.sats      ?? null,
                protocol   : 'android',
            });

            logger.info('ANDROID', 'Location received', {
                deviceId : context.deviceId,
                lat      : json.lat ?? json.latitude,
                lng      : json.lng ?? json.longitude ?? json.lon,
                speed    : json.speed,
                time     : json.time ?? json.timestamp ?? json.ts,
            });

        } catch (err) {
            logger.warn('ANDROID', 'JSON parse failed', {
                deviceId : context.deviceId,
                line,
                error    : err.message,
            });
        }

        return;
    }

    logger.debug('ANDROID', 'Unknown line', { deviceId: context.deviceId, line });
}

// ── Buffer processor ───────────────────────────────────────────────

async function processBuffer(buffer, socket, context) {
    const lines     = buffer.toString().split('\n');
    const remaining = Buffer.from(lines.pop());

    for (const raw of lines) {
        await processLine(raw.trim(), socket, context);
    }

    return remaining;
}

module.exports = { detect, processBuffer };