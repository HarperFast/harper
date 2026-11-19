const { parentPort } = require('node:worker_threads');
const { onStartup } = require('#src/utility/lifecycle');
const { realExit } = require('#src/server/threads/workerProcessGuard');

onStartup(async () => {
	parentPort.postMessage({ type: 'startup-ref', held: parentPort.hasRef() });
	// Model startup work whose completion does not itself keep the event loop alive.
	await new Promise((resolve) => setTimeout(resolve, 100).unref());
	parentPort.postMessage({ type: 'startup-hook-completed' });
	realExit(0);
});
