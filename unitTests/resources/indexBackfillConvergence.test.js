/**
 * Regression coverage for harper#2536: a secondary-index backfill that could not converge on a
 * large table because runIndexing (resources/databases.ts) (1) never used its resume checkpoint —
 * `start` stayed undefined and every retrigger rescanned from the first record — and (2) never
 * yielded the event loop on a plain index whose put resolves synchronously, so the whole backfill
 * ran as one uninterrupted turn.
 */
require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const { readFileSync, rmSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { setupTestDBPath } = require('../testUtils');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');
const {
	table,
	resetDatabases,
	closeDatabase,
	resumeStartKey,
	setIndexingCheckpointPeriod,
	CHECKPOINT_ALGORITHM,
} = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const DB = 'test';
const LMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const INDEXING_YIELD_INTERVAL = 100;

async function collect(iter) {
	const out = [];
	for await (const x of iter) out.push(x);
	return out;
}

function pad(i) {
	return String(i).padStart(4, '0');
}

// The per-attribute descriptor lives in Table.dbisDB under the table's key prefix; the dbisDB is
// shared by every table in the database, so scope the scan to this table.
function findDescriptor(Tbl, attrName) {
	const prefix = Tbl.tableName + '/';
	for (const { key, value } of Tbl.dbisDB.getRange({ start: false })) {
		if (value && value.name === attrName && key.toString().startsWith(prefix)) return { key, value };
	}
	return null;
}

// LMDB commits checkpoint writes asynchronously; every checkpoint put is queued by the time
// runIndexing resolves, so waiting for the queue to flush makes the read authoritative.
async function settledCheckpoint(Tbl, attrName) {
	await Tbl.dbisDB.flushed;
	return findDescriptor(Tbl, attrName).value.lastIndexedKey;
}

// Run the crash fixture as a child process; it is expected to SIGKILL itself, so a child that never
// reaches its marker is killed by the parent instead of wedging the run (.mocharc.json has timeout 0).
async function runCrashChild(args) {
	const child = spawn(process.execPath, [path.join(__dirname, 'indexBackfillConvergence-crash.js'), ...args], {
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	let stderr = '';
	child.stderr.on('data', (chunk) => (stderr += chunk));
	const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
	try {
		return await new Promise((resolve, reject) => {
			child.once('error', reject);
			child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
		});
	} finally {
		clearTimeout(timer);
	}
}

// Wrap Table.primaryStore.getRange so the test can observe the range runIndexing actually opens
// (its `start` option and every key it visits) and optionally abort the scan partway. runIndexing
// only reads the store after awaiting a schema-change signal and an event turn, so wrapping right
// after table() returns is early enough.
function observeRange(Tbl, { onKey, abortAfter } = {}) {
	const store = Tbl.primaryStore;
	const original = store.getRange;
	const observed = { start: undefined, keys: [] };
	store.getRange = function (options) {
		observed.start = options?.start;
		const inner = original.call(this, options);
		return {
			[Symbol.iterator]() {
				const iterator = inner[Symbol.iterator]();
				return {
					next: () => {
						if (abortAfter !== undefined && observed.keys.length >= abortAfter) {
							iterator.return?.();
							throw new Error('simulated primary-store iterator failure');
						}
						const result = iterator.next();
						if (!result.done) {
							observed.keys.push(result.value.key);
							onKey?.(result.value.key);
						}
						return result;
					},
					return: () => iterator.return?.(),
				};
			},
		};
	};
	observed.restore = () => {
		store.getRange = original;
	};
	return observed;
}

describe('resumeStartKey: minimum resume checkpoint across the attributes being built (#2536)', () => {
	it('returns the shared checkpoint when every attribute checkpointed at the same key', () => {
		assert.strictEqual(resumeStartKey([{ lastIndexedKey: 'k-0500' }, { lastIndexedKey: 'k-0500' }]), 'k-0500');
	});

	it('returns the minimum when the attributes checkpointed at different keys', () => {
		assert.strictEqual(
			resumeStartKey([{ lastIndexedKey: 'k-0700' }, { lastIndexedKey: 'k-0300' }, { lastIndexedKey: 'k-0500' }]),
			'k-0300'
		);
		assert.strictEqual(resumeStartKey([{ lastIndexedKey: 42 }, { lastIndexedKey: 7 }]), 7);
	});

	it('returns undefined (full scan) when any attribute has never checkpointed', () => {
		assert.strictEqual(resumeStartKey([{ lastIndexedKey: 'k-0700' }, {}]), undefined);
		assert.strictEqual(resumeStartKey([{ lastIndexedKey: 'k-0700' }, { lastIndexedKey: undefined }]), undefined);
	});

	it('returns the checkpoint of a single attribute', () => {
		assert.strictEqual(resumeStartKey([{ lastIndexedKey: 'k-0900' }]), 'k-0900');
	});
});

describe('index backfill convergence (#2536)', () => {
	// checkpoint at every yield interval instead of every few seconds, so small tables checkpoint
	let checkpointPolicy;
	before(() => {
		checkpointPolicy = setIndexingCheckpointPeriod(0, 0);
	});
	after(() => {
		setIndexingCheckpointPeriod(checkpointPolicy.ms, checkpointPolicy.minRecords);
	});

	it('resumes an interrupted backfill from its persisted checkpoint, not from the first record', async () => {
		const TABLE = 'BackfillResume';
		const N = 600;
		const ABORT_AFTER = 250;
		setupTestDBPath();
		setMainIsWorker(true);

		let Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }, { name: 'group' }],
		});
		let last;
		for (let i = 0; i < N; i++) last = Tbl.put({ id: 'k-' + pad(i), tag: 't-' + (i % 3), group: 'g-' + (i % 2) });
		await last;

		resetDatabases();
		Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
				{ name: 'group', indexed: true },
			],
		});
		assert.ok(Tbl.indexingOperation, 'adding indexed attributes should trigger a backfill');
		const firstPass = observeRange(Tbl, { abortAfter: ABORT_AFTER });
		try {
			await Tbl.indexingOperation;
		} finally {
			firstPass.restore();
		}
		assert.strictEqual(firstPass.keys.length, ABORT_AFTER, 'the first pass should have been aborted partway');
		// runIndexing checkpoints every 100 entries it visits (LMDB yields a leading structures entry
		// too), once the index writes the checkpoint covers have settled; LMDB commits those
		// asynchronously, so the last checkpoint can land after the interruption itself was recorded.
		const checkpoint = firstPass.keys[199];
		assert.strictEqual(await settledCheckpoint(Tbl, 'tag'), checkpoint, 'the last checkpoint should be persisted');
		for (const name of ['tag', 'group']) {
			const parked = findDescriptor(Tbl, name);
			assert.strictEqual(parked?.value.indexingFailed, true, `${name}: interrupted backfill should be parked`);
			assert.strictEqual(parked.value.lastIndexedKey, checkpoint, `${name}: checkpoint should be persisted`);
			assert.strictEqual(parked.value.checkpointCertified, checkpoint, `${name}: checkpoint should be stamped`);
		}

		// The parked descriptor retriggers the backfill; it must open its scan at the checkpoint.
		resetDatabases();
		const Tbl2 = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
				{ name: 'group', indexed: true },
			],
		});
		assert.ok(Tbl2.indexingOperation, 'a parked backfill should retrigger');
		const resumed = observeRange(Tbl2);
		try {
			await Tbl2.indexingOperation;
		} finally {
			resumed.restore();
		}

		assert.strictEqual(resumed.start, checkpoint, 'the resumed scan should start at the persisted checkpoint');
		assert.strictEqual(resumed.keys[0], checkpoint, 'the first key visited after resume should be the checkpoint');
		assert.strictEqual(
			resumed.keys.length,
			N - Number(checkpoint.slice(2)),
			'the resumed scan should only cover the checkpoint and the records after it'
		);

		for (const name of ['tag', 'group']) {
			const done = findDescriptor(Tbl2, name);
			assert.strictEqual(done.value.indexingFailed, undefined, `${name}: indexingFailed cleared after completion`);
			assert.strictEqual(done.value.lastIndexedKey, undefined, `${name}: checkpoint cleared after completion`);
			assert.strictEqual(done.value.checkpointCertified, undefined, `${name}: stamp cleared after completion`);
		}
		let total = 0;
		for (const v of ['t-0', 't-1', 't-2']) {
			total += (await collect(Tbl2.search({ conditions: [{ attribute: 'tag', value: v }] }))).length;
		}
		assert.strictEqual(total, N, 'every row should be indexed once the resumed backfill completes');
	});

	// A failed index write must freeze the checkpoint before that record whether it throws
	// synchronously (RocksDB) or a non-last value's put rejects asynchronously (LMDB), since only a
	// record's last put is awaited.
	for (const { failure, tagOf, failPut, secondAttribute } of [
		{
			failure: 'throws synchronously',
			tagOf: (i) => 't-' + (i % 3),
			failPut: () => {
				throw new Error('simulated transient index put failure');
			},
		},
		{
			failure: 'rejects asynchronously on a non-last value',
			tagOf: (i) => ['t-' + (i % 3), 'u-' + (i % 5)],
			failPut: () =>
				new Promise((_, reject) => setImmediate(() => reject(new Error('simulated async index put failure')))),
		},
		{
			failure: "rejects asynchronously while a later attribute's put resolves",
			tagOf: (i) => 't-' + (i % 3),
			failPut: () =>
				new Promise((_, reject) => setImmediate(() => reject(new Error('simulated async index put failure')))),
			secondAttribute: true,
		},
	]) {
		it(`does not advance the checkpoint past a record whose index write ${failure}, so the retry re-covers it`, async () => {
			const TABLE = 'BackfillFailedRecord' + (Array.isArray(tagOf(0)) ? 'Multi' : secondAttribute ? 'Two' : '');
			const N = 600;
			const FAILING_ID = 'k-' + pad(250);
			const failingValue = [].concat(tagOf(250))[0];
			const indexedAttributes = [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
				{ name: 'group', indexed: !!secondAttribute },
			];
			setupTestDBPath();
			setMainIsWorker(true);

			let Tbl = table({
				table: TABLE,
				database: DB,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }, { name: 'group' }],
			});
			let last;
			for (let i = 0; i < N; i++) last = Tbl.put({ id: 'k-' + pad(i), tag: tagOf(i), group: 'g-' + (i % 2) });
			await last;

			resetDatabases();
			Tbl = table({ table: TABLE, database: DB, attributes: indexedAttributes });
			assert.ok(Tbl.indexingOperation, 'adding an indexed attribute should trigger a backfill');
			const tagIndex = Tbl.indices.tag;
			const originalPut = tagIndex.put;
			tagIndex.put = function (indexedValue, primaryKey, options) {
				if (primaryKey === FAILING_ID && indexedValue === failingValue) return failPut();
				return originalPut.call(this, indexedValue, primaryKey, options);
			};
			const firstPass = observeRange(Tbl);
			try {
				await Tbl.indexingOperation;
			} finally {
				tagIndex.put = originalPut;
				firstPass.restore();
			}
			const failedAt = firstPass.keys.indexOf(FAILING_ID);
			const lastSafeCheckpoint = firstPass.keys[Math.floor(failedAt / 100) * 100 - 1];
			const parked = findDescriptor(Tbl, 'tag');
			assert.strictEqual(parked?.value.indexingFailed, true, 'a backfill with a failed record should be parked');
			const persisted = await settledCheckpoint(Tbl, 'tag');
			if (LMDB) {
				// checkpoints wait for their writes to commit, so a failure that lands first withholds them
				const safe = [undefined, ...firstPass.keys.slice(0, failedAt).filter((_, i) => i % 100 === 99)];
				assert.ok(safe.includes(persisted), `checkpoint ${persisted} must not pass the failed record`);
			} else {
				assert.strictEqual(
					persisted,
					lastSafeCheckpoint,
					'the checkpoint must stop at the last one written before the failed record'
				);
			}

			resetDatabases();
			const Tbl2 = table({ table: TABLE, database: DB, attributes: indexedAttributes });
			assert.ok(Tbl2.indexingOperation, 'a parked backfill should retrigger');
			const resumed = observeRange(Tbl2);
			try {
				await Tbl2.indexingOperation;
			} finally {
				resumed.restore();
			}
			assert.strictEqual(resumed.start, persisted, 'the retry should resume from the persisted safe checkpoint');
			assert.ok(resumed.keys.includes(FAILING_ID), 'the retry must revisit the record that failed');
			assert.strictEqual(
				findDescriptor(Tbl2, 'tag').value.indexingFailed,
				undefined,
				'the retry should complete cleanly'
			);
			const viaIndex = await collect(Tbl2.search({ conditions: [{ attribute: 'tag', value: failingValue }] }));
			assert.ok(
				viaIndex.some((row) => row.id === FAILING_ID),
				'the record whose index write failed must be indexed after the retry'
			);
		});
	}

	// A record fans out into one index put per indexed value and only the last was ever awaited, so a
	// rejection from any earlier one used to be seen only if it happened to settle before the next
	// checkpoint. These cases release the rejection at a chosen point in the scan instead of on a timer,
	// so the interleaving is the same on a fast and a slow runner.
	function deferredPut(release) {
		let reject;
		const promise = new Promise((_, r) => (reject = r));
		promise.catch(() => {}); // the rejection is delivered through runIndexing's own handler
		release.issued = true;
		release.fire = () => reject(new Error('simulated deferred index put failure'));
		return promise;
	}

	async function waitFor(condition, what, timeoutMs = 20000) {
		const deadline = Date.now() + timeoutMs;
		while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(condition(), `timed out waiting for ${what}`);
	}

	it('freezes the checkpoint when an index write rejects only after a later checkpoint was reached', async () => {
		const TABLE = 'BackfillLateRejection';
		const N = 600;
		const FAILING_ID = 'k-' + pad(250);
		// Past the k-0299 checkpoint the failed record must not reach, and before the next one at k-0399,
		// so the scan is never waiting on the release.
		const RELEASE_AT = 'k-' + pad(310);
		setupTestDBPath();
		setMainIsWorker(true);

		let Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		for (let i = 0; i < N; i++) last = Tbl.put({ id: 'k-' + pad(i), tag: ['t-' + (i % 3), 'u-' + (i % 5)] });
		await last;

		resetDatabases();
		Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		assert.ok(Tbl.indexingOperation, 'adding an indexed attribute should trigger a backfill');
		const release = {};
		const tagIndex = Tbl.indices.tag;
		const originalPut = tagIndex.put;
		tagIndex.put = function (indexedValue, primaryKey, options) {
			// the first of the record's two values, so a resolving put follows it
			if (primaryKey === FAILING_ID && indexedValue === 't-1') return deferredPut(release);
			return originalPut.call(this, indexedValue, primaryKey, options);
		};
		const observed = observeRange(Tbl, {
			onKey: (key) => {
				if (key === RELEASE_AT) release.fire();
			},
		});
		try {
			await Tbl.indexingOperation;
		} finally {
			tagIndex.put = originalPut;
			observed.restore();
		}

		const parked = findDescriptor(Tbl, 'tag').value;
		assert.strictEqual(parked.indexingFailed, true, 'a backfill with a failed record should be parked');
		const persisted = await settledCheckpoint(Tbl, 'tag');
		assert.ok(
			persisted === undefined || persisted < FAILING_ID,
			`checkpoint ${persisted} must not pass the failed record ${FAILING_ID}`
		);

		resetDatabases();
		const Tbl2 = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		assert.ok(Tbl2.indexingOperation, 'a parked backfill should retrigger');
		const resumed = observeRange(Tbl2);
		try {
			await Tbl2.indexingOperation;
		} finally {
			resumed.restore();
		}
		assert.ok(resumed.keys.includes(FAILING_ID), 'the retry must revisit the record that failed');
		const viaIndex = await collect(Tbl2.search({ conditions: [{ attribute: 'tag', value: 't-1' }] }));
		assert.ok(
			viaIndex.some((row) => row.id === FAILING_ID),
			'the record whose index write failed must be indexed after the retry'
		);
	});

	it('does not declare the index complete while an index write is still in flight', async () => {
		const TABLE = 'BackfillCompletionRace';
		const N = 400;
		const FAILING_ID = 'k-' + pad(250);
		setupTestDBPath();
		setMainIsWorker(true);

		let Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		for (let i = 0; i < N; i++) last = Tbl.put({ id: 'k-' + pad(i), tag: ['t-' + (i % 3), 'u-' + (i % 5)] });
		await last;

		resetDatabases();
		Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		assert.ok(Tbl.indexingOperation, 'adding an indexed attribute should trigger a backfill');
		const release = {};
		const tagIndex = Tbl.indices.tag;
		const originalPut = tagIndex.put;
		tagIndex.put = function (indexedValue, primaryKey, options) {
			if (primaryKey === FAILING_ID && indexedValue === 't-1') return deferredPut(release);
			return originalPut.call(this, indexedValue, primaryKey, options);
		};
		let settled = false;
		Tbl.indexingOperation.then(
			() => (settled = true),
			() => (settled = true)
		);
		// The scan has to reach the failing record before there is anything to release; a loaded runner
		// only makes that slower, never skips it.
		await waitFor(() => release.issued || settled, 'the failing index write to be issued');
		// Release as soon as indexing resolves, which is what a build that ignores the unsettled write
		// does; the deadline only bounds the case where it correctly refuses to resolve. So a slow runner
		// can make this test lenient, never make it fail spuriously.
		const deadline = Date.now() + 2000;
		while (!settled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(release.issued, 'the failing index write should have been issued by now');
		release.fire();
		try {
			await Tbl.indexingOperation;
		} finally {
			tagIndex.put = originalPut;
		}
		assert.strictEqual(
			findDescriptor(Tbl, 'tag').value.indexingFailed,
			true,
			'the build must be parked, not completed, when a write it issued rejected'
		);
	});

	// LMDB only: RocksDB awaits its clear inline, so only the LMDB path enqueues one whose rejection the
	// barriers have to catch. A full rebuild clears first, so a rejected clear is the one way a checkpoint
	// could certify over stale index entries with no put ever failing.
	(LMDB ? it : it.skip)('parks the build when the clear that precedes a full rebuild rejects', async () => {
		const TABLE = 'BackfillClearRejects';
		const N = 300;
		setupTestDBPath();
		setMainIsWorker(true);

		let Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		for (let i = 0; i < N; i++) last = Tbl.put({ id: 'k-' + pad(i), tag: 't-' + (i % 3) });
		await last;

		resetDatabases();
		Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		assert.ok(Tbl.indexingOperation, 'adding an indexed attribute should trigger a backfill');
		const tagIndex = Tbl.indices.tag;
		assert.strictEqual(typeof tagIndex.clearAsync, 'function', 'the LMDB path should clear asynchronously');
		let cleared = false;
		tagIndex.clearAsync = () => {
			cleared = true;
			return new Promise((_, reject) => setTimeout(() => reject(new Error('simulated clear failure')), 25));
		};
		await Tbl.indexingOperation;
		assert.ok(cleared, 'a full rebuild should have cleared the index first');
		assert.strictEqual(
			findDescriptor(Tbl, 'tag').value.indexingFailed,
			true,
			'a rejected clear must park the build rather than let it complete'
		);
	});

	it('bounds how many index writes it leaves in flight', async () => {
		const TABLE = 'BackfillBackpressure';
		const N = 4000;
		setupTestDBPath();
		setMainIsWorker(true);

		let Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		for (let i = 0; i < N; i++) last = Tbl.put({ id: 'k-' + pad(i), tag: ['t-' + (i % 3), 'u-' + (i % 5)] });
		await last;

		resetDatabases();
		Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		assert.ok(Tbl.indexingOperation, 'adding an indexed attribute should trigger a backfill');
		const tagIndex = Tbl.indices.tag;
		const originalPut = tagIndex.put;
		// The first value of each record resolves only after a delay, the second immediately: the shape
		// that leaves one unsettled write per record behind a per-record counter.
		let inFlight = 0;
		let peakInFlight = 0;
		tagIndex.put = function (indexedValue, primaryKey, options) {
			const result = originalPut.call(this, indexedValue, primaryKey, options);
			if (!String(indexedValue).startsWith('t-')) return result;
			inFlight++;
			if (inFlight > peakInFlight) peakInFlight = inFlight;
			return new Promise((resolve) =>
				setTimeout(() => {
					inFlight--;
					resolve(result);
				}, 400)
			);
		};
		try {
			await Tbl.indexingOperation;
		} finally {
			tagIndex.put = originalPut;
		}
		assert.ok(peakInFlight > 0, 'the slow puts should actually have been in flight');
		// MAX_OUTSTANDING_INDEXING is 1000; the loop checks after issuing a record's writes, so it may
		// overshoot by that record's fan-out before the bound applies.
		assert.ok(
			peakInFlight <= 1100,
			`the backfill left ${peakInFlight} index writes in flight, past the outstanding bound`
		);
	});

	it('rebuilds instead of resuming a checkpoint stamped by an earlier checkpoint algorithm', async () => {
		const TABLE = 'BackfillLegacyStamp';
		const N = 400;
		setupTestDBPath();
		setMainIsWorker(true);

		let Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		for (let i = 0; i < N; i++) last = Tbl.put({ id: 'k-' + pad(i), tag: 't-' + (i % 3) });
		await last;

		resetDatabases();
		Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		await Tbl.indexingOperation;

		// A checkpoint the pre-fix code left behind: certified and self-consistent, but possibly advanced
		// past a record whose index write failed, so it must not be resumed from.
		const { key, value } = findDescriptor(Tbl, 'tag');
		value.indexingFailed = true;
		value.lastIndexedKey = 'k-' + pad(200);
		value.checkpointCertified = value.lastIndexedKey;
		delete value.checkpointAlgorithm;
		Tbl.dbisDB.putSync(key, value);

		resetDatabases();
		const Tbl2 = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		assert.ok(Tbl2.indexingOperation, 'a parked index should retrigger');
		const resumed = observeRange(Tbl2);
		try {
			await Tbl2.indexingOperation;
		} finally {
			resumed.restore();
		}
		assert.strictEqual(resumed.start, undefined, 'an unversioned checkpoint must force a full rebuild');
	});

	it('resumes from the minimum of unequal persisted checkpoints, and scans everything when one is absent', async () => {
		const TABLE = 'BackfillUnequalCheckpoints';
		const N = 500;
		setupTestDBPath();
		setMainIsWorker(true);

		let Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }, { name: 'group' }],
		});
		let last;
		for (let i = 0; i < N; i++) last = Tbl.put({ id: 'k-' + pad(i), tag: 't-' + (i % 3), group: 'g-' + (i % 2) });
		await last;
		const indexedAttributes = [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'tag', indexed: true },
			{ name: 'group', indexed: true },
		];
		resetDatabases();
		Tbl = table({ table: TABLE, database: DB, attributes: indexedAttributes });
		await Tbl.indexingOperation;

		// Park both indexes at different checkpoints, the way two attributes whose checkpoint writes
		// straddled an interruption would be left.
		const park = (Tbl, checkpoints, { certified = true } = {}) => {
			for (const [name, lastIndexedKey] of Object.entries(checkpoints)) {
				const { key, value } = findDescriptor(Tbl, name);
				value.indexingFailed = true;
				delete value.checkpointCertified;
				delete value.checkpointAlgorithm;
				if (lastIndexedKey === undefined) delete value.lastIndexedKey;
				else {
					value.lastIndexedKey = lastIndexedKey;
					if (certified) {
						value.checkpointCertified = lastIndexedKey;
						value.checkpointAlgorithm = CHECKPOINT_ALGORITHM;
					}
				}
				Tbl.dbisDB.putSync(key, value);
			}
		};
		park(Tbl, { tag: 'k-' + pad(300), group: 'k-' + pad(200) });
		resetDatabases();
		let Tbl2 = table({ table: TABLE, database: DB, attributes: indexedAttributes });
		assert.ok(Tbl2.indexingOperation, 'parked indexes should retrigger');
		let resumed = observeRange(Tbl2);
		try {
			await Tbl2.indexingOperation;
		} finally {
			resumed.restore();
		}
		assert.strictEqual(resumed.start, 'k-' + pad(200), 'the scan should start at the lower checkpoint');
		assert.strictEqual(resumed.keys[0], 'k-' + pad(200));

		park(Tbl2, { tag: 'k-' + pad(300), group: undefined });
		resetDatabases();
		Tbl2 = table({ table: TABLE, database: DB, attributes: indexedAttributes });
		assert.ok(Tbl2.indexingOperation, 'parked indexes should retrigger');
		resumed = observeRange(Tbl2);
		try {
			await Tbl2.indexingOperation;
		} finally {
			resumed.restore();
		}
		assert.strictEqual(resumed.start, undefined, 'an attribute with no checkpoint forces a full scan');
		assert.strictEqual(
			resumed.keys.find((key) => typeof key === 'string'),
			'k-' + pad(0)
		);
		for (const name of ['tag', 'group']) {
			assert.strictEqual(findDescriptor(Tbl2, name).value.lastIndexedKey, undefined, `${name}: completed`);
		}
		const evens = await collect(Tbl2.search({ conditions: [{ attribute: 'group', value: 'g-0' }] }));
		assert.strictEqual(evens.length, N / 2, 'the cleared index should be fully repopulated');

		// A checkpoint written by a release without the stamp advanced past failed and unflushed index
		// writes, so it must not be resumed: full rebuild, including the clear of the existing entries.
		park(Tbl2, { tag: 'k-' + pad(300), group: 'k-' + pad(300) }, { certified: false });
		resetDatabases();
		Tbl2 = table({ table: TABLE, database: DB, attributes: indexedAttributes });
		assert.ok(Tbl2.indexingOperation, 'a parked legacy checkpoint should retrigger');
		resumed = observeRange(Tbl2);
		try {
			await Tbl2.indexingOperation;
		} finally {
			resumed.restore();
		}
		assert.strictEqual(resumed.start, undefined, 'an unstamped legacy checkpoint must not be resumed');
		assert.strictEqual(
			resumed.keys.find((key) => typeof key === 'string'),
			'k-' + pad(0)
		);
		const odds = await collect(Tbl2.search({ conditions: [{ attribute: 'group', value: 'g-1' }] }));
		assert.strictEqual(odds.length, N / 2, 'the rebuilt index should be complete');
	});

	it('resumes from the checkpoint a process killed mid-backfill left behind', async () => {
		const DATABASE = 'backfillcrash';
		const TABLE = 'BackfillCrash';
		const N = 10000;
		const dbPath = setupTestDBPath();
		setMainIsWorker(true);
		// The database under test lives outside storage.path and is opened only by the child until
		// it is dead, so no store is ever shared between the two processes.
		const crashDir = path.join(dbPath, 'backfill-crash');
		rmSync(crashDir, { recursive: true, force: true });
		const markerPath = path.join(crashDir, 'checkpoint.marker');
		const databasesConfig = env.get(terms.CONFIG_PARAMS.DATABASES);
		env.setProperty(terms.CONFIG_PARAMS.DATABASES, {
			...databasesConfig,
			[DATABASE]: { path: path.join(crashDir, 'shared') },
		});

		const { code, signal, stderr } = await runCrashChild([
			path.join(crashDir, 'child-root'),
			path.join(crashDir, 'shared'),
			DATABASE,
			TABLE,
			markerPath,
			String(N),
			'kill-at-checkpoint',
		]);
		assert.strictEqual(
			signal,
			'SIGKILL',
			`the child should have killed itself at its first checkpoint (exit ${code}): ${stderr}`
		);
		const checkpoint = readFileSync(markerPath, 'utf8');
		assert.match(checkpoint, /^c-\d{6}$/, 'the child should have recorded a durable checkpoint');

		// The dead process's PID on the descriptor is the crash-recovery trigger.
		const Tbl = table({
			table: TABLE,
			database: DATABASE,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		try {
			assert.ok(Tbl.indexingOperation, 'reopening after the crash should retrigger the backfill');
			const resumed = observeRange(Tbl);
			try {
				await Tbl.indexingOperation;
			} finally {
				resumed.restore();
			}
			if (LMDB) {
				// the child read a committed checkpoint, but LMDB's write thread can commit the next one
				// (already queued) before the kill lands
				assert.ok(resumed.start >= checkpoint, `the resumed scan should start at or after ${checkpoint}`);
			} else {
				assert.strictEqual(
					resumed.start,
					checkpoint,
					"the resumed scan should start at the crashed process's checkpoint"
				);
			}
			assert.strictEqual(resumed.keys[0], resumed.start);
			assert.strictEqual(
				findDescriptor(Tbl, 'tag').value.indexingPID,
				undefined,
				'the resumed backfill should complete'
			);
			let total = 0;
			for (let i = 0; i < 7; i++) {
				total += (await collect(Tbl.search({ conditions: [{ attribute: 'tag', value: 't-' + i }] }))).length;
			}
			assert.strictEqual(total, N, 'every row should be indexed after the resumed backfill');
		} finally {
			closeDatabase(DATABASE);
			env.setProperty(terms.CONFIG_PARAMS.DATABASES, databasesConfig);
		}
	});

	it('flushes the tail written since the last checkpoint before announcing the index complete', async () => {
		const DATABASE = 'backfillcomplete';
		const TABLE = 'BackfillComplete';
		const N = 10000;
		const dbPath = setupTestDBPath();
		setMainIsWorker(true);
		const crashDir = path.join(dbPath, 'backfill-complete');
		rmSync(crashDir, { recursive: true, force: true });
		const markerPath = path.join(crashDir, 'complete.marker');
		const databasesConfig = env.get(terms.CONFIG_PARAMS.DATABASES);
		env.setProperty(terms.CONFIG_PARAMS.DATABASES, {
			...databasesConfig,
			[DATABASE]: { path: path.join(crashDir, 'shared') },
		});

		// a long period means the whole index is the unflushed tail when the ready descriptor lands
		const { code, signal, stderr } = await runCrashChild([
			path.join(crashDir, 'child-root'),
			path.join(crashDir, 'shared'),
			DATABASE,
			TABLE,
			markerPath,
			String(N),
			'kill-after-complete',
		]);
		assert.strictEqual(
			signal,
			'SIGKILL',
			`the child should have killed itself once complete (exit ${code}): ${stderr}`
		);
		assert.strictEqual(readFileSync(markerPath, 'utf8'), 'COMPLETED');

		const Tbl = table({
			table: TABLE,
			database: DATABASE,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		try {
			assert.strictEqual(Tbl.indexingOperation, undefined, 'a completed index must not retrigger');
			let total = 0;
			for (let i = 0; i < 7; i++) {
				total += (await collect(Tbl.search({ conditions: [{ attribute: 'tag', value: 't-' + i }] }))).length;
			}
			assert.strictEqual(total, N, 'every index entry must survive a kill right after completion');
		} finally {
			closeDatabase(DATABASE);
			env.setProperty(terms.CONFIG_PARAMS.DATABASES, databasesConfig);
		}
	});

	it('parks the index instead of certifying a checkpoint or completing when the flush fails', async function () {
		if (LMDB) return this.skip(); // LMDB commits in order and never flushes
		const TABLE = 'BackfillFlushFails';
		const N = 300;
		setupTestDBPath();
		setMainIsWorker(true);

		let Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		for (let i = 0; i < N; i++) last = Tbl.put({ id: 'k-' + pad(i), tag: 't-' + (i % 3) });
		await last;

		resetDatabases();
		Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		assert.ok(Tbl.indexingOperation, 'adding an indexed attribute should trigger a backfill');
		const rootStore = Tbl.primaryStore.rootStore;
		const originalFlush = rootStore.flush;
		rootStore.flush = () => Promise.reject(new Error('simulated flush failure'));
		try {
			await Tbl.indexingOperation;
		} finally {
			rootStore.flush = originalFlush;
		}
		const parked = findDescriptor(Tbl, 'tag');
		assert.strictEqual(parked.value.indexingFailed, true, 'the index must stay parked when it cannot be flushed');
		assert.strictEqual(parked.value.lastIndexedKey, undefined, 'no checkpoint may be certified without a flush');

		resetDatabases();
		const Tbl2 = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		assert.ok(Tbl2.indexingOperation, 'the parked index should retrigger');
		await Tbl2.indexingOperation;
		assert.strictEqual(findDescriptor(Tbl2, 'tag').value.indexingFailed, undefined, 'the retry should complete');
	});

	it('does not persist a checkpoint before the record floor, whatever the period', async () => {
		const TABLE = 'BackfillCheckpointFloor';
		const N = 25000;
		const FLOOR = 10000;
		setupTestDBPath();
		setMainIsWorker(true);

		let Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		for (let i = 0; i < N; i++) last = Tbl.put({ id: 'f-' + String(i).padStart(5, '0'), tag: 't-' + (i % 3) });
		await last;

		const policy = setIndexingCheckpointPeriod(0, FLOOR);
		try {
			resetDatabases();
			Tbl = table({
				table: TABLE,
				database: DB,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'tag', indexed: true },
				],
			});
			assert.ok(Tbl.indexingOperation, 'adding an indexed attribute should trigger a backfill');
			const checkpoints = [];
			const originalPut = Tbl.dbisDB.put;
			Tbl.dbisDB.put = function (key, value, options) {
				if (value?.name === 'tag' && value.lastIndexedKey !== undefined) checkpoints.push(value.lastIndexedKey);
				return originalPut.call(this, key, value, options);
			};
			try {
				await Tbl.indexingOperation;
			} finally {
				Tbl.dbisDB.put = originalPut;
			}
			assert.ok(checkpoints.length > 0, 'a 25k-row backfill should checkpoint');
			const stringKeys = (key) => typeof key === 'string';
			const visitedBefore = (key) => Number(key.slice(2)) + (LMDB ? 1 : 0) + 1;
			assert.ok(
				visitedBefore(checkpoints[0]) >= FLOOR,
				`the first checkpoint ${checkpoints[0]} should come after ${FLOOR} records`
			);
			for (let i = 1; i < checkpoints.length; i++) {
				assert.ok(
					visitedBefore(checkpoints[i]) - visitedBefore(checkpoints[i - 1]) >= FLOOR,
					`checkpoints ${checkpoints[i - 1]} and ${checkpoints[i]} are closer than ${FLOOR} records`
				);
			}
			assert.ok(checkpoints.every(stringKeys));
		} finally {
			setIndexingCheckpointPeriod(policy.ms, policy.minRecords);
		}
	});

	it('yields the event loop at a bounded record interval on a plain index whose put resolves synchronously', async () => {
		const TABLE = 'BackfillYield';
		const N = 2000;
		setupTestDBPath();
		setMainIsWorker(true);

		let Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		for (let i = 0; i < N; i++) last = Tbl.put({ id: 'y-' + pad(i), tag: 't-' + (i % 5) });
		await last;

		resetDatabases();
		Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		assert.ok(Tbl.indexingOperation, 'adding an indexed attribute should trigger a backfill');

		// A setImmediate ticker advances once per event-loop turn the backfill gives up; stamp each
		// visited key with the current tick so the longest run of keys on one tick is the longest
		// stretch the loop ran without yielding.
		let tick = 0;
		let running = true;
		const ticksPerKey = [];
		const ticker = () => {
			if (!running) return;
			tick++;
			setImmediate(ticker);
		};
		setImmediate(ticker);
		const observed = observeRange(Tbl, {
			onKey: (key) => {
				if (typeof key === 'string') ticksPerKey.push(tick);
			},
		});
		try {
			await Tbl.indexingOperation;
		} finally {
			running = false;
			observed.restore();
		}

		assert.strictEqual(ticksPerKey.length, N, 'the backfill should visit every record');
		let longestRun = 0;
		let run = 0;
		for (let i = 0; i < ticksPerKey.length; i++) {
			run = i > 0 && ticksPerKey[i] === ticksPerKey[i - 1] ? run + 1 : 1;
			if (run > longestRun) longestRun = run;
		}
		// LMDB index puts are asynchronous, so the pre-existing backpressure branch yields more often there
		if (LMDB) {
			assert.ok(
				longestRun <= INDEXING_YIELD_INTERVAL,
				`backfill ran ${longestRun} records without yielding the event loop (bound ${INDEXING_YIELD_INTERVAL})`
			);
		} else {
			assert.ok(
				longestRun >= INDEXING_YIELD_INTERVAL / 2 && longestRun <= INDEXING_YIELD_INTERVAL,
				`backfill should yield the event loop every ${INDEXING_YIELD_INTERVAL} records, ran ${longestRun}`
			);
		}
		const complete = await collect(Tbl.search({ conditions: [{ attribute: 'tag', value: 't-0' }] }));
		assert.strictEqual(complete.length, N / 5, 'the backfill should still index every row');
	});
});
