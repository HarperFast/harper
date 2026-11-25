const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, closeDatabase, resetDatabases } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { LMDBTransaction } = require('#src/resources/LMDBTransaction');
const { createAuditEntry, readAuditEntry, getLastRemoved } = require('#src/resources/auditStore');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

async function withCompetingWrite(stage, competingWrite) {
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	let staged;
	const read = new Promise((resolve) => (staged = resolve));
	let stagingFailed = false;
	const committed = transaction(async (txn) => {
		await stage(txn);
		staged();
		await gate;
	});
	// a staging failure opens the gate for the caller below, which then rethrows it from `committed`
	committed.catch(() => {
		stagingFailed = true;
		staged();
	});
	await read;
	try {
		if (!stagingFailed) await competingWrite();
	} finally {
		release();
		await committed.catch(() => {});
	}
	await committed;
}

describe('LMDB optimistic commit', () => {
	let CommitPath;
	let nextId = 1;
	const id = (label) => `${label}-${nextId++}`;

	before(function () {
		if (!isLMDB) return this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		CommitPath = table({
			table: 'LMDBCommitPath',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
			audit: false,
		});
	});
	// each detected conflict raises retryRisk, which sends later commits down the exclusive path, where
	// a conflict is resolved without the retry these tests exist to observe
	beforeEach(() => {
		CommitPath.primaryStore.retryRisk = 0;
	});

	function incrementWrite(store, key, entry, attempts) {
		return {
			key,
			store,
			entry,
			commit(txnTime, currentEntry, retries) {
				attempts.push(retries);
				store.put(key, { n: (currentEntry?.value?.n ?? 0) + 1 }, txnTime);
			},
		};
	}

	async function commitWrites(writes) {
		const transaction = new LMDBTransaction();
		transaction.db = CommitPath.primaryStore;
		for (const write of writes) transaction.addWrite(write);
		await transaction.commit({ doneWriting: true });
		await CommitPath.primaryStore.flushed;
	}

	async function seed(key, n, version) {
		await CommitPath.primaryStore.put(key, { n }, version);
		return CommitPath.primaryStore.getEntry(key);
	}

	const read = (key) => CommitPath.primaryStore.get(key);

	it('retries an update-then-insert commit when the updated key changed concurrently', async function () {
		const store = CommitPath.primaryStore;
		const [existing, created] = [id('existing'), id('created')];
		const staleEntry = await seed(existing, 1, 1000);
		await store.put(existing, { n: 10 }, 2000);
		const attempts = [];
		await commitWrites([
			incrementWrite(store, existing, staleEntry, attempts),
			incrementWrite(store, created, undefined, attempts),
		]);
		assert.strictEqual(read(existing)?.n, 11, 'the update is applied on top of the concurrent one');
		assert.strictEqual(read(created)?.n, 1, 'the insert is persisted');
		assert.ok(
			attempts.some((retries) => retries > 0),
			'the conflict was retried'
		);
	});

	it('retries an update-then-insert commit when the updated key was deleted concurrently', async function () {
		const store = CommitPath.primaryStore;
		const [existing, created] = [id('existing'), id('created')];
		const staleEntry = await seed(existing, 1, 1000);
		await store.remove(existing);
		const attempts = [];
		await commitWrites([
			incrementWrite(store, existing, staleEntry, attempts),
			incrementWrite(store, created, undefined, attempts),
		]);
		assert.strictEqual(read(existing)?.n, 1, 'the update recreates the deleted record');
		assert.strictEqual(read(created)?.n, 1, 'the insert is persisted');
		assert.ok(
			attempts.some((retries) => retries > 0),
			'the conflict was retried'
		);
	});

	it('retries an insert-then-update commit when the updated key changed concurrently', async function () {
		const store = CommitPath.primaryStore;
		const [created, existing] = [id('created'), id('existing')];
		const staleEntry = await seed(existing, 1, 1000);
		await store.put(existing, { n: 10 }, 2000);
		const attempts = [];
		await commitWrites([
			incrementWrite(store, created, undefined, attempts),
			incrementWrite(store, existing, staleEntry, attempts),
		]);
		assert.strictEqual(read(created)?.n, 1, 'the insert is persisted');
		assert.strictEqual(read(existing)?.n, 11, 'the update is applied on top of the concurrent one');
		assert.ok(
			attempts.some((retries) => retries > 0),
			'the conflict was retried'
		);
	});

	it('retries when only the middle write of three conflicts', async function () {
		const store = CommitPath.primaryStore;
		const [first, middle, last] = [id('first'), id('middle'), id('last')];
		const staleEntry = await seed(middle, 1, 1000);
		await store.put(middle, { n: 10 }, 2000);
		const attempts = [];
		await commitWrites([
			incrementWrite(store, first, undefined, attempts),
			incrementWrite(store, middle, staleEntry, attempts),
			incrementWrite(store, last, undefined, attempts),
		]);
		assert.strictEqual(read(first)?.n, 1);
		assert.strictEqual(read(middle)?.n, 11);
		assert.strictEqual(read(last)?.n, 1);
		assert.ok(
			attempts.some((retries) => retries > 0),
			'the conflict was retried'
		);
	});

	it('commits without a retry when nothing conflicts', async function () {
		const store = CommitPath.primaryStore;
		const [existing, created] = [id('existing'), id('created')];
		const entry = await seed(existing, 1, 1000);
		const attempts = [];
		await commitWrites([
			incrementWrite(store, existing, entry, attempts),
			incrementWrite(store, created, undefined, attempts),
		]);
		assert.strictEqual(read(existing)?.n, 2);
		assert.strictEqual(read(created)?.n, 1);
		assert.deepStrictEqual(attempts, [0, 0], 'each write ran once, on the first attempt');
	});
});

describe('LMDB optimistic commit through the Table API', () => {
	let Rows;
	let nextId = 1;
	const id = (label) => `${label}-${nextId++}`;

	before(function () {
		if (!isLMDB) return this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		Rows = table({
			table: 'LMDBCommitPathRows',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'count', type: 'Int' }, { name: 'other' }],
			audit: true,
		});
	});
	beforeEach(() => {
		Rows.primaryStore.retryRisk = 0;
	});

	async function historyLength(key) {
		return (await Rows.getHistoryOfRecord(key)).length;
	}

	it('applies an update-then-insert transaction once a concurrent patch of the updated row is retried', async function () {
		const [existing, created] = [id('existing'), id('created')];
		await Rows.put({ id: existing, count: 1 });
		await withCompetingWrite(
			async (txn) => {
				const row = await Rows.update(existing, {}, txn);
				row.addTo('count', 1);
				await Rows.put(created, { count: 5 }, txn);
			},
			() => Rows.patch(existing, { other: 'concurrent' })
		);
		assert.ok(Rows.primaryStore.retryRisk > 0, 'the first attempt conflicted and was retried');
		const updated = await Rows.get(existing);
		assert.strictEqual(updated.count, 2, 'the increment is applied');
		assert.strictEqual(updated.other, 'concurrent', 'the concurrent patch is kept');
		assert.strictEqual((await Rows.get(created))?.count, 5, 'the insert is persisted');
		assert.strictEqual(await historyLength(created), 1, 'one audit entry for the insert');
		assert.strictEqual(await historyLength(existing), 3, 'the put, the concurrent patch and the increment');
	});

	it('applies an insert-then-update transaction once a concurrent patch of the updated row is retried', async function () {
		const [created, existing] = [id('created'), id('existing')];
		await Rows.put({ id: existing, count: 1 });
		await withCompetingWrite(
			async (txn) => {
				await Rows.put(created, { count: 5 }, txn);
				const row = await Rows.update(existing, {}, txn);
				row.addTo('count', 1);
			},
			() => Rows.patch(existing, { other: 'concurrent' })
		);
		assert.ok(Rows.primaryStore.retryRisk > 0, 'the first attempt conflicted and was retried');
		const updated = await Rows.get(existing);
		assert.strictEqual(updated.count, 2, 'the increment is applied');
		assert.strictEqual(updated.other, 'concurrent', 'the concurrent patch is kept');
		assert.strictEqual((await Rows.get(created))?.count, 5, 'the insert is persisted');
		assert.strictEqual(await historyLength(created), 1, 'one audit entry for the insert');
	});

	it('keeps a retried commit decodable after reopen when it minted a new record shape', async function () {
		const databaseName = 'lmdbCommitPathReopen';
		const Shapes = table({
			table: 'Shapes',
			database: databaseName,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'count', type: 'Int' },
			],
			audit: true,
		});
		await Shapes.put({ id: 'existing', count: 1 });
		Shapes.primaryStore.retryRisk = 0;
		await withCompetingWrite(
			async (txn) => {
				const row = await Shapes.update('existing', {}, txn);
				row.addTo('count', 1);
				row.freshShapeProperty = 'minted by the retried update';
				await Shapes.put('created', { count: 5, anotherFreshShapeProperty: true }, txn);
			},
			() => Shapes.patch('existing', { concurrentProperty: 'concurrent' })
		);
		assert.ok(Shapes.primaryStore.retryRisk > 0, 'the first attempt conflicted and was retried');
		await closeDatabase(databaseName);
		const Reopened = resetDatabases()[databaseName].Shapes;
		const existing = await Reopened.get('existing');
		assert.strictEqual(existing.count, 2);
		assert.strictEqual(existing.freshShapeProperty, 'minted by the retried update');
		assert.strictEqual(existing.concurrentProperty, 'concurrent');
		const created = await Reopened.get('created');
		assert.strictEqual(created.count, 5);
		assert.strictEqual(created.anotherFreshShapeProperty, true);
	});
});

describe('bodyless audit entries', () => {
	const reloadRecord = (recordId, version) => ({
		version,
		tableId: 7,
		recordId,
		nodeId: 0,
		type: 'reload',
	});

	it('does not alias the buffer the next entry is encoded into', function () {
		const first = createAuditEntry(reloadRecord('first-record', 1000.5));
		const before = Buffer.from(first);
		createAuditEntry(reloadRecord('a-much-longer-second-record-id', 2000.5));
		assert.deepStrictEqual(Buffer.from(first), before, 'encoding a second entry rewrote the first');
		assert.strictEqual(readAuditEntry(first).recordId, 'first-record');
	});

	describe('written to an LMDB audit store', () => {
		let AuditPath;
		before(function () {
			if (!isLMDB) return this.skip();
			setupTestDBPath();
			setMainIsWorker(true);
			AuditPath = table({
				table: 'LMDBBodylessAudit',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
		});

		it('keeps each of several back-to-back entries intact', async function () {
			const auditStore = AuditPath.auditStore;
			const keys = [];
			for (let index = 0; index < 20; index++) {
				const key = 5_000_000 + index;
				keys.push(key);
				// no await: the store has not written an entry when the next one is encoded
				auditStore.put(key, reloadRecord(`bodyless-${index}-${'x'.repeat(index * 3)}`, 3000.5 + index));
			}
			await auditStore.flushed;
			await waitFor(() => keys.every((key) => auditStore.get(key)), { message: 'every entry is written' });
			for (let index = 0; index < keys.length; index++) {
				const entry = auditStore.get(keys[index]);
				assert.strictEqual(entry.recordId, `bodyless-${index}-${'x'.repeat(index * 3)}`, `entry ${index}`);
				assert.strictEqual(entry.version, 3000.5 + index);
			}
		});

		it('keeps the last-removed marker a new audit store writes when another store is read meanwhile', async function () {
			const otherMarker = Buffer.from(new Uint8Array(new Float64Array([7]).buffer));
			const otherStore = { get: () => otherMarker };
			const Opened = table({
				table: 'LMDBLastRemoved',
				database: 'lmdblastremoved',
				attributes: [{ name: 'id', isPrimaryKey: true }],
				audit: true,
			});
			assert.strictEqual(getLastRemoved(otherStore), 7);
			await Opened.auditStore.flushed;
			const stored = Opened.auditStore.getBinary(Symbol.for('last-removed'));
			assert.strictEqual(
				new Float64Array(Uint8Array.from(stored).buffer)[0],
				1,
				'the marker holds the value it was written with'
			);
		});

		it('stores a reload marker and the audit entry committed in the same batch, each intact', async function () {
			const startedAt = Date.now() - 1;
			const context = {};
			await transaction(context, async () => {
				AuditPath.writeReloadMarker(context);
				await AuditPath.put({ id: 'after-marker', name: 'next' }, context);
			});
			await AuditPath.auditStore.flushed;
			const persisted = [...AuditPath.auditStore.getRange({ start: startedAt })].filter(
				(entry) => entry.tableId === AuditPath.tableId
			);
			assert.deepStrictEqual(
				persisted.map((entry) => entry.type).sort(),
				['put', 'reload'],
				'each entry is stored with its own type'
			);
			assert.strictEqual(persisted.find((entry) => entry.type === 'put').recordId, 'after-marker');
		});
	});
});
