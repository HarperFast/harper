'use strict';

const { parentPort } = require('node:worker_threads');

// Deliberately never loads Table.ts or server/threads/itc.js.
parentPort?.on('message', () => {});
