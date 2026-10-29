'use strict';

const testUtils = require('../testUtils.js');
const assert = require('node:assert');
const fs = require('node:fs');
const {
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} = fs;
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pipeline } = require('node:stream/promises');
const { waitFor } = require('../waitFor.js');
const { closeDatabase, table } = require('#src/resources/databases');
const { openRestoredGeneration, closeRestoredGeneration } = require('#src/resources/databases');
const { createBlob, getFilePathForBlob } = require('#src/resources/blob');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { createBackupStream } = require('#src/dataLayer/rocksdbBackup');
const { stageArchive, stagedTreeDir, STAGED_INVENTORY_FILE } = require('#src/dataLayer/archiveStaging');
const { verifyStagedTree, installStagedTree, assertInstallFits } = require('#src/dataLayer/stagedTreeInstall');
const { fileIdentity } = require('#src/utility/fileIdentity');

const describeUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;
const SOURCE = 'stagedtreesrc';
const LOADED = 'stagedtreeloaded';
const BLOB_BYTES = Buffer.alloc(20000, 'z');
const RECORD_COUNT = 40;
const ENGINE_FILE = /^[^/]+\.(sst|blob)$/;

function walk(root, prefix = '') {
	const out = [];
	for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walk(root, relative));
		else if (entry.isFile()) out.push(relative);
	}
	return out;
}

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

function largest(root, pattern) {
	const [path] = walk(root)
		.filter((file) => pattern.test(file))
		.sort((a, b) => statSync(join(root, b)).size - statSync(join(root, a)).size);
	return path;
}

function flipMiddleByte(path) {
	const bytes = readFileSync(path);
	bytes[Math.floor(bytes.length / 2)] ^= 0xff;
	writeFileSync(path, bytes);
}

function failingOnCall(name, failOn, error) {
	const original = fs[name];
	let calls = 0;
	fs[name] = (...args) => {
		if (++calls === failOn) throw error;
		return original(...args);
	};
	return () => {
		fs[name] = original;
	};
}

function errorWithCode(code) {
	return Object.assign(new Error(`${code}: simulated`), { code });
}

describeUnlessLmdb('installing a staged archive tree', function () {
	this.timeout(120000);
	let tempDir;
	let fullArchive;
	let engineArchive;
	let sequence = 0;

	function fresh(label) {
		return join(tempDir, `${label}-${++sequence}`);
	}

	async function stage(archive) {
		const stagingDir = join(fresh('stage'), 'staging');
		await stageArchive({
			databaseName: LOADED,
			stagingDir,
			serverPath: archive,
			serverPathIdentity: fileIdentity(statSync(archive)),
			acceptIncompatible: false,
			restoredFrom: archive,
		});
		return { stagingDir, treeDir: stagedTreeDir(stagingDir) };
	}

	function readRecords(databasePath) {
		const generation = openRestoredGeneration(databasePath, LOADED);
		try {
			const ids = [];
			for (const entry of generation.tables.Items.primaryStore.getRange({ versions: true })) ids.push(entry.key);
			return ids;
		} finally {
			closeRestoredGeneration(databasePath, generation);
		}
	}

	function assertRecords(databasePath) {
		const ids = readRecords(databasePath);
		assert.strictEqual(ids.length, RECORD_COUNT + 1, 'every archived record loads');
		assert.ok(ids.includes('with-blob'));
	}

	function assertSameBytes(treeDir, databasePath, files) {
		for (const file of files) {
			assert.ok(readFileSync(join(treeDir, file)).equals(readFileSync(join(databasePath, file))), `${file} bytes`);
		}
	}

	before(async function () {
		await testUtils.ensureSystemTables();
		setMainIsWorker(true);
		tempDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.staged-tree-'));
		const Items = table({
			table: 'Items',
			database: SOURCE,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'label', indexed: true }, { name: 'attachment' }],
		});
		for (let id = 0; id < RECORD_COUNT; id++) await Items.put({ id, label: `item-${id % 5}`, pad: 'p'.repeat(64) });
		const blob = await createBlob(BLOB_BYTES);
		await Items.put({ id: 'with-blob', label: 'blob', attachment: blob });
		const blobPath = getFilePathForBlob(blob);
		await waitFor(() => existsSync(blobPath) && readFileSync(blobPath).length > BLOB_BYTES.length, {
			timeout: 10000,
			message: 'the blob was never written to its file',
		});
		const rootStore = Items.primaryStore.rootStore;
		await rootStore.flush();
		fullArchive = join(tempDir, 'full.tar');
		engineArchive = join(tempDir, 'engine.tar');
		await pipeline(createBackupStream(rootStore, SOURCE, false), createWriteStream(fullArchive));
		await pipeline(createBackupStream(rootStore, SOURCE, false, true), createWriteStream(engineArchive));
	});

	after(async function () {
		this.timeout(60000);
		await closeDatabase(SOURCE).catch(() => {});
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	describe('on one device', function () {
		it('hard-links table and blob files, copies the rest, and leaves the tree whole', async function () {
			const { stagingDir, treeDir } = await stage(fullArchive);
			await verifyStagedTree(stagingDir);
			const target = fresh('target');
			const blobRoot = fresh('blobroot');

			await installStagedTree(stagingDir, target, [blobRoot], true, 'op1');

			const engineFiles = walk(treeDir).filter((file) => !file.startsWith('blobs/'));
			const linked = engineFiles.filter((file) => ENGINE_FILE.test(file));
			assert.ok(
				linked.some((file) => file.endsWith('.sst')),
				'the archive has table files'
			);
			for (const file of linked) {
				const staged = statSync(join(treeDir, file));
				const installed = statSync(join(target, file));
				assert.ok(installed.nlink >= 2, `${file} is linked`);
				assert.strictEqual(installed.ino, staged.ino, `${file} shares the tree's inode`);
			}
			const copied = engineFiles.filter((file) => !ENGINE_FILE.test(file));
			assert.ok(copied.some((file) => file.startsWith('MANIFEST-')));
			assert.ok(copied.includes('CURRENT'));
			assert.ok(copied.some((file) => file.startsWith('OPTIONS-')));
			for (const file of copied) {
				assert.notStrictEqual(statSync(join(target, file)).ino, statSync(join(treeDir, file)).ino, `${file} is a copy`);
			}
			assertSameBytes(treeDir, target, engineFiles);
			assert.ok(!readdirSync(target).some((entry) => entry.startsWith('.harper-restore-')), 'the temp dir is gone');
			assert.ok(walk(blobRoot).length > 0, 'the blob root was installed');
			await verifyStagedTree(stagingDir);
			assertRecords(target);
		});
	});

	describe('when the filesystem will not link', function () {
		it('copies every file, verified, and succeeds', async function () {
			const { stagingDir, treeDir } = await stage(engineArchive);
			await verifyStagedTree(stagingDir);
			const target = fresh('target');
			const restore = (() => {
				const original = fs.linkSync;
				fs.linkSync = () => {
					throw errorWithCode('EXDEV');
				};
				return () => {
					fs.linkSync = original;
				};
			})();
			try {
				await installStagedTree(stagingDir, target, [], false, 'op2');
			} finally {
				restore();
			}

			const engineFiles = walk(treeDir);
			for (const file of engineFiles) assert.strictEqual(statSync(join(target, file)).nlink, 1, `${file} is a copy`);
			assertSameBytes(treeDir, target, engineFiles);
			assertRecords(target);
		});
	});

	describe('the install plan', function () {
		it('counts top-level table and blob files, and per-root blobs, without the blobs README', async function () {
			const { stagingDir, treeDir } = await stage(fullArchive);
			const plan = await verifyStagedTree(stagingDir);

			const top = walk(treeDir).filter((file) => ENGINE_FILE.test(file));
			assert.ok(top.length > 0);
			assert.strictEqual(plan.immutableEngine.files, top.length);
			const blobFiles = walk(treeDir).filter((file) => /^blobs\/\d+\//.test(file));
			assert.ok(blobFiles.length > 0, 'precondition: the archive carries blobs');
			const roots = [...plan.blobRoots.entries()];
			assert.ok(roots.length > 0);
			assert.ok(roots.every(([index, root]) => Number.isInteger(index) && root.files > 0));
			assert.strictEqual(
				roots.reduce((sum, [, root]) => sum + root.files, 0),
				blobFiles.length,
				'a blobs README is not counted'
			);
		});
	});

	describe('assertInstallFits', function () {
		const probes = (directory) => readdirSync(directory).filter((entry) => entry.startsWith('.harper-link-probe-'));

		for (const linking of [true, false]) {
			it(`leaves no link probe behind when linking ${linking ? 'works' : 'fails with EXDEV'}`, async function () {
				const { stagingDir } = await stage(fullArchive);
				const plan = await verifyStagedTree(stagingDir);
				const parent = fresh('parent');
				const blobParent = fresh('blobparent');
				mkdirSync(parent, { recursive: true });
				mkdirSync(blobParent, { recursive: true });
				const original = fs.linkSync;
				if (!linking) {
					fs.linkSync = () => {
						throw errorWithCode('EXDEV');
					};
				}
				try {
					await assertInstallFits(stagingDir, plan, join(parent, 'db'), [join(blobParent, 'blobs')], true, 'probe1');
				} finally {
					fs.linkSync = original;
				}
				assert.deepStrictEqual(probes(parent), []);
				assert.deepStrictEqual(probes(blobParent), []);
			});
		}
	});

	describe('a corrupted tree', function () {
		it('is refused with a 409 naming the file', async function () {
			const { stagingDir, treeDir } = await stage(fullArchive);
			const sst = largest(treeDir, /^[^/]+\.sst$/);
			flipMiddleByte(join(treeDir, sst));

			await assert.rejects(verifyStagedTree(stagingDir), (error) => {
				assert.strictEqual(error.statusCode, 409);
				assert.ok(error.message.includes(sst), error.message);
				return true;
			});
		});

		it('is refused with a 410 when a file is gone', async function () {
			const { stagingDir, treeDir } = await stage(engineArchive);
			const sst = largest(treeDir, /^[^/]+\.sst$/);
			rmSync(join(treeDir, sst));

			await assert.rejects(
				verifyStagedTree(stagingDir),
				(error) => error.statusCode === 410 && error.message.includes(sst)
			);
		});
	});

	describe('an interrupted install', function () {
		it('leaves the tree whole and installs on the rerun', async function () {
			const { stagingDir, treeDir } = await stage(engineArchive);
			await verifyStagedTree(stagingDir);
			const target = fresh('target');
			const failure = new Error('simulated rename failure');
			const restore = failingOnCall('renameSync', 2, failure);
			try {
				await assert.rejects(installStagedTree(stagingDir, target, [], false, 'op3'), failure);
			} finally {
				restore();
			}

			assert.ok(!existsSync(join(target, 'CURRENT')), 'CURRENT is installed last, so the target cannot open');
			assert.ok(readdirSync(target).length > 0, 'the target is partial');
			await verifyStagedTree(stagingDir);

			await installStagedTree(stagingDir, target, [], false, 'op3');

			assertSameBytes(treeDir, target, walk(treeDir));
			assert.ok(!readdirSync(target).some((entry) => entry.startsWith('.harper-restore-')));
			assertRecords(target);
		});
	});

	describe('an unsafe inventory', function () {
		let stagingDir;
		let original;

		before(async function () {
			({ stagingDir } = await stage(engineArchive));
			original = readFileSync(join(stagingDir, STAGED_INVENTORY_FILE), 'utf8');
		});

		afterEach(function () {
			if (stagingDir) writeFileSync(join(stagingDir, STAGED_INVENTORY_FILE), original);
		});

		const cases = {
			'a parent traversal': '../escape',
			'an absolute path': join(tmpdir(), 'escape'),
			'a nested traversal': 'a/../../escape',
		};
		for (const [label, path] of Object.entries(cases)) {
			it(`refuses ${label} before reading any file`, async function () {
				const line = JSON.stringify({ path, size: 1, sha256: 'x' });
				writeFileSync(join(stagingDir, STAGED_INVENTORY_FILE), `${line}\n${original}`);
				await assert.rejects(verifyStagedTree(stagingDir), /invalid entry/);
			});
		}

		it('refuses a line that is not JSON', async function () {
			writeFileSync(join(stagingDir, STAGED_INVENTORY_FILE), `not json\n${original}`);
			await assert.rejects(verifyStagedTree(stagingDir), /invalid entry/);
		});
	});

	describe('an engine-only archive', function () {
		it('leaves existing blob roots untouched', async function () {
			const { stagingDir } = await stage(engineArchive);
			const plan = await verifyStagedTree(stagingDir);
			assert.strictEqual(plan.blobRoots.size, 0, 'precondition: no blobs staged');
			const blobRoot = fresh('blobroot');
			mkdirSync(join(blobRoot, 'ab'), { recursive: true });
			writeFileSync(join(blobRoot, 'ab', 'keep'), 'kept');
			const target = fresh('target');

			await installStagedTree(stagingDir, target, [blobRoot], false, 'op6');

			assert.strictEqual(readFileSync(join(blobRoot, 'ab', 'keep'), 'utf8'), 'kept');
			assert.deepStrictEqual(walk(blobRoot), ['ab/keep']);
			assertRecords(target);
		});
	});

	describe('staging an archive with a corrupted block', function () {
		it('rejects it and publishes no inventory or source record', async function () {
			const buffer = Buffer.from(readFileSync(engineArchive));
			const [sst] = tarEntries(buffer)
				.filter((entry) => entry.name.endsWith('.sst'))
				.sort((a, b) => b.size - a.size);
			assert.ok(sst, 'precondition: the archive carries a table file');
			buffer[sst.offset + 512 + Math.floor(sst.size / 2)] ^= 0xff;
			const corrupt = join(tempDir, 'corrupt.tar');
			writeFileSync(corrupt, buffer);
			const stagingDir = join(fresh('stage'), 'staging');

			await assert.rejects(
				stageArchive({
					databaseName: LOADED,
					stagingDir,
					serverPath: corrupt,
					serverPathIdentity: fileIdentity(statSync(corrupt)),
					acceptIncompatible: false,
					restoredFrom: corrupt,
				})
			);

			assert.ok(!existsSync(join(stagingDir, STAGED_INVENTORY_FILE)));
			assert.ok(!existsSync(join(stagingDir, 'staged.json')));
		});
	});
});
