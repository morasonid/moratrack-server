'use strict';

const logger = require('../logger');
const state  = require('../state');

const COMMAND_TIMEOUT_MS = 15000;

/**
 * Kirim command ke asset.
 * Resolve asset_id → device identifier aktif → TCP socket.
 *
 * Asset-centric: caller cukup tahu asset_id, tidak perlu tahu device mana yang aktif.
 */
function sendCommand(assetId, rawCommand) {
    // resolve asset → device identifier aktif
    const deviceId = state.assetDevices.get(assetId);

    if (!deviceId) {
        logger.warn('COMMAND', 'No active device for asset', { assetId });
        return Promise.resolve(false);
    }

    const entry = state.deviceSockets.get(deviceId);

    if (!entry || !entry.socket.writable) {
        logger.warn('COMMAND', 'Device not connected', { assetId, deviceId });
        return Promise.resolve(false);
    }

    return new Promise(resolve => {
        const timeout = setTimeout(() => {
            if (state.pendingCommands.has(deviceId)) {
                state.pendingCommands.delete(deviceId);
                logger.warn('COMMAND', 'ACK timeout', { assetId, deviceId });
                resolve(false);
            }
        }, COMMAND_TIMEOUT_MS);

        try {
            entry.sendCommand(rawCommand, resolve, timeout);
        } catch (e) {
            clearTimeout(timeout);
            state.pendingCommands.delete(deviceId);
            logger.error('COMMAND', 'Send failed', { assetId, deviceId, error: e.message });
            resolve(false);
        }
    });
}

/**
 * Dipanggil oleh parser saat ACK diterima dari device.
 */
function resolveCommand(deviceId, matched = true) {
    const pending = state.pendingCommands.get(deviceId);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    state.pendingCommands.delete(deviceId);
    pending.resolve(matched);
    return true;
}

module.exports = { sendCommand, resolveCommand };