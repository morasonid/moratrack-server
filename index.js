'use strict';

require('dotenv').config();

const http = require('http');

const logger                  = require('./src/logger');
const { createTcpServer }     = require('./src/transport/tcp');
const { attachWebSocket }     = require('./src/transport/websocket');
const { startAntiFlap }       = require('./src/transport/antiflap');
const { cleanupStaleDevices } = require('./src/transport/cleanupstale');
const { router }              = require('./src/api/routes');
const parsers                 = require('./src/parsers');

// ── Port config ────────────────────────────────────────────────────────────
const HTTP_PORT      = Number(process.env.PORT)                  || 8080;
const PORT_CONCOX    = Number(process.env.TCP_PORT_CONCOX)       || 5023;
const PORT_ANDROID   = Number(process.env.TCP_PORT_ANDROID)      || 5050;
const PORT_TELTONIKA = Number(process.env.TCP_PORT_TELTONIKA)    || 5027;
const PORT_SINOTRACK = Number(process.env.TCP_PORT_SINOTRACK)    || 5013;

// ── Bootstrap ──────────────────────────────────────────────────────────────
(async () => {

    // TCP servers
    createTcpServer(PORT_CONCOX,    parsers.concox);
    createTcpServer(PORT_ANDROID,   parsers.android);
    createTcpServer(PORT_TELTONIKA, parsers.teltonika);
    createTcpServer(PORT_SINOTRACK, parsers.sinotrack);

    // HTTP + WebSocket server
    const httpServer = http.createServer(router);
    attachWebSocket(httpServer);
    httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
        logger.info('BOOT', 'HTTP + WebSocket server listening', { port: HTTP_PORT });
    });

    // Anti-flapping (satu-satunya offline monitor)
    startAntiFlap();

    // Cleanup stale devices
    cleanupStaleDevices();

    logger.info('BOOT', 'Moratrack GPS Server started', {
        http     : HTTP_PORT,
        concox   : PORT_CONCOX,
        android  : PORT_ANDROID,
        teltonika: PORT_TELTONIKA,
        sinotrack: PORT_SINOTRACK,
    });

})();