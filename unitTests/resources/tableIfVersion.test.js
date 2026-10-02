require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
// Checked by `.code`/`.statusCode`, not `instanceof VersionConflictError`: `require('#src/...')`
// resolves to the compiled `dist/` build outside the `typestrip` condition (see package.json
// `imports`), a *different* module instance than `resources/Table.ts`'s own relative `.ts` import
// of this class, so `instanceof` would never match the error it actually throws.
// Arrow function, not a `function` declaration: assert.rejects distinguishes a validation
// function from a constructor by whether it has a `.prototype`, and only an arrow function lacks
// one — a plain `function` here would be used as an (always-failing) `instanceof` check instead.
const assertVersionConflict =
	(expectedRetryable = true) =>
	(error) => {
		assert.strictEqual(error.code, 'VERSION_CONFLICT');
		assert.strictEqual(error.statusCode, 409);
		assert.strictEqual(error.retryable, expectedRetryable);
		return true;
	};

// HarperFast/harper#2983: `Table.put(record, { ifVersion })` guards a write on the record's current
// version, matching every platform's primary-store engine (default run is RocksDB; the lmdb variant
// of this suite runs the same assertions via HARPER_STORAGE_ENGINE=lmdb) rather than an LMDB-only
// primitive. On a mismatch nothing is written and the caller gets a distinct, catchable
// VersionConflictError rather than a storage failure. No `ifVersion` option keeps today's behavior.
describe('Table.put ifVersion', () => {
	let Rows;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Rows = table({
			table: 'IfVersionRows',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'count' }],
		});
	});

	it('writes unconditionally when ifVersion is omitted', async () => {
		await Rows.put({ id: 'unconditional', name: 'a' });
		const firstVersion = Rows.primaryStore.getEntry('unconditional').version;
		await Rows.put({ id: 'unconditional', name: 'b' });
		const entry = Rows.primaryStore.getEntry('unconditional');
		assert.strictEqual(entry.value.name, 'b');
		assert.ok(entry.version >= firstVersion, 'version did not regress');
	});

	it('writes and advances the version when ifVersion matches', async () => {
		await Rows.put({ id: 'match', name: 'a' });
		const version = Rows.primaryStore.getEntry('match').version;

		await Rows.put({ id: 'match', name: 'b' }, { ifVersion: version });

		const entry = Rows.primaryStore.getEntry('match');
		assert.strictEqual(entry.value.name, 'b', 'the matched write landed');
		assert.ok(entry.version > version, 'the version advanced past the matched ifVersion');
	});

	it('rejects and writes nothing when ifVersion does not match the stored version', async () => {
		await Rows.put({ id: 'mismatch', name: 'a' });
		const staleVersion = Rows.primaryStore.getEntry('mismatch').version - 1000;

		await assert.rejects(Rows.put({ id: 'mismatch', name: 'b' }, { ifVersion: staleVersion }), assertVersionConflict());

		const entry = Rows.primaryStore.getEntry('mismatch');
		assert.strictEqual(entry.value.name, 'a', 'the rejected write left the record unchanged');
	});

	it('rejects on whatever existingEntry the commit actually receives, not a value cached before it', async () => {
		// Regression guard: the comparison must read `existingEntry` — the parameter `write.commit`
		// is actually invoked with — not a version captured separately before or outside that call.
		// A refactor that captured the "current" version some other way (e.g. once, before staging)
		// and compared against that instead would still pass every other test in this file, since
		// none of them give the base read and the commit-time read a reason to disagree.
		//
		// A real two-writer race was tried twice here and dropped both times: staging the guarded
		// and a concurrent write under one shared, explicit transaction leaked a RocksDB read
		// snapshot into later, unrelated test files once the guard rejected; interposing a genuine
		// concurrent `put()` via `Transaction.prototype.commit` (the technique
		// unitTests/resources/immediateTransactionConflictRetry.test.js uses) left RocksDB's native
		// conflict/retry bookkeeping desynced for that same file's own tests, run afterward in the
		// same process. Both are real, pre-existing issues outside this change's scope (noted
		// alongside the single-write-transaction limit in resources/DESIGN.md), not something to
		// paper over by shipping a test that reproduces them. This uses the same `getEntry`
		// interception technique as unitTests/security/userRecordLookups.test.js instead: no real
		// transaction, no leak, and it drives `write.commit`'s actual `existingEntry` argument
		// directly rather than hoping a race lands in the right window.
		const id = 'race';
		await Rows.put({ id, name: 'a' });
		const entry = Rows.primaryStore.getEntry(id);

		const getEntry = Rows.primaryStore.getEntry;
		let intercepted = false;
		Rows.primaryStore.getEntry = function (key, options) {
			const real = getEntry.call(this, key, options);
			if (intercepted || key !== id) return real;
			intercepted = true;
			// A version this write never staged against, as if a concurrent write had landed since.
			return { ...real, version: real.version + 1000 };
		};
		try {
			await assert.rejects(Rows.put({ id, name: 'guarded' }, { ifVersion: entry.version }), assertVersionConflict());
		} finally {
			Rows.primaryStore.getEntry = getEntry;
		}

		assert.strictEqual(Rows.primaryStore.getEntry(id).value.name, 'a', 'the rejected write left nothing behind');
	});

	it('rejects a conditional write against a row that does not exist', async () => {
		await assert.rejects(Rows.put({ id: 'never-existed', name: 'a' }, { ifVersion: 12345 }), assertVersionConflict());
		assert.strictEqual(Rows.primaryStore.getEntry('never-existed'), undefined);
	});

	it('rejects a conditional write against a row that was deleted after the caller read it', async () => {
		await Rows.put({ id: 'deleted', name: 'a' });
		const version = Rows.primaryStore.getEntry('deleted').version;
		await Rows.delete('deleted');

		await assert.rejects(Rows.put({ id: 'deleted', name: 'b' }, { ifVersion: version }), assertVersionConflict());
		// A delete leaves a tombstone entry (value: null) rather than no entry at all.
		assert.strictEqual(Rows.primaryStore.getEntry('deleted')?.value ?? null, null, 'the row stays deleted');
	});

	it('rejects a second conditional write against the version the first one already advanced past', async () => {
		await Rows.put({ id: 'sequential', name: 'a' });
		const version = Rows.primaryStore.getEntry('sequential').version;

		await Rows.put({ id: 'sequential', name: 'b' }, { ifVersion: version });
		// Reusing the same (now stale) expected version a second time must reject, not silently re-apply.
		await assert.rejects(Rows.put({ id: 'sequential', name: 'c' }, { ifVersion: version }), assertVersionConflict());

		assert.strictEqual(Rows.primaryStore.getEntry('sequential').value.name, 'b');
	});

	it('rejects a matched put whose version came from a future-timestamped row, rather than silently merging', async function () {
		// Only RocksDB's singular version/timestamp can be pushed ahead of real time by a timestamped write.
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		await Rows.put({ id: 'future', name: 'old' });
		// Advance the row to a version ahead of real time (as a resequenced/replicated write could).
		await Rows.patch('future', { name: 'newer' }, { timestamp: Date.now() + 60_000 });
		const futureVersion = Rows.primaryStore.getEntry('future').version;

		// A normal (current-time) put whose ifVersion matches that future version would, without this
		// guard, merge onto 'newer' and report success while 'attempted' never actually lands. Not
		// retryable: a fresh read sees the same future version until real time catches up to it.
		await assert.rejects(
			Rows.put({ id: 'future', name: 'attempted' }, { ifVersion: futureVersion }),
			assertVersionConflict(false)
		);
		assert.strictEqual(Rows.primaryStore.getEntry('future').value.name, 'newer', "the caller's value never landed");
	});

	it('rejects a VERSION_REUSED row as not retryable, even when the version matches', async function () {
		// Only RocksDB's singular version/timestamp can be reused by an out-of-order write.
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		const { VERSION_REUSED } = require('#src/resources/RecordEncoder');
		const now = Date.now();
		await Rows.put({ id: 'reused', name: 'base', count: 0 });
		await Rows.patch('reused', { count: { __op__: 'add', value: 1 } }, { timestamp: now + 100 });
		// Out-of-order: merges onto the newer record and stores under its (reused) version.
		await Rows.patch('reused', { count: { __op__: 'add', value: 1 } }, { timestamp: now + 50 });
		const entry = Rows.primaryStore.getEntry('reused');
		assert.ok(entry.metadataFlags & VERSION_REUSED, 'the record carries a reused version');

		await assert.rejects(
			Rows.put({ id: 'reused', name: 'c' }, { ifVersion: entry.version }),
			assertVersionConflict(false)
		);
		// A fresh re-read still sees the same (reused) version: retrying with it is futile, not transient.
		assert.strictEqual(Rows.primaryStore.getEntry('reused').version, entry.version);
	});
});
