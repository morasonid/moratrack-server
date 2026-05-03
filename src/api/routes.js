'use strict';

const logger          = require('../logger');
const { sendCommand } = require('../services/commandService');

/**
 * POST /api/command
 * Body: { asset_id: string, params: { raw: string } }
 *
 * Asset-centric: caller pakai asset_id, server resolve ke device aktif.
 */
async function handleCommand(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });

    req.on('end', async () => {
        try {
            const { asset_id, params } = JSON.parse(body);

            if (!asset_id || !params?.raw) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    success : false,
                    message : 'asset_id and params.raw are required',
                }));
            }

            logger.info('API_CMD', 'Incoming command', { asset_id, cmd: params.raw });

            const success = await sendCommand(asset_id, params.raw);

            res.writeHead(success ? 200 : 408, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success,
                message: success
                    ? 'GPS responded successfully'
                    : 'GPS failed to respond (Timeout or Offline)',
            }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: e.message }));
        }
    });
}

function router(req, res) {
    if (req.method === 'POST' && req.url === '/api/command') {
        return handleCommand(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not found' }));
}

module.exports = { router };