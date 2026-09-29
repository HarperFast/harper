const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, closeDatabase, __setReadOnlyModeForTest } = require('#src/resources/databases');
const {
	getAuditFloor,
	getAuditResumeFloor,
	getDatabaseGeneration,
	establishDatabaseGeneration,
	isResumablePosition,
	raiseAuditFloor,
	stampDatabaseGeneration,
	stampDatabaseDirectory,
} = require('#src/resources/auditStore');
const { DatabaseClosingError, DatabaseGenerationChangedError } = require('#src/utility/errors/hdbError');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const GENERATION_KEY = Symbol.for('database-generation');
const RESUME_FLOOR_KEY = Symbol.for('audit-resume-floor');
const FLOOR_KEY = Symbol.for('audit-floor');
const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';

function floorBytes(value) {
	return new Uint8Array(new Float64Array([value]).buffer);
}

/** Write raw metadata the way an older binary, or corruption, would leave it. */
function putRecord(auditStore, key, bytes) {
	auditStore.putSync(key, bytes);
}

async function clearRecord(auditStore, key) {
	const root = auditStore.rootStore;
	if (typeof root?.removeSync === 'function') root.removeSync(key);
	await auditStore.remove(key);
}

let sequence = 0;
function tableInOwnDatabase(name = `Generation${++sequence}`) {
	return table({
		table: name,
		database: `generation_${name}`,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
}

describe('Database generation', () => {
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	describe('genesis', () => {
		it('gives a new database a generation of its own, with a finite resume floor', () => {
			const store = tableInOwnDatabase().auditStore;
			const generation = getDatabaseGeneration(store);
			assert.match(generation.id, /^[0-9a-f]{32}$/);
			assert.strictEqual(generation.epoch, 0, 'no copy produced it');
			assert.ok(Number.isFinite(getAuditResumeFloor(store)));
		});

		it('gives two databases different generations', () => {
			assert.notStrictEqual(
				getDatabaseGeneration(tableInOwnDatabase().auditStore).id,
				getDatabaseGeneration(tableInOwnDatabase().auditStore).id
			);
		});

		it('keeps the generation across a close and reopen', async () => {
			const name = 'Reopened';
			const before = getDatabaseGeneration(tableInOwnDatabase(name).auditStore);
			assert.ok(await closeDatabase(`generation_${name}`));
			const reopened = tableInOwnDatabase(name).auditStore;
			assert.deepStrictEqual(getDatabaseGeneration(reopened), before);
		});

		it("adopts another worker's genesis instead of minting a second one", async () => {
			const store = tableInOwnDatabase().auditStore;
			const winner = getDatabaseGeneration(store);
			// This worker read "no generation" before the winner's commit landed; the compare-and-set
			// inside the transaction sees the record and writes nothing.
			const realGetBinary = store.getBinary.bind(store);
			let hidden = false;
			store.getBinary = (key) => {
				if (key === GENERATION_KEY && !hidden) {
					hidden = true;
					return undefined;
				}
				return realGetBinary(key);
			};
			try {
				establishDatabaseGeneration(store);
			} finally {
				store.getBinary = realGetBinary;
			}
			assert.ok(hidden, 'precondition: the outer read was the stale one');
			assert.deepStrictEqual(getDatabaseGeneration(store), winner);
		});

		it('refuses to resume against an unreadable generation record, and does not repair it', async () => {
			const store = tableInOwnDatabase().auditStore;
			const garbage = new Uint8Array([1, 2, 3]);
			putRecord(store, GENERATION_KEY, garbage);
			establishDatabaseGeneration(store);
			assert.strictEqual(getDatabaseGeneration(store), undefined);
			assert.deepStrictEqual(new Uint8Array(store.getBinary(GENERATION_KEY)), garbage, 'an open must not rewrite it');
			assert.strictEqual(isResumablePosition(store, undefined, Date.now()), false);
			await clearRecord(store, GENERATION_KEY);
		});

		it('mints nothing in read-only mode', async () => {
			const store = tableInOwnDatabase().auditStore;
			await clearRecord(store, GENERATION_KEY);
			__setReadOnlyModeForTest(true);
			try {
				establishDatabaseGeneration(store);
			} finally {
				__setReadOnlyModeForTest(undefined);
			}
			assert.strictEqual(getDatabaseGeneration(store), undefined);
			assert.strictEqual(store.getBinary(GENERATION_KEY), undefined);
		});
	});

	describe('the resume floor', () => {
		it('is raised by a prune together with the audit floor', () => {
			const store = tableInOwnDatabase().auditStore;
			const cutoff = Date.now() + 1000;
			raiseAuditFloor(store, cutoff);
			assert.strictEqual(getAuditFloor(store), cutoff);
			assert.strictEqual(getAuditResumeFloor(store), cutoff);
		});

		it('is not absorbed by an unknown audit floor, which stays unknown', () => {
			const store = tableInOwnDatabase().auditStore;
			putRecord(store, FLOOR_KEY, floorBytes(Infinity));
			const cutoff = Date.now() + 1000;
			raiseAuditFloor(store, cutoff);
			assert.strictEqual(getAuditFloor(store), Infinity, "reconciliation's unknown floor is never rewritten");
			assert.strictEqual(getAuditResumeFloor(store), cutoff);
			const { id } = getDatabaseGeneration(store);
			assert.strictEqual(isResumablePosition(store, id, cutoff), true, 'an unknown floor no longer blocks resume');
			assert.strictEqual(isResumablePosition(store, id, cutoff - 1), false);
		});

		it('is raised even when the audit floor already covers the cutoff', async () => {
			const store = tableInOwnDatabase().auditStore;
			const cutoff = Date.now() + 1000;
			raiseAuditFloor(store, cutoff + 1000);
			await clearRecord(store, RESUME_FLOOR_KEY);
			raiseAuditFloor(store, cutoff);
			putRecord(store, FLOOR_KEY, floorBytes(Infinity));
			assert.strictEqual(getAuditResumeFloor(store), cutoff, 'the lock-free skip must check both records');
		});

		it('is never below a finite audit floor, which a generation-unaware binary raises alone when it prunes', () => {
			const store = tableInOwnDatabase().auditStore;
			const { id } = getDatabaseGeneration(store);
			const cursor = Date.now();
			assert.strictEqual(isResumablePosition(store, id, cursor), true, 'precondition');
			putRecord(store, FLOOR_KEY, floorBytes(cursor + 5000));
			assert.strictEqual(getAuditResumeFloor(store), cursor + 5000);
			assert.strictEqual(isResumablePosition(store, id, cursor), false);
			__setReadOnlyModeForTest(true);
			try {
				assert.strictEqual(isResumablePosition(store, id, cursor), false, 'read-only opens read the same bound');
			} finally {
				__setReadOnlyModeForTest(undefined);
			}
		});
	});

	describe('stamping a copy', () => {
		it('starts a new generation, and leaves the floor of a copy that carried its log alone', () => {
			const store = tableInOwnDatabase().auditStore;
			const before = getDatabaseGeneration(store);
			raiseAuditFloor(store, Date.now() - 60_000);
			const floor = getAuditFloor(store);
			const stamped = stampDatabaseGeneration(store, { carriesLog: true });
			assert.notStrictEqual(stamped.id, before.id);
			assert.ok(stamped.epoch > 0);
			assert.strictEqual(getAuditFloor(store), floor);
			assert.strictEqual(getAuditResumeFloor(store), floor, 'no prune has run in the new generation');
			establishDatabaseGeneration(store);
			assert.deepStrictEqual(getDatabaseGeneration(store), stamped);
			assert.strictEqual(isResumablePosition(store, before.id, Date.now()), false, 'the old generation is refused');
		});

		it('raises the floor of a copy that carried no log to its epoch, but never an unknown one', () => {
			const store = tableInOwnDatabase().auditStore;
			raiseAuditFloor(store, Date.now() - 60_000);
			const stamped = stampDatabaseGeneration(store, { carriesLog: false });
			assert.strictEqual(getAuditFloor(store), stamped.epoch);

			const unknown = tableInOwnDatabase().auditStore;
			putRecord(unknown, FLOOR_KEY, floorBytes(Infinity));
			stampDatabaseGeneration(unknown, { carriesLog: false });
			assert.strictEqual(getAuditFloor(unknown), Infinity);
		});

		it('replays a generation the caller recorded first', () => {
			const store = tableInOwnDatabase().auditStore;
			const recorded = { id: 'ab'.repeat(16), epoch: Date.now() };
			assert.deepStrictEqual(stampDatabaseGeneration(store, { carriesLog: true, generation: recorded }), recorded);
			establishDatabaseGeneration(store);
			assert.deepStrictEqual(getDatabaseGeneration(store), recorded);
		});

		it('commits none of its records when one of them does not land', function () {
			if (isRocksDB) return this.skip(); // the LMDB write branch reads its puts back through the store
			const store = tableInOwnDatabase().auditStore;
			raiseAuditFloor(store, Date.now()); // so the dropped resume-floor write differs from what is stored
			const before = new Uint8Array(store.getBinary(GENERATION_KEY));
			const realPut = store.put.bind(store);
			store.put = (key, value) => (key === RESUME_FLOOR_KEY ? Promise.resolve(true) : realPut(key, value));
			try {
				assert.throws(() => stampDatabaseGeneration(store, { carriesLog: true }), /did not commit/);
			} finally {
				store.put = realPut;
			}
			assert.deepStrictEqual(
				new Uint8Array(store.getBinary(GENERATION_KEY)),
				before,
				'the generation must roll back too'
			);
		});
	});

	describe('resumable positions', () => {
		it('require the current generation id and a finite cursor at or above the resume floor', () => {
			const store = tableInOwnDatabase().auditStore;
			const { id } = getDatabaseGeneration(store);
			const floor = Date.now();
			raiseAuditFloor(store, floor);
			assert.strictEqual(isResumablePosition(store, id, floor), true);
			assert.strictEqual(isResumablePosition(store, id, floor - 1), false);
			assert.strictEqual(isResumablePosition(store, 'cd'.repeat(16), floor), false);
			assert.strictEqual(isResumablePosition(store, undefined, floor), false, 'no scalar mode');
			assert.strictEqual(isResumablePosition(store, id, Infinity), false);
			assert.strictEqual(isResumablePosition(store, id, NaN), false);
		});

		it('refuses a cursor from before tracking began, however it compares with the bootstrap floor', () => {
			// resources/DESIGN.md's worked example: a legacy prune removed tableA through 1000, the newest
			// survivor was 900, and a rolled-back clock stamped the floor at 920. A cursor at 970 compares
			// above every floor; it carries no generation id, so it cannot be certified.
			const store = tableInOwnDatabase().auditStore;
			putRecord(store, FLOOR_KEY, floorBytes(920));
			assert.strictEqual(isResumablePosition(store, undefined, 970), false);
		});
	});

	describe('live subscriptions across a generation change', function () {
		before(function () {
			if (!isRocksDB) this.skip(); // copies of a live database are RocksDB paths
		});

		async function reopenAsCopy(name, stampedTable) {
			const path = stampedTable.auditStore.rootStore.path;
			assert.ok(await closeDatabase(`generation_${name}`));
			await stampDatabaseDirectory(path, { carriesLog: true });
			return tableInOwnDatabase(name);
		}

		it('ends a subscription registered before the database was replaced by a copy', async () => {
			const name = 'LiveReplaced';
			const T = tableInOwnDatabase(name);
			const events = [];
			const subscription = await T.subscribe({ id: 'A', listener: (event) => events.push(event) });
			await T.put('A', { value: 1 });
			await waitFor(() => events.some((event) => event.value?.value === 1));
			const copy = await reopenAsCopy(name, T);
			assert.strictEqual(subscription.closed, true);
			assert.ok(events.at(-1) instanceof DatabaseGenerationChangedError, 'the consumer is told to resync');
			const after = [];
			await copy.subscribe({ id: 'A', listener: (event) => after.push(event) });
			await copy.put('A', { value: 2 });
			await waitFor(() => after.some((event) => event.value?.value === 2));
			assert.ok(!events.some((event) => event.value?.value === 2), 'the old subscription must not see the copy');
		});

		it('still closes a subscription whose listener throws on the terminal event', async () => {
			const name = 'LiveThrowing';
			const T = tableInOwnDatabase(name);
			const subscription = await T.subscribe({
				id: 'A',
				listener: (event) => {
					if (event instanceof Error) throw new Error('listener failed');
				},
			});
			const sibling = await T.subscribe({ id: 'A' });
			await reopenAsCopy(name, T);
			assert.strictEqual(subscription.closed, true);
			assert.strictEqual(sibling.closed, true, 'one throwing listener must not strand the others');
		});

		async function subscribeAndWrite(copy) {
			const events = [];
			const subscription = await copy.subscribe({ id: 'A', listener: (event) => events.push(event) });
			await copy.put('A', { value: 2 });
			await waitFor(() => events.some((event) => event.value?.value === 2));
			return { subscription, events };
		}

		it('refuses a resubscribe that a listener makes through the replaced database while it is being ended', async () => {
			const name = 'LiveReentrant';
			const T = tableInOwnDatabase(name);
			await T.put('A', { value: 1 });
			const resource = await T.getResource('A', {});
			const stale = [];
			let resubscribe;
			await T.subscribe({
				id: 'A',
				listener: (event) => {
					if (event instanceof DatabaseGenerationChangedError && !resubscribe) {
						resubscribe = resource.subscribe({ listener: (staleEvent) => stale.push(staleEvent) });
						resubscribe.catch(() => {});
					}
				},
			});
			const copy = await reopenAsCopy(name, T);
			assert.ok(resubscribe, 'precondition: the listener resubscribed during the teardown');
			await assert.rejects(resubscribe, DatabaseGenerationChangedError);
			const current = await subscribeAndWrite(copy);
			assert.deepStrictEqual(stale, []);
			assert.ok(await closeDatabase(`generation_${name}`));
			tableInOwnDatabase(name);
			assert.ok(
				current.events.at(-1) instanceof DatabaseClosingError,
				'the copy’s subscriber ends as a same-generation reopen, not as a replaced database'
			);
		});

		it('refuses a subscription through a resource loaded before the database was replaced', async () => {
			const name = 'LiveStaleResource';
			const T = tableInOwnDatabase(name);
			await T.put('A', { value: 1 });
			const resource = await T.getResource('A', {});
			const copy = await reopenAsCopy(name, T);
			const stale = [];
			await assert.rejects(
				resource.subscribe({ listener: (event) => stale.push(event) }),
				DatabaseGenerationChangedError
			);
			(await subscribeAndWrite(copy)).subscription.end();
			assert.deepStrictEqual(stale, []);
		});

		it('ends a subscription at a reopen of the same generation with a retryable error, and a resubscribe resumes', async () => {
			const name = 'LiveSame';
			const T = tableInOwnDatabase(name);
			const events = [];
			const subscription = await T.subscribe({ id: 'A', listener: (event) => events.push(event) });
			assert.ok(await closeDatabase(`generation_${name}`));
			const reopened = tableInOwnDatabase(name);
			await reopened.put('A', { value: 1 });
			await waitFor(() => events.some((event) => event instanceof Error || event.value?.value === 1));
			assert.ok(events.at(-1) instanceof DatabaseClosingError, 'the consumer is told to resubscribe');
			assert.strictEqual(subscription.closed, true);
			(await subscribeAndWrite(reopened)).subscription.end();
		});

		it('refuses a retry through the handle that a same-generation reopen closed', async () => {
			const name = 'LiveSameRetry';
			const T = tableInOwnDatabase(name);
			await T.put('A', { value: 1 });
			const resource = await T.getResource('A', {});
			const first = [];
			await resource.subscribe({ listener: (event) => first.push(event) });
			assert.ok(await closeDatabase(`generation_${name}`));
			await assert.rejects(resource.subscribe({}), DatabaseClosingError, 'its store is closed');
			const reopened = tableInOwnDatabase(name);
			assert.ok(first.at(-1) instanceof DatabaseClosingError, 'precondition: the reopen ended the first subscription');
			await assert.rejects(resource.subscribe({}), DatabaseClosingError, 'it is not the reopened handle');
			(await subscribeAndWrite(reopened)).subscription.end();
		});
	});
});
