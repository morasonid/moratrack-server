'use strict';

const logger   = require('../logger');
const supabase = require('../supabase');
const monitor  = require('../services/monitorService');

/**
 * Cleanup stale devices.
 * Dipanggil untuk load devices dari DB dan tandai yang sudah expired sebagai offline.
 */
async function cleanupStaleDevices() {
    const { data: links } = await supabase
        .from('asset_devices')
        .select('device_id, asset_id')
        .eq('is_active', true)
        .is('removed_at', null);
    
    if (!links?.length) return;

    for (const link of links) {
        try {
            const { data: device } = await supabase
                .from('devices')
                .select('timeout_seconds')
                .eq('id', link.device_id)
                .single();

            if (!device) continue;

            const thresholdMs = (device.timeout_seconds ?? 300) * 1000;

            const { data: assetState } = await supabase
                .from('asset_states')
                .select('last_update')
                .eq('asset_id', link.asset_id)
                .single();

            if (!assetState?.last_update) continue;

            const lastUpdate = new Date(assetState.last_update).getTime();
            const idleMs = Date.now() - lastUpdate;

            if (idleMs > thresholdMs) {
                await monitor.setStatus(link.asset_id, 'offline');
                logger.info('CLEANUP_STALE', 'Stale device marked offline on startup', {
                    assetId: link.asset_id,
                    deviceId: link.device_id,
                    idleMs,
                    threshold: thresholdMs,
                });
            }
        } catch (err) {
            logger.error('CLEANUP_STALE', 'Error checking device during startup', { 
                deviceId: link.device_id, 
                error: err.message 
            });
        }
    }
}

module.exports = { cleanupStaleDevices };