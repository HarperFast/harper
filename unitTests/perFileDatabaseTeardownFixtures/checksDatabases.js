'use strict';

// Fixture for perFileDatabaseTeardown.test.js. Assert on booleans and strings only: an
// AssertionError inspects its operands, and a database object inspects into gigabytes.

const assert = require('node:assert');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { registryStatus } = require('@harperfast/rocksdb-js');
const { databases, resetDatabases, resolveDatabaseStorageRoot } = require('#src/resources/databases');

const isRocks = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';

function rootOf(name) {
	return path.join(resolveDatabaseStorageRoot(name), isRocks ? name : `${name}.mdb`);
}

function assertGone(name) {
	assert.strictEqual(name in databases, false, `${name} is still registered`);
	assert.strictEqual(existsSync(rootOf(name)), false, rootOf(name));
	assert.strictEqual(
		registryStatus().some((entry) => entry.refCount > 0 && path.resolve(entry.path) === rootOf(name)),
		false,
		`${name} is still open natively`
	);
}

describe('the file that runs next', () => {
	before(() => {
		// a storage scan reopens any database directory still on disk
		resetDatabases();
	});

	it('no longer has the database the previous file created', () => {
		assertGone('teardownProbeOwn');
	});

	it('no longer has the database the previous file created with no tables', () => {
		assertGone('teardownProbeTableless');
	});

	(isRocks ? it : it.skip)('no longer has the database the previous file closed but left on disk', () => {
		assertGone('teardownProbeClosed');
	});

	it('keeps a database that existed before the previous file ran', () => {
		assert.strictEqual(Boolean(databases.teardownProbeLoadTime?.LoadedFirst), true);
	});

	it('keeps a configured database the previous file wrote to, and the alias the previous file configured onto it', async () => {
		assert.strictEqual((await databases.test.TeardownProbeShared.get('shared'))?.name, 'shared');
		assert.strictEqual(Boolean(databases.teardownProbeAlias?.TeardownProbeShared), true);
	});
});
