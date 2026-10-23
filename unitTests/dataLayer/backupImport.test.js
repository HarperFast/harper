'use strict';

const testUtils = require('../testUtils.js');
const assert = require('node:assert');
const { createHash, randomUUID } = require('node:crypto');
const {
	chmodSync,
	copyFileSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { gunzipSync } = require('node:zlib');
const { pack: tarPack } = require('tar-stream');
const { setTimeout: delay } = require('node:timers/promises');
const { waitFor } = require('../waitFor.js');
const { closeDatabase, getDatabases, table } = require('#src/resources/databases');
const { createBlob, getBlobPathsForDatabaseName, getFilePathForBlob } = require('#src/resources/blob');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const {
	backupDirForDatabase,
	createBackupStream,
	getBackupsRoot,
	listBackups,
	listBackupsInDir,
	restoreBackup,
	verifyBackup,
} = require('#src/dataLayer/rocksdbBackup');
const { blobSnapshotDir } = require('#src/dataLayer/blobBackup');
const { readBackupManifest } = require('#src/dataLayer/backupManifest');
const { ARCHIVE_MANIFEST_ENTRY } = require('#src/dataLayer/backupArchiveManifest');
const backupImport = require('#src/dataLayer/backupImport');
const {
	IMPORT_SOURCE_DIR,
	IMPORT_STAGING_DIR,
	importBackup,
	importBackupJob,
	importStagingDir,
	sweepImportStaging,
	validateImportBackup,
} = backupImport;

const describeUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;
const SU = { hdb_user: { username: 'admin', role: { permission: { super_user: true } } } };
const SOURCE = 'importsource';
const IMPORTED = 'importrepo';
const FOREIGN = 'importforeign';
const RESTORED = 'importrestored';
const BLOB_BYTES = Buffer.alloc(20000, 'q'); // over the file-storage threshold, so it is a file in a blob root
const RECORDS = Array.from({ length: 40 }, (_, id) => ({ id, label: `item-${id % 5}`, pad: 'p'.repeat(64) }));

function sha256(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function stagingRoot(databaseName) {
	return join(backupDirForDatabase(databaseName), IMPORT_STAGING_DIR);
}

function stagingEntries(databaseName) {
	return existsSync(stagingRoot(databaseName)) ? readdirSync(stagingRoot(databaseName)) : [];
}

function placeInImport(databaseName, archivePath, name) {
	const dir = join(backupDirForDatabase(databaseName), IMPORT_SOURCE_DIR);
	mkdirSync(dir, { recursive: true });
	copyFileSync(archivePath, join(dir, name));
	return join(dir, name);
}

// The code under test reads these through their module objects (or a class prototype) at call time, so
// assigning one reaches it. Returns the function that puts the original back.
function replaceProperty(owner, name, replacement) {
	const original = owner[name];
	owner[name] = replacement;
	return () => {
		owner[name] = original;
	};
}

function recordingCalls(implementation) {
	const calls = [];
	const recorder = (...args) => {
		calls.push(args);
		return implementation(...args);
	};
	recorder.calls = calls;
	return recorder;
}

// The repository as list_backups and the engine see it: an import that failed must leave neither.
async function repositoryState(databaseName) {
	const backupDir = backupDirForDatabase(databaseName);
	const engine = (await listBackupsInDir(backupDir)).map((backup) => backup.backupId);
	const manifests = existsSync(join(backupDir, 'manifests')) ? readdirSync(join(backupDir, 'manifests')) : [];
	const listed = engine.length ? (await listBackups({ ...SU, database: databaseName })).map((b) => b.backup_id) : [];
	return { engine, manifests, listed };
}

// A plain tar's entries as [header offset, name, size] — enough to cut and splice entries.
function tarEntries(buffer) {
	const entries = [];
	for (let offset = 0; offset + 512 <= buffer.length;) {
		const header = buffer.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = header.toString('utf8', 0, 100).split('\0')[0];
		const size = Number.parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim(), 8);
		entries.push({ offset, name, size });
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return entries;
}

function firstEntryManifest(tar) {
	const [first] = tarEntries(tar);
	assert.strictEqual(first.name, ARCHIVE_MANIFEST_ENTRY, 'precondition: get_backup puts its manifest first');
	return JSON.parse(tar.toString('utf8', first.offset + 512, first.offset + 512 + first.size));
}

async function packArchive(path, entries) {
	const pack = tarPack();
	const written = pipeline(pack, createWriteStream(path));
	for (const entry of entries) {
		await new Promise((resolve, reject) =>
			pack.entry(entry.header, entry.body, (error) => (error ? reject(error) : resolve()))
		);
	}
	pack.finalize();
	await written;
}

async function assertSameAsSource(Restored) {
	const Source = getDatabases()[SOURCE].Items;
	for (const record of RECORDS) {
		const restored = await Restored.get(record.id);
		const source = await Source.get(record.id);
		assert.deepStrictEqual(
			{ id: restored.id, label: restored.label, pad: restored.pad },
			{ id: source.id, label: source.label, pad: source.pad },
			`record ${record.id}`
		);
		assert.deepStrictEqual({ id: source.id, label: source.label, pad: source.pad }, record);
	}
	const restoredBlob = Buffer.from(await (await Restored.get('with-blob')).attachment.arrayBuffer());
	const sourceBlob = Buffer.from(await (await Source.get('with-blob')).attachment.arrayBuffer());
	assert.ok(restoredBlob.equals(sourceBlob) && restoredBlob.equals(BLOB_BYTES), "the blob bytes are the source's");
}

describeUnlessLmdb('import_backup', function () {
	this.timeout(120000);
	let tempDir;
	let gzArchive;
	let tarArchive;
	let tarManifest;
	let gzManifest;
	let blobRelativePath;

	before(async function () {
		this.timeout(120000);
		await testUtils.ensureSystemTables();
		setMainIsWorker(true);
		tempDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.backup-import-'));
		const Items = table({
			table: 'Items',
			database: SOURCE,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'label', indexed: true },
				{ name: 'pad' },
				{ name: 'attachment' },
			],
		});
		for (const record of RECORDS) await Items.put(record);
		const blob = await createBlob(BLOB_BYTES);
		await Items.put({ id: 'with-blob', label: 'blob', attachment: blob });
		const blobPath = getFilePathForBlob(blob);
		await waitFor(() => existsSync(blobPath) && readFileSync(blobPath).length > BLOB_BYTES.length, {
			timeout: 10000,
			message: 'the blob was never written to its file',
		});
		blobRelativePath = blobPath.slice(getBlobPathsForDatabaseName(SOURCE)[0].length + 1);
		const rootStore = Items.primaryStore.rootStore;
		await rootStore.flush();
		gzArchive = join(tempDir, `${SOURCE}.tar.gz`);
		tarArchive = join(tempDir, `${SOURCE}.tar`);
		await pipeline(createBackupStream(rootStore, SOURCE, true), createWriteStream(gzArchive));
		await pipeline(createBackupStream(rootStore, SOURCE, false), createWriteStream(tarArchive));
		tarManifest = firstEntryManifest(readFileSync(tarArchive));
		gzManifest = firstEntryManifest(gunzipSync(readFileSync(gzArchive)));
	});

	after(async function () {
		this.timeout(60000);
		for (const name of [SOURCE, IMPORTED, FOREIGN, RESTORED]) {
			await closeDatabase(name).catch(() => {});
			for (const root of getBlobPathsForDatabaseName(name)) rmSync(root, { recursive: true, force: true });
			rmSync(backupDirForDatabase(name), { recursive: true, force: true });
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe('source_file', function () {
		afterEach(function () {
			for (const name of [IMPORTED, FOREIGN]) rmSync(backupDirForDatabase(name), { recursive: true, force: true });
		});

		it('turns a staged .tar.gz into a verified managed backup that restores records and blob bytes', async function () {
			placeInImport(IMPORTED, gzArchive, 'source.tar.gz');
			const result = await importBackupJob({ ...SU, database: IMPORTED, source_file: 'source.tar.gz' });

			assert.strictEqual(result.identified, true);
			assert.deepStrictEqual(result.tables, ['Items']);
			assert.strictEqual(result.digest, sha256(gzArchive));
			assert.strictEqual(result.imported_from, `${IMPORT_SOURCE_DIR}/source.tar.gz`);
			assert.strictEqual(result.blobs, true);
			assert.strictEqual(result.blob_root_count, 1);
			assert.deepStrictEqual(result.missing_roles, []);

			const listed = await listBackups({ ...SU, database: IMPORTED });
			assert.deepStrictEqual(
				listed.map((backup) => [backup.backup_id, backup.blobs]),
				[[result.backup_id, true]]
			);
			await verifyBackup({ ...SU, database: IMPORTED, backup_id: result.backup_id, verify_checksum: true });

			const manifest = await readBackupManifest(backupDirForDatabase(IMPORTED), result.backup_id);
			assert.deepStrictEqual(manifest.tables, ['Items']);
			assert.strictEqual(manifest.imported_from, `${IMPORT_SOURCE_DIR}/source.tar.gz`);
			assert.strictEqual(manifest.digest, sha256(gzArchive));
			assert.deepStrictEqual(manifest.producer, gzManifest);
			assert.ok(
				existsSync(join(blobSnapshotDir(backupDirForDatabase(IMPORTED), result.backup_id), '0', blobRelativePath)),
				'the archive blob is in the backup snapshot under its root index'
			);
			assert.deepStrictEqual(stagingEntries(IMPORTED), [], 'staging is removed');
			assert.ok(
				existsSync(join(backupDirForDatabase(IMPORTED), IMPORT_SOURCE_DIR, 'source.tar.gz')),
				'.import is read only'
			);

			await restoreBackup({ ...SU, database: IMPORTED, backup_id: result.backup_id, target_database: RESTORED });
			const Restored = await waitFor(() => getDatabases()[RESTORED]?.Items, {
				timeout: 10000,
				message: 'the restored database was never loaded',
			});
			await assertSameAsSource(Restored);
		});

		it('imports a plain .tar into a database that does not exist locally, and restores it in place', async function () {
			assert.strictEqual(getDatabases()[FOREIGN], undefined, 'precondition: no such local database');
			placeInImport(FOREIGN, tarArchive, 'foreign.tar');
			const result = await importBackupJob({ ...SU, database: FOREIGN, source_file: 'foreign.tar' });
			assert.strictEqual(result.identified, true);
			assert.strictEqual(result.digest, sha256(tarArchive));
			const manifest = await readBackupManifest(backupDirForDatabase(FOREIGN), result.backup_id);
			assert.deepStrictEqual(manifest.producer, tarManifest);
			assert.strictEqual(manifest.producer.database, SOURCE, 'the producer still names the database it came from');
			await verifyBackup({ ...SU, database: FOREIGN, backup_id: result.backup_id });

			await restoreBackup({ ...SU, database: FOREIGN, backup_id: result.backup_id });
			const Restored = await waitFor(() => getDatabases()[FOREIGN]?.Items, {
				timeout: 10000,
				message: 'the restored database was never loaded',
			});
			await assertSameAsSource(Restored);
		});

		it('refuses an archive whose sha256 does not match the pinned one, leaving nothing behind', async function () {
			placeInImport(IMPORTED, gzArchive, 'pinned.tar.gz');
			await assert.rejects(
				importBackupJob({ ...SU, database: IMPORTED, source_file: 'pinned.tar.gz', sha256: 'ab'.repeat(32) }),
				(error) => error.statusCode === 400 && /sha256/.test(error.message)
			);
			assert.deepStrictEqual(stagingEntries(IMPORTED), []);
			assert.deepStrictEqual(await repositoryState(IMPORTED), { engine: [], manifests: [], listed: [] });
			// the same pin, written in upper case, is the same digest
			const result = await importBackupJob({
				...SU,
				database: IMPORTED,
				source_file: 'pinned.tar.gz',
				sha256: sha256(gzArchive).toUpperCase(),
			});
			assert.strictEqual(result.digest, sha256(gzArchive));
		});

		it('refuses a pre-manifest archive unless accept_incompatible_backup, which imports it unidentified', async function () {
			const tar = readFileSync(tarArchive);
			const [first, second] = tarEntries(tar);
			assert.strictEqual(first.name, ARCHIVE_MANIFEST_ENTRY);
			const stripped = join(tempDir, 'pre-manifest.tar');
			writeFileSync(stripped, tar.subarray(second.offset));
			placeInImport(IMPORTED, stripped, 'pre-manifest.tar');

			await assert.rejects(
				importBackupJob({ ...SU, database: IMPORTED, source_file: 'pre-manifest.tar' }),
				(error) => error.statusCode === 400 && /first entry must be harper-backup\.json/.test(error.message)
			);
			assert.deepStrictEqual(stagingEntries(IMPORTED), []);
			assert.deepStrictEqual(await repositoryState(IMPORTED), { engine: [], manifests: [], listed: [] });

			const result = await importBackupJob({
				...SU,
				database: IMPORTED,
				source_file: 'pre-manifest.tar',
				accept_incompatible_backup: true,
			});
			assert.strictEqual(result.identified, false);
			assert.strictEqual(result.blobs, true, 'blob roots found in the tree stand in for the missing manifest');
			const manifest = await readBackupManifest(backupDirForDatabase(IMPORTED), result.backup_id);
			assert.strictEqual(manifest.producer, undefined, 'no producer is invented for an unidentified archive');
			await verifyBackup({ ...SU, database: IMPORTED, backup_id: result.backup_id });
		});

		it('refuses an archive with a symlink entry and leaves nothing in staging or the repository', async function () {
			const linked = join(tempDir, 'symlink.tar');
			await packArchive(linked, [
				{ header: { name: ARCHIVE_MANIFEST_ENTRY }, body: JSON.stringify(tarManifest) },
				{ header: { name: 'CURRENT' }, body: 'MANIFEST-000001\n' },
				{ header: { name: 'escape', type: 'symlink', linkname: '/etc/passwd' } },
			]);
			placeInImport(IMPORTED, linked, 'symlink.tar');
			await assert.rejects(
				importBackupJob({ ...SU, database: IMPORTED, source_file: 'symlink.tar' }),
				(error) => error.statusCode === 400 && /symlink entry/.test(error.message)
			);
			assert.deepStrictEqual(stagingEntries(IMPORTED), []);
			assert.deepStrictEqual(await repositoryState(IMPORTED), { engine: [], manifests: [], listed: [] });
		});

		it('refuses a truncated .tar.gz and leaves nothing behind', async function () {
			const gz = readFileSync(gzArchive);
			const truncated = join(tempDir, 'truncated.tar.gz');
			writeFileSync(truncated, gz.subarray(0, Math.floor(gz.length / 2)));
			placeInImport(IMPORTED, truncated, 'truncated.tar.gz');
			await assert.rejects(importBackupJob({ ...SU, database: IMPORTED, source_file: 'truncated.tar.gz' }));
			assert.deepStrictEqual(stagingEntries(IMPORTED), []);
			assert.deepStrictEqual(await repositoryState(IMPORTED), { engine: [], manifests: [], listed: [] });
		});

		it('refuses a source_file that is a symlink out of .import/', async function () {
			const importDir = join(backupDirForDatabase(IMPORTED), IMPORT_SOURCE_DIR);
			mkdirSync(importDir, { recursive: true });
			try {
				symlinkSync(gzArchive, join(importDir, 'escape.tar.gz'));
			} catch (error) {
				// Windows needs Developer Mode or an elevated token to create a symlink
				if (process.platform === 'win32' && error.code === 'EPERM') this.skip();
				throw error;
			}
			await assert.rejects(
				importBackupJob({ ...SU, database: IMPORTED, source_file: 'escape.tar.gz' }),
				(error) => error.statusCode === 400 && /is not a file inside/.test(error.message)
			);
			await assert.rejects(
				importBackupJob({ ...SU, database: IMPORTED, source_file: 'absent.tar.gz' }),
				(error) => error.statusCode === 404
			);
			assert.deepStrictEqual(stagingEntries(IMPORTED), []);
			assert.deepStrictEqual(await repositoryState(IMPORTED), { engine: [], manifests: [], listed: [] });
		});

		const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;
		(canChmod ? it : it.skip)(
			'removes the converted engine backup and its blob snapshot when the completion manifest cannot be written',
			async function () {
				placeInImport(IMPORTED, gzArchive, 'source.tar.gz');
				const backupDir = backupDirForDatabase(IMPORTED);
				const manifestsDir = join(backupDir, 'manifests');
				mkdirSync(manifestsDir, { recursive: true });
				chmodSync(manifestsDir, 0o555);
				try {
					await assert.rejects(
						importBackupJob({ ...SU, database: IMPORTED, source_file: 'source.tar.gz' }),
						/EACCES|permission denied/i
					);
				} finally {
					chmodSync(manifestsDir, 0o755);
				}
				assert.deepStrictEqual(await repositoryState(IMPORTED), { engine: [], manifests: [], listed: [] });
				assert.ok(!existsSync(blobSnapshotDir(backupDir, 1)), 'the blob snapshot is removed');
				assert.deepStrictEqual(stagingEntries(IMPORTED), [], 'and staging');
			}
		);
	});

	describe('a multipart upload', function () {
		const jobs = require('#src/server/jobs/jobs');
		const jobRunner = require('#src/server/jobs/jobRunner');
		let restoreParseMessage;
		let queued;

		beforeEach(function () {
			queued = [];
			// the job thread, run in this thread: what the job sees when it starts, then the job itself
			restoreParseMessage = replaceProperty(jobRunner, 'parseMessage', async (message) => {
				const stagingDir = message.json.staging_id && importStagingDir(IMPORTED, message.json.staging_id);
				const read = (name) => stagingDir && existsSync(join(stagingDir, name)) && readFileSync(join(stagingDir, name));
				const seen = {
					json: message.json,
					owner: read('owner.json') && JSON.parse(read('owner.json')),
					archive: read('archive'),
				};
				queued.push(seen);
				seen.result = await importBackupJob(message.json).catch((error) => error);
			});
		});

		afterEach(function () {
			restoreParseMessage();
			rmSync(backupDirForDatabase(IMPORTED), { recursive: true, force: true });
		});

		const upload = (fields, payload = Readable.from([readFileSync(gzArchive)])) =>
			importBackup({ ...SU, operation: 'import_backup', database: IMPORTED, ...fields, payload });

		it('spools the raw bytes to staging, hands staging to the import before queuing it, and removes it after', async function () {
			const queuedJob = await upload({});
			assert.strictEqual(queued.length, 1);
			const [{ json, owner, archive, result }] = queued;
			assert.ok(!(result instanceof Error), result?.stack);
			assert.deepStrictEqual(owner, { owner: 'import', import_id: json.staging_id }, 'import-owned before the job ran');
			assert.ok(archive.equals(readFileSync(gzArchive)), 'the raw upload, not inflated');
			assert.strictEqual(json.upload_digest, sha256(gzArchive));
			assert.strictEqual(json.payload, undefined, 'the stream is never part of the job request');

			const row = await getDatabases().system.hdb_job.get(queuedJob.job_id);
			assert.strictEqual(row.request.staging_id, json.staging_id);
			assert.strictEqual(row.request.payload, undefined);

			assert.strictEqual(result.digest, sha256(gzArchive));
			assert.strictEqual(result.imported_from, 'upload');
			assert.deepStrictEqual(stagingEntries(IMPORTED), [], 'the spool is removed after the job');
			const listed = await listBackups({ ...SU, database: IMPORTED });
			assert.deepStrictEqual(
				listed.map((backup) => backup.backup_id),
				[result.backup_id]
			);
		});

		it('refuses an invalid request before spooling anything', async function () {
			for (const fields of [
				{ sha256: 'not-a-digest' },
				{ accept_incompatible_backup: 'yes' },
				{ url: 'https://example.com/a.tar.gz' },
				{ declared_size: -1 },
			]) {
				await assert.rejects(upload(fields), (error) => error.statusCode === 400, JSON.stringify(fields));
				assert.deepStrictEqual(stagingEntries(IMPORTED), [], `nothing staged for ${JSON.stringify(fields)}`);
			}
			assert.strictEqual(queued.length, 0);
		});

		it('refuses a declared size larger than the staging device has free, before writing', async function () {
			await assert.rejects(upload({ declared_size: Number.MAX_SAFE_INTEGER }), (error) => error.statusCode === 507);
			assert.deepStrictEqual(stagingEntries(IMPORTED), []);
		});

		it('removes a spool whose upload fails part way', async function () {
			const broken = new Readable({
				read() {
					this.push(readFileSync(gzArchive).subarray(0, 4096));
					this.destroy(new Error('connection reset'));
				},
			});
			await assert.rejects(upload({}, broken), /connection reset/);
			assert.deepStrictEqual(stagingEntries(IMPORTED), []);
			assert.strictEqual(queued.length, 0);
		});

		it('removes the spool when the job cannot be queued', async function () {
			const restoreAddJob = replaceProperty(jobs, 'addJob', async () => {
				throw new Error('job table unavailable');
			});
			try {
				await assert.rejects(upload({}), /job table unavailable/);
			} finally {
				restoreAddJob();
			}
			assert.deepStrictEqual(stagingEntries(IMPORTED), []);
		});

		// staging_id names the directory the job removes when it finishes; from a client it would name any directory
		it('refuses a client-supplied staging_id instead of treating it as a staged upload', async function () {
			const victim = join(getBackupsRoot(), 'importvictim');
			mkdirSync(victim, { recursive: true });
			writeFileSync(join(victim, 'keep'), 'keep');
			try {
				const outcomes = [];
				for (const stagingId of ['../../importvictim', randomUUID()]) {
					outcomes.push(
						await importBackup({ ...SU, operation: 'import_backup', database: IMPORTED, staging_id: stagingId }).then(
							() => 'queued',
							(error) => error
						)
					);
				}
				assert.ok(existsSync(join(victim, 'keep')), 'nothing outside staging is removed');
				for (const outcome of outcomes) {
					assert.ok(outcome.statusCode === 400 && /staging_id/.test(outcome.message), String(outcome));
				}
				assert.strictEqual(queued.length, 0, 'no job is queued');
			} finally {
				rmSync(victim, { recursive: true, force: true });
			}
		});
	});

	describe('a pull from a URL', function () {
		const { SAFE_FETCH_TEST_TRANSPORT } = require('#src/utility/safeFetch');
		const serveArchive = (req, res) => res.end(readFileSync(gzArchive));
		let server;
		let port;
		let requests;
		let caCert;
		let handler;

		before(async function () {
			const mkcert = require('mkcert');
			const ca = await mkcert.createCA({
				organization: 'import test CA',
				countryCode: 'US',
				state: 'X',
				locality: 'X',
				validity: 1,
			});
			const cert = await mkcert.createCert({
				ca: { key: ca.key, cert: ca.cert },
				domains: ['127.0.0.1', 'localhost'],
				validity: 1,
			});
			caCert = ca.cert;
			requests = 0;
			server = require('node:https').createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
				requests++;
				handler(req, res);
			});
			await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
			port = server.address().port;
		});

		after(() => {
			server.closeAllConnections();
			return new Promise((resolve) => server.close(resolve));
		});

		beforeEach(function () {
			handler = serveArchive;
		});

		afterEach(function () {
			rmSync(backupDirForDatabase(IMPORTED), { recursive: true, force: true });
		});

		// What the child runs, in-process: the pull is capped at the staging device's room before a byte
		// lands, and what it fetched is charged to the ledger the tally and extraction reserve against.
		describe('bounded by the disk ledger', function () {
			const safeFetch = require('#src/utility/safeFetch');
			const { DiskLedger } = require('#src/dataLayer/diskLedger');
			const { importArchive } = require('#src/dataLayer/importChildCommands');
			const SHA = 'a'.repeat(64);
			let restores;
			let root;

			beforeEach(function () {
				restores = [];
				root = mkdtempSync(join(tmpdir(), 'harper.unit-test.import-pull-'));
			});

			afterEach(function () {
				for (const restore of restores.reverse()) restore();
				rmSync(root, { recursive: true, force: true });
			});

			// no network and no full disk in a unit test: the fetch, the S3 read and the device's room stand in
			const replace = (owner, name, replacement) => {
				restores.push(replaceProperty(owner, name, replacement));
				return replacement;
			};

			const pull = () =>
				importArchive({
					databaseName: IMPORTED,
					backupDir: join(root, 'backups'),
					stagingDir: join(root, 'staging'),
					url: 'https://backups.example.com/db.tar.gz',
					sha256: SHA,
				});

			for (const [room, maxBytes] of [
				[123_456_789, 123_456_789],
				[-4096, 0],
			]) {
				it(`passes maxBytes ${maxBytes} when the staging device has ${room} bytes of room`, async function () {
					replace(DiskLedger.prototype, 'remaining', async () => ({ bytes: room, inodes: 1000, basis: 'quota' }));
					const fetch = replace(
						safeFetch,
						'safeFetchToFile',
						recordingCalls(async () => {
							throw new Error('no network in a unit test');
						})
					);
					await assert.rejects(pull(), /no network/);
					assert.strictEqual(fetch.calls.length, 1);
					const [url, destination, options] = fetch.calls[0];
					assert.strictEqual(url, 'https://backups.example.com/db.tar.gz');
					assert.strictEqual(destination, join(root, 'staging', 'archive'));
					assert.strictEqual(options.maxBytes, maxBytes);
					assert.strictEqual(options.sha256, SHA, 'the pinned digest is checked as the bytes arrive');
				});
			}

			it('meters an S3 pull into the ledger as it lands', async function () {
				const aws = require('#js/utility/AWS/AWSConnector');
				replace(aws, 'getFileStreamFromS3', async () =>
					Readable.from([Buffer.from('not '), Buffer.from('an archive')])
				);
				const debit = replace(
					DiskLedger.prototype,
					'debit',
					recordingCalls(async () => {})
				);
				await assert.rejects(
					importArchive({
						databaseName: IMPORTED,
						backupDir: join(root, 'backups'),
						stagingDir: join(root, 'staging'),
						s3: {
							bucket: 'b',
							key: 'k',
							region: 'r',
							credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
						},
						sha256: SHA,
					})
				);
				assert.strictEqual(readFileSync(join(root, 'staging', 'archive'), 'utf8'), 'not an archive');
				assert.deepStrictEqual(debit.calls[0]?.slice(0, 2), [join(root, 'staging', 'archive'), 14]);
			});

			it('charges the fetched bytes to the staging device before reading them', async function () {
				replace(DiskLedger.prototype, 'remaining', async () => ({ bytes: 1e9, inodes: 1000, basis: 'quota' }));
				const debit = replace(
					DiskLedger.prototype,
					'debit',
					recordingCalls(async () => {})
				);
				replace(safeFetch, 'safeFetchToFile', async (_url, destination, options) => {
					writeFileSync(destination, 'not an archive');
					options.onBytes(14);
					return { bytes: 14 };
				});
				await assert.rejects(pull());
				assert.deepStrictEqual(debit.calls, [[join(root, 'staging'), 14]]);
			});

			// A real https transfer from the local server; only the ledger's refusal stands in for a full device.
			it('charges a pull as it lands, and stops it once the staging device refuses a charge', async function () {
				const BATCH = 8 * 1024 * 1024;
				const ROOM = 12 * 1024 * 1024;
				const TOTAL = 64 * 1024 * 1024;
				let served = 0;
				let servedAll = false;
				handler = (req, res) => {
					res.writeHead(200, { 'content-length': TOTAL });
					const chunk = Buffer.alloc(1024 * 1024, 'p');
					const pump = () => {
						while (served < TOTAL) {
							served += chunk.length;
							if (!res.write(chunk)) return res.once('drain', pump);
						}
						servedAll = true;
						res.end();
					};
					pump();
				};
				const realFetch = safeFetch.safeFetchToFile;
				replace(safeFetch, 'safeFetchToFile', (url, destination, options) =>
					realFetch(url, destination, {
						...options,
						[SAFE_FETCH_TEST_TRANSPORT]: { trustedAddresses: ['127.0.0.1'], ca: caCert },
					})
				);
				let charged = 0;
				const debit = replace(
					DiskLedger.prototype,
					'debit',
					recordingCalls(async (_path, bytes) => {
						if (charged + bytes > ROOM) {
							throw Object.assign(new Error('Insufficient storage on the staging volume'), { statusCode: 507 });
						}
						charged += bytes;
					})
				);

				await assert.rejects(
					importArchive({
						databaseName: IMPORTED,
						backupDir: join(root, 'backups'),
						stagingDir: join(root, 'staging'),
						url: `https://127.0.0.1:${port}/db.tar.gz`,
					}),
					(error) => error.statusCode === 507 && /Insufficient storage/.test(error.message)
				);
				// a batch closes on the chunk that reaches it
				const inBatches = debit.calls.every(
					([path, bytes]) => path === join(root, 'staging') && bytes >= BATCH && bytes < BATCH + 1024 * 1024
				);
				assert.ok(
					inBatches && debit.calls.length === 2,
					`charged in batches as the bytes land, the second refused: ${JSON.stringify(debit.calls)}`
				);
				assert.strictEqual(servedAll, false, `the transfer was cut short, not finished (${served} of ${TOTAL} served)`);
			});

			// S3's header wait is bounded by the 5 minute idle timeout: a manual clock in a worker stands in for it.
			it('fails an S3 pull with 504 when S3 never answers', async function () {
				const { Worker } = require('node:worker_threads');
				const IDLE_MS = 5 * 60 * 1000;
				const worker = new Worker(
					`
					const { workerData, parentPort } = require('node:worker_threads');
					require(workerData.aws).getFileStreamFromS3 = () => new Promise(() => {});
					const { importArchive } = require(workerData.importChildCommands);
					const pending = new Map();
					let now = 0;
					globalThis.setTimeout = (callback, ms = 0, ...args) => {
						const handle = { ref: () => handle, unref: () => handle, hasRef: () => true };
						pending.set(handle, { at: now + ms, callback, args });
						parentPort.postMessage({ type: 'timer', ms });
						return handle;
					};
					globalThis.clearTimeout = (handle) => pending.delete(handle);
					parentPort.on('message', (message) => {
						if (message?.type !== 'advance') return;
						now += message.ms;
						for (const [handle, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
							if (timer.at > now || !pending.delete(handle)) continue;
							timer.callback(...timer.args);
						}
					});
					importArchive(workerData.args).then(
						() => parentPort.postMessage({ type: 'outcome' }),
						(error) => parentPort.postMessage({ type: 'outcome', message: error.message, statusCode: error.statusCode })
					);
					`,
					{
						eval: true,
						workerData: {
							aws: require.resolve('#js/utility/AWS/AWSConnector'),
							importChildCommands: require.resolve('#src/dataLayer/importChildCommands'),
							args: {
								databaseName: IMPORTED,
								backupDir: join(root, 'backups'),
								stagingDir: join(root, 'staging'),
								s3: {
									bucket: 'b',
									key: 'k',
									region: 'r',
									credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
								},
							},
						},
					}
				);
				const timers = [];
				let outcome;
				worker.on('message', (message) => {
					if (message?.type === 'timer') timers.push(message.ms);
					else if (message?.type === 'outcome') outcome = message;
				});
				try {
					await waitFor(() => timers.includes(IDLE_MS), {
						timeout: 30000,
						message: () => `the S3 request was never bounded: ${JSON.stringify({ timers, outcome })}`,
					});
					worker.postMessage({ type: 'advance', ms: IDLE_MS - 1 });
					await delay(200);
					assert.strictEqual(outcome, undefined, 'still waiting just inside the bound');
					worker.postMessage({ type: 'advance', ms: 1 });
					await waitFor(() => outcome, { timeout: 5000, message: 'the S3 wait never timed out' });
					assert.strictEqual(outcome.statusCode, 504);
					assert.match(outcome.message, /S3 did not answer for b\/k/);
				} finally {
					await worker.terminate();
				}
			});
		});

		it('keeps a presigned URL out of the job row, and hands it whole to the job worker', async function () {
			const { Worker } = require('node:worker_threads');
			const { JOB_TRANSIENT_ENV } = require('#src/server/jobs/jobRunner');
			const manageThreads = require('#js/server/threads/manageThreads');
			const signed = 'https://backups.example.com/exports/db.tar.gz?X-Amz-Signature=sekrit-token';
			// no job worker is started from this thread: what runJob would start it with is recorded, and the
			// real job worker is then run below with exactly that
			const started = [];
			const restoreStart = replaceProperty(manageThreads, 'startWorker', (path, options) =>
				started.push({ path, options })
			);
			let queued;
			try {
				queued = await importBackup({ ...SU, operation: 'import_backup', database: IMPORTED, url: signed });
			} finally {
				restoreStart();
			}

			const row = JSON.parse(JSON.stringify(await getDatabases().system.hdb_job.get(queued.job_id)));
			assert.strictEqual(row.request.url, 'https://backups.example.com/exports/db.tar.gz');
			assert.ok(!JSON.stringify(row).includes('sekrit'), 'nothing of the query is persisted');
			assert.strictEqual(started.length, 1);
			const { env } = started[0].options;
			assert.deepStrictEqual(JSON.parse(env[JOB_TRANSIENT_ENV]), { url: signed });

			// The job worker, reading that row, with its dispatch stubbed to report the request it would run.
			const worker = new Worker(
				`
				const { workerData, parentPort } = require('node:worker_threads');
				const jobs = require(workerData.jobs);
				const serverUtilities = require(workerData.serverUtilities);
				const application = require(workerData.application);
				jobs.getJobById = async () => [workerData.row];
				jobs.updateJob = async () => {};
				application.getEnvBuiltInComponents = () => [];
				serverUtilities.getOperationFunction = () => ({
					job_operation_function: async (request) =>
						parentPort.postMessage({
							type: 'ran',
							url: request.url,
							transientLeft: process.env[workerData.transientEnv],
						}),
				});
				require(workerData.jobProcess);
				`,
				{
					eval: true,
					env,
					workerData: {
						row,
						transientEnv: JOB_TRANSIENT_ENV,
						jobs: require.resolve('#src/server/jobs/jobs'),
						serverUtilities: require.resolve('#src/server/serverHelpers/serverUtilities'),
						application: require.resolve('#src/components/Application'),
						jobProcess: require.resolve('#src/server/jobs/jobProcess'),
					},
				}
			);
			let ran;
			const errors = [];
			worker.on('message', (message) => {
				if (message?.type === 'ran') ran = message;
			});
			worker.on('error', (error) => errors.push(error));
			try {
				await waitFor(() => ran || errors.length > 0, { timeout: 30000, message: 'the job worker never ran the job' });
			} finally {
				await worker.terminate();
			}
			assert.deepStrictEqual(errors, []);
			assert.strictEqual(ran.url, signed, 'the job runs with the URL the operator sent');
			assert.strictEqual(ran.transientLeft, undefined, 'and drops it from its environment once read');
		});

		// An end-to-end https pull needs safeFetch's Symbol-keyed test transport to trust loopback, which a
		// JSON operation (and so the child's IPC arguments) cannot carry; safeFetch.test.js covers the fetch.
		for (const host of ['127.0.0.1', 'localhost']) {
			it(`refuses a loopback source (${host}) by policy, naming only the redacted URL`, async function () {
				const url = `https://${host}:${port}/exports/db.tar.gz?X-Amz-Signature=sekrit-token#frag`;
				const error = await importBackupJob({ ...SU, database: IMPORTED, url }).then(
					() => assert.fail('a loopback pull must be refused'),
					(error) => error
				);
				assert.strictEqual(error.statusCode, 400, error.message);
				assert.ok(error.message.includes(`https://${host}:${port}/exports/db.tar.gz`), error.message);
				assert.ok(!/sekrit|X-Amz|frag/.test(error.message), error.message);
				assert.strictEqual(requests, 0, 'nothing connects to a denied address');
				assert.deepStrictEqual(stagingEntries(IMPORTED), []);
				assert.deepStrictEqual(await repositoryState(IMPORTED), { engine: [], manifests: [], listed: [] });
			});
		}
	});

	describe('S3 credentials', function () {
		const restoreChildRunner = require('#src/dataLayer/restoreChildRunner');
		const jobRunner = require('#src/server/jobs/jobRunner');
		const { databases } = require('#src/resources/databases');
		const { registerSecretCustody, clearSecretCustody } = require('#src/resources/secretDecryptor');
		const { resolveProcessSecret } = require('#src/components/secretOperations');
		const PLAINTEXT = JSON.stringify({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'plaintext-secret-key' });
		const rows = new Map([
			['S3_CREDS', { name: 'S3_CREDS', processEnv: true, envelope: 'envelope:S3_CREDS' }],
			['NOT_JSON', { name: 'NOT_JSON', processEnv: true, envelope: 'envelope:NOT_JSON' }],
			['SCOPED', { name: 'SCOPED', processEnv: false, grants: ['app'], envelope: 'envelope:SCOPED' }],
		]);
		const plaintexts = { S3_CREDS: PLAINTEXT, NOT_JSON: 'not-json-plaintext', SCOPED: PLAINTEXT };
		let restores;
		let priorTable;

		// no S3 and no job thread in a unit test: the child and the job runner stand in
		const replace = (owner, name, replacement) => {
			restores.push(replaceProperty(owner, name, replacement));
			return replacement;
		};

		beforeEach(function () {
			restores = [];
			priorTable = databases.system.hdb_secret;
			databases.system.hdb_secret = { get: async (name) => rows.get(name) };
			registerSecretCustody({ decrypt: (envelope) => plaintexts[envelope.slice('envelope:'.length)] });
		});

		afterEach(function () {
			for (const restore of restores.reverse()) restore();
			databases.system.hdb_secret = priorTable;
			clearSecretCustody();
			rmSync(backupDirForDatabase(IMPORTED), { recursive: true, force: true });
		});

		it('resolves only a processEnv secret, and only with custody', async function () {
			assert.strictEqual(await resolveProcessSecret('S3_CREDS'), PLAINTEXT);
			await assert.rejects(resolveProcessSecret('SCOPED'), (error) => error.statusCode === 403);
			await assert.rejects(resolveProcessSecret('MISSING'), (error) => error.statusCode === 404);
			clearSecretCustody();
			await assert.rejects(resolveProcessSecret('S3_CREDS'), (error) => error.statusCode === 503);
		});

		const s3 = (secret) => ({
			bucket: 'backups',
			key: 'db/archive.tar.gz',
			region: 'us-east-1',
			credentials: { secret },
		});

		it('hands the resolved keys only to the child, leaving the job request with the secret name', async function () {
			let childArgs;
			replace(restoreChildRunner, 'runRestoreChild', async (_command, args) => {
				childArgs = args;
				mkdirSync(args.stagingDir, { recursive: true });
				throw new Error('S3 is not reachable from a unit test');
			});
			const request = { ...SU, database: IMPORTED, s3: s3('S3_CREDS') };
			await assert.rejects(importBackupJob(request), /not reachable/);
			assert.deepStrictEqual(request.s3, s3('S3_CREDS'), 'the job request is not rewritten with the plaintext');
			assert.deepStrictEqual(childArgs.s3, {
				bucket: 'backups',
				key: 'db/archive.tar.gz',
				region: 'us-east-1',
				credentials: JSON.parse(PLAINTEXT),
			});
			assert.strictEqual(childArgs.importedFrom, 's3://backups/db/archive.tar.gz');
			assert.deepStrictEqual(stagingEntries(IMPORTED), []);
		});

		it('gives the import child 30 hours, past the day a pull alone may take', async function () {
			const child = replace(
				restoreChildRunner,
				'runRestoreChild',
				recordingCalls(async (_command, args) => {
					mkdirSync(args.stagingDir, { recursive: true });
					throw new Error('no child in a unit test');
				})
			);
			await assert.rejects(importBackupJob({ ...SU, database: IMPORTED, s3: s3('S3_CREDS') }), /no child/);
			assert.strictEqual(child.calls.length, 1);
			assert.strictEqual(child.calls[0][2]?.timeoutMs, 30 * 60 * 60 * 1000);
		});

		it('refuses a scoped secret or one that is not a key pair, without echoing its value', async function () {
			const child = replace(
				restoreChildRunner,
				'runRestoreChild',
				recordingCalls(async () => {
					throw new Error('must not run');
				})
			);
			await assert.rejects(
				importBackupJob({ ...SU, database: IMPORTED, s3: s3('SCOPED') }),
				(error) => error.statusCode === 403
			);
			await assert.rejects(
				importBackupJob({ ...SU, database: IMPORTED, s3: s3('NOT_JSON') }),
				(error) =>
					error.statusCode === 400 && /NOT_JSON/.test(error.message) && !/not-json-plaintext/.test(error.message)
			);
			assert.strictEqual(child.calls.length, 0);
		});

		// A job worker without custody asks the main thread; a reply that never comes must not leave the
		// job IN_PROGRESS forever. Fake timers stand in for the 30s deadline.
		it('fails the job with 504 when the main thread never answers the secret request', async function () {
			const { Worker } = require('node:worker_threads');
			const worker = new Worker(
				`
				const { workerData, parentPort } = require('node:worker_threads');
				const { importBackupJob } = require(workerData.backupImport);
				// a manual clock: the deadline reads the global setTimeout when it is armed
				const pending = new Map();
				let now = 0;
				globalThis.setTimeout = (callback, ms = 0, ...args) => {
					const handle = { ref: () => handle, unref: () => handle, hasRef: () => true };
					pending.set(handle, { at: now + ms, callback, args });
					return handle;
				};
				globalThis.clearTimeout = (handle) => pending.delete(handle);
				parentPort.on('message', (message) => {
					if (message?.type !== 'advance') return;
					now += message.ms;
					for (const [handle, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
						if (timer.at > now || !pending.delete(handle)) continue;
						timer.callback(...timer.args);
					}
				});
				importBackupJob(workerData.request).then(
					() => parentPort.postMessage({ type: 'outcome' }),
					(error) => parentPort.postMessage({ type: 'outcome', message: error.message, statusCode: error.statusCode })
				);
				`,
				{
					eval: true,
					workerData: {
						backupImport: require.resolve('#src/dataLayer/backupImport'),
						request: { ...SU, database: IMPORTED, s3: s3('S3_CREDS') },
					},
				}
			);
			const requests = [];
			let outcome;
			worker.on('message', (message) => {
				if (message?.type === 'import_secret_request') requests.push(message);
				else if (message?.type === 'outcome') outcome = message;
			});
			try {
				await waitFor(() => requests.length === 1, {
					timeout: 30000,
					message: 'the worker never asked for the secret',
				});
				assert.strictEqual(requests[0].name, 'S3_CREDS');
				worker.postMessage({ type: 'advance', ms: 29_999 });
				await delay(200);
				assert.strictEqual(outcome, undefined, 'still waiting just inside the deadline');
				worker.postMessage({ type: 'advance', ms: 1 });
				await waitFor(() => outcome, { timeout: 5000, message: 'the secret request never timed out' });
				assert.strictEqual(outcome.statusCode, 504);
				assert.match(outcome.message, /did not resolve secret 'S3_CREDS' in time/);
			} finally {
				await worker.terminate();
			}
		});

		it('persists only the secret name in the job row', async function () {
			replace(jobRunner, 'parseMessage', async () => undefined);
			const { job_id } = await importBackup({
				...SU,
				operation: 'import_backup',
				database: IMPORTED,
				s3: s3('S3_CREDS'),
			});
			const row = await getDatabases().system.hdb_job.get(job_id);
			assert.deepStrictEqual(row.request.s3, s3('S3_CREDS'));
			assert.ok(!JSON.stringify(row).includes('plaintext-secret-key'));
		});
	});

	describe('staging sweeps', function () {
		const manageThreads = require('#js/server/threads/manageThreads');
		const DB = 'importsweep';

		function area(name, owner) {
			const dir = join(stagingRoot(DB), name);
			mkdirSync(dir, { recursive: true });
			if (owner) writeFileSync(join(dir, 'owner.json'), JSON.stringify(owner));
			return dir;
		}

		beforeEach(function () {
			mkdirSync(join(backupDirForDatabase(DB), IMPORT_SOURCE_DIR), { recursive: true });
			writeFileSync(join(backupDirForDatabase(DB), IMPORT_SOURCE_DIR, 'operator.tar.gz'), 'operator file');
			area('imported', { owner: 'import', import_id: 'imported' });
			area('thread-7', { owner: 'thread', thread_id: 7, process_instance: manageThreads.processIncarnation });
			area('thread-8', { owner: 'thread', thread_id: 8, process_instance: manageThreads.processIncarnation });
			area('earlier-process', { owner: 'thread', thread_id: 7, process_instance: 'an-earlier-process' });
			// a url, s3 or source_file import in flight: its staging has no owner record
			area('in-flight-pull');
		});

		afterEach(function () {
			rmSync(backupDirForDatabase(DB), { recursive: true, force: true });
		});

		it('on a thread exit, removes only the staging that thread was still writing', function () {
			assert.strictEqual(backupImport.sweepExitedThreadStaging(7), 1);
			assert.deepStrictEqual(stagingEntries(DB).sort(), ['earlier-process', 'imported', 'in-flight-pull', 'thread-8']);
		});

		it('keeps every area the predicate claims and never removes .staging or .import', function () {
			assert.strictEqual(
				sweepImportStaging(() => true),
				0
			);
			assert.strictEqual(stagingEntries(DB).length, 5);
			assert.strictEqual(
				sweepImportStaging(() => false),
				5
			);
			assert.ok(existsSync(stagingRoot(DB)), '.staging itself stays');
			assert.strictEqual(
				readFileSync(join(backupDirForDatabase(DB), IMPORT_SOURCE_DIR, 'operator.tar.gz'), 'utf8'),
				'operator file'
			);
		});

		it('at startup removes every area, once per process', function () {
			const backupImport = require('#src/dataLayer/backupImport');
			backupImport.resetImportStagingSweepForTesting();
			backupImport.sweepImportStagingAtStartup();
			assert.deepStrictEqual(stagingEntries(DB), []);
			area('later');
			backupImport.sweepImportStagingAtStartup();
			assert.deepStrictEqual(stagingEntries(DB), ['later'], 'a later call is a no-op');
		});
	});
});

describe('import_backup validation', function () {
	const ok = { ...SU, database: 'importvalidation' };
	const s3 = { bucket: 'b', key: 'k', region: 'us-east-1', credentials: { secret: 'S3_CREDS' } };
	const accepted = [
		{ source_file: 'archive.tar.gz' },
		{ url: 'https://example.com/a.tar.gz?X-Amz-Signature=x' },
		{ s3 },
		{ s3: { bucket: 'b', key: 'k', credentials: { secret: 'S3_CREDS' } } },
		{ source_file: 'a.tar', declared_size: 0, sha256: 'A'.repeat(64), accept_incompatible_backup: true },
		{ staging_id: randomUUID() },
	];
	for (const fields of accepted) {
		it(`accepts ${JSON.stringify(fields)}`, function () {
			validateImportBackup({ ...ok, ...fields });
		});
	}

	const refused = [
		['no source', {}, /exactly one source/],
		['two sources', { source_file: 'a.tar', url: 'https://example.com/a.tar' }, /exactly one source/],
		['an empty source_file', { source_file: '' }, /source_file/],
		['a source_file with a slash', { source_file: 'sub/a.tar' }, /source_file/],
		['a source_file with a backslash', { source_file: 'sub\\a.tar' }, /source_file/],
		['a source_file of ..', { source_file: '..' }, /source_file/],
		['a non-string source_file', { source_file: 7 }, /source_file/],
		['an http url', { url: 'http://example.com/a.tar' }, /https/],
		['a non-string url', { url: 7 }, /https/],
		['an s3 that is not an object', { s3: 'bucket/key' }, /bucket and a key/],
		['an s3 with no key', { s3: { bucket: 'b' } }, /bucket and a key/],
		// the job could only refuse it after its row exists
		['an s3 with no credentials', { s3: { bucket: 'b', key: 'k' } }, /credentials: \{ secret/],
		['an s3 with null credentials', { s3: { bucket: 'b', key: 'k', credentials: null } }, /credentials: \{ secret/],
		['an s3 with an endpoint', { s3: { ...s3, endpoint: 'http://169.254.169.254' } }, /inline keys are refused/],
		['inline s3 keys', { s3: { ...s3, aws_access_key_id: 'AK', aws_secret_access_key: 'SK' } }, /inline keys/],
		[
			'inline credentials',
			{ s3: { ...s3, credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' } } },
			/inline keys are refused/,
		],
		['a secret beside inline keys', { s3: { ...s3, credentials: { secret: 'n', secretAccessKey: 'SK' } } }, /inline/],
		['a credentials string', { s3: { ...s3, credentials: 'S3_CREDS' } }, /inline keys are refused/],
		['a negative declared_size', { source_file: 'a.tar', declared_size: -1 }, /declared_size/],
		['a fractional declared_size', { source_file: 'a.tar', declared_size: 1.5 }, /declared_size/],
		['a string declared_size', { source_file: 'a.tar', declared_size: '10' }, /declared_size/],
		['a short sha256', { source_file: 'a.tar', sha256: 'abc' }, /sha256/],
		['a non-hex sha256', { source_file: 'a.tar', sha256: 'g'.repeat(64) }, /sha256/],
		[
			'a non-boolean accept_incompatible_backup',
			{ source_file: 'a.tar', accept_incompatible_backup: 'true' },
			/boolean/,
		],
		['a database that escapes the backups root', { source_file: 'a.tar', database: '../system' }, /database/i],
		['a staging_id that is a path', { staging_id: '../../elsewhere' }, /staging_id/],
	];
	for (const [label, fields, pattern] of refused) {
		it(`refuses ${label} with a 400`, function () {
			assert.throws(
				() => validateImportBackup({ ...ok, ...fields }),
				(error) => error.statusCode === 400 && pattern.test(error.message)
			);
		});
	}

	it('never echoes a URL query in a refusal', function () {
		assert.throws(
			() => validateImportBackup({ ...ok, url: 'http://example.com/a.tar?X-Amz-Signature=sekrit' }),
			(error) => !error.message.includes('sekrit')
		);
	});

	const nonSuperUsers = {
		'a non-super_user role': { super_user: false },
		'a role with import_backup in its operations allowlist': { super_user: false, operations: ['import_backup'] },
	};
	for (const [label, permission] of Object.entries(nonSuperUsers)) {
		it(`refuses ${label} with a 403, in the validator and the handler`, async function () {
			const request = { hdb_user: { username: 'joe', role: { permission } }, database: 'x', source_file: 'a.tar' };
			assert.throws(
				() => validateImportBackup(request),
				(error) => error.statusCode === 403
			);
			await assert.rejects(
				importBackup({ ...request, operation: 'import_backup' }),
				(error) => error.statusCode === 403
			);
		});
	}
});

describe('import_backup operation logging', function () {
	const serverUtilities = require('#src/server/serverHelpers/serverUtilities');

	it('drops url, s3 and payload from an import_backup body, whatever their case', function () {
		const body = {
			operation: 'import_backup',
			database: 'db',
			source_file: 'a.tar',
			url: 'https://example.com/a?X-Amz-Signature=sekrit',
			URL: 'https://example.com/a?X-Amz-Signature=sekrit',
			s3: { bucket: 'b', key: 'k', credentials: { secret: 'S3_CREDS' } },
			payload: Readable.from([]),
		};
		assert.deepStrictEqual(serverUtilities.redactForOperationLog(body), {
			operation: 'import_backup',
			database: 'db',
			source_file: 'a.tar',
		});
		const other = { operation: 'csv_url_load', url: 'https://example.com/a.csv' };
		assert.deepStrictEqual(serverUtilities.redactForOperationLog(other), other, 'only import_backup drops url');
	});

	describe("executeJob's created-job log (real log file)", function () {
		const { pinLogConfig } = require('../logConfigFixture.js');
		const harperLogger = require('#src/utility/logging/harper_logger');
		const jobs = require('#src/server/jobs/jobs');
		const jobRunner = require('#src/server/jobs/jobRunner');
		let restoreLogConfig;
		let originalLogLevel;

		before(function () {
			restoreLogConfig = pinLogConfig({ level: 'info' });
			originalLogLevel = harperLogger.logLevel;
			harperLogger.logLevel = 'info';
		});

		after(function () {
			harperLogger.logLevel = originalLogLevel;
			restoreLogConfig?.();
		});

		it('logs the job id and type, not the request that carries a presigned URL', async function () {
			const marker = randomUUID();
			const request = {
				operation: 'import_backup',
				database: 'db',
				url: 'https://example.com/a.tar.gz?X-Amz-Signature=sekrit-presigned',
			};
			const logPath = harperLogger.getLogFilePath();
			const offset = existsSync(logPath) ? readFileSync(logPath, 'utf8').length : 0;

			// the job row and the job thread stand in, so only executeJob's own log is in play
			const restores = [
				replaceProperty(jobs, 'addJob', async () => ({
					createdJob: { id: marker, type: 'import_backup', request },
				})),
				replaceProperty(jobRunner, 'parseMessage', async () => undefined),
			];
			try {
				// the loaded module, not a fresh copy: re-requiring it rebinds server.operation and
				// server.registerOperation to the copy for every later test
				assert.strictEqual((await serverUtilities.executeJob(request)).job_id, marker);
			} finally {
				for (const restore of restores) restore();
			}

			const written = await waitFor(
				() => {
					if (!existsSync(logPath)) return undefined;
					const tail = readFileSync(logPath, 'utf8').slice(offset);
					return tail.includes(marker) ? tail : undefined;
				},
				{ message: 'the addJob result entry was never written' }
			);
			assert.match(written, /addJob result/);
			assert.ok(!written.includes('sekrit-presigned'), written);
		});
	});
});

describe('import_backup CLI', function () {
	const http = require('node:http');
	const busboy = require('busboy');
	const cliOperations = require('#src/bin/cliOperations');
	let server;
	let target;
	let received;
	let tempDir;
	let originalExit;
	let originalConsoleError;
	let originalConsoleLog;

	before(async function () {
		tempDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.import-cli-'));
		server = http.createServer((req, res) => {
			const parts = [];
			const parser = busboy({ headers: req.headers });
			parser.on('field', (name, value) => parts.push({ kind: 'field', name, value }));
			parser.on('file', (name, stream, info) => {
				const chunks = [];
				stream.on('data', (chunk) => chunks.push(chunk));
				stream.on('end', () => parts.push({ kind: 'file', name, info, bytes: Buffer.concat(chunks) }));
			});
			parser.on('close', () => {
				received = { headers: req.headers, parts };
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ message: 'Starting job', job_id: 'job-1' }));
			});
			req.pipe(parser);
		});
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		target = `http://127.0.0.1:${server.address().port}`;
	});

	after(async function () {
		await new Promise((resolve) => server.close(resolve));
		rmSync(tempDir, { recursive: true, force: true });
	});

	beforeEach(function () {
		received = undefined;
		originalExit = process.exit;
		process.exit = (code) => {
			throw new Error(`process.exit(${code})`);
		};
		originalConsoleError = console.error;
		originalConsoleLog = console.log;
		console.error = () => {};
		console.log = () => {};
	});

	afterEach(function () {
		process.exit = originalExit;
		console.error = originalConsoleError;
		console.log = originalConsoleLog;
	});

	const send = (file) =>
		cliOperations.cliOperations(
			{ operation: 'import_backup', database: 'db', file, target, auth_username: 'admin', auth_password: 'pw' },
			true
		);

	it('uploads a plain tar as the last multipart part, declaring its size', async function () {
		const archive = join(tempDir, 'db.tar');
		writeFileSync(archive, Buffer.alloc(3000, 't'));
		await send(archive);
		assert.match(received.headers['content-type'], /^multipart\/form-data; boundary=/);
		const kinds = received.parts.map((part) => part.kind);
		assert.deepStrictEqual(kinds.slice(-1), ['file'], 'the file part comes last');
		assert.ok(kinds.slice(0, -1).every((kind) => kind === 'field'));
		const fields = Object.fromEntries(received.parts.filter((p) => p.kind === 'field').map((p) => [p.name, p.value]));
		assert.strictEqual(fields.operation, 'import_backup');
		assert.strictEqual(fields.database, 'db');
		assert.strictEqual(fields.declared_size, '3000');
		for (const local of ['file', 'auth_password', 'target', '_uploadFile', '_multipart']) {
			assert.strictEqual(fields[local], undefined, `${local} is not sent`);
		}
		const [file] = received.parts.filter((part) => part.kind === 'file');
		assert.strictEqual(file.name, 'payload');
		assert.strictEqual(file.info.filename, 'db.tar');
		assert.strictEqual(file.info.mimeType, 'application/x-tar');
		assert.ok(file.bytes.equals(readFileSync(archive)));
	});

	// the server compares declared_size with the bytes it spools, which for a compressed archive are its own
	it("declares a compressed archive's own size, the bytes the server spools", async function () {
		const archive = join(tempDir, 'db.tar.gz');
		writeFileSync(archive, Buffer.alloc(100, 'g'));
		await send(archive);
		const fields = Object.fromEntries(received.parts.filter((p) => p.kind === 'field').map((p) => [p.name, p.value]));
		assert.strictEqual(fields.declared_size, '100');
		const [file] = received.parts.filter((part) => part.kind === 'file');
		assert.strictEqual(file.info.mimeType, 'application/gzip');
		assert.ok(file.bytes.equals(readFileSync(archive)));
	});

	it('keeps a declared_size the operator passed', async function () {
		const archive = join(tempDir, 'db.tar.gz');
		writeFileSync(archive, Buffer.alloc(100, 'g'));
		await cliOperations.cliOperations(
			{
				operation: 'import_backup',
				database: 'db',
				file: archive,
				declared_size: 4096,
				target,
				auth_username: 'admin',
				auth_password: 'pw',
			},
			true
		);
		const fields = Object.fromEntries(received.parts.filter((p) => p.kind === 'field').map((p) => [p.name, p.value]));
		assert.strictEqual(fields.declared_size, '4096');
	});
});
