'use strict';

const assert = require('node:assert');
const { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const {
	assertBackupsUnpinned,
	backupPinsDir,
	managementLockPath,
	pinBackup,
	readBackupPins,
	unpinBackup,
	withBackupRepositoryLock,
} = require('#src/dataLayer/backupRepository');
const { abandonRestore, beginRestore, completeRestore } = require('#src/dataLayer/restoreMarker');

describe('backupRepository', function () {
	let tempDir;
	let backupDir;

	beforeEach(function () {
		tempDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.backup-repo-'));
		backupDir = join(tempDir, 'backup', 'somedb');
	});

	afterEach(function () {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe('withBackupRepositoryLock', function () {
		it('creates the repository only for a caller that is creating a backup', async function () {
			const result = await withBackupRepositoryLock(backupDir, 'somedb', async () => 'done', true);
			assert.strictEqual(result, 'done');
			assert.ok(existsSync(managementLockPath(backupDir)));
		});

		it('runs unlocked on a repository that does not exist, leaving nothing behind', async function () {
			// a delete or purge for a name with no repository must 404 on its own, not leave an empty
			// directory that makes a later list_backups answer [] instead of that 404
			const result = await withBackupRepositoryLock(backupDir, 'somedb', async () => 'done');
			assert.strictEqual(result, 'done');
			assert.ok(!existsSync(backupDir), 'no repository may be created by a non-creating caller');
		});

		it('serializes concurrent operations rather than interleaving them', async function () {
			mkdirSync(backupDir, { recursive: true });
			const events = [];
			const operation = async (name) =>
				withBackupRepositoryLock(backupDir, 'somedb', async () => {
					events.push(`${name}:enter`);
					await delay(25);
					events.push(`${name}:exit`);
				});

			await Promise.all([operation('first'), operation('second')]);

			// whichever won, its enter/exit pair must be contiguous
			assert.strictEqual(events.length, 4);
			assert.strictEqual(events[1], events[0].replace(':enter', ':exit'));
			assert.strictEqual(events[3], events[2].replace(':enter', ':exit'));
		});

		it('releases the lock when the operation throws', async function () {
			await assert.rejects(
				withBackupRepositoryLock(backupDir, 'somedb', async () => {
					throw new Error('boom');
				}),
				/boom/
			);
			assert.strictEqual(await withBackupRepositoryLock(backupDir, 'somedb', async () => 'reacquired'), 'reacquired');
		});

		it('refuses a repository it cannot write, by name rather than by errno', async function () {
			if (process.platform === 'win32' || process.getuid?.() === 0) this.skip();
			mkdirSync(backupDir, { recursive: true });
			chmodSync(backupDir, 0o500);
			try {
				await assert.rejects(
					withBackupRepositoryLock(backupDir, 'somedb', async () => 'unreachable'),
					(error) => error.statusCode === 409 && /is not writable \(E(ACCES|PERM|ROFS)\)/.test(error.message)
				);
			} finally {
				chmodSync(backupDir, 0o700);
			}
		});
	});

	describe('pins', function () {
		it('refuses to remove a pinned backup, and allows it again once unpinned', function () {
			pinBackup(backupDir, 'restore-abc', 7, 'restore of somedb pending restart');

			assert.throws(
				() => assertBackupsUnpinned(backupDir, [7], 'somedb'),
				(error) => error.statusCode === 409 && /pending restart/.test(error.message)
			);

			unpinBackup(backupDir, 'restore-abc');
			assertBackupsUnpinned(backupDir, [7], 'somedb');
		});

		it('only blocks the ids that are actually pinned', function () {
			pinBackup(backupDir, 'restore-abc', 7, 'in use');
			assertBackupsUnpinned(backupDir, [5, 6], 'somedb');
			assert.throws(() => assertBackupsUnpinned(backupDir, [6, 7], 'somedb'), /backup 7/);
		});

		it('reports every pin it holds', function () {
			pinBackup(backupDir, 'restore-abc', 7, 'restore');
			pinBackup(backupDir, 'import-xyz', 9, 'import');
			const pins = readBackupPins(backupDir).sort((a, b) => a.backup_id - b.backup_id);
			assert.deepStrictEqual(
				pins.map((pin) => [pin.pin_id, pin.backup_id, pin.reason]),
				[
					['restore-abc', 7, 'restore'],
					['import-xyz', 9, 'import'],
				]
			);
		});

		it('is a no-op to unpin something that was never pinned', function () {
			unpinBackup(backupDir, 'never-pinned');
			assert.deepStrictEqual(readBackupPins(backupDir), []);
		});

		it('fails closed on a pin file it cannot parse, blocking every id', function () {
			mkdirSync(backupPinsDir(backupDir), { recursive: true });
			writeFileSync(join(backupPinsDir(backupDir), 'torn.json'), '{"backup_id":');

			assert.throws(
				() => assertBackupsUnpinned(backupDir, [1], 'somedb'),
				(error) => error.statusCode === 409 && /unknown backup/.test(error.message)
			);
		});

		it('fails closed on a pin file that parses but carries no usable backup id', function () {
			mkdirSync(backupPinsDir(backupDir), { recursive: true });
			for (const [name, contents] of [
				['empty.json', '{}'],
				['stringy.json', '{"backup_id":"7"}'],
				['nulled.json', '{"backup_id":null}'],
				['fractional.json', '{"backup_id":7.5}'],
			]) {
				writeFileSync(join(backupPinsDir(backupDir), name), contents);
				assert.throws(
					() => assertBackupsUnpinned(backupDir, [7], 'somedb'),
					(error) => error.statusCode === 409 && /unknown backup/.test(error.message),
					`${name} must block the delete it cannot vouch for`
				);
				rmSync(join(backupPinsDir(backupDir), name));
			}
		});

		it('rejects a pin id that would escape the pins directory', function () {
			assert.throws(() => pinBackup(backupDir, '../escape', 1, 'nope'), /Invalid backup pin id/);
			assert.throws(() => unpinBackup(backupDir, 'a/b'), /Invalid backup pin id/);
		});

		it('honors a restore pin only while its database is still marked', function () {
			const databasePath = join(tempDir, 'somedb');
			const lock = beginRestore(databasePath);
			try {
				pinBackup(backupDir, 'restore-abc', 7, 'restore in flight', databasePath);
				assert.throws(
					() => assertBackupsUnpinned(backupDir, [7], 'somedb'),
					(error) => error.statusCode === 409
				);
			} finally {
				completeRestore(lock); // the restore finished; the marker is gone
			}

			// the pin outlived the restore it protected — a process killed between clearing the marker
			// and releasing the pin leaves exactly this
			assertBackupsUnpinned(backupDir, [7], 'somedb');
			assert.deepStrictEqual(readBackupPins(backupDir), [], 'a lapsed pin is swept, not left to 409 forever');
		});

		it('keeps honoring a restore pin while the marker survives a failed attempt', function () {
			const databasePath = join(tempDir, 'somedb');
			abandonRestore(beginRestore(databasePath)); // destructive failure: marker retained
			pinBackup(backupDir, 'restore-abc', 7, 'restore awaiting rerun', databasePath);

			assert.throws(
				() => assertBackupsUnpinned(backupDir, [7], 'somedb'),
				(error) => error.statusCode === 409,
				'the rerun still needs this backup'
			);
		});

		it('has no pins before anything claims one', function () {
			assert.deepStrictEqual(readBackupPins(backupDir), []);
			assertBackupsUnpinned(backupDir, [1, 2, 3], 'somedb');
		});
	});
});
