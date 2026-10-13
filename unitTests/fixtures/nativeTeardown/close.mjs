import assert from 'node:assert';
import { closeLoadedDatabases, databases } from '#src/resources/databases';
import * as env from '#src/utility/environment/environmentManager';
import { CONFIG_PARAMS } from '#src/utility/hdbTerms';
import { writeSettled } from './writeSettled.mts';

describe('an ESM-only owner that closes its database', () => {
	it('leaves closed residue with an empty registry', async () => {
		await closeLoadedDatabases();
		env.setProperty(CONFIG_PARAMS.DATABASES, {});
		await writeSettled('nativeTeardownClosed', 'row', {});
		await closeLoadedDatabases();
		assert.deepStrictEqual(Object.keys(databases), []);
	});
});
