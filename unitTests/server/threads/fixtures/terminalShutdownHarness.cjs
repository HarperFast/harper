'use strict';

const { once } = require('node:events');
const { waitFor } = require('../../../waitFor.js');
process.env.HARPER_SAFE_MODE = 'true';
require('#src/utility/environment/environmentManager').initTestEnvironment();
const manageThreads = require('#js/server/threads/manageThreads');
const { beginProcessShutdown, restartWorkers, shutdownWorkersNow, startWorker, workers } = manageThreads;

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

async function unexpectedExit() {
	let starts = 0;
	const worker = startWorker(require.resolve('./terminalShutdownWorker.cjs'), {
		name: 'unexpected-exit-test',
		onStarted() {
			starts++;
		},
	});
	await once(worker, 'message');
	beginProcessShutdown();
	worker.postMessage('exit');
	await waitFor(() => workers.length === 0, { timeout: 5000, message: 'unexpected worker exit did not settle' });
	process.stdout.write(`${JSON.stringify({ starts, workersAfterExit: workers.length })}\n`);
}

async function nonOverlappingRestart() {
	let starts = 0;
	const worker = startWorker(require.resolve('./terminalShutdownWorker.cjs'), {
		name: 'non-overlapping-test',
		onStarted() {
			starts++;
		},
	});
	await once(worker, 'message');
	const restart = restartWorkers('non-overlapping-test');
	await waitFor(() => worker.wasShutdown, { timeout: 5000, message: 'worker restart did not begin' });
	await shutdownWorkersNow();
	await restart;
	process.stdout.write(`${JSON.stringify({ starts, workersAfterShutdown: workers.length })}\n`);
}

// The production ordering from #1585: bin/restart.ts latches first, then tears down across
// closeServers()/cleanupChildrenProcesses(). A component-watcher reload or queued requestRestart
// landing in that window must not reload root components, bump the restart number, or respawn.
async function lateRestart() {
	let starts = 0;
	const worker = startWorker(require.resolve('./terminalShutdownWorker.cjs'), {
		name: 'http',
		onStarted() {
			starts++;
		},
	});
	await once(worker, 'message');
	beginProcessShutdown();
	const restartNumberBefore = manageThreads.restartNumber;
	await restartWorkers('http');
	const restartNumberChanged = manageThreads.restartNumber !== restartNumberBefore;
	const startsAfterLateRestart = starts;
	const workersAfterLateRestart = workers.length;
	await shutdownWorkersNow();
	process.stdout.write(
		`${JSON.stringify({
			restartNumberChanged,
			starts,
			startsAfterLateRestart,
			workersAfterLateRestart,
			workersAfterShutdown: workers.length,
		})}\n`
	);
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

const mode = process.argv[2];
const modes = {
	'scoped': scopedShutdown,
	'unexpected': unexpectedExit,
	'non-overlapping': nonOverlappingRestart,
	'late-restart': lateRestart,
};
const run = modes[mode] ?? terminalShutdown;
run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
