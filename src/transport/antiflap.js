'use strict';

const logger        = require('../logger');
const state         = require('../state');
const deviceService = require('../services/deviceService');
const monitor       = require('../services/monitorService');

const CHECK_INTERVAL_MS = 30_000; // cek setiap 30 detik

/**
 * Detect idle devices dan mark offline.
 * Timeout per device diambil dari field timeout_seconds di tabel devices.
 *
 * Skenario yang ditangani:
 *
 * 1. Device benar-benar mati — tidak ada packet lebih dari threshold:
 *    → set offline, bersihkan state dan socket.
 *
 * 2. Device reconnect CGNAT — gap ~2–3 menit lalu muncul lagi:
 *    → lastSeen diupdate oleh parser saat packet masuk, threshold tidak tercapai.
 *    → antiflap skip device ini (now - lastSeen <= threshold).
 *
 * 3. Device idle tapi socket masih terbuka (TCP keepalive aktif):
 *    → lastSeen tidak diupdate karena tidak ada packet.
 *    → setelah threshold, antiflap set offline.
 *    → socket akan ditutup oleh socket.setTimeout() di tcp.js secara terpisah.
 *
 * Catatan ST-903: device tidak kirim heartbeat terpisah.
 * Satu-satunya tanda hidup adalah V8 packet saat TCP aktif.
 * Gap reconnect CGNAT ~2–3 menit → gunakan timeout_seconds >= 300 (default).
 * ST-903 di DB: 480 detik → aman.
 */
function startAntiFlap() {
    const interval = setInterval(async () => {
        const now = Date.now();

        for (const [deviceId, lastSeen] of state.lastSeen.entries()) {
            try {
                const { assetId, timeoutSeconds } = await deviceService.getAssetIdByDevice(deviceId);

                // gunakan timeout_seconds per device, default 300 detik
                const thresholdMs = (timeoutSeconds ?? 300) * 1000;

                // Device masih aktif — skip
                if (now - lastSeen <= thresholdMs) continue;

                // Cek sekali lagi: apakah device punya socket aktif?
                // Jika ada socket aktif tapi tidak ada packet (lastSeen expired),
                // tcp.js akan tangani via socket.setTimeout — antiflap cukup set status.
                const hasActiveSocket = state.deviceSockets.has(deviceId);

                logger.info('ANTI_FLAP', 'Device idle → OFFLINE', {
                    deviceId,
                    assetId,
                    idleMs      : now - lastSeen,
                    threshold   : thresholdMs,
                    hasSocket   : hasActiveSocket,
                });

                // Set status offline di DB
                if (assetId) await monitor.setStatus(assetId, 'offline');

                // Update status di memory — spread supaya field lain tidak hilang
                const deviceSt = state.deviceState.get(deviceId) || {};
                state.deviceState.set(deviceId, { ...deviceSt, status: 'offline' });

                // Hapus dari lastSeen supaya tidak di-proses lagi di iterasi berikutnya
                // sampai device reconnect dan markSeen dipanggil lagi
                state.lastSeen.delete(deviceId);

                // Jika tidak ada socket aktif → bersihkan cache mapping juga
                // Jika masih ada socket → tcp.js akan cleanup saat socket tutup
                if (!hasActiveSocket) {
                    state.deviceToAsset.delete(deviceId);
                    state.deviceCacheExpiry.delete(deviceId);

                    // Hapus reverse mapping
                    for (const [aId, dId] of state.assetDevices.entries()) {
                        if (dId === deviceId) {
                            state.assetDevices.delete(aId);
                            break;
                        }
                    }
                }

            } catch (err) {
                logger.error('ANTI_FLAP', 'Offline update failed', {
                    deviceId,
                    error: err.message,
                });
            }
        }
    }, CHECK_INTERVAL_MS);

    interval.unref();
    return interval;
}

module.exports = { startAntiFlap };