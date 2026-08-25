'use strict';

const { parentPort } = require('node:worker_threads');

parentPort.postMessage('ready');
setInterval(() => {}, 10000);
