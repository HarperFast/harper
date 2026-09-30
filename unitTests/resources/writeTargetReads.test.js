const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { Resource } = require('#src/resources/Resource');
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
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'value', indexed: true },
				{ name: 'created', assignCreatedTime: true, type: 'Float' },
			],
		});
	}
	async function readsOf(Table, ids, action, onlySnapshotReads = false) {
		const store = Table.primaryStore;
		const getEntry = store.getEntry;
		const reads = Object.fromEntries(ids.map((id) => [id, 0]));
		store.getEntry = function (key, options) {
			if (key in reads && (!onlySnapshotReads || options?.uncachedRead)) reads[key]++;
			return getEntry.call(this, key, options);
		};
		try {
			await action();
		} finally {
			store.getEntry = getEntry;
		}
		return reads;
	}
	async function idsWithValue(Table, value) {
		const ids = [];
		for await (const record of Table.search({ conditions: [{ attribute: 'value', value }] })) ids.push(record.id);
		return ids;
	}

	it('reads an inserted record once, reusing that read as the commit base', async () => {
		const Target = freshTable();
		const reads = await readsOf(Target, ['new'], () => Target.put('new', { value: 1 }));
		assert.strictEqual((await Target.get('new')).value, 1);
		if (!isLMDB) assert.strictEqual(reads.new, 1);
	});

	it('reads an updated record once and keeps its created time and index entries', async () => {
		const Target = freshTable();
		await Target.put('kept', { value: 1 });
		const created = (await Target.get('kept')).created;
		const reads = await readsOf(Target, ['kept'], () => Target.put('kept', { value: 3 }));
		if (!isLMDB) assert.strictEqual(reads.kept, 1);
		const record = await Target.get('kept');
		assert.strictEqual(record.value, 3);
		assert.strictEqual(record.created, created);
		assert.deepStrictEqual(await idsWithValue(Target, 1), []);
		assert.deepStrictEqual(await idsWithValue(Target, 3), ['kept']);
		await Target.delete('kept');
		assert.strictEqual(await Target.get('kept'), null);
		assert.deepStrictEqual(await idsWithValue(Target, 3), []);
	});

	it('reads a record written without an instance load only as the commit base', async () => {
		const Target = freshTable();
		class NoInstance extends Target {
			static loadAsInstance = false;
		}
		const reads = await readsOf(Target, ['direct'], () => NoInstance.put('direct', { value: 2 }));
		assert.strictEqual((await Target.get('direct')).value, 2);
		if (!isLMDB) assert.strictEqual(reads.direct, 1);
	});

	it('updates an existing record written without an instance load against its stored state', async () => {
		const Target = freshTable();
		class NoInstance extends Target {
			static loadAsInstance = false;
		}
		await Target.put('stored', { value: 1 });
		const created = (await Target.get('stored')).created;
		const reads = await readsOf(Target, ['stored'], () => NoInstance.put('stored', { value: 2 }));
		if (!isLMDB) assert.strictEqual(reads.stored, 1);
		const record = await Target.get('stored');
		assert.strictEqual(record.value, 2);
		assert.strictEqual(record.created, created);
		assert.deepStrictEqual(await idsWithValue(Target, 1), []);
		assert.deepStrictEqual(await idsWithValue(Target, 2), ['stored']);
	});

	it('reads the commit base of a key other than the loaded one', async () => {
		const Target = freshTable();
		await Target.put('other', { value: 5 });
		const created = (await Target.get('other')).created;
		class WritesOther extends Target {
			// loaded as the request's target, then writes a different key through the target-first form
			put(data) {
				return super.put('other', data);
			}
		}
		const reads = await readsOf(Target, ['loaded', 'other'], () => WritesOther.put('loaded', { value: 6 }));
		if (!isLMDB) assert.ok(reads.other >= 1, 'the written key is read as its own commit base');
		const record = await Target.get('other');
		assert.strictEqual(record.value, 6);
		assert.strictEqual(record.created, created);
		assert.deepStrictEqual(await idsWithValue(Target, 5), []);
		assert.strictEqual(await Target.get('loaded'), null);
	});

	it('reloads the commit base after a snapshot-free read opened the transaction', async () => {
		const Target = freshTable();
		await Target.put('late', { value: 1 });
		const reads = await readsOf(Target, ['late'], () =>
			transaction({}, async (context) => {
				for await (const _record of Target.search(
					{ conditions: [{ attribute: 'value', value: 9 }], snapshot: false },
					context
				));
				await Target.put('late', { value: 2 }, context);
			})
		);
		if (!isLMDB) assert.ok(reads.late >= 2, 'a snapshot-free handle is never reused as the commit base');
		assert.strictEqual((await Target.get('late')).value, 2);
		assert.deepStrictEqual(await idsWithValue(Target, 1), []);
	});

	it('reloads the commit base once a source fill has replaced the loaded entry', async () => {
		const Target = freshTable();
		Target.sourcedFrom(
			class extends Resource {
				get() {
					// no background cache fill, so the only snapshot reads of the key are the write's own
					this.getContext().noCacheStore = true;
					return { id: this.getId(), value: 7 };
				}
				put() {}
			}
		);
		class FillsFromSource extends Target {
			async put(data, target) {
				await this.ensureLoaded();
				return super.put(data, target);
			}
		}
		const reads = await readsOf(Target, ['filled'], () => FillsFromSource.put('filled', { value: 8 }), true);
		if (!isLMDB)
			assert.strictEqual(reads.filled, 2, 'the pre-load and a commit-base reload, not a reused source entry');
		assert.strictEqual((await Target.get('filled')).value, 8);
		assert.deepStrictEqual(await idsWithValue(Target, 7), []);
		assert.deepStrictEqual(await idsWithValue(Target, 8), ['filled']);
	});

	it('reloads the commit base after an earlier write to the key in the same transaction', async () => {
		const Target = freshTable();
		await Target.put('twice', { value: 1 });
		await transaction({}, async (context) => {
			await Target.put('twice', { value: 2 }, context);
			await Target.patch('twice', { value: 4 }, context);
		});
		assert.strictEqual((await Target.get('twice')).value, 4);
		assert.deepStrictEqual(await idsWithValue(Target, 2), []);
		assert.deepStrictEqual(await idsWithValue(Target, 4), ['twice']);
	});
});
