const net = require('net');
const http = require('http');
const url = require('url');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// ======================================================
// 0. CONFIG & STATE
// ======================================================
const PORT = process.env.PORT || 8080;
const TCP_PORT = process.env.TCP_PORT || 5005;

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const wsClients = new Map();
const lastSeen  = new Map();
const deviceState = new Map();
const deviceSockets = new Map();
const pendingCommands = new Map();
const deviceSerialCounters = new Map();

// ======================================================
// 1. BOOTSTRAP
// ======================================================
async function markAllDevicesOfflineOnStartup() {
    const { error } = await supabase.rpc('reset_all_devices_offline');
    if (error) {
        logger.error('BOOT', 'RPC reset failed', { error: error.message });
    } else {
        logger.info('BOOT', 'All devices set OFFLINE');
    }
}

// ======================================================
// 2. CRC16 X25
// ======================================================
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
        const content = packet.slice(2, packet.length - 4);
        const receivedCRC = packet.readUInt16BE(packet.length - 4);
        const calculatedCRC = getCRC16(content);
        return receivedCRC === calculatedCRC;
    } catch (e) {
        logger.error('CONCOX', 'CRC validation error', { error: e.message });
        return false;
    }
}

function getNextSerial(deviceId) {
    const current = deviceSerialCounters.get(deviceId) || 1;
    const next = current >= 0xFFFF ? 1 : current + 1;
    deviceSerialCounters.set(deviceId, next);
    return next;
}

// ======================================================
// 3. LOGGER
// ======================================================
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function log(level, tag, message, data) {
    if (LEVELS[level] > LEVELS[LOG_LEVEL]) return;

    const entry = {
        ts: new Date().toISOString(),
        level,
        tag,
        message
    };

    if (data !== undefined) entry.data = data;
    console.log(JSON.stringify(entry));
}

const logger = {
    error: (tag, msg, data) => log('error', tag, msg, data),
    warn:  (tag, msg, data) => log('warn',  tag, msg, data),
    info:  (tag, msg, data) => log('info',  tag, msg, data),
    debug: (tag, msg, data) => log('debug', tag, msg, data),
};

function toHex(buf) {
    return buf.toString('hex').match(/.{1,2}/g).join(' ');
}

function battRawToPercentAT4(raw) {
    if (raw >= 0xF0) return 100;
    if (raw >= 0xD0) return 90;
    if (raw >= 0xB0) return 80;
    if (raw >= 0x98) return 70;
    if (raw >= 0x80) return 55;
    if (raw >= 0x70) return 45;
    if (raw >= 0x60) return 35;
    if (raw >= 0x50) return 25;
    if (raw >= 0x40) return 15;
    if (raw >= 0x30) return 8;
    return 3;
}

function battRawToVoltEstimate(raw) {
    return 3.6 + (raw / 255) * 0.6;
}

function sendConcoxACK(socket, protocol, serial) {
    const body = Buffer.from([
        0x05,
        protocol,
        (serial >> 8) & 0xff,
        serial & 0xff
    ]);

    const crc = getCRC16(body);

    const response = Buffer.from([
        0x78, 0x78,
        ...body,
        (crc >> 8) & 0xff,
        crc & 0xff,
        0x0d, 0x0a
    ]);

    logger.debug('CONCOX_RAW', 'ACK_OUT', toHex(response));
    socket.write(response);
}

function parseIMEI(buf) {
    let imei = '';
    for (const b of buf) {
        imei += ((b >> 4) & 0x0f).toString();
        imei += (b & 0x0f).toString();
    }
    return imei.replace(/^0/, '');
}

// ======================================================
// 4. DEVICE CORE & COMMAND HELPER
// ======================================================
async function ensureDevice(deviceId) {
    await supabase.from('devices')
        .upsert({ device_id: deviceId }, { onConflict: 'device_id' });
}

async function setOnline(deviceId, online) {
    await supabase.from('devices')
        .update({ is_online: online })
        .eq('device_id', deviceId);

    logger.info('DEVICE_STATUS', online ? 'ONLINE' : 'OFFLINE', { deviceId });
}

async function applyDeviceContext(payload, deviceId) {
    const { data } = await supabase
        .from('devices')
        .select('lat_factor, lng_factor')
        .eq('device_id', deviceId)
        .maybeSingle();

    if (!data) return payload;

    if (data.lat_factor === -1 || data.lat_factor === 1)
        payload.lat *= data.lat_factor;

    if (data.lng_factor === -1 || data.lng_factor === 1)
        payload.lng *= data.lng_factor;

    return payload;
}

/**
 * Fungsi untuk mengirim perintah ke alat dan menunggu respon (ACK)
 * Dioptimalkan untuk protokol Concox AT4 (0x80)
 */
function sendDeviceCommand(deviceId, rawCommand) {
    const dev = deviceSockets.get(deviceId);
    if (!dev || !dev.socket.writable) {
        logger.warn('COMMAND', 'Device not connected', { deviceId });
        return Promise.resolve(false);
    }

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            if (pendingCommands.has(deviceId)) {
                pendingCommands.delete(deviceId);
                logger.warn('COMMAND', 'Response timeout (GPS No Response)', { deviceId });
                resolve(false);
            }
        }, 15000);

        try {
            if (dev.type === 'android') {
                pendingCommands.set(deviceId, { resolve, timeout });
                dev.socket.write(rawCommand + '\n');
            } else if (dev.type === 'concox') {
                const cmdBuf = Buffer.from(rawCommand);
                const serial = getNextSerial(deviceId);

                // STRUKTUR MINIMALIST (Tanpa Language Field - Sering digunakan AT4)
                const bodyContent = Buffer.concat([
                    Buffer.from([0x80]),                   // Protocol ID
                    Buffer.from([cmdBuf.length]),          // Command length
                    Buffer.from([0x00, 0x00, 0x00, 0x01]), // Server Flag (Coba 01 untuk GPRS Command)
                    cmdBuf,                                // Command ASCII
                    Buffer.from([(serial >> 8) & 0xff, serial & 0xff]) // Serial
                ]);

                const lenByte = bodyContent.length + 2;
                const bodyForCRC = Buffer.concat([Buffer.from([lenByte]), bodyContent]);
                const crc = getCRC16(bodyForCRC);

                const packet = Buffer.concat([
                    Buffer.from([0x78, 0x78]),
                    bodyForCRC,
                    Buffer.from([(crc >> 8) & 0xff, crc & 0xff]),
                    Buffer.from([0x0d, 0x0a])
                ]);

                pendingCommands.set(deviceId, { resolve, timeout, serial });
                dev.socket.write(packet);
                
                logger.info('CONCOX_SEND', 'Forwarding simplified packet', { 
                    deviceId, 
                    cmd: rawCommand, 
                    hex: toHex(packet) 
                });
            }
        } catch (e) {
            clearTimeout(timeout);
            pendingCommands.delete(deviceId);
            logger.error('COMMAND', 'Send failed', { error: e.message });
            resolve(false);
        }
    });
}

// ======================================================
// 5. DATA INGESTION
// ======================================================
async function handleLocation(payload, deviceId) {
    if (!payload || payload.lat === 0 || payload.lng === 0) return;

    if (!payload.time) payload.time = new Date().toISOString();
    payload = await applyDeviceContext(payload, deviceId);

    if (wsClients.has(deviceId)) {
        const clients = wsClients.get(deviceId);
        logger.debug('WS', 'Broadcast location', {
            deviceId,
            clients: clients.size
        });

        const msg = JSON.stringify(payload);
        clients.forEach(ws => {
            if (ws.readyState === 1) ws.send(msg);
        });
    }

    const row = {
        device_id: deviceId,
        time: payload.time,
        lat: payload.lat,
        lng: payload.lng,
        speed: payload.speed ?? 0,
        course: payload.course ?? 0,
        satellites: payload.satellites ?? 0
    };

    if (typeof payload.batt_level === 'number') row.batt_level = payload.batt_level;
    if (typeof payload.batt_voltage === 'number') row.batt_voltage = payload.batt_voltage;

    await supabase.from('gps_data')
        .upsert(row, { onConflict: 'device_id,time' });

    logger.info('GPS_DATA', 'Location saved', row);
}

function markSeen(deviceId) {
    lastSeen.set(deviceId, Date.now());
}

// ======================================================
// 6. TCP SERVER
// ======================================================
const tcpServer = net.createServer(socket => {

    socket.setTimeout(90000);

    let buffer = Buffer.alloc(0);
    let deviceId = null;
    let deviceType = null;

    const cleanup = () => {
        if (deviceId) {
            deviceSockets.delete(deviceId);
            lastSeen.delete(deviceId);
            setOnline(deviceId, false).catch(() => {});
        }
    };

    socket.on('timeout', () => {
        logger.warn('TCP', 'Connection timeout', { deviceId });
        socket.destroy();
    });

    socket.on('data', async data => {

        buffer = Buffer.concat([buffer, data]);

        // ---------- CONCOX ----------
        if (buffer.length >= 2 && buffer[0] === 0x78 && buffer[1] === 0x78) {

            deviceType = 'concox';

            while (buffer.length >= 5) {

                const len = buffer[2];
                const totalLen = len + 5;
                if (buffer.length < totalLen) break;

                const packet = buffer.slice(0, totalLen);
                buffer = buffer.slice(totalLen);

                logger.debug('CONCOX_RAW', 'PACKET_IN', toHex(packet));

                if (!validateCRC(packet)) {
                    logger.warn('CONCOX', 'CRC INVALID - Packet dropped', {
                        raw: toHex(packet)
                    });
                    continue;
                }

                const protocol = packet[3];
                const serial = packet.readUInt16BE(packet.length - 6);

                if (protocol === 0x01) {
                    deviceId = parseIMEI(packet.slice(4, 12));
                    deviceSockets.set(deviceId, { socket, type: 'concox' });
                    logger.info('CONCOX', 'LOGIN', { deviceId });
                    await ensureDevice(deviceId);
                    sendConcoxACK(socket, 0x01, serial);
                    await setOnline(deviceId, true);
                    markSeen(deviceId);
                }

                else if (protocol === 0x15) { 
					// Terminal Response (Respon terhadap perintah 0x80)
					// Format: [7878] [Length] [15] [Sub-Length] [Content] [Serial] [CRC] [0D 0A]
					
					try {
						const subLen = packet[4]; // Panjang isi balasan
						const content = packet.slice(5, 5 + subLen).toString().trim();
						
						// Serial number balasan berada setelah content (2 byte)
						const serialInResponse = packet.readUInt16BE(5 + subLen);

						logger.info('CONCOX', 'CMD_ACK_RECEIVED', { 
							deviceId, 
							content, 
							serial: serialInResponse 
						});

						// Cari perintah yang sedang menunggu (pending) berdasarkan deviceId
						const pending = pendingCommands.get(deviceId);

						// Validasi: Pastikan serial number balasan cocok dengan yang kita kirim tadi
						if (pending && pending.serial === serialInResponse) {
							clearTimeout(pending.timeout);
							pendingCommands.delete(deviceId);
							
							// Selesaikan Promise REST API dengan 'true'
							pending.resolve(true); 
							
							logger.debug('COMMAND', 'Matched serial and resolved Promise', { deviceId, serial: serialInResponse });
						} else {
							logger.warn('COMMAND', 'Serial mismatch or no pending command', { 
								deviceId, 
								receivedSerial: serialInResponse,
								expectedSerial: pending ? pending.serial : 'none'
							});
						}
					} catch (e) {
						logger.error('CONCOX', 'Error parsing 0x15 response', { error: e.message });
					}
				}

                else if (protocol === 0x23) {
                    markSeen(deviceId);

                    const acc = packet[5] === 0x01;
                    const battRaw = packet[6];
                    const battLevel = battRawToPercentAT4(battRaw);
                    const battVolt = battRawToVoltEstimate(battRaw);

                    deviceState.set(deviceId, {
                        batt_level: battLevel,
                        batt_voltage: battVolt,
                        acc
                    });

                    logger.info('CONCOX', 'STATUS', {
                        deviceId,
                        acc,
                        battLevel,
                        battVolt
                    });

                    sendConcoxACK(socket, 0x23, serial);
                }

                else if (protocol === 0x12 || protocol === 0x22) {
                    const lat_raw = packet.readUInt32BE(11);
                    const lng_raw = packet.readUInt32BE(15);
                    const speed_raw = packet[19];
                    const course_raw = packet.readUInt16BE(20);

                    markSeen(deviceId);

                    // Parse base coordinates
                    const lat = lat_raw / 1800000;
                    const lng = lng_raw / 1800000;
                    
                    // Hemisphere detection from flags byte 21 (Bit 2=S/N, Bit 3=W/E)
                    const flags_byte = packet[21];
                    const is_south = (flags_byte >> 2) & 1;
                    const is_west = (flags_byte >> 3) & 1;
                    
                    // Apply hemisphere sign
                    const lat_final = is_south ? -lat : lat;
                    const lng_final = is_west ? -lng : lng;
                    
                    const speed = speed_raw;
                    const course = course_raw & 0x03ff;

                    const state = deviceState.get(deviceId) || {};

                    await handleLocation({
                        lat: lat, //lat_final
                        lng: lng, //lng_final
                        speed,
                        course,
                        batt_level: state.batt_level,
                        batt_voltage: state.batt_voltage
                    }, deviceId);
                }
            }
        }

        // ---------- ANDROID ----------
        else {

            deviceType = 'android';
            const lines = buffer.toString().split('\n');
            buffer = Buffer.from(lines.pop());

            for (const raw of lines) {

                const line = raw.trim();
                if (!line) continue;

                if (line.startsWith('LOGIN:')) {

                    deviceId = line.split(':')[1];
                    deviceSockets.set(deviceId, { socket, type: 'android' });
                    await ensureDevice(deviceId);
                    await setOnline(deviceId, true);
                    markSeen(deviceId);
                    socket.write('LOGIN:OK\n');
                }

                else if (line === 'OK' || line.startsWith('RESULT:')) {

                    const pending = pendingCommands.get(deviceId);
                    if (pending) {
                        clearTimeout(pending.timeout);
                        pendingCommands.delete(deviceId);
                        pending.resolve(true);
                    }
                }

                else if (line === 'PING') {
                    socket.write('PONG\n');
                    markSeen(deviceId);
                }

                else if (line.startsWith('{')) {
                    const json = JSON.parse(line);
                    markSeen(deviceId);
                    await handleLocation(json, deviceId);
                }
            }
        }
    });

    socket.on('end', cleanup);
    socket.on('error', (err) => {
        logger.error('TCP', 'Socket error', { deviceId, error: err.message });
        cleanup();
    });
});

// ======================================================
// 7. ANTI-FLAPPING
// ======================================================
setInterval(async () => {
    const now = Date.now();
    for (const [id, ts] of lastSeen) {
        if (now - ts > 120000) {
            await setOnline(id, false).catch(() => {});
            lastSeen.delete(id);
        }
    }
}, 30000);

// ======================================================
// 8. HTTP SERVER (REST API + WS UPGRADE)
// ======================================================
const server = http.createServer(async (req, res) => {

    if (req.method === 'POST' && req.url === '/api/command') {

        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });

        req.on('end', async () => {
            try {

                const data = JSON.parse(body);
                const { device_id, params } = data;

                if (!device_id || !params?.raw) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        success: false,
                        message: 'device_id and params.raw are required'
                    }));
                }

                logger.info('API_CMD', 'Incoming request', {
                    device_id,
                    cmd: params.raw
                });

                const success = await sendDeviceCommand(device_id, params.raw);

                res.writeHead(success ? 200 : 408, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success,
                    message: success
                        ? 'GPS responded successfully'
                        : 'GPS failed to respond (Timeout or Offline)'
                }));

            } catch (e) {

                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    message: e.message
                }));
            }
        });

        return;
    }

    res.writeHead(404);
    res.end();
});

const wss = new WebSocketServer({ noServer: true });

setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) {
            logger.warn('WS', 'Zombie client terminated', {
                deviceId: ws.deviceId
            });
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

server.on('upgrade', async (req, socket, head) => {

    const { pathname, query } = url.parse(req.url, true);
    const token = query.token;
    const deviceId = pathname.split('/')[2];

    if (!token || !deviceId) {
        logger.warn('WS', 'Upgrade rejected');
        return socket.destroy();
    }

    try {

        const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);

        const { data } = await supabase
            .from('user_devices')
            .select('device_id')
            .eq('device_id', deviceId)
            .eq('user_id', decoded.sub)
            .maybeSingle();

        if (!data) {
            logger.warn('WS', 'Unauthorized device', { deviceId });
            return socket.destroy();
        }

        wss.handleUpgrade(req, socket, head, ws => {

            const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

            ws.deviceId = deviceId;
            ws.isAlive = true;

            ws.on('pong', () => { ws.isAlive = true; });

            if (!wsClients.has(deviceId)) {
                wsClients.set(deviceId, new Set());
            }

            const clients = wsClients.get(deviceId);
            clients.add(ws);

            logger.info('WS', 'Client connected', {
                deviceId,
                ip: clientIp,
                totalClients: clients.size
            });

            ws.on('close', () => {
                clients.delete(ws);
                if (!clients.size) wsClients.delete(deviceId);
                logger.info('WS', 'Client disconnected', {
                    deviceId,
                    remaining: clients.size
                });
            });

            ws.on('error', err => {
                logger.error('WS', 'Socket error', {
                    deviceId,
                    error: err.message
                });
            });
        });

    } catch (err) {
        logger.warn('WS', 'Invalid token', { error: err.message });
        socket.destroy();
    }
});

// ======================================================
// 9. RUN
// ======================================================
(async () => {

    await markAllDevicesOfflineOnStartup();

    tcpServer.listen(TCP_PORT, '0.0.0.0', () =>
        logger.info('BOOT', 'TCP Gateway started', { port: TCP_PORT })
    );

    server.listen(PORT, '0.0.0.0', () =>
        logger.info('BOOT', 'REST & Dashboard Server started', { port: PORT })
    );

})();
