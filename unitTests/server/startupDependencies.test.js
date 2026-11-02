'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

// Each of these costs every thread heap (lmdb also a 16 MB native buffer) and is only needed by a
// feature a default server may never use, so the startup modules must not load them.
const DEFERRED_PACKAGES = [
	'lmdb',
	'pkijs',
	'asn1js',
	'easy-ocsp',
	'node-forge',
	'systeminformation',
	'moment',
	'lodash (full build)',
];

describe('startup dependencies', function () {
	this.timeout(120000);

	it('do not include packages that are loaded on first use', function () {
		const result = spawnSync(process.execPath, [path.join(__dirname, 'startupDependencies-fixture.cjs')], {
			encoding: 'utf8',
			timeout: 110000,
		});
		assert.strictEqual(result.status, 0, result.stderr);
		const loaded = JSON.parse(result.stdout.slice(result.stdout.lastIndexOf('[')));
		assert.deepStrictEqual(
			DEFERRED_PACKAGES.filter((name) => loaded.includes(name)),
			[]
		);
	});
});
