'use strict';

const { isThreadRunning, startWorker } = require('#src/server/threads/manageThreads');

function isZombie(processGroupId) {
	if (process.platform !== 'linux') return false;
	try {
		const stat = require('node:fs').readFileSync(`/proc/${processGroupId}/stat`, 'utf8');
		return stat[stat.lastIndexOf(')') + 2] === 'Z';
	} catch {
		return false;
	}
}

// A process group leader spawned by a worker thread's own event loop is never reaped once that
// thread is gone (nothing polls for its exit), so it persists as a zombie rather than fully
// disappearing. A zombie can no longer touch the filesystem, so "still alive" here means "still
// capable of running" — a live process, not merely a still-allocated pid slot.
function processGroupIsAlive(processGroupId) {
	try {
		process.kill(-processGroupId, 0);
	} catch (error) {
		return error.code === 'EPERM';
	}
	return !isZombie(processGroupId);
}

const worker = startWorker(require.resolve('./processGroupOwnerWorker.js'), {
	name: 'process-group-reclaim-test',
	autoRestart: false,
	workerIndex: 0,
	threadCount: 1,
});
worker.on('message', async (message) => {
	if (message.type !== 'owner-ready') return;
	const deadThreadId = worker.threadId;
	// Simulate a hard crash of the owning worker while it still holds its process group.
	await worker.terminate();
	const stillRunning = await isThreadRunning(deadThreadId);
	// The invariant under test: by the time isThreadRunning() reports the owner gone, the process
	// group it was tracking must already be confirmed dead — not just signaled.
	const groupAlive = processGroupIsAlive(message.processGroupId);
	process.stdout.write(`${JSON.stringify({ stillRunning, groupAlive })}\n`);
});
