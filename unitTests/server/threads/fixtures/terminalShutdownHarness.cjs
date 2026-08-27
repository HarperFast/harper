'use strict';

const { mkdtempSync, rmSync, writeFileSync, writeSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { once } = require('node:events');
const Module = require('node:module');
const { waitFor } = require('../../../waitFor.js');
const { HARPER_CONFIG_FILE } = require('#src/utility/hdbTerms');
process.env.HARPER_SAFE_MODE = 'true';

// Keep configuration self-contained if the real root-component loader runs.
const rootPath = mkdtempSync(join(tmpdir(), 'harper-terminal-shutdown-'));
writeFileSync(join(rootPath, HARPER_CONFIG_FILE), `rootPath: ${JSON.stringify(rootPath)}\n`);
process.env.ROOTPATH = rootPath;
process.on('exit', () => {
	// Throwing here would exit the harness non-zero with an irrelevant stack, and the caller reads
	// any non-zero exit as the mode failing. Windows refuses to remove a tree while anything still
	// holds a handle under it, and the logger closes its fd on a timer.
	try {
		rmSync(rootPath, { force: true, recursive: true });
	} catch {}
});

require('#src/utility/environment/environmentManager').initTestEnvironment();
stubLoadRootComponents();
const manageThreads = require('#js/server/threads/manageThreads');
const { beginProcessShutdown, restartWorkers, shutdownWorkersNow, startWorker, workers } = manageThreads;

// Bounds a hang rather than asserting how fast a restart is: these waits run in a freshly spawned
// process on a CI runner that may be doing anything else at the time.
const WAIT_TIMEOUT_MS = 20_000;

/**
 * The restart modes race a wait against a restartWorkers() call they do not await until afterwards.
 * A rejection from it would otherwise sit unhandled while the wait spins to its deadline and then
 * reports the condition it was watching — "replacement worker was not created" instead of the
 * ENOENT that actually stopped the restart.
 */
function rejectionOf(promise) {
	return new Promise((resolve, reject) => promise.catch(reject));
}

let loadRootComponentsCalls = 0;

// The root-component loader's top level costs ~5,400 module loads (~34s on Windows).
function stubLoadRootComponents() {
	const manageThreadsDir = dirname(require.resolve('#js/server/threads/manageThreads'));
	const path = require.resolve('../loadRootComponents.js', { paths: [manageThreadsDir] });
	const stub = new Module(path, null);
	stub.filename = path;
	stub.loaded = true;
	stub.exports.loadRootComponents = async () => {
		loadRootComponentsCalls++;
	};
	require.cache[path] = stub;
}

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
	await Promise.race([
		rejectionOf(restart),
		waitFor(() => workers.length === 2, { timeout: WAIT_TIMEOUT_MS, message: 'replacement worker was not created' }),
	]);
	await shutdownWorkersNow();
	await restart;
	if (loadRootComponentsCalls === 0)
		throw new Error('restartWorkers() never reached the stubbed loadRootComponents load');

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
	await waitFor(() => workers.length === 0, {
		timeout: WAIT_TIMEOUT_MS,
		message: 'unexpected worker exit did not settle',
	});
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
	await Promise.race([
		rejectionOf(restart),
		waitFor(() => worker.wasShutdown, { timeout: WAIT_TIMEOUT_MS, message: 'worker restart did not begin' }),
	]);
	await shutdownWorkersNow();
	await restart;
	if (loadRootComponentsCalls === 0)
		throw new Error('restartWorkers() never reached the stubbed loadRootComponents load');
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
	if (loadRootComponentsCalls !== 0)
		throw new Error("a late restart reloaded root components — the shutdown latch let it past #1585's ordering");
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
	// A worker the failed mode left running holds the event loop open forever, so an exit code
	// alone never applies and the caller reports a mocha timeout carrying none of this. stdout
	// because the caller captures it into the assertion message; writeSync because process.exit()
	// drops a queued write to a pipe.
	writeSync(1, `${error?.stack ?? error}\n`);
	process.exit(1);
});
