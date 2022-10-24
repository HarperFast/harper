'use strict';

const { Worker, MessageChannel } = require('worker_threads');
const { PACKAGE_ROOT } = require('../utility/hdbTerms');
const { join } = require('path');

const workers = [];

module.exports = {
	startWorker,
};

function startWorker(path) {
	const worker = new Worker(join(PACKAGE_ROOT, path));
	worker.on('error', (error) => {
		console.error('error', error);
	});
	worker.on('exit', (code, message) => {
		if (code !== 0)
			console.error(`Worker stopped with exit code ${code}` + message);
	});
	for (let prevWorker of workers) {
		let { port1, port2 } = new MessageChannel();
		prevWorker.postMessage({
			type: 'add-port',
			port: port1,
		}, [port1]);
		worker.postMessage({
			type: 'add-port',
			port: port2,
		}, [port2]);
	}
	return worker;
}