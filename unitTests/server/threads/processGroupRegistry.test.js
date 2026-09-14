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
		const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
			detached: true,
			stdio: 'ignore',
		});
		await once(child, 'spawn');
		const childExit = once(child, 'exit');

		try {
			addProcessGroup(ownerThreadId, child.pid, 100, 90, 1);
			addProcessGroup(ownerThreadId, child.pid, 500, 490, 2);
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

		assert.notStrictEqual(child.signalCode, null);
	});
});
