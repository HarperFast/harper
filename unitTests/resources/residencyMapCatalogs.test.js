const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

describe('Residency map activation across storage roots', function () {
	this.timeout(30000);
	it('refuses reassignment when a later native catalog has an active policy', () => {
		const root = mkdtempSync(join(tmpdir(), 'residency-catalogs-'));
		try {
			const result = spawnSync(process.execPath, [join(__dirname, 'residencyMapCatalogs-child.cjs'), root], {
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
});
