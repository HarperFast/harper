import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { databases, resolveDatabaseStorageRoot } from '#src/resources/databases';

describe('the file after a rescan', () => {
	it('has dropped reopened residue while preserving initial contents', async () => {
		assert(!Object.hasOwn(databases, 'nativeTeardownClosed'));
		const root = resolveDatabaseStorageRoot('nativeTeardownClosed');
		assert(!existsSync(join(root, 'nativeTeardownClosed')));
		assert(!existsSync(join(root, 'nativeTeardownClosed.mdb')));
		assert.strictEqual((await databases.nativeTeardownExisting.Record.get('existing')).value, 'preserved');
	});
});
