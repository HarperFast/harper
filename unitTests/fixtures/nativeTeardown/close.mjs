import assert from 'node:assert';
import { table, closeDatabase, closeLoadedDatabases, databases } from '#src/resources/databases';
import * as env from '#src/utility/environment/environmentManager';
import { CONFIG_PARAMS } from '#src/utility/hdbTerms';

describe('an ESM-only owner that closes its database', () => {
	it('leaves closed residue with an empty registry', async () => {
		await closeLoadedDatabases();
		env.setProperty(CONFIG_PARAMS.DATABASES, {});
		const Own = table({
			database: 'nativeTeardownClosed',
			table: 'Record',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		await Own.put('row', {});
		await closeDatabase('nativeTeardownClosed');
		assert.deepStrictEqual(Object.keys(databases), []);
	});
});
