'use strict';

const { parentPort } = require('node:worker_threads');

parentPort.postMessage({ stackTraceLimit: Error.stackTraceLimit });
