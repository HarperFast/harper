'use strict';

const assert = require('node:assert');
const {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { threadId } = require('node:worker_threads');
const {
	applyStagedSwap,
	assertUploadFits,
	createStagingAreas,
	keepInstalledCharge,
	stagingBudgets,
	mintStagingId,
	planStaging,
	removeStagingArea,
	stagedAreasOfReceipt,
	sweepStagingAtStartup,
	verifyStagedSwap,
	withIdentities,
	writeStagedRecord,
} = require('#src/dataLayer/archiveStaging');
const {
	acquireExtractionLock,
	extractionLockPath,
	releaseExtractionOfExitedThread,
	releaseStaleExtractionLock,
} = require('#src/dataLayer/archiveExtractionLock');
const { RESTORE_META_DIR, restoreMetaKey, restoringMarkerPath } = require('#src/dataLayer/restoreMarker');
const { inheritedStagingDirs, restoreReceiptPath } = require('#src/dataLayer/restoreReceipt');
const durableFileModule = require('#js/utility/durableFile');

const EARLIER_PROCESS = 'deadbeefdeadbeef';
const earlierId = (thread = 1) => `${EARLIER_PROCESS}-${thread}-${require('node:crypto').randomUUID()}`;

describe('archive staging', function () {
	let root;

	beforeEach(function () {
		root = mkdtempSync(join(tmpdir(), 'harper.unit-test.archive-staging-'));
	});

	afterEach(function () {
		if (root) rmSync(root, { recursive: true, force: true });
		rmSync(extractionLockPath(), { force: true });
	});

	describe('the swap', function () {
		let databaseDir;
		let blobRoots;
		let record;

		/** A proven area whose parts each hold `staged`, over destinations each holding `live` (the second blob root never written). */
		function stage() {
			databaseDir = join(root, 'database', 'orders');
			// the second root on a tree of its own, as a second storage.blobPaths entry would be
			blobRoots = [join(root, 'blobs', 'orders'), join(root, 'second-volume', 'blob-path', 'orders')];
			const plan = planStaging(databaseDir, blobRoots, mintStagingId());
			createStagingAreas(plan);
			for (const destination of [databaseDir, blobRoots[0]]) {
				mkdirSync(destination, { recursive: true });
				writeFileSync(join(destination, 'content'), 'live');
			}
			for (const part of plan.parts) writeFileSync(join(part.staged, 'content'), `staged ${part.kind}`);
			record = {
				version: 1,
				staging_id: plan.stagingId,
				database: 'orders',
				state: 'proven',
				parts: withIdentities(plan.parts),
			};
			writeStagedRecord(plan.stagingDir, record);
			return plan;
		}

		function assertInstalled() {
			for (const part of record.parts) {
				assert.strictEqual(readFileSync(join(part.destination, 'content'), 'utf8'), `staged ${part.kind}`);
				const { ino } = statSync(part.destination, { bigint: true });
				assert.strictEqual(String(ino), part.ino, `${part.destination} is the staged directory, renamed`);
				assert.strictEqual(existsSync(part.staged), false);
			}
			assert.strictEqual(readFileSync(join(record.parts[0].previous, 'content'), 'utf8'), 'live');
			assert.strictEqual(readFileSync(join(record.parts[1].previous, 'content'), 'utf8'), 'live');
			// nothing to move aside where nothing was written
			assert.strictEqual(existsSync(record.parts[2].previous), false);
		}

		/** Every state a crash can leave: the renames of the swap, in its order, applied up to `step`. */
		function crashAfter(step) {
			const renames = [];
			for (const part of record.parts) {
				if (existsSync(part.destination)) renames.push([part.destination, part.previous]);
				renames.push([part.staged, part.destination]);
			}
			for (const [from, to] of renames.slice(0, step)) renameSync(from, to);
			return renames.length;
		}

		it('installs every part by rename, and a retry from any crash point finishes the same way', function () {
			stage();
			const steps = crashAfter(0);
			rmSync(root, { recursive: true, force: true });
			mkdirSync(root);
			for (let step = 0; step <= steps; step++) {
				stage();
				crashAfter(step);
				verifyStagedSwap(record, databaseDir, blobRoots);
				applyStagedSwap(record);
				assertInstalled();
				// and once more, as a retry after a crash that followed the last rename
				verifyStagedSwap(record, databaseDir, blobRoots);
				applyStagedSwap(record);
				assertInstalled();
				rmSync(root, { recursive: true, force: true });
				mkdirSync(root);
			}
		});

		it('fails closed where the disk does not say what happened', function () {
			stage();
			// the old generation was moved aside, and something recreated the destination since
			renameSync(databaseDir, record.parts[0].previous);
			mkdirSync(databaseDir);
			assert.throws(() => verifyStagedSwap(record, databaseDir, blobRoots), /already moved/);
			assert.throws(() => applyStagedSwap(record), /already moved/);

			rmSync(root, { recursive: true, force: true });
			stage();
			// staged part gone and the destination is not it
			rmSync(record.parts[1].staged, { recursive: true });
			assert.throws(() => verifyStagedSwap(record, databaseDir, blobRoots), /is gone and the destination is not/);

			rmSync(root, { recursive: true, force: true });
			stage();
			// a staged directory that is not the one the proof recorded; made before the recorded one is
			// removed, since a filesystem may hand a new directory the inode number just freed
			const impostor = `${record.parts[0].staged}.impostor`;
			mkdirSync(impostor);
			rmSync(record.parts[0].staged, { recursive: true });
			renameSync(impostor, record.parts[0].staged);
			assert.throws(() => verifyStagedSwap(record, databaseDir, blobRoots), /not the one the staged proof recorded/);
		});

		it('flushes the parents of a rename a retry finds already done, which the failed attempt never flushed', function () {
			stage();
			const [engine] = record.parts;
			const installed = () => statSync(engine.destination, { bigint: true }).ino === BigInt(engine.ino);
			const flushed = [];
			let failed = false;
			const original = durableFileModule.fsyncDirectory;
			durableFileModule.fsyncDirectory = (directory) => {
				// the first flush after the engine part is renamed into place fails, as a crash there would leave it
				if (!failed && existsSync(engine.destination) && installed()) {
					failed = true;
					throw Object.assign(new Error('I/O error'), { code: 'EIO' });
				}
				flushed.push(directory);
				return original(directory);
			};
			try {
				assert.throws(() => applyStagedSwap(record), /I\/O error/);
				assert.ok(installed(), 'precondition: the rename landed before the flush failed');
				flushed.length = 0;
				verifyStagedSwap(record, databaseDir, blobRoots);
				applyStagedSwap(record);
			} finally {
				durableFileModule.fsyncDirectory = original;
			}
			assertInstalled();
			for (const directory of [dirname(engine.destination), dirname(engine.staged), dirname(engine.previous)])
				assert.ok(flushed.includes(directory), `the retry flushes ${directory}; it flushed ${flushed.join(', ')}`);
		});

		it('refuses before destruction a record that is not proven, or whose destinations configuration has moved', function () {
			stage();
			assert.throws(
				() => verifyStagedSwap({ ...record, state: 'extracted' }, databaseDir, blobRoots),
				/not been proven/
			);
			assert.throws(
				() => verifyStagedSwap(record, databaseDir, [blobRoots[1], blobRoots[0]]),
				(error) => error.statusCode === 409 && /storage.blobPaths changed/.test(error.message)
			);
			assert.throws(() => verifyStagedSwap(record, databaseDir, [blobRoots[0]]), /storage.blobPaths changed/);
			assert.throws(() => verifyStagedSwap(record, join(root, 'elsewhere', 'orders'), blobRoots), /changed/);
			assert.strictEqual(readFileSync(join(databaseDir, 'content'), 'utf8'), 'live', 'nothing was touched');
		});

		it('refuses, before creating anything, a blob path at or inside the database directory, or holding it', function () {
			const dir = join(root, 'database', 'orders');
			for (const [roots, relation] of [
				[[dir], 'also'],
				[[join(dir, 'blobs', 'orders')], 'inside'],
				[[join(root, 'blobs', 'orders'), join(root, 'blobs', 'orders')], 'also'],
			]) {
				const plan = planStaging(dir, roots, mintStagingId());
				assert.throws(
					() => createStagingAreas(plan),
					(error) =>
						error.statusCode === 400 &&
						error.message.includes(` is ${relation} `) &&
						/storage\.blobPaths/.test(error.message)
				);
				assert.strictEqual(existsSync(plan.stagingDir), false);
			}
			// the database directory inside a blob path
			const nested = planStaging(join(root, 'blobs', 'orders', 'db'), [join(root, 'blobs', 'orders')], mintStagingId());
			assert.throws(() => createStagingAreas(nested), / is inside /);
			// the same directory under another spelling
			mkdirSync(join(root, 'database'), { recursive: true });
			symlinkSync(join(root, 'database'), join(root, 'alias'), 'junction');
			assert.throws(
				() => createStagingAreas(planStaging(dir, [join(root, 'alias', 'orders')], mintStagingId())),
				/ is also /
			);
			// a sibling whose name only starts with the other's is apart
			createStagingAreas(planStaging(dir, [`${dir}-blobs`], mintStagingId()));

			stage();
			assert.throws(
				() =>
					verifyStagedSwap(
						{ ...record, parts: record.parts.map((part) => ({ ...part, destination: databaseDir })) },
						databaseDir,
						[databaseDir, databaseDir]
					),
				/ is also /
			);
		});

		it('names every area of a receipt, the one holding its record last', function () {
			const plan = stage();
			const areas = stagedAreasOfReceipt({
				staging_dir: plan.stagingDir,
				database: 'orders',
				database_path: databaseDir,
			});
			assert.strictEqual(areas[areas.length - 1], plan.stagingDir);
			assert.deepStrictEqual([...areas].sort(), [...plan.areas].sort());
		});

		it('removes each area’s <key>.staged directory with its last area, and keeps one holding another', async function () {
			const plan = stage();
			const other = planStaging(databaseDir, blobRoots, mintStagingId());
			createStagingAreas(other);
			await removeStagingArea(plan.areas);
			for (const area of other.areas) assert.ok(existsSync(area), `${area} is kept`);
			await removeStagingArea(other.areas);
			for (const area of plan.areas)
				assert.strictEqual(existsSync(dirname(area)), false, `${dirname(area)} is removed`);
		});
	});

	it('compares a known upload length with every destination filesystem’s budget together', function () {
		const plan = planStaging(join(root, 'database', 'orders'), [join(root, 'blobs', 'orders')], mintStagingId());
		// blobs on a larger volume than the database
		const budgets = new Map([
			['engine', 100],
			['blob volume', 1000],
		]);
		assertUploadFits(plan, budgets, 1100);
		assertUploadFits(plan, budgets, undefined);
		assert.throws(
			() => assertUploadFits(plan, budgets, 1101),
			(error) => error.statusCode === 507
		);
	});

	it('applies the quota to a device a part outside its root shares with one inside it', async function () {
		const env = require('#src/utility/environment/environmentManager');
		const rootPath = env.get('rootPath');
		const outside = mkdtempSync(join(dirname(rootPath), 'harper.unit-test.outside-root-'));
		const quotaReport = join(rootPath, 'quota-status.json');
		const plan = planStaging(
			join(outside, 'database', 'orders'),
			[join(rootPath, `blobs-${process.pid}`, 'orders')],
			mintStagingId()
		);
		try {
			createStagingAreas(plan);
			assert.strictEqual(
				statSync(plan.parts[0].staged).dev,
				statSync(plan.parts[1].staged).dev,
				'precondition: one device'
			);
			const quotaBytes = 4 * 1024 ** 3;
			writeFileSync(
				quotaReport,
				JSON.stringify({ usedBytes: quotaBytes - 1.5 * 1024 ** 3, quotaBytes, updatedAt: Date.now() })
			);
			const budgets = await stagingBudgets(plan);
			assert.strictEqual(budgets.size, 1);
			// the quota leaves 1.5 GiB, less its 1 GiB reserve
			assert.ok([...budgets.values()][0] <= 0.5 * 1024 ** 3, JSON.stringify([...budgets]));
		} finally {
			rmSync(quotaReport, { force: true });
			rmSync(outside, { recursive: true, force: true });
			rmSync(join(rootPath, `blobs-${process.pid}`), { recursive: true, force: true });
		}
	});

	describe('the startup sweep', function () {
		function area(location, databaseName, id) {
			const path = join(
				location,
				RESTORE_META_DIR,
				restoreMetaKey(join(root, 'database', databaseName)) + '.staged',
				id
			);
			mkdirSync(join(path, 'db'), { recursive: true });
			return path;
		}
		function receipt(databaseName, contents) {
			const path = restoreReceiptPath(join(root, 'database', databaseName));
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, contents);
		}

		it('keeps what one root holds for a database name, whatever another root’s receipt for that name says', function () {
			const first = join(root, 'first');
			const second = join(root, 'second');
			const managed = (databaseDir) =>
				JSON.stringify({
					version: 1,
					operation_id: 'op',
					route: 'online',
					state: 'applying',
					database: 'shared',
					database_path: databaseDir,
					source_database: 'shared',
					backup_dir: join(root, 'backups'),
					backup_id: 1,
					attempts: 1,
					options: {},
				});
			const held = [];
			for (const [name, hold] of [
				['unreadable', (dir) => writeFileSync(restoreReceiptPath(dir), '{"version":')],
				['marked', (dir) => writeFileSync(restoringMarkerPath(dir), 'marked\n')],
			]) {
				const [holding, other] = [join(first, name), join(second, name)];
				for (const dir of [holding, other]) mkdirSync(dirname(restoreReceiptPath(dir)), { recursive: true });
				hold(holding);
				// the later root's readable receipt for the same name
				writeFileSync(restoreReceiptPath(other), managed(other));
				const area = join(first, RESTORE_META_DIR, restoreMetaKey(holding) + '.staged', earlierId());
				mkdirSync(join(area, 'db'), { recursive: true });
				held.push(area);
			}
			assert.deepStrictEqual(sweepStagingAtStartup([first, second], []), []);
			for (const area of held) assert.ok(existsSync(area), `${area} is kept`);
		});

		it('removes what an earlier process left unless a receipt names it or cannot be read', function () {
			const databases = join(root, 'database');
			const blobPaths = [join(root, 'blobs'), join(root, 'second-volume')];
			const locations = [databases, ...blobPaths];
			const orphaned = locations.map((location) => area(location, 'orphaned', earlierId()));
			const unreadable = locations.map((location) => area(location, 'unreadable', earlierId()));
			receipt('unreadable', '{"version":');
			const ownedId = earlierId();
			const owned = locations.map((location) => area(location, 'owned', ownedId));
			const superseded = locations.map((location) => area(location, 'owned', earlierId()));
			receipt(
				'owned',
				JSON.stringify({
					version: 2,
					operation_id: 'op',
					route: 'online',
					state: 'applying',
					database: 'owned',
					database_path: join(databases, 'owned'),
					source_database: 'owned',
					backup_dir: join(root, 'backups', 'owned'),
					source_kind: 'staged_tree',
					staging_dir: owned[0],
					attempts: 1,
					options: {},
				})
			);
			// cancelled after its swap began: terminal, keeping its staging, then taken over by a managed restart restore
			const cancelledId = earlierId();
			const cancelled = locations.map((location) => area(location, 'succeeded', cancelledId));
			const successor = {
				version: 1,
				operation_id: 'successor',
				route: 'on_restart',
				state: 'pending',
				database: 'succeeded',
				database_path: join(databases, 'succeeded'),
				source_database: 'succeeded',
				backup_dir: join(root, 'backups', 'succeeded'),
				backup_id: 1,
				attempts: 1,
				options: {},
				...inheritedStagingDirs({ staging_dir: cancelled[0], state: 'terminal', source_kind: 'staged_tree' }),
			};
			receipt('succeeded', JSON.stringify(successor));
			const marked = locations.map((location) => area(location, 'marked', earlierId()));
			writeFileSync(restoringMarkerPath(join(databases, 'marked')), 'marked\n');
			const ours = locations.map((location) => area(location, 'ours', mintStagingId()));

			const removed = sweepStagingAtStartup([databases], blobPaths);

			assert.deepStrictEqual([...removed].sort(), [...orphaned, ...superseded].sort());
			for (const path of [...unreadable, ...owned, ...cancelled, ...marked, ...ours])
				assert.ok(existsSync(path), `${path} is kept`);
			for (const path of [...orphaned, ...superseded]) assert.strictEqual(existsSync(path), false);
		});

		it('removes a <key>.staged directory once its last area is gone, and keeps one still holding an area', function () {
			const databases = join(root, 'database');
			const blobPaths = [join(root, 'blobs')];
			const emptied = [databases, ...blobPaths].map((location) => area(location, 'emptied', earlierId()));
			const ours = area(databases, 'shared', mintStagingId());
			const orphanBeside = area(databases, 'shared', earlierId());

			sweepStagingAtStartup([databases], blobPaths);

			for (const path of emptied) assert.strictEqual(existsSync(dirname(path)), false, `${dirname(path)} is removed`);
			assert.strictEqual(existsSync(orphanBeside), false);
			assert.ok(existsSync(ours));
		});

		it('moves an installed archive’s record to its charge before removing the area, and keeps the area while it cannot', function () {
			const databases = join(root, 'database');
			const metaDir = join(databases, RESTORE_META_DIR);
			const left = (databaseName, { createdAt = Date.now(), installed = true } = {}) => {
				const id = earlierId();
				const path = area(databases, databaseName, id);
				const destination = join(databases, databaseName);
				mkdirSync(destination, { recursive: true });
				const stats = statSync(installed ? destination : join(path, 'db'), { bigint: true });
				writeStagedRecord(path, {
					version: 1,
					staging_id: id,
					database: databaseName,
					state: 'proven',
					restored_from: 'upload',
					archive: { sha256: '', bytes: 1, inflated_bytes: 1, entries: 1, files: 1, payload_bytes: 1000 },
					manifest: null,
					waived: [],
					parts: [
						{
							kind: 'engine',
							staged: join(path, 'db'),
							destination,
							previous: join(path, 'previous', 'db'),
							dev: String(stats.dev),
							ino: String(stats.ino),
						},
					],
					created_at: createdAt,
				});
				return { path, charge: join(metaDir, `${id}.charge`) };
			};
			const moved = left('moved');
			const blocked = left('blocked');
			// a directory where the charge goes, so the record cannot be moved there
			mkdirSync(join(blocked.charge, 'held'), { recursive: true });
			const aged = left('aged', { createdAt: Date.now() - 10 * 60 * 1000 });
			const neverInstalled = left('never-installed', { installed: false });
			const expired = join(metaDir, 'expired.charge');
			writeFileSync(expired, JSON.stringify({ archive: { payload_bytes: 1000 }, created_at: 1 }));

			const removed = sweepStagingAtStartup([databases], []);

			assert.deepStrictEqual([...removed].sort(), [moved.path, aged.path, neverInstalled.path].sort());
			assert.strictEqual(JSON.parse(readFileSync(moved.charge, 'utf8')).archive.payload_bytes, 1000);
			assert.strictEqual(
				JSON.parse(readFileSync(join(blocked.path, 'staged.json'), 'utf8')).archive.payload_bytes,
				1000,
				'the record that still charges stays with its area'
			);
			for (const path of [aged.charge, neverInstalled.charge, expired]) assert.strictEqual(existsSync(path), false);
		});

		it('keeps a record or a charge it cannot read while that could still charge the quota', async function () {
			const databases = join(root, 'database');
			const metaDir = join(databases, RESTORE_META_DIR);
			const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
			// a directory in the record's place: a read of it fails, and not as a missing file
			const unread = (databaseName) => {
				const path = area(databases, databaseName, earlierId());
				mkdirSync(join(path, 'staged.json'));
				return path;
			};
			const young = unread('young');
			const old = unread('old');
			utimesSync(join(old, 'staged.json'), tenMinutesAgo, tenMinutesAgo);
			// nothing there, and not JSON: neither charges anything
			const absent = area(databases, 'absent', earlierId());
			const garbled = area(databases, 'garbled', earlierId());
			writeFileSync(join(garbled, 'staged.json'), '{"version":');
			const charge = (name, contents) => {
				const path = join(metaDir, `${name}.charge`);
				writeFileSync(path, contents);
				return path;
			};
			const current = charge('current', JSON.stringify({ archive: { payload_bytes: 1 }, created_at: Date.now() }));
			const garbledCharge = charge('garbled', '{"archive":');
			const canDenyReads = process.platform !== 'win32' && process.getuid() !== 0;
			const youngUnread = charge('young-unread', '{}');
			const oldUnread = charge('old-unread', '{}');
			if (canDenyReads) {
				for (const path of [youngUnread, oldUnread]) chmodSync(path, 0o000);
				utimesSync(oldUnread, tenMinutesAgo, tenMinutesAgo);
			}

			// the restore that removes its staging is told, so it leaves the area
			await assert.rejects(keepInstalledCharge(young), { code: 'EISDIR' });
			await keepInstalledCharge(absent);

			const removed = sweepStagingAtStartup([databases], []);

			assert.deepStrictEqual([...removed].sort(), [old, absent, garbled].sort());
			assert.ok(existsSync(young), 'an unread record of unknown age stays while it is young');
			assert.ok(existsSync(current));
			assert.strictEqual(existsSync(garbledCharge), false);
			if (canDenyReads) {
				assert.ok(existsSync(youngUnread), 'a charge that cannot be read is judged by its own time');
				assert.strictEqual(existsSync(oldUnread), false);
			}
		});

		it('flushes again a charge move an earlier attempt made but could not flush', function () {
			const databases = join(root, 'database');
			const id = earlierId();
			const path = area(databases, 'moved', id);
			const charge = join(databases, RESTORE_META_DIR, `${id}.charge`);
			writeFileSync(charge, JSON.stringify({ archive: { payload_bytes: 1 }, created_at: Date.now() }));
			const flushed = [];
			const original = durableFileModule.fsyncDirectory;
			durableFileModule.fsyncDirectory = (directory) => {
				flushed.push(directory);
				return original(directory);
			};
			try {
				assert.deepStrictEqual(sweepStagingAtStartup([databases], []), [path]);
			} finally {
				durableFileModule.fsyncDirectory = original;
			}
			for (const directory of [dirname(charge), path])
				assert.ok(flushed.includes(directory), `the sweep flushes ${directory}; it flushed ${flushed.join(', ')}`);
			assert.ok(existsSync(charge));
		});

		it('keeps the area of a charge move whose flush fails, so a later sweep flushes it', function () {
			const databases = join(root, 'database');
			const id = earlierId();
			const path = area(databases, 'unflushed', id);
			const charge = join(databases, RESTORE_META_DIR, `${id}.charge`);
			writeFileSync(charge, JSON.stringify({ archive: { payload_bytes: 1 }, created_at: Date.now() }));
			const original = durableFileModule.fsyncDirectory;
			durableFileModule.fsyncDirectory = () => {
				throw Object.assign(new Error('I/O error'), { code: 'EIO' });
			};
			try {
				assert.deepStrictEqual(sweepStagingAtStartup([databases], []), []);
			} finally {
				durableFileModule.fsyncDirectory = original;
			}
			assert.ok(existsSync(path));
			assert.deepStrictEqual(sweepStagingAtStartup([databases], []), [path]);
		});
	});

	describe('the extraction lock', function () {
		/** The areas of one extraction: the engine's, holding its finished record, and a blob root's, which never holds one. */
		function extractionAreas(databaseName) {
			const id = earlierId();
			const databaseDir = join(root, 'database', databaseName);
			const plan = planStaging(databaseDir, [join(root, 'blobs', databaseName)], id);
			createStagingAreas(plan);
			writeFileSync(join(plan.stagingDir, 'staged.json'), '{}');
			return { databaseDir, plan };
		}

		function staleLock(areas, staging_id = earlierId()) {
			writeFileSync(
				extractionLockPath(),
				JSON.stringify({ incarnation: EARLIER_PROCESS, thread_id: 1, pid: 2 ** 22 + 7, staging_id, areas })
			);
		}

		it('admits one extraction at a time', async function () {
			const release = await acquireExtractionLock(mintStagingId(), []);
			await assert.rejects(acquireExtractionLock(mintStagingId(), []), (error) => error.statusCode === 409);
			release();
			(await acquireExtractionLock(mintStagingId(), []))();
		});

		it('takes over a lock an earlier, exited process left, removing every part of its extraction together', async function () {
			const { plan } = extractionAreas('abandoned');
			staleLock(plan.areas);
			const release = await acquireExtractionLock(mintStagingId(), []);
			release();
			for (const area of plan.areas) assert.strictEqual(existsSync(area), false, `${area} is removed`);
		});

		it('keeps every part of an abandoned extraction a restore record names', async function () {
			const { databaseDir, plan } = extractionAreas('recorded');
			mkdirSync(dirname(restoreReceiptPath(databaseDir)), { recursive: true });
			writeFileSync(
				restoreReceiptPath(databaseDir),
				JSON.stringify({
					version: 2,
					operation_id: 'op',
					route: 'online',
					state: 'applying',
					database: 'recorded',
					database_path: databaseDir,
					source_database: 'recorded',
					backup_dir: join(root, 'backups', 'recorded'),
					source_kind: 'staged_tree',
					staging_dir: plan.stagingDir,
					attempts: 1,
					options: {},
				})
			);
			staleLock(plan.areas);
			(await acquireExtractionLock(mintStagingId(), []))();
			for (const area of plan.areas) assert.ok(existsSync(area), `${area} is kept`);
		});

		it('lets only one of two contenders take over the same stale lock', async function () {
			const { plan } = extractionAreas('contended');
			staleLock(plan.areas);
			// both recognise the stale owner before either has removed it: the first awaits the removal of its areas
			const outcomes = await Promise.allSettled([
				acquireExtractionLock(mintStagingId(), []),
				acquireExtractionLock(mintStagingId(), []),
			]);
			const acquired = outcomes.filter((outcome) => outcome.status === 'fulfilled');
			const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
			assert.strictEqual(acquired.length, 1, JSON.stringify(outcomes.map((outcome) => outcome.status)));
			assert.strictEqual(refused[0].reason.statusCode, 409);
			assert.match(refused[0].reason.message, /clearing an abandoned archive extraction.*starting Harper clears it/);
			acquired[0].value();
			assert.strictEqual(existsSync(extractionLockPath()), false);
			assert.deepStrictEqual(
				require('node:fs')
					.readdirSync(dirname(extractionLockPath()))
					.filter((name) => name.startsWith('.restore-extraction.lock')),
				[],
				'no reclaim marker or temp is left'
			);
		});

		it('is released, with every part of its extraction, when the thread holding it exits', async function () {
			const { plan } = extractionAreas('exited');
			await acquireExtractionLock(mintStagingId(), plan.areas);
			await releaseExtractionOfExitedThread(threadId + 1000);
			assert.ok(existsSync(extractionLockPath()), "another thread's exit leaves it");
			await releaseExtractionOfExitedThread(threadId);
			assert.strictEqual(existsSync(extractionLockPath()), false);
			for (const area of plan.areas) assert.strictEqual(existsSync(area), false, `${area} is removed`);
		});

		it('is released at startup when an earlier process left it, even under a reused process id', async function () {
			writeFileSync(
				extractionLockPath(),
				JSON.stringify({
					incarnation: EARLIER_PROCESS,
					thread_id: 1,
					pid: process.pid,
					staging_id: earlierId(),
					areas: [],
				})
			);
			await assert.rejects(acquireExtractionLock(mintStagingId(), []), (error) => error.statusCode === 409);
			await releaseStaleExtractionLock();
			(await acquireExtractionLock(mintStagingId(), []))();
		});
	});
});
