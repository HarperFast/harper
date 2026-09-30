const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Reads of a write target', () => {
	let sequence = 0;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});
	function freshTable() {
		return table({
			database: 'writetargetreads',
			table: `Target${++sequence}`,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
	}
	async function readsOf(Table, id, action) {
		const store = Table.primaryStore;
		const getEntry = store.getEntry;
		let reads = 0;
		store.getEntry = function (key, options) {
			if (key === id) reads++;
			return getEntry.call(this, key, options);
		};
		try {
			await action();
		} finally {
			store.getEntry = getEntry;
		}
		return reads;
	}

	it('reads an inserted record once before staging and once as the commit base', async () => {
		const Target = freshTable();
		const reads = await readsOf(Target, 'new', () => Target.put('new', { value: 1 }));
		assert.strictEqual((await Target.get('new')).value, 1);
		if (!isLMDB) assert.strictEqual(reads, 2);
	});

	it('reads a record written without an instance load only as the commit base', async () => {
		const Target = freshTable();
		class NoInstance extends Target {
			static loadAsInstance = false;
		}
		const reads = await readsOf(Target, 'direct', () => NoInstance.put('direct', { value: 2 }));
		assert.strictEqual((await Target.get('direct')).value, 2);
		if (!isLMDB) assert.strictEqual(reads, 1);
	});

	it('updates an existing record written without an instance load against its stored state', async () => {
		const Target = table({
			database: 'writetargetreads',
			table: `Target${++sequence}`,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'value', indexed: true },
				{ name: 'label' },
				{ name: 'created', assignCreatedTime: true, type: 'Float' },
			],
		});
		class NoInstance extends Target {
			static loadAsInstance = false;
		}
		await Target.put('stored', { value: 1, label: 'kept' });
		const created = (await Target.get('stored')).created;
		const reads = await readsOf(Target, 'stored', () => NoInstance.put('stored', { value: 2 }));
		if (!isLMDB) assert.strictEqual(reads, 1);
		assert.strictEqual((await Target.get('stored')).created, created);
		await NoInstance.patch('stored', { label: 'patched' });
		const record = await Target.get('stored');
		assert.strictEqual(record.value, 2);
		assert.strictEqual(record.label, 'patched');
		assert.strictEqual(record.created, created);
		const byValue = [];
		for await (const found of Target.search({ conditions: [{ attribute: 'value', value: 1 }] })) byValue.push(found.id);
		assert.deepStrictEqual(byValue, []);
	});

	it('keeps an existing record correct through update and delete', async () => {
		const Target = freshTable();
		await Target.put('kept', { value: 1 });
		await Target.put('kept', { value: 3 });
		assert.strictEqual((await Target.get('kept')).value, 3);
		await Target.delete('kept');
		assert.strictEqual(await Target.get('kept'), null);
	});
});
