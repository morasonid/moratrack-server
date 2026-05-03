'use strict';

/**
 * Registry parser protokol.
 *
 * Setiap parser wajib mengekspor:
 *   name                                      → string
 *   detect(buffer)                            → boolean
 *   processBuffer(buffer, socket, context)    → Promise<Buffer> (sisa buffer)
 *
 * Masing-masing parser di-bind ke port TCP-nya sendiri di index.js.
 * Tidak ada auto-detect — satu port = satu parser.
 */

const concox    = { name: 'concox',    ...require('./concox')    };
const android   = { name: 'android',   ...require('./android')   };
const teltonika = { name: 'teltonika', ...require('./teltonika') };
const sinotrack = { name: 'sinotrack', ...require('./sinotrack') };

module.exports = { concox, android, teltonika, sinotrack };