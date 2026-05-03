'use strict';

const { WebSocketServer } = require('ws');
const { createPublicKey } = require('crypto');
const jwt = require('jsonwebtoken');
const url = require('url');

const logger   = require('../logger');
const state    = require('../state');
const supabase = require('../supabase');

const PING_INTERVAL_MS = 30000;

// ── JWKS cache ─────────────────────────────────────────────────────────────
let _cachedKeys = null;
let _cacheTime  = 0;

async function getJwks() {
    const now = Date.now();
    if (_cachedKeys && now - _cacheTime < 86400000) return _cachedKeys;

    const res  = await fetch(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`, {
        headers: {
            'apikey': process.env.SUPABASE_PUBLISHABLE_KEY,
        }
    });

    const json = await res.json();

    if (!json.keys) {
        throw new Error(`JWKS fetch failed: ${json.message ?? 'unknown error'}`);
    }

    _cachedKeys = json.keys;
    _cacheTime  = now;

    logger.info('WS', 'JWKS refreshed', { keyCount: _cachedKeys.length });

    return _cachedKeys;
}

async function verifyToken(token) {
    const decoded = jwt.decode(token, { complete: true });

    if (!decoded?.header?.kid) {
        throw new Error('missing kid in JWT header');
    }

    const keys = await getJwks();
    const jwk  = keys.find(k => k.kid === decoded.header.kid);

    if (!jwk) {
        throw new Error(`key not found for kid: ${decoded.header.kid}`);
    }

    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });

    return jwt.verify(token, publicKey, {
        algorithms: ['ES256'],
    });
}

// ── WebSocket server ───────────────────────────────────────────────────────

function attachWebSocket(httpServer) {
    const wss = new WebSocketServer({ noServer: true });

    // ─────────────────────────────────────────
    // Zombie connection cleanup
    // ─────────────────────────────────────────

    const pingInterval = setInterval(() => {

        wss.clients.forEach(ws => {

            if (!ws.isAlive) {
                logger.warn('WS', 'Zombie client terminated', {
                    assetId: ws.assetId
                });
                return ws.terminate();
            }

            ws.isAlive = false;
            ws.ping();
        });

    }, PING_INTERVAL_MS);

    pingInterval.unref();

    wss.on('close', () => clearInterval(pingInterval));

    // ─────────────────────────────────────────
    // HTTP → WebSocket upgrade
    // ─────────────────────────────────────────

    httpServer.on('upgrade', async (req, socket, head) => {
        const { pathname, query } = url.parse(req.url, true);

        const token = query.token;
        const parts = pathname.split('/');

        // expected: /ws/asset/<assetId>
        const resource = parts[2];
        const assetId  = parts[3];

        if (!token || resource !== 'asset' || !assetId) {
            logger.warn('WS', 'Upgrade rejected — invalid route', { pathname });
            return socket.destroy();
        }

        try {
            const decoded = await verifyToken(token);
            const userId  = decoded.sub;

            // ─────────────────────────────────────
            // Check user access to asset
            // ─────────────────────────────────────

            const { data } = await supabase
                .from('user_assets_view')
                .select('asset_id')
                .eq('asset_id', assetId)
                .eq('user_id', userId)
                .maybeSingle();

            if (!data) {
                logger.warn('WS', 'Unauthorized asset access', { assetId, userId });
                return socket.destroy();
            }

            // ─────────────────────────────────────
            // Accept connection
            // ─────────────────────────────────────

            wss.handleUpgrade(req, socket, head, ws => {
                const clientIp =
                    req.headers['x-forwarded-for'] ||
                    req.socket.remoteAddress;

                ws.assetId = assetId;
                ws.userId  = userId;
                ws.isAlive = true;

                ws.on('pong', () => { ws.isAlive = true; });

                // Register client
                if (!state.wsClients.has(assetId)) {
                    state.wsClients.set(assetId, new Set());
                }

                const clients = state.wsClients.get(assetId);
                clients.add(ws);

                logger.info('WS', 'Client connected', {
                    assetId,
                    userId,
                    ip          : clientIp,
                    totalClients: clients.size
                });

                // Disconnect
                ws.on('close', () => {
                    clients.delete(ws);

                    if (clients.size === 0) {
                        state.wsClients.delete(assetId);
                    }

                    logger.info('WS', 'Client disconnected', {
                        assetId,
                        remaining: clients.size
                    });
                });

                ws.on('error', err => {
                    logger.error('WS', 'Socket error', {
                        assetId,
                        error: err.message
                    });
                });
            });

        } catch (err) {
            logger.warn('WS', 'Invalid JWT', { error: err.message });
            socket.destroy();
        }
    });

    return wss;
}

module.exports = { attachWebSocket };