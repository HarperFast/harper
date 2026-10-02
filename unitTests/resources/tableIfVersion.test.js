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
const assertVersionConflict = (error) => {
	assert.strictEqual(error.code, 'VERSION_CONFLICT');
	assert.strictEqual(error.statusCode, 409);
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
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
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

		await assert.rejects(Rows.put({ id: 'mismatch', name: 'b' }, { ifVersion: staleVersion }), assertVersionConflict);

		const entry = Rows.primaryStore.getEntry('mismatch');
		assert.strictEqual(entry.value.name, 'a', 'the rejected write left the record unchanged');
	});

	it('rejects a conditional write against a row that does not exist', async () => {
		await assert.rejects(Rows.put({ id: 'never-existed', name: 'a' }, { ifVersion: 12345 }), assertVersionConflict);
		assert.strictEqual(Rows.primaryStore.getEntry('never-existed'), undefined);
	});

	it('rejects a conditional write against a row that was deleted after the caller read it', async () => {
		await Rows.put({ id: 'deleted', name: 'a' });
		const version = Rows.primaryStore.getEntry('deleted').version;
		await Rows.delete('deleted');

		await assert.rejects(Rows.put({ id: 'deleted', name: 'b' }, { ifVersion: version }), assertVersionConflict);
		// A delete leaves a tombstone entry (value: null) rather than no entry at all.
		assert.strictEqual(Rows.primaryStore.getEntry('deleted')?.value ?? null, null, 'the row stays deleted');
	});

	it('rejects a second conditional write against the version the first one already advanced past', async () => {
		await Rows.put({ id: 'sequential', name: 'a' });
		const version = Rows.primaryStore.getEntry('sequential').version;

		await Rows.put({ id: 'sequential', name: 'b' }, { ifVersion: version });
		// Reusing the same (now stale) expected version a second time must reject, not silently re-apply.
		await assert.rejects(Rows.put({ id: 'sequential', name: 'c' }, { ifVersion: version }), assertVersionConflict);

		assert.strictEqual(Rows.primaryStore.getEntry('sequential').value.name, 'b');
	});
});
