'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const FIXTURE = path.join(__dirname, 'fixtures', 'pkijsFirstUse.cjs');

function firstUse(consumer) {
	const result = spawnSync(process.execPath, [FIXTURE, consumer], { encoding: 'utf8', timeout: 60000 });
	assert.strictEqual(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

describe('PKI.js first use', function () {
	this.timeout(90000);

	for (const consumer of ['ocsp', 'certificate parsing']) {
		it(`is loaded on first use and patched for Ed25519 when ${consumer} comes first`, function () {
			const report = firstUse(consumer);
			assert.strictEqual(report.loadedWithModules, false);
			assert.strictEqual(report.loadedAfterFirstUse, true);
			assert.strictEqual(report.ed25519Hash, 'UNUSED-EDDSA-BUILTIN-HASH');
		});
	}
});
