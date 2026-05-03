'use strict';

/**
 * MoraTrack V2 — Shared In-Memory Runtime State
 *
 * Arsitektur: Asset-centric
 *
 * Device adalah transport layer — koneksi TCP, heartbeat, ACK.
 * Asset adalah business layer — command, broadcast, state.
 *
 * ── Mapping ───────────────────────────────────────────────────────────────
 *
 *   deviceToAsset : Map<identifier, { deviceUuid, assetId }>
 *     Cache hasil lookup identifier → UUID → assetId
 *
 *   assetDevices  : Map<assetId, identifier>
 *     Reverse mapping untuk command routing asset → device aktif
 *
 *   deviceCacheExpiry : Map<identifier, timestamp>
 *     TTL untuk negative cache
 *
 * ── Realtime ──────────────────────────────────────────────────────────────
 *
 *   wsClients : Map<assetId, Set<WebSocket>>
 *
 * ── Device runtime ────────────────────────────────────────────────────────
 *
 *   lastSeen    : Map<identifier, timestamp>
 *   deviceState : Map<identifier, object>  — battery, signal, acc
 *   deviceSockets : Map<identifier, { socket, type, sendCommand }>
 *
 * ── Command ───────────────────────────────────────────────────────────────
 *
 *   pendingCommands : Map<identifier, { resolve, timeout, serial? }>
 *   serialCounters  : Map<identifier, number>
 */

const wsClients = new Map();

// mapping
const deviceToAsset     = new Map();
const assetDevices      = new Map(); // Map<assetId, identifier>
const deviceCacheExpiry = new Map();

// device metadata
const deviceProtocols = new Map();

// device runtime
const lastSeen      = new Map();
const deviceState   = new Map();
const deviceSockets = new Map();

// command
const pendingCommands = new Map();
const serialCounters  = new Map();

function getNextSerial(deviceId) {
    const cur  = serialCounters.get(deviceId) || 0;
    const next = cur >= 0xFFFF ? 1 : cur + 1;
    serialCounters.set(deviceId, next);
    return next;
}

module.exports = {
    wsClients,

    deviceToAsset,
    assetDevices,
    deviceCacheExpiry,

    deviceProtocols,

    lastSeen,
    deviceState,
    deviceSockets,

    pendingCommands,
    serialCounters,

    getNextSerial,
};