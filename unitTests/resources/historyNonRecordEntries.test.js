const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { ResourceBridge } = require('#src/dataLayer/harperBridge/ResourceBridge');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const schema = 'history_non_record_entries';

describe('history readers and non-record audit entries', function () {
	this.timeout(60_000);
	let tableIndex = 0;
	const bridge = new ResourceBridge();

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	function newTable(database = schema) {
		return table({
			database,
			table: `HistoryNonRecord${++tableIndex}`,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
	}

	function auditEntries(T) {
		const entries = [];
		for (const entry of T.auditStore.getRange({ start: 1 })) {
			if (entry.tableId === T.tableId) entries.push({ type: entry.type, txnLogKey: entry.txnLogKey });
		}
		return entries;
	}

	describe('reload marker', () => {
		it('getHistory and getHistoryOfRecord omit it', async () => {
			const T = newTable();
			await T.put({ id: 'a', name: 'one' });
			await T.writeReloadMarker();
			await T.put({ id: 'a', name: 'two' });
			assert.ok(
				auditEntries(T).some((entry) => entry.type === 'reload'),
				'the marker is in the audit log'
			);

			const history = await Array.fromAsync(T.getHistory());
			assert.deepStrictEqual(
				history.map((entry) => [entry.type, entry.id]),
				[
					['put', 'a'],
					['put', 'a'],
				]
			);
			const ofRecord = await T.getHistoryOfRecord('a');
			assert.deepStrictEqual(
				ofRecord.map((entry) => entry.value.name),
				['one', 'two']
			);
		});

		it('a table with only a marker has no history', async () => {
			const T = newTable();
			await T.writeReloadMarker();
			assert.deepStrictEqual(
				auditEntries(T).map((entry) => entry.type),
				['reload']
			);
			assert.deepStrictEqual(await Array.fromAsync(T.getHistory()), []);
			const groups = await Array.fromAsync(
				await bridge.readAuditLog({ schema, table: T.tableName, search_type: 'timestamp', search_values: [0] })
			);
			assert.deepStrictEqual(groups, []);
		});

		it('read_audit_log reports only the user writes around it', async () => {
			const T = newTable();
			await T.put({ id: 'a', name: 'one' });
			await T.writeReloadMarker();
			await T.put({ id: 'b', name: 'two' });

			const groups = await Array.fromAsync(
				await bridge.readAuditLog({ schema, table: T.tableName, search_type: 'timestamp', search_values: [0] })
			);
			assert.deepStrictEqual(
				groups.map((group) => [group.operation, group.ids]),
				[
					['upsert', ['a']],
					['upsert', ['b']],
				]
			);
		});

		it('read_audit_log keeps a transaction group intact when the marker shares the transaction', async function () {
			if (isLMDB) return this.skip(); // LMDB gives each write its own version, so nothing groups
			const T = newTable();
			const context = {};
			await transaction(context, () => {
				T.put({ id: 'a', name: 'one' }, context);
				T.put({ id: 'b', name: 'two' }, context);
				T.writeReloadMarker(context);
			});
			await T.put({ id: 'c', name: 'three' });

			const groups = await Array.fromAsync(
				await bridge.readAuditLog({ schema, table: T.tableName, search_type: 'timestamp', search_values: [0] })
			);
			assert.deepStrictEqual(
				groups.map((group) => group.ids),
				[['a', 'b'], ['c']]
			);
			assert.deepStrictEqual(
				groups.flatMap((group) => group.records.map((record) => record.name)),
				['one', 'two', 'three']
			);
		});
	});

	describe('a record whose primary entry has no local audit time', () => {
		it('has an empty history, not an error', async function () {
			if (!isLMDB) return this.skip(); // RocksDB resolves the audit position from the record's version
			const T = newTable();
			// a write that bypasses the audit path, as a base copy does
			T.primaryStore.putSync('orphan', { id: 'orphan', name: 'unaudited' }, Date.now());
			assert.strictEqual(T.primaryStore.getEntry('orphan').localTime, undefined);

			assert.deepStrictEqual(await T.getHistoryOfRecord('orphan'), []);
			const byHash = await bridge.readAuditLog({
				schema,
				table: T.tableName,
				search_type: 'hash_value',
				search_values: ['orphan'],
			});
			assert.deepStrictEqual(byHash, { orphan: [] });
			await assert.rejects(T.getHistoryOfRecord(undefined), /An id is required/);
		});
	});
});
