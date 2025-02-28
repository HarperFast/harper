const { describe, it } = require('mocha');

const assert = require('node:assert/strict');
const { join } = require('node:path');

const packageUtils = require('../../utility/packageUtils');

// Compare the fs resolved package.json to an absolute resolution from this test file.
// These tests will fail if this test file changes location.
describe('packageUtils', () => {
	it('should export the HarperDB package.json as packageJson', () => {
		assert.equal(typeof packageUtils.packageJson, 'object');
		assert.deepEqual(packageUtils.packageJson, require('../../package.json'));
	});

	it('should export the HarperDB package root as PACKAGE_ROOT', () => {
		assert.equal(typeof packageUtils.PACKAGE_ROOT, 'string');
		assert.equal(packageUtils.PACKAGE_ROOT, join(__dirname, '../..'));
	});
});