const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

(process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe)(
	'Shard map activation across storage roots',
	function () {
		this.timeout(30000);
		for (const mode of ['', 'worker-configured', 'owner-assertion'])
			it(`protects map activation and assertions across native catalogs (${mode || 'aliased roots'})`, () => {
				const root = mkdtempSync(join(tmpdir(), 'residency-catalogs-'));
				try {
					const result = spawnSync(process.execPath, [join(__dirname, 'residencyMapCatalogs-child.cjs'), root, mode], {
						encoding: 'utf8',
						timeout: 25000,
					});
					assert.ifError(result.error);
					assert.equal(result.status, 0, result.stdout + result.stderr);
					assert.match(result.stdout, /multi-root map fence passed/);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			});
	}
);
