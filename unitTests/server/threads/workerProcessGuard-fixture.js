'use strict';

// Fixture script executed inside a Worker thread by workerProcessGuard.test.js.
// Loads the guard, then exercises process.exit() / unhandled rejections on
// command from the parent.

require('#src/server/threads/workerProcessGuard');

const { parentPort } = require('node:worker_threads');

parentPort.on('message', (msg) => {
	if (msg === 'try-exit') {
		const exitBeforeCall = process.exit;
		const realExit = process._realExit;
		// This should be intercepted; execution must continue past this line.
		process.exit(42);
		parentPort.postMessage({
			type: 'survived-exit',
			realExitIsFunction: typeof realExit === 'function',
			exitWasOverridden: exitBeforeCall !== realExit,
		});
	} else if (msg === 'try-exit-from-rejection') {
		// Simulate a framework that registers its own unhandledRejection handler
		// and explicitly calls process.exit() from it (Next.js production mode).
		process.on('unhandledRejection', () => {
			process.exit(1);
		});
		Promise.reject(new Error('fixture: simulated framework rejection'));
		setImmediate(() => {
			parentPort.postMessage({ type: 'survived-framework-exit' });
		});
	} else if (msg === 'trigger-unhandled-rejection') {
		Promise.reject(new Error('fixture: unhandled rejection probe'));
		setImmediate(() => {
			parentPort.postMessage({ type: 'survived-rejection' });
		});
	} else if (msg === 'shutdown') {
		// Use the real exit to terminate the fixture worker so the test process
		// can move on. _realExit must remain a working exit primitive.
		process._realExit(0);
	}
});

parentPort.postMessage({ type: 'ready' });
