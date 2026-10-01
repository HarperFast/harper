'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { waitFor } = require('../../waitFor.js');
const {
	addProcessGroup,
	removeProcessGroup,
	terminateProcessGroupsForThread,
} = require('#src/server/threads/manageThreads');

describe('process group registration identity', () => {
	it('does not let an old unregister erase a newer same-owner PID generation', async () => {
		const ownerThreadId = 91001;
		const spawnStartedAt = Date.now();
		const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
			detached: true,
			stdio: 'ignore',
		});
		await once(child, 'spawn');
		const spawnedAt = Date.now();
		const childExit = once(child, 'exit');

		try {
			// Both registrations name the same real child, so both need its real creation-time
			// bracket — a literal placeholder (e.g. a 1970 epoch value) is fine on POSIX, which never
			// consults it, but on Windows confirmWindowsProcessTreeGone would reject the live child as
			// created too late relative to that bracket and conclude the tree is already gone without
			// ever killing it. Only the generation number needs to differ, to exercise the fencing.
			addProcessGroup(ownerThreadId, child.pid, spawnedAt, spawnStartedAt, 1);
			addProcessGroup(ownerThreadId, child.pid, spawnedAt, spawnStartedAt, 2);
			removeProcessGroup(ownerThreadId, child.pid, 1);

			await terminateProcessGroupsForThread(ownerThreadId);
			await waitFor(() => child.exitCode !== null || child.signalCode !== null, {
				message: 'the dead-owner sweep did not terminate the newer registration',
			});
		} finally {
			removeProcessGroup(ownerThreadId, child.pid, 2);
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
			await childExit;
		}

		assert.ok(child.exitCode !== null || child.signalCode !== null);
	});
});
