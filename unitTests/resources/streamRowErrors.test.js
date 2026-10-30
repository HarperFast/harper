require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

describe('A row that fails in a collection read is reported with its primary key', () => {
	let FailingRow;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		FailingRow = table({
			table: 'FailingRow',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'group', indexed: true },
				{ name: 'seq', indexed: true },
				{ name: 'tag', computed: true },
			],
		});
		FailingRow.setComputedAttribute('tag', (record) => {
			if (record.seq === 2) throw new Error('tag failed at seq=2');
			return 'ok-' + record.seq;
		});
		for (let seq = 1; seq <= 4; seq++) await FailingRow.put({ id: 'row-' + seq, group: 'g', seq });
	});

	async function recoverRows(query) {
		const recovered = [];
		const rows = FailingRow.search(query).mapError((error) => {
			recovered.push(error);
			return error;
		});
		const values = [];
		for await (const value of rows) values.push(value);
		return { values, recovered };
	}

	it('on a single-condition index scan, where each entry is a bare key', async function () {
		const { values, recovered } = await recoverRows({
			conditions: [{ attribute: 'group', value: 'g' }],
			select: ['id', 'tag'],
		});
		assert.strictEqual(values.length, 4);
		assert.strictEqual(recovered.length, 1);
		assert.match(recovered[0].message, /tag failed at seq=2/);
		assert.deepStrictEqual(recovered[0].partialObject, { id: 'row-2' });
	});

	it('on a multi-condition scan, where each entry carries its key', async function () {
		const { values, recovered } = await recoverRows({
			conditions: [
				{ attribute: 'group', value: 'g' },
				{ attribute: 'seq', comparator: 'ge', value: 1 },
			],
			select: ['id', 'tag'],
		});
		assert.strictEqual(values.length, 4);
		assert.strictEqual(recovered.length, 1);
		assert.deepStrictEqual(recovered[0].partialObject, { id: 'row-2' });
	});

	it('on an id=in scan', async function () {
		const { recovered } = await recoverRows({
			conditions: [{ attribute: 'id', comparator: 'in', value: ['row-1', 'row-2', 'row-3'] }],
			select: ['id', 'tag'],
		});
		assert.strictEqual(recovered.length, 1);
		assert.deepStrictEqual(recovered[0].partialObject, { id: 'row-2' });
	});
});
