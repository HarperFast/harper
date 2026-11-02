'use strict';

const assert = require('node:assert');
const fs = require('fs-extra');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEST_ROOT = path.join(__dirname, 'fileIdentityLogs');

describe('Log generation identity on a volume with file IDs past 2^53', () => {
	after(() => {
		try {
			fs.removeSync(TEST_ROOT);
		} catch {}
	});

	// A child process: the emulated file IDs have to be in place before anything loads fs.
	it('tells neighbouring files apart in the stale sweep, the write-path guard and the interval clock', () => {
		fs.mkdirpSync(TEST_ROOT);
		const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures', 'highFileIdLogging.cjs'), TEST_ROOT], {
			encoding: 'utf8',
			timeout: 60000,
		});
		assert.strictEqual(child.status, 0, `exit ${child.status} ${child.signal ?? ''}\n${child.stdout}\n${child.stderr}`);
	}).timeout(70000);
});
