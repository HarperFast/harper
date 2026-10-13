import assert from 'node:assert';
import { table, databases, closeDatabase } from '#src/resources/databases';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
assert.strictEqual(require.cache[require.resolve('#src/resources/databases')], undefined);
assert.strictEqual(require('#src/globals').databases, databases);
const originalGlobalDatabases = globalThis.databases;
delete globalThis.databases;

const Existing = table({
	database: 'nativeTeardownExisting',
	table: 'Record',
	attributes: [{ name: 'id', isPrimaryKey: true }],
});
await Existing.put('existing', { value: 'preserved' });
await closeDatabase('nativeTeardownExisting');

describe('an ESM-only database owner', () => {
	before(() => {
		assert.strictEqual(require.cache[require.resolve('#src/resources/databases')].exports.databases, databases);
	});
	after(() => {
		globalThis.databases = originalGlobalDatabases;
	});
	it('writes to its own database', async () => {
		const Own = table({
			database: 'nativeTeardownOwned',
			table: 'Record',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		await Own.put('row', {});
		assert(await Own.get('row'));
	});
});
