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
	scanLifecycleMarkers,
	beginDrop,
	completeDrop,
	abandonDrop,
	lifecycleMarkerKind,
	recoverInterruptedDrop,
	removeDroppedDatabaseFiles,
	RESTORE_META_DIR,
} = require('#src/dataLayer/restoreMarker');
const { symlinkSync, readFileSync, lstatSync } = require('node:fs');

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

	describe('drop markers', function () {
		it('beginDrop writes a marker typed as a drop, and the kind is readable while it is held', function () {
			const lock = beginDrop(dbPath);
			try {
				assert.equal(lifecycleMarkerKind(dbPath), 'drop');
				assert.equal(checkRestoreState(dbPath), 'in-progress');
				const [entry] = scanLifecycleMarkers(tempDir);
				assert.deepEqual(entry, { dbName: 'somedb', state: 'in-progress', kind: 'drop' });
			} finally {
				completeDrop(lock);
			}
			assert.equal(lifecycleMarkerKind(dbPath), null);
			assert.equal(checkRestoreState(dbPath), 'clear');
		});

		it('a restore marker, including one written before markers were typed, reads as a restore', function () {
			const lock = beginRestore(dbPath);
			assert.equal(lifecycleMarkerKind(dbPath), 'restore');
			abandonRestore(lock);
			writeFileSync(restoringMarkerPath(dbPath), 'somedb\n');
			assert.equal(lifecycleMarkerKind(dbPath), 'restore');
			assert.deepEqual(scanLifecycleMarkers(tempDir), [{ dbName: 'somedb', state: 'incomplete', kind: 'restore' }]);
		});

		it('ignores a marker whose key does not match the database it names', function () {
			// a marker keyed for `somedb` that names another database is not evidence about either
			mkdirSync(restoreMetaDir(dbPath), { recursive: true });
			writeFileSync(restoringMarkerPath(dbPath), 'otherdb\ndrop started now\n');
			assert.deepEqual(scanLifecycleMarkers(tempDir), []);
		});
	});

	describe('recoverInterruptedDrop', function () {
		let blobRoot;

		function leaveInterruptedDrop() {
			mkdirSync(dbPath, { recursive: true });
			writeFileSync(join(dbPath, 'CURRENT'), 'MANIFEST-000001\n');
			blobRoot = join(tempDir, 'blobs', 'somedb');
			mkdirSync(blobRoot, { recursive: true });
			writeFileSync(join(blobRoot, 'leftover.bin'), 'x');
			abandonDrop(beginDrop(dbPath));
			assert.equal(checkRestoreState(dbPath), 'incomplete');
		}

		it('deletes the database directory and its blob roots, then the marker', function () {
			leaveInterruptedDrop();
			assert.equal(recoverInterruptedDrop(tempDir, 'somedb', { blobRoots: [blobRoot] }), 'recovered');
			assert.ok(!existsSync(dbPath));
			assert.ok(!existsSync(blobRoot));
			assert.equal(checkRestoreState(dbPath), 'clear');
			assert.deepEqual(scanLifecycleMarkers(tempDir), []);
		});

		it('is a no-op once whoever held the lock finished the drop', function () {
			assert.equal(recoverInterruptedDrop(tempDir, 'somedb', { blobRoots: [] }), 'recovered');
		});

		it('does not delete while another holder has the lock', function () {
			leaveInterruptedDrop();
			const token = tryFileLock(restoreLockPath(dbPath));
			try {
				assert.equal(recoverInterruptedDrop(tempDir, 'somedb', { blobRoots: [blobRoot] }), 'in-progress');
				assert.ok(existsSync(dbPath));
			} finally {
				fileLockRelease(token);
			}
		});

		it('leaves a restore marker alone', function () {
			mkdirSync(dbPath, { recursive: true });
			abandonRestore(beginRestore(dbPath));
			assert.equal(recoverInterruptedDrop(tempDir, 'somedb', { blobRoots: [] }), 'not-a-drop');
			assert.ok(existsSync(dbPath));
			assert.equal(checkRestoreState(dbPath), 'incomplete');
		});

		it('refuses a name that is not a single directory name, without touching anything', function () {
			leaveInterruptedDrop();
			for (const name of ['../somedb', 'a/b', '..', '.', 'a\\b', '']) {
				assert.throws(() => recoverInterruptedDrop(tempDir, name, { blobRoots: [] }), /Refusing/);
			}
			assert.ok(existsSync(dbPath));
			assert.equal(checkRestoreState(dbPath), 'incomplete');
		});

		it('refuses a marker that names a different database, keeping the marker', function () {
			leaveInterruptedDrop();
			writeFileSync(restoringMarkerPath(dbPath), 'otherdb\ndrop started now\n');
			assert.throws(() => recoverInterruptedDrop(tempDir, 'somedb', { blobRoots: [] }), /names a different database/);
			assert.ok(existsSync(dbPath));
			assert.ok(existsSync(restoringMarkerPath(dbPath)));
		});

		it('refuses to delete through a symbolic link, keeping the marker', function () {
			const elsewhere = join(tempDir, 'elsewhere');
			mkdirSync(elsewhere, { recursive: true });
			writeFileSync(join(elsewhere, 'precious'), 'x');
			symlinkSync(elsewhere, dbPath, 'dir');
			assert.ok(lstatSync(dbPath).isSymbolicLink());
			abandonDrop(beginDrop(dbPath));
			assert.throws(() => recoverInterruptedDrop(tempDir, 'somedb', { blobRoots: [] }), /symbolic link/);
			assert.ok(existsSync(join(elsewhere, 'precious')));
			assert.equal(checkRestoreState(dbPath), 'incomplete');
		});

		describe('removeDroppedDatabaseFiles (the online drop)', function () {
			it('removes the directory remnants and every blob root', async function () {
				leaveInterruptedDrop();
				await removeDroppedDatabaseFiles(dbPath, [blobRoot]);
				assert.ok(!existsSync(dbPath));
				assert.ok(!existsSync(blobRoot));
			});

			it('rejects on the first removal that fails, so the caller keeps its marker', async function () {
				leaveInterruptedDrop();
				await assert.rejects(
					removeDroppedDatabaseFiles(dbPath, [blobRoot], async (path) => {
						if (path === blobRoot) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
						rmSync(path, { recursive: true, force: true });
					}),
					/EBUSY/
				);
				assert.ok(!existsSync(dbPath));
				assert.ok(existsSync(join(blobRoot, 'leftover.bin')));
				assert.equal(checkRestoreState(dbPath), 'incomplete');
			});

			it('refuses a blob root that is a symbolic link before removing anything', async function () {
				leaveInterruptedDrop();
				const elsewhere = join(tempDir, 'elsewhere');
				mkdirSync(elsewhere, { recursive: true });
				writeFileSync(join(elsewhere, 'precious'), 'x');
				const linkedRoot = join(tempDir, 'blobs', 'linked');
				symlinkSync(elsewhere, linkedRoot, 'dir');
				await assert.rejects(removeDroppedDatabaseFiles(dbPath, [blobRoot, linkedRoot]), /symbolic link/);
				assert.ok(existsSync(join(dbPath, 'CURRENT')));
				assert.ok(existsSync(join(blobRoot, 'leftover.bin')));
				assert.ok(existsSync(join(elsewhere, 'precious')));
			});
		});

		it('keeps the marker when a deletion fails, so the next scan tries again', function () {
			leaveInterruptedDrop();
			assert.throws(
				() =>
					recoverInterruptedDrop(tempDir, 'somedb', {
						blobRoots: [blobRoot],
						remove: (path) => {
							if (path === blobRoot) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
							rmSync(path, { recursive: true, force: true });
						},
					}),
				/EBUSY/
			);
			assert.ok(existsSync(restoringMarkerPath(dbPath)));
			assert.equal(checkRestoreState(dbPath), 'incomplete');
			assert.equal(readFileSync(restoringMarkerPath(dbPath), 'utf8').split('\n')[0], 'somedb');
		});
	});
});
