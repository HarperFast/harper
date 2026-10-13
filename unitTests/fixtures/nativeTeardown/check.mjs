import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDatabases, resolveDatabaseStorageRoot } from '#src/resources/databases';

describe('the next ESM file', () => {
	it('does not inherit the preceding file database', async () => {
		assert(!Object.hasOwn(getDatabases(), 'nativeTeardownOwned'));
		const root = resolveDatabaseStorageRoot('nativeTeardownOwned');
		assert(!existsSync(join(root, 'nativeTeardownOwned')));
		assert(!existsSync(join(root, 'nativeTeardownOwned.mdb')));
		assert(!Object.hasOwn(getDatabases(), 'nativeTeardownClosed'));
		if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') assert(!existsSync(join(root, 'nativeTeardownClosed')));
		assert.strictEqual((await getDatabases().nativeTeardownExisting.Record.get('existing')).value, 'preserved');
	});
});
