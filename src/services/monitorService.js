'use strict';

const logger   = require('../logger');
const state    = require('../state');
const supabase = require('../supabase');

/**
 * Ensure device runtime state exists (in-memory only)
 */
function ensureDevice(deviceId) {
    if (!state.lastSeen.has(deviceId)) {
        state.lastSeen.set(deviceId, Date.now());
    }
}

/**
 * Mark device seen (heartbeat / packet masuk)
 */
function markSeen(deviceId) {
    state.lastSeen.set(deviceId, Date.now());
}

/**
 * Set status asset di asset_states.
 * @param {string} assetId
 * @param {string} status - 'online' | 'offline'
 */
async function setStatus(assetId, status) {
    if (!assetId) return;

    const { error } = await supabase
        .from('asset_states')
        .update({ status })
        .eq('asset_id', assetId);

    if (error) logger.error('MONITOR', 'setStatus failed', { assetId, status, error: error.message });
}

/**
 * Remove device runtime state dari memory.
 * Termasuk hapus reverse mapping assetDevices.
 * Set status asset ke 'offline' sebelum cleanup.
 */
async function cleanupDevice(deviceId) {
    // Set status offline dulu sebelum hapus state
    try {
        const cached = state.deviceToAsset.get(deviceId);
        const assetId = cached?.assetId ?? null;
        if (assetId) {
            await setStatus(assetId, 'offline');
            logger.info('MONITOR', 'Device disconnected → OFFLINE', { deviceId, assetId });
        }
    } catch (err) {
        logger.error('MONITOR', 'cleanupDevice setStatus failed', { deviceId, error: err.message });
    }

    state.lastSeen.delete(deviceId);
    state.deviceState.delete(deviceId);
    state.deviceCacheExpiry.delete(deviceId);
    state.deviceToAsset.delete(deviceId);

    // hapus reverse mapping
    for (const [assetId, dId] of state.assetDevices.entries()) {
        if (dId === deviceId) {
            state.assetDevices.delete(assetId);
            break;
        }
    }
}

module.exports = {
    ensureDevice,
    markSeen,
    setStatus,
    cleanupDevice,
};