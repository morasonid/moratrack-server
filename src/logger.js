'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_LEVEL   = process.env.LOG_LEVEL   || 'info';
const LOG_TO_FILE = process.env.LOG_TO_FILE !== 'false';
const LOG_DIR     = path.resolve(process.env.LOG_DIR || 'logs');
const LEVELS      = { error: 0, warn: 1, info: 2, debug: 3 };

if (LOG_TO_FILE && !fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getLogFilePath() {
    const date = new Date().toISOString().slice(0, 10);
    return path.join(LOG_DIR, `${date}.log`);
}

function writeToFile(line) {
    fs.appendFile(getLogFilePath(), line + '\n', err => {
        if (err) process.stderr.write(`[LOGGER] File write error: ${err.message}\n`);
    });
}

function log(level, tag, message, data) {
    if (LEVELS[level] > LEVELS[LOG_LEVEL]) return;
    const entry = { ts: new Date().toISOString(), level, tag, message };
    if (data !== undefined) entry.data = data;
    const line = JSON.stringify(entry);
    console.log(line);
    if (LOG_TO_FILE) writeToFile(line);
}

const logger = {
    error : (tag, msg, data) => log('error', tag, msg, data),
    warn  : (tag, msg, data) => log('warn',  tag, msg, data),
    info  : (tag, msg, data) => log('info',  tag, msg, data),
    debug : (tag, msg, data) => log('debug', tag, msg, data),
};

module.exports = logger;