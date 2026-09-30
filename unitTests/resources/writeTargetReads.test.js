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

	it('keeps an existing record correct through update and delete', async () => {
		const Target = freshTable();
		await Target.put('kept', { value: 1 });
		await Target.put('kept', { value: 3 });
		assert.strictEqual((await Target.get('kept')).value, 3);
		await Target.delete('kept');
		assert.strictEqual(await Target.get('kept'), null);
	});
});
