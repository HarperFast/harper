const assert = require('assert');
const sinon = require('sinon');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { getDatabaseGeneration } = require('#src/resources/auditStore');
const { ResumeHistoryUnavailableError } = require('#src/utility/errors/hdbError');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { ResourceBridge } = require('#src/dataLayer/harperBridge/ResourceBridge');
const { logger } = require('#src/utility/logging/logger');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const schema = 'history_non_record_entries';

// Entries that describe no record (the whole-table reload marker) are not history: every history reader
// must skip them, and the startTime replay must not try to scope them by record id.
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

	async function auditEntryTypes(T) {
		const types = [];
		for (const entry of T.auditStore.getRange({ start: 1 })) {
			if (entry.tableId === T.tableId) types.push(entry.type);
		}
		return types;
	}

	// the audit-log position of a write, usable as a startTime that precedes everything after it
	async function putAt(T, record) {
		let position;
		const live = await T.subscribe({
			omitCurrent: true,
			includeSuperseded: true,
			listener: (event) => (position = event.localTime),
		});
		await T.put(record);
		await waitFor(() => position !== undefined);
		live.end();
		return position;
	}

	describe('reload marker', () => {
		it('getHistory and getHistoryOfRecord omit it', async () => {
			const T = newTable();
			await T.put({ id: 'a', name: 'one' });
			await T.writeReloadMarker();
			await T.put({ id: 'a', name: 'two' });
			assert.ok((await auditEntryTypes(T)).includes('reload'), 'the marker is in the audit log');

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
			assert.deepStrictEqual(await auditEntryTypes(T), ['reload']);
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
			// a RocksDB transaction's entries share one log key, which is what groups them
			if (isLMDB) return this.skip();
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

		describe('previousCount backfill', () => {
			// RocksDB's transaction log store has no reverse iteration (see subscriptionReplay.test.js)
			async function backfill(T, request) {
				const events = [];
				const subscription = await T.subscribe({ isCollection: true, omitCurrent: true, ...request });
				subscription.on('data', (event) => events.push(event));
				await waitFor(() => events.length >= request.previousCount);
				subscription.end();
				return events;
			}

			async function writeInterleaved(T) {
				await T.put({ id: 'p/1', name: 'one' });
				await T.writeReloadMarker();
				await T.put({ id: 'q/1', name: 'two' });
				await T.put({ id: 'p/2', name: 'three' });
				await T.writeReloadMarker();
				await T.put({ id: 'p/3', name: 'four' });
			}

			it('a marker does not take a slot of a collection backfill', async function () {
				if (!isLMDB) return this.skip();
				const T = newTable();
				await writeInterleaved(T);
				const events = await backfill(T, { previousCount: 3 });
				assert.deepStrictEqual(
					events.map((event) => [event.type, event.id]),
					[
						['put', 'q/1'],
						['put', 'p/2'],
						['put', 'p/3'],
					]
				);
			});

			it('a prefix backfill skips it instead of failing on its null id', async function () {
				if (!isLMDB) return this.skip();
				const T = newTable();
				await writeInterleaved(T);
				const errors = sinon.stub(logger, 'error');
				try {
					const events = await backfill(T, { id: 'p/', previousCount: 2 });
					assert.deepStrictEqual(
						events.map((event) => event.id),
						['p/2', 'p/3']
					);
					assert.strictEqual(errors.callCount, 0, 'the backfill logged an error for a marker');
				} finally {
					errors.restore();
				}
			});
		});

		describe('startTime replay of a prefix subscription', () => {
			it('delivers it and the later in-scope entries, without a sibling prefix', async () => {
				const T = newTable();
				const start = await putAt(T, { id: 'p/1', name: 'one' });
				await T.writeReloadMarker();
				await T.put({ id: 'q/1', name: 'sibling' });
				await T.put({ id: 'p/2', name: 'two' });
				const events = [];
				const subscription = await T.subscribe({
					id: 'p/',
					isCollection: true,
					startTime: start,
					omitCurrent: true,
					listener: (event) => events.push(event),
				});
				await waitFor(() => events.some((event) => event.id === 'p/2'));
				subscription.end();
				assert.deepStrictEqual(
					events.map((event) => (event instanceof Error ? event.message : [event.type, event.id])),
					[
						['reload', null],
						['put', 'p/2'],
					]
				);
			});

			it('still refuses a checked resume that crosses it', async function () {
				if (isLMDB) return this.skip(); // checked resume is RocksDB-only
				const T = newTable(`${schema}_checked`);
				const start = await putAt(T, { id: 'p/1', name: 'one' });
				await T.writeReloadMarker();
				await T.put({ id: 'p/2', name: 'two' });
				const events = [];
				const subscription = await T.subscribe({
					id: 'p/',
					isCollection: true,
					databaseGeneration: getDatabaseGeneration(T.auditStore).id,
					startTime: start,
					listener: (event) => events.push(event),
				});
				assert.strictEqual(await subscription.resumeVerified, false);
				assert.ok(events.at(-1) instanceof ResumeHistoryUnavailableError);
				assert.match(events.at(-1).message, /bulk reload/);
				assert.ok(!events.some((event) => event.id === 'p/2'), 'nothing past the marker is delivered');
			});
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
