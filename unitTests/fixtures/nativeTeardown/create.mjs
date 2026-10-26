import assert from 'node:assert';
import { databases, closeDatabase, resetDatabases } from '#src/resources/databases';
import { createRequire } from 'node:module';
import { writeSettled } from './writeSettled.mts';

const require = createRequire(import.meta.url);
assert.strictEqual(require.cache[require.resolve('#src/resources/databases')], undefined);
assert.strictEqual(require('#src/globals').databases, databases);
await writeSettled('nativeTeardownExisting', 'existing', { value: 'preserved' });
await closeDatabase('nativeTeardownExisting');
const originalGlobalDatabases = globalThis.databases;
delete globalThis.databases;

describe('an ESM-only database owner', () => {
	before(() => {
		assert.strictEqual(require.cache[require.resolve('#src/resources/databases')].exports.databases, databases);
		assert(!Object.hasOwn(databases, 'nativeTeardownExisting'));
		globalThis.databases = originalGlobalDatabases;
	});
	after(() => {
		globalThis.databases = originalGlobalDatabases;
	});
	it('writes to its own database', async () => {
		resetDatabases();
		assert(Object.hasOwn(databases, 'nativeTeardownExisting'));
		const Own = await writeSettled('nativeTeardownOwned', 'row', {});
		assert(await Own.get('row'));
	});
});
