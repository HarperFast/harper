'use strict';

const { once } = require('node:events');
const manageThreads = require('#js/server/threads/manageThreads');
const { startWorker, workers } = manageThreads;

async function main() {
	let starts = 0;
	const worker = startWorker(require.resolve('./terminalShutdownWorker.cjs'), {
		name: 'terminal-shutdown-test',
		onStarted() {
			starts++;
		},
	});
	await once(worker, 'message');
	manageThreads.beginProcessShutdown?.();
	worker.wasShutdown = false;
	await worker.terminate();
	await new Promise(setImmediate);

	let errorCode;
	let forbiddenWorker;
	try {
		forbiddenWorker = startWorker(require.resolve('./terminalShutdownWorker.cjs'), {
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
	if (forbiddenWorker && !workers.includes(forbiddenWorker)) {
		forbiddenWorker.wasShutdown = true;
		await forbiddenWorker.terminate();
	}
	process.stdout.write(`${JSON.stringify({ errorCode, starts, workersAfterShutdown })}\n`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
