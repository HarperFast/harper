import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDatabases, resetDatabases, resolveDatabaseStorageRoot } from '#src/resources/databases';

describe('the next ESM file', () => {
	before(() => resetDatabases());
	it('does not inherit the preceding file database', async () => {
		assert(!Object.hasOwn(getDatabases(), 'nativeTeardownOwned'));
		const root = resolveDatabaseStorageRoot('nativeTeardownOwned');
		assert(!existsSync(join(root, 'nativeTeardownOwned')));
		assert(!existsSync(join(root, 'nativeTeardownOwned.mdb')));
		if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') {
			assert(!Object.hasOwn(getDatabases(), 'nativeTeardownClosed'));
			assert(!existsSync(join(root, 'nativeTeardownClosed')));
		} else assert(Object.hasOwn(getDatabases(), 'nativeTeardownClosed'));
		assert(Object.hasOwn(getDatabases(), 'nativeTeardownExisting'), 'preexisting directory was dropped');
		assert.strictEqual((await getDatabases().nativeTeardownExisting.Record.get('existing')).value, 'preserved');
	});
});
