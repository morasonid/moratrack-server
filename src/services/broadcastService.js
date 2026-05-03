'use strict';

const state = require('../state');

function broadcastAsset(assetId, payload) {
    const clients = state.wsClients.get(assetId);

    if (!clients) return;

    const message = JSON.stringify(payload);

    for (const ws of clients) {

        if (ws.readyState === ws.OPEN) {
            ws.send(message);
        }

    }
}

module.exports = {
    broadcastAsset
};