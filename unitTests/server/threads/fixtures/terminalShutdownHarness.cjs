'use strict';

const { once } = require('node:events');
const { waitFor } = require('../../../waitFor.js');
process.env.HARPER_SAFE_MODE = 'true';
require('#src/utility/environment/environmentManager').initTestEnvironment();
const manageThreads = require('#js/server/threads/manageThreads');
const { restartWorkers, shutdownWorkersNow, startWorker, workers } = manageThreads;

async function terminalShutdown() {
	let starts = 0;
	const worker = startWorker(require.resolve('./terminalShutdownWorker.cjs'), {
		name: 'http',
		onStarted() {
			starts++;
		},
	});
	await once(worker, 'message');
	const restart = restartWorkers('http');
	await waitFor(() => workers.length === 2, { timeout: 5000, message: 'replacement worker was not created' });
	await shutdownWorkersNow();
	await restart;

	let errorCode;
	try {
		startWorker(require.resolve('./terminalShutdownWorker.cjs'), {
			autoRestart: false,
			name: 'forbidden-terminal-shutdown-test',
		});
	} catch (error) {
		errorCode = error.code;
	}

	const workersAfterShutdown = workers.length;
	for (const remainingWorker of workers.slice()) {
		remainingWorker.wasShutdown = true;
		await remainingWorker.terminate();
	}
	process.stdout.write(`${JSON.stringify({ errorCode, starts, workersAfterShutdown })}\n`);
}

async function scopedShutdown() {
	const worker = startWorker(require.resolve('./terminalShutdownWorker.cjs'), {
		autoRestart: false,
		name: 'terminal-shutdown-test',
	});
	await once(worker, 'message');
	await shutdownWorkersNow('terminal-shutdown-test');
	const allowedWorker = startWorker(require.resolve('./terminalShutdownWorker.cjs'), {
		autoRestart: false,
		name: 'allowed-after-scoped-shutdown',
	});
	await once(allowedWorker, 'message');
	allowedWorker.wasShutdown = true;
	await allowedWorker.terminate();
	process.stdout.write(`${JSON.stringify({ workerCreationAllowed: true })}\n`);
}

(process.argv[2] === 'scoped' ? scopedShutdown() : terminalShutdown()).catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
