import assert from 'node:assert';
import { table } from '#src/resources/databases';

describe('an ESM-only database owner', () => {
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
