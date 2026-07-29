'use strict';

const assert = require('node:assert');
const { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');
const { tmpdir } = require('node:os');
const { tryFileLock, fileLockRelease } = require('@harperfast/rocksdb-js');
const {
	beginRestore,
	completeRestore,
	abandonRestore,
	acquireRestoreLock,
	releaseRestoreLock,
	clearRestoreMarker,
	checkRestoreState,
	restoreMarkerPresent,
	restoreLockPath,
	restoringMarkerPath,
	restoreMetaDir,
	scanBlockedRestores,
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
		it('keeps restore metadata in an isolated .restore/ sibling directory, out of the database-name namespace', function () {
			const metaDir = restoreMetaDir(dbPath);
			assert.strictEqual(metaDir, join(tempDir, RESTORE_META_DIR));
			// both files live under .restore/, keyed by a hash — not suffixed onto the database name
			assert.strictEqual(dirname(restoreLockPath(dbPath)), metaDir);
			assert.strictEqual(dirname(restoringMarkerPath(dbPath)), metaDir);
			assert.ok(!restoringMarkerPath(dbPath).startsWith(dbPath), 'marker must not be dbPath + suffix');
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
});
