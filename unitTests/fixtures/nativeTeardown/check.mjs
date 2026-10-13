import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDatabases, resolveDatabaseStorageRoot } from '#src/resources/databases';

describe('the next ESM file', () => {
	it('does not inherit the preceding file database', () => {
		assert(!Object.hasOwn(getDatabases(), 'nativeTeardownOwned'));
		const root = resolveDatabaseStorageRoot('nativeTeardownOwned');
		assert(!existsSync(join(root, 'nativeTeardownOwned')));
		assert(!existsSync(join(root, 'nativeTeardownOwned.mdb')));
	});
});
