'use strict';
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { rmSync } = require('node:fs');
const { join } = require('node:path');
const { ENV_DIR_PATH } = require('../../perPidRoot.js');

describe('Bun listener batch ownership', function () {
	this.timeout(60_000);
	before(function () {
		if (spawnSync('bun', ['--version']).error?.code === 'ENOENT') this.skip();
	});
	for (const mode of ['success', 'failure']) {
		it(
			mode === 'success'
				? 'shares concurrent binds and releases both socket types'
				: 'retains non-address bind rejection',
			function () {
				const result = spawnSync('bun', [join(__dirname, 'fixtures/bunListenerBatch.cjs'), mode], {
					encoding: 'utf8',
					timeout: 45_000,
				});
				if (result.pid) rmSync(join(ENV_DIR_PATH, String(result.pid)), { recursive: true, force: true });
				assert.equal(result.status, 0, result.stdout + result.stderr);
			}
		);
	}
});
