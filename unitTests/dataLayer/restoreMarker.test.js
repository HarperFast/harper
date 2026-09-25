'use strict';

const assert = require('node:assert');
const {
	appendFileSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} = require('node:fs');
const { basename, dirname, join } = require('node:path');
const { tmpdir } = require('node:os');
const { tryFileLock, fileLockRelease } = require('@harperfast/rocksdb-js');
const {
	beginRestore,
	beginDatabaseDrop,
	completeRestore,
	completeDatabaseDrop,
	abandonRestore,
	abandonDatabaseDrop,
	cancelDatabaseDrop,
	acquireRestoreLock,
	releaseRestoreLock,
	clearRestoreMarker,
	checkRestoreState,
	restoreMarkerPresent,
	restoreLockPath,
	restoringMarkerPath,
	droppingMarkerPath,
	restoreMetaDir,
	scanBlockedRestores,
	scanBlockedDatabaseDrops,
	RESTORE_META_DIR,
} = require('#src/dataLayer/restoreMarker');

describe('restoreMarker', function () {
	let tempDir;
	let dbPath;

	beforeEach(function () {
		tempDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.restore-marker-'));
		dbPath = join(tempDir, 'somedb');
	});

	afterEach(function () {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe('paths', function () {
		it('keeps restore metadata in an isolated sibling directory, out of the database-name namespace', function () {
			const metaDir = restoreMetaDir(dbPath);
			assert.strictEqual(metaDir, join(tempDir, RESTORE_META_DIR));
			// both files live under the metadata dir, keyed by a hash — not suffixed onto the db name
			assert.strictEqual(dirname(restoreLockPath(dbPath)), metaDir);
			assert.strictEqual(dirname(restoringMarkerPath(dbPath)), metaDir);
			assert.ok(!restoringMarkerPath(dbPath).startsWith(dbPath), 'marker must not be dbPath + suffix');
			// the metadata dir name must be an illegal database name so it can never collide with one
			// (schemaRegex forbids only `/` and a backtick among filesystem-legal characters)
			assert.ok(RESTORE_META_DIR.includes('`'), 'metadata dir name must contain a backtick');
		});

		it('does not collide with a database literally named ".restore" (a legal database name)', function () {
			const dotRestore = join(tempDir, '.restore');
			// a real .restore database directory would be purged on restore; the marker must NOT live
			// inside it, or purgeAllFiles would delete the marker and completeRestore would ENOENT
			const lock = beginRestore(dotRestore);
			try {
				assert.ok(
					!restoringMarkerPath(dotRestore).startsWith(dotRestore + require('node:path').sep),
					'marker must not be written inside the .restore database directory'
				);
				assert.ok(existsSync(restoringMarkerPath(dotRestore)));
			} finally {
				completeRestore(lock); // must not throw ENOENT
			}
			assert.strictEqual(checkRestoreState(dotRestore), 'clear');
		});

		it('a database literally named like a marker suffix does not collide with another database', function () {
			// `orders.restoring` is a legal database name; under the old suffix scheme it would be
			// mistaken for the restore marker of `orders`
			const orders = join(tempDir, 'orders');
			const ordersRestoring = join(tempDir, 'orders.restoring');
			assert.notStrictEqual(restoringMarkerPath(orders), restoringMarkerPath(ordersRestoring));
			assert.notStrictEqual(restoringMarkerPath(orders), ordersRestoring);
		});

		it('handles maximum-length (250-char) database names without exceeding NAME_MAX', function () {
			const longName = 'd'.repeat(250);
			const longPath = join(tempDir, longName);
			for (const p of [restoreLockPath(longPath), restoringMarkerPath(longPath)]) {
				assert.ok(basename(p).length <= 255, `metadata filename ${basename(p).length} exceeds NAME_MAX`);
			}
			// and it is actually creatable
			const lock = beginRestore(longPath);
			assert.ok(existsSync(restoringMarkerPath(longPath)));
			completeRestore(lock);
		});
	});

	describe('checkRestoreState', function () {
		it('is clear when neither lock nor marker exists', function () {
			assert.strictEqual(checkRestoreState(dbPath), 'clear');
		});

		it('is in-progress while a restore holds the lock', function () {
			const lock = beginRestore(dbPath);
			try {
				assert.strictEqual(checkRestoreState(dbPath), 'in-progress');
			} finally {
				completeRestore(lock);
			}
		});

		it('is incomplete when the marker survives an abandoned restore', function () {
			const lock = beginRestore(dbPath);
			abandonRestore(lock);
			assert.strictEqual(checkRestoreState(dbPath), 'incomplete');
			assert.ok(existsSync(restoringMarkerPath(dbPath)));
		});

		it('is clear again after a completed restore, even though the lock file persists', function () {
			const lock = beginRestore(dbPath);
			completeRestore(lock);
			assert.ok(existsSync(restoreLockPath(dbPath)), 'unheld lock file is expected to persist');
			assert.ok(!existsSync(restoringMarkerPath(dbPath)), 'marker must be deleted on completion');
			assert.strictEqual(checkRestoreState(dbPath), 'clear');
		});

		it('probing the state does not release a held lock', function () {
			const lock = beginRestore(dbPath);
			try {
				checkRestoreState(dbPath);
				assert.strictEqual(checkRestoreState(dbPath), 'in-progress');
			} finally {
				completeRestore(lock);
			}
		});

		it('never probes the lock when no marker exists (marker-first), so rescans cannot collide on a stale lock file', function () {
			// simulate the persistent lock file of a long-ago-completed restore, held the way a
			// colliding sibling probe would hold it
			mkdirSync(restoreMetaDir(dbPath), { recursive: true });
			writeFileSync(restoreLockPath(dbPath), '');
			const token = tryFileLock(restoreLockPath(dbPath));
			assert.notStrictEqual(token, 0);
			try {
				assert.strictEqual(checkRestoreState(dbPath), 'clear');
			} finally {
				fileLockRelease(token);
			}
		});
	});

	describe('beginRestore', function () {
		it('writes the marker while holding the lock', function () {
			const lock = beginRestore(dbPath);
			try {
				assert.ok(existsSync(restoringMarkerPath(dbPath)));
				assert.strictEqual(lock.preexisting, false);
			} finally {
				completeRestore(lock);
			}
		});

		it('fails with 409 when a restore is already in progress', function () {
			const lock = beginRestore(dbPath);
			try {
				assert.throws(
					() => beginRestore(dbPath),
					(error) => error.statusCode === 409 && /already in progress/.test(error.message)
				);
			} finally {
				completeRestore(lock);
			}
		});

		it('reports preexisting=true when a marker from a crashed restore is already present', function () {
			abandonRestore(beginRestore(dbPath)); // leaves the marker (incomplete)
			assert.strictEqual(checkRestoreState(dbPath), 'incomplete');
			const rerun = beginRestore(dbPath);
			try {
				assert.strictEqual(rerun.preexisting, true, 'a recovery run must know the marker pre-existed');
			} finally {
				completeRestore(rerun);
			}
		});

		it('a rerun after an abandoned restore succeeds and clears the marker', function () {
			abandonRestore(beginRestore(dbPath));
			assert.strictEqual(checkRestoreState(dbPath), 'incomplete');
			const lock = beginRestore(dbPath);
			completeRestore(lock);
			assert.strictEqual(checkRestoreState(dbPath), 'clear');
		});

		it('leaves an intact marker byte-identical on a recovery attempt', function () {
			// The marker a recovery attempt finds is the only thing keeping a possibly half-purged
			// directory from loading as healthy. Rewriting it opens a window where a crash leaves it
			// empty — which scanBlockedRestores reads as "no block".
			abandonRestore(beginRestore(dbPath));
			appendFileSync(restoringMarkerPath(dbPath), 'written by the interrupted restore\n');
			const before = readFileSync(restoringMarkerPath(dbPath), 'utf8');

			const rerun = beginRestore(dbPath);
			try {
				assert.strictEqual(rerun.preexisting, true);
				assert.strictEqual(
					readFileSync(restoringMarkerPath(dbPath), 'utf8'),
					before,
					'a recovery attempt must not rewrite the marker that is blocking the database'
				);
			} finally {
				abandonRestore(rerun);
			}
			assert.strictEqual(checkRestoreState(dbPath), 'incomplete');
		});

		it('repairs a marker an interrupted write left empty, so the database stays blocked', function () {
			// what a torn write under the pre-rename implementation left behind
			mkdirSync(dbPath, { recursive: true });
			mkdirSync(restoreMetaDir(dbPath), { recursive: true });
			writeFileSync(restoringMarkerPath(dbPath), '');
			assert.deepStrictEqual(
				scanBlockedRestores(tempDir),
				[[basename(dbPath), 'incomplete']],
				'the startup scan must block the database without trusting the empty marker'
			);

			abandonRestore(beginRestore(dbPath));

			assert.strictEqual(readFileSync(restoringMarkerPath(dbPath), 'utf8').split('\n', 1)[0], basename(dbPath));
			assert.deepStrictEqual(scanBlockedRestores(tempDir), [[basename(dbPath), 'incomplete']]);
		});

		it('repairs a marker whose database name was torn mid-write', function () {
			// Non-empty but truncated. The scan resolves the name it reads back to a *different* metadata
			// key, so a torn name blocks nothing at all while the real database loads.
			mkdirSync(dbPath, { recursive: true });
			mkdirSync(restoreMetaDir(dbPath), { recursive: true });
			writeFileSync(restoringMarkerPath(dbPath), `${basename(dbPath).slice(0, 3)}`);
			assert.deepStrictEqual(
				scanBlockedRestores(tempDir),
				[[basename(dbPath), 'incomplete']],
				'the startup scan must block the database without trusting the torn name'
			);

			abandonRestore(beginRestore(dbPath));

			assert.deepStrictEqual(scanBlockedRestores(tempDir), [[basename(dbPath), 'incomplete']]);
		});

		it('publishes the marker by rename, leaving no temp file behind', function () {
			const lock = beginRestore(dbPath);
			try {
				assert.deepStrictEqual(
					readdirSync(restoreMetaDir(dbPath)).sort(),
					[basename(restoreLockPath(dbPath)), basename(restoringMarkerPath(dbPath))].sort()
				);
			} finally {
				completeRestore(lock);
			}
		});

		it('overwrites a temp file a crashed write left behind, and the scan never sees it', function () {
			const tempPath = restoringMarkerPath(dbPath).replace(/\.restoring$/, '.tmp');
			mkdirSync(restoreMetaDir(dbPath), { recursive: true });
			writeFileSync(tempPath, 'someotherdb\npartial write\n');
			assert.deepStrictEqual(scanBlockedRestores(tempDir), [], 'a temp file must never read as a marker');

			const lock = beginRestore(dbPath);
			try {
				assert.deepStrictEqual(scanBlockedRestores(tempDir), [[basename(dbPath), 'in-progress']]);
				assert.ok(!existsSync(tempPath), 'the temp file is consumed by the rename');
			} finally {
				completeRestore(lock);
			}
		});
	});

	describe('acquireRestoreLock (drop serialization primitive)', function () {
		it('takes the lock without writing a marker, and excludes a concurrent restore', function () {
			const lock = acquireRestoreLock(dbPath);
			try {
				assert.ok(!restoreMarkerPresent(dbPath), 'the bare lock must not write a marker');
				assert.throws(
					() => beginRestore(dbPath),
					(error) => error.statusCode === 409
				);
			} finally {
				releaseRestoreLock(lock);
			}
		});

		it('a restore in progress makes acquireRestoreLock fail with 409', function () {
			const lock = beginRestore(dbPath);
			try {
				assert.throws(
					() => acquireRestoreLock(dbPath),
					(error) => error.statusCode === 409
				);
			} finally {
				completeRestore(lock);
			}
		});
	});

	describe('clearRestoreMarker', function () {
		it('removes a leftover marker and releases the lock', function () {
			abandonRestore(beginRestore(dbPath)); // leftover incomplete marker
			const lock = acquireRestoreLock(dbPath);
			clearRestoreMarker(lock);
			assert.strictEqual(checkRestoreState(dbPath), 'clear');
		});
	});

	describe('scanBlockedRestores', function () {
		it('maps every surviving marker back to its database name and state', function () {
			const a = join(tempDir, 'alpha');
			const b = join(tempDir, 'beta');
			abandonRestore(beginRestore(a)); // incomplete
			const held = beginRestore(b); // in-progress
			try {
				const blocked = new Map(scanBlockedRestores(tempDir));
				assert.strictEqual(blocked.get('alpha'), 'incomplete');
				assert.strictEqual(blocked.get('beta'), 'in-progress');
			} finally {
				completeRestore(held);
			}
			// once beta completes and alpha is cleared, nothing is blocked
			const alphaLock = beginRestore(a);
			completeRestore(alphaLock);
			assert.deepStrictEqual(scanBlockedRestores(tempDir), []);
		});

		it('returns [] when there is no .restore directory', function () {
			assert.deepStrictEqual(scanBlockedRestores(join(tempDir, 'no-such-root')), []);
		});
	});

	describe('database drop markers', function () {
		it('blocks each physical root until the whole drop completes', function () {
			const a = join(tempDir, 'alpha');
			const b = join(tempDir, 'beta');
			mkdirSync(a);
			mkdirSync(b);
			const locks = [beginDatabaseDrop(a, 'catalog'), beginDatabaseDrop(b, 'catalog')];
			try {
				assert.deepStrictEqual(
					scanBlockedDatabaseDrops(tempDir)
						.map(({ rootPath, databaseName }) => [basename(rootPath), databaseName])
						.sort(),
					[
						['alpha', 'catalog'],
						['beta', 'catalog'],
					]
				);
			} finally {
				for (const lock of locks) completeDatabaseDrop(lock);
			}
			assert.deepStrictEqual(scanBlockedDatabaseDrops(tempDir), []);
		});

		it('retains an interrupted drop marker and rejects restore', function () {
			abandonDatabaseDrop(beginDatabaseDrop(dbPath, 'catalog'));
			assert.ok(existsSync(droppingMarkerPath(dbPath)));
			assert.throws(
				() => beginRestore(dbPath),
				(error) => error.statusCode === 409 && /incomplete drop/.test(error.message)
			);
			const retry = beginDatabaseDrop(dbPath, 'catalog');
			assert.strictEqual(retry.preexisting, true);
			completeDatabaseDrop(retry);
		});

		it('cancels a new marker but preserves a marker owned by a retry', function () {
			const first = beginDatabaseDrop(dbPath, 'catalog');
			cancelDatabaseDrop(first);
			assert.ok(!existsSync(droppingMarkerPath(dbPath)));

			abandonDatabaseDrop(beginDatabaseDrop(dbPath, 'catalog'));
			const retry = beginDatabaseDrop(dbPath, 'catalog');
			cancelDatabaseDrop(retry);
			assert.ok(existsSync(droppingMarkerPath(dbPath)));
			completeDatabaseDrop(beginDatabaseDrop(dbPath, 'catalog'));
		});

		it('blocks an existing root without trusting corrupt marker contents', function () {
			mkdirSync(dbPath);
			mkdirSync(restoreMetaDir(dbPath));
			writeFileSync(droppingMarkerPath(dbPath), 'corrupt');
			assert.deepStrictEqual(scanBlockedDatabaseDrops(tempDir), [
				{ rootPath: dbPath, databaseName: undefined, markerPath: droppingMarkerPath(dbPath) },
			]);
		});
	});
});
