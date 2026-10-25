const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

describe('Residency map activation across storage roots', function () {
	this.timeout(30000);
	it('refuses reassignment when a later native catalog has an active policy', () => {
		const result = spawnSync(process.execPath, [join(__dirname, 'residencyMapCatalogs-child.js')], {
			encoding: 'utf8',
			timeout: 25000,
		});
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /multi-root map fence passed/);
	});
});
