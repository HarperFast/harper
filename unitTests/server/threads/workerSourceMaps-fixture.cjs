'use strict';

const { parentPort } = require('node:worker_threads');

parentPort.postMessage({ sourceMapsEnabled: process.sourceMapsEnabled, execArgv: process.execArgv });
