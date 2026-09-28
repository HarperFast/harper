'use strict';

const { spawn } = require('node:child_process');
const { parentPort } = require('node:worker_threads');

const { registerProcessGroup } = require('#src/server/threads/manageThreads');

// A detached child is its own process group leader, so its pid doubles as the process group id —
// the same relationship `nonInteractiveSpawn` relies on in Application.ts.
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
	detached: true,
	stdio: 'ignore',
});
registerProcessGroup(child.pid);
parentPort.postMessage({ type: 'owner-ready', processGroupId: child.pid });
