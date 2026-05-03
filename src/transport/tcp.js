'use strict';

const net     = require('net');
const logger  = require('../logger');
const state   = require('../state');
const monitor = require('../services/monitorService');

const MAX_BUFFER = 4096;

// Timeout per protokol — disesuaikan dengan interval kirim saat device diam.
// Nilai harus lebih besar dari interval kirim terlama device supaya koneksi
// tidak terputus di tengah interval.
//
// Concox AT4   : diam kirim setiap 5 menit  → timeout 7 menit
// Sinotrack    : binary, diam tidak kirim    → timeout 7 menit
// HQ ST-903    : V8 setiap 10 detik SELALU  → timeout 3 menit
//                (confirmed dari log: device kirim V8 bahkan saat GPS void)
//                NAT CGNAT operator bisa putus dalam 2-5 menit idle
// Teltonika    : tergantung konfigurasi      → timeout 10 menit
// Android      : ada PING heartbeat          → timeout 3 menit
//
// 0 = disable timeout (tidak direkomendasikan — ghost connection tidak dibersihkan)

const SOCKET_TIMEOUTS = {
    default   : 7 * 60 * 1000,   // 7 menit fallback
    concox    : 7 * 60 * 1000,   // 7 menit — diam kirim setiap 5 menit
    android   : 7 * 60 * 1000,   // 7 menit — diam kirim setiap 5 menit
    teltonika : 7 * 60 * 1000,   // 7 menit — sementara, sesuaikan setelah ada device
    sinotrack : 3 * 60 * 1000,   // 3 menit — HQ ST-903 kirim V8 setiap 10 detik
};

function createTcpServer(port, parser, label = parser.name.toUpperCase()) {

    // Ambil timeout sesuai nama parser, fallback ke default
    const socketTimeout = SOCKET_TIMEOUTS[parser.name?.toLowerCase()]
        ?? SOCKET_TIMEOUTS.default;

    const server = net.createServer(socket => {

        // Aktifkan TCP keepalive di level OS — deteksi socket mati dari NAT timeout
        // tanpa menunggu data masuk (CGNAT operator Indonesia bisa timeout dalam 2-5 menit)
        socket.setKeepAlive(true, 60_000);  // probe setelah 60 detik idle

        socket.setTimeout(socketTimeout);

        let buffer = Buffer.alloc(0);
        let protocolChecked = false;

        const context = { deviceId: null };

        let cleaned = false;

        const cleanup = async () => {
            if (cleaned) return;
            cleaned = true;

            if (!context.deviceId) return;

            const deviceId = context.deviceId;

            // ── CGNAT stale socket guard ──────────────────────────────────
            // Device dengan SIM CGNAT (Telkomsel, XL, Indosat) sering reconnect
            // dengan IP publik baru sementara socket lama belum dapat RST.
            // Situasi: socket A putus → device reconnect → socket B aktif →
            //          beberapa menit kemudian socket A baru dapat ECONNRESET.
            //
            // Jika deviceSockets masih menunjuk ke socket INI → device offline.
            // Jika deviceSockets sudah pindah ke socket LAIN → device reconnected,
            // jangan set offline — cukup log dan skip cleanup state.
            const currentEntry   = state.deviceSockets.get(deviceId);
            const isActiveSocket = !currentEntry || currentEntry.socket === socket;

            if (isActiveSocket) {
                state.deviceSockets.delete(deviceId);
                await monitor.cleanupDevice(deviceId);
                logger.info(label, 'Device disconnected → OFFLINE', { deviceId });
            } else {
                // Socket lama yang baru ketahuan mati — device sudah reconnect
                logger.info(label, 'Stale socket closed — device already reconnected, skip offline', { deviceId });
            }
        };

        socket.on('data', async data => {

            buffer = Buffer.concat([buffer, data]);

            // guard buffer overflow
            if (buffer.length > MAX_BUFFER) {

                logger.warn(label, 'Buffer overflow — connection dropped', {
                    deviceId : context.deviceId,
                    size     : buffer.length,
                });

                socket.destroy();
                return;
            }

            // check protocol only once
            if (!protocolChecked && buffer.length >= 4) {

                if (!parser.detect(buffer)) {

                    logger.warn(label, 'Protocol mismatch — connection dropped', {
                        expected : parser.name,
                        hex      : buffer.slice(0, 8).toString('hex'),
                    });

                    socket.destroy();
                    return;
                }

                protocolChecked = true;
            }

            try {

                buffer = await parser.processBuffer(buffer, socket, context);

            } catch (err) {

                logger.error(label, 'Parser error', {
                    deviceId : context.deviceId,
                    error    : err.message,
                });

            }

        });

        socket.on('timeout', () => {

            logger.warn(label, 'Connection timeout', {
                deviceId: context.deviceId,
            });

            socket.destroy();

        });

        socket.on('end', cleanup);

        socket.on('close', cleanup);

        socket.on('error', err => {

            logger.error(label, 'Socket error', {
                deviceId : context.deviceId,
                error    : err.message,
            });

            cleanup();

        });

    });

    server.listen(port, '0.0.0.0', () => {

        logger.info('BOOT', `${label} TCP server listening`, {
            port,
            socketTimeout: `${socketTimeout / 1000}s`,
        });

    });

    server.on('error', err => {

        logger.error('BOOT', `${label} TCP server error`, {
            port,
            error: err.message,
        });

    });

    return server;
}

module.exports = { createTcpServer };