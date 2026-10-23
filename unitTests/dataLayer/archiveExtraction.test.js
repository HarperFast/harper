'use strict';

const assert = require('node:assert');
const { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Writable } = require('node:stream');
const { gzipSync } = require('node:zlib');
const tarStream = require('tar-stream');
const { DEFAULT_ARCHIVE_LIMITS, extractArchive, tallyArchive } = require('#src/dataLayer/archiveExtraction');
const { DiskLedger } = require('#src/dataLayer/diskLedger');
const {
	ARCHIVE_MANIFEST_ENTRY,
	ARCHIVE_SCHEMA_VERSION,
	buildArchiveManifest,
	serializeArchiveManifest,
} = require('#src/dataLayer/backupArchiveManifest');

const MANIFEST = serializeArchiveManifest(
	buildArchiveManifest({ databaseName: 'orders', blobs: true, blobRootCount: 1, roles: [] })
);
// the walker's own check, not the filesystem's EEXIST, which a case-insensitive volume would also raise
const COLLISION = /differ only by case or Unicode normalization, or repeat/;
const manifestEntry = (contents = MANIFEST) => ({ name: ARCHIVE_MANIFEST_ENTRY, contents });

/** A plain tar of `entries` ({ name, contents?, type?, linkname?, ...header }), without compression. */
async function tarOf(entries) {
	const pack = tarStream.pack();
	const chunks = [];
	pack.on('data', (chunk) => chunks.push(chunk));
	const done = new Promise((resolve, reject) => {
		pack.on('end', resolve);
		pack.on('error', reject);
	});
	for (const { contents, ...header } of entries) {
		await new Promise((resolve, reject) =>
			pack.entry(
				header,
				['file', 'contiguous-file', undefined].includes(header.type) ? Buffer.from(contents ?? '') : undefined,
				(error) => (error ? reject(error) : resolve())
			)
		);
	}
	pack.finalize();
	await done;
	return Buffer.concat(chunks);
}

describe('archiveExtraction', function () {
	let workDir;
	let destDir;
	let archiveCount;

	beforeEach(function () {
		workDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.archive-extraction-'));
		destDir = join(workDir, 'staging', 'import-1');
		mkdirSync(destDir, { recursive: true });
		archiveCount = 0;
	});

	afterEach(function () {
		rmSync(workDir, { recursive: true, force: true });
	});

	async function writeArchive(entries, { gzip = true } = {}) {
		const tar = await tarOf(entries);
		const path = join(workDir, `archive-${archiveCount++}.tar${gzip ? '.gz' : ''}`);
		writeFileSync(path, gzip ? gzipSync(tar) : tar);
		return path;
	}

	function ledger({ available = 1e12, bsize = 4096 } = {}) {
		return new DiskLedger({
			stats: async () => ({ available, free: available, size: 2e12, basis: 'quota', updatedAt: 1 }),
			statfs: () => ({ bsize, files: 0, ffree: 0 }),
			reserve: () => 0,
		});
	}

	function assertNothingExtracted() {
		assert.deepStrictEqual(readdirSync(destDir), [], 'a failed extraction must leave nothing behind');
		assert.ok(existsSync(destDir), 'the extraction directory itself is kept');
	}

	async function assertRefused(entries, pattern, options = {}) {
		const archive = await writeArchive(entries);
		await assert.rejects(extractArchive(archive, destDir, { ledger: ledger(), ...options }), (error) => {
			assert.match(error.message, pattern);
			return true;
		});
		assertNothingExtracted();
	}

	it('extracts a manifest-first archive and reports what it wrote', async function () {
		const archive = await writeArchive([
			manifestEntry(),
			{ name: 'CURRENT', contents: 'MANIFEST-000001\n' },
			{ name: 'blobs/', type: 'directory' },
			{ name: 'blobs/0/1/2', contents: 'blob-bytes' },
			{ name: './README.md', contents: 'readme' },
		]);
		const result = await extractArchive(archive, destDir, { ledger: ledger() });
		assert.strictEqual(result.manifest.archive_schema_version, ARCHIVE_SCHEMA_VERSION);
		assert.deepStrictEqual(result.waived, []);
		assert.strictEqual(result.entries, 5);
		assert.strictEqual(result.files, 4);
		assert.strictEqual(result.directories, 3, 'blobs, blobs/0 and blobs/0/1');
		assert.strictEqual(readFileSync(join(destDir, 'blobs', '0', '1', '2'), 'utf8'), 'blob-bytes');
		assert.strictEqual(readFileSync(join(destDir, 'README.md'), 'utf8'), 'readme');
		assert.strictEqual(readFileSync(join(destDir, ARCHIVE_MANIFEST_ENTRY), 'utf8'), MANIFEST);
	});

	it('reads a plain (uncompressed) tar as well', async function () {
		const archive = await writeArchive([manifestEntry(), { name: 'CURRENT', contents: 'x' }], { gzip: false });
		const result = await extractArchive(archive, destDir, { ledger: ledger() });
		assert.strictEqual(result.files, 2);
	});

	describe('tallyArchive', function () {
		const entries = [
			manifestEntry(),
			{ name: 'a/b/one', contents: 'x' },
			{ name: 'a/b/block', contents: 'y'.repeat(4096) },
			{ name: 'a/c/over', contents: 'z'.repeat(4097) },
			{ name: 'a/empty', contents: '' },
			{ name: 'd/', type: 'directory' },
		];

		it('counts every file in whole blocks and every directory, including the implied ones', async function () {
			const archive = await writeArchive(entries);
			const tally = await tallyArchive(archive, { bsize: 4096 });
			const manifestBlocks = Math.ceil(Buffer.byteLength(MANIFEST) / 4096) * 4096;
			// a, a/b, a/c are implied; d is explicit
			assert.strictEqual(tally.directories, 4);
			assert.strictEqual(tally.files, 5);
			assert.strictEqual(tally.entries, 6);
			assert.strictEqual(tally.inodes, 9);
			assert.strictEqual(tally.bytes, manifestBlocks + 4096 + 4096 + 8192 + 0 + 4 * 4096);
			assert.strictEqual(tally.payloadBytes, Buffer.byteLength(MANIFEST) + 1 + 4096 + 4097);
			assert.strictEqual(tally.firstEntryName, ARCHIVE_MANIFEST_ENTRY);
			assert.strictEqual(tally.manifest.database, 'orders');
		});

		it('rounds by the block size it is given', async function () {
			const archive = await writeArchive(entries);
			const tally = await tallyArchive(archive, { bsize: 131072 });
			assert.strictEqual(tally.bytes, 131072 * (1 + 1 + 1 + 1 + 0 + 4));
		});

		it('matches exactly what extraction charges the ledger', async function () {
			const archive = await writeArchive(entries);
			const tally = await tallyArchive(archive, { bsize: 4096 });
			const extractLedger = ledger({ available: 1e9 });
			const result = await extractArchive(archive, destDir, { ledger: extractLedger });
			assert.strictEqual(result.chargedBytes, tally.bytes);
			assert.strictEqual((await extractLedger.remaining(destDir)).bytes, 1e9 - tally.bytes);
			assert.strictEqual(result.directories, tally.directories);
		});

		it('reports the first entry without a manifest when the archive has none', async function () {
			const archive = await writeArchive([{ name: 'CURRENT', contents: 'x' }]);
			const tally = await tallyArchive(archive, { bsize: 4096 });
			assert.strictEqual(tally.firstEntryName, 'CURRENT');
			assert.strictEqual(tally.manifest, null);
		});

		it('applies the same entry checks as extraction', async function () {
			const archive = await writeArchive([manifestEntry(), { name: 'link', type: 'symlink', linkname: '/etc' }]);
			await assert.rejects(tallyArchive(archive, { bsize: 4096 }), /symlink/);
		});
	});

	describe('manifest', function () {
		it('requires harper-backup.json to be the first entry', async function () {
			await assertRefused(
				[{ name: 'CURRENT', contents: 'x' }, manifestEntry()],
				/first entry must be harper-backup\.json.*accept_incompatible_backup/
			);
		});

		it('requires it to be the first entry even when a directory comes first', async function () {
			await assertRefused(
				[{ name: './', type: 'directory' }, manifestEntry(), { name: 'CURRENT', contents: 'x' }],
				/first entry must be harper-backup\.json/
			);
		});

		it('accepts an archive without one when allowed, reporting no manifest', async function () {
			const archive = await writeArchive([{ name: 'CURRENT', contents: 'x' }]);
			const result = await extractArchive(archive, destDir, { ledger: ledger(), allowMissingManifest: true });
			assert.strictEqual(result.manifest, null);
			assert.strictEqual(result.files, 1);
		});

		it('refuses a newer schema major unless the incompatibility is accepted', async function () {
			const newer = JSON.stringify({ ...JSON.parse(MANIFEST), archive_schema_version: ARCHIVE_SCHEMA_VERSION + 1 });
			await assertRefused([manifestEntry(newer), { name: 'CURRENT', contents: 'x' }], /manifest schema version/);
			const archive = await writeArchive([manifestEntry(newer), { name: 'CURRENT', contents: 'x' }]);
			const result = await extractArchive(archive, destDir, { ledger: ledger(), acceptIncompatible: true });
			assert.strictEqual(result.waived.length, 1);
		});

		it('refuses an unparseable manifest', async function () {
			await assertRefused([manifestEntry('{not json'), { name: 'CURRENT', contents: 'x' }], /not valid JSON/);
		});

		it('refuses an oversized manifest without buffering it', async function () {
			await assertRefused([manifestEntry(' '.repeat(2048)), { name: 'CURRENT', contents: 'x' }], /limit is 1024/, {
				limits: { maxManifestBytes: 1024 },
			});
		});
	});

	describe('entry types', function () {
		for (const [type, header] of [
			['symlink', { type: 'symlink', linkname: 'CURRENT' }],
			['link', { type: 'link', linkname: 'CURRENT' }],
			['character-device', { type: 'character-device', devmajor: 1, devminor: 3 }],
			['block-device', { type: 'block-device', devmajor: 8, devminor: 0 }],
			['fifo', { type: 'fifo' }],
			['contiguous-file', { type: 'contiguous-file' }],
		]) {
			it(`refuses a ${type} entry and removes what was already extracted`, async function () {
				await assertRefused(
					[manifestEntry(), { name: 'dir/CURRENT', contents: 'x' }, { name: 'dir/special', ...header }],
					new RegExp(`is a ${type} entry`)
				);
			});
		}
	});

	describe('paths', function () {
		it('refuses an absolute path', async function () {
			await assertRefused([manifestEntry(), { name: '/etc/passwd', contents: 'x' }], /absolute path/);
		});

		it("refuses a '..' segment", async function () {
			await assertRefused([manifestEntry(), { name: 'a/../../escape', contents: 'x' }], /'\.\.' segment/);
			assert.ok(!existsSync(join(workDir, 'staging', 'escape')));
		});

		it('refuses a backslash, which is a separator on Windows', async function () {
			await assertRefused([manifestEntry(), { name: 'a\\..\\..\\escape', contents: 'x' }], /backslash/);
		});

		it('refuses a path longer than the cap, including one carried in a pax header', async function () {
			const long = `${'d/'.repeat(300)}${'f'.repeat(500)}`;
			assert.ok(Buffer.byteLength(long) > 1024);
			await assertRefused([manifestEntry(), { name: long, contents: 'x' }], /longer than 1024 bytes/);
		});

		it('refuses to overwrite a file already in the extraction directory, keeping it', async function () {
			writeFileSync(join(destDir, 'CURRENT'), 'theirs');
			const archive = await writeArchive([manifestEntry(), { name: 'CURRENT', contents: 'ours' }]);
			await assert.rejects(extractArchive(archive, destDir, { ledger: ledger() }), /collides with a path already/);
			assert.deepStrictEqual(readdirSync(destDir), ['CURRENT']);
			assert.strictEqual(readFileSync(join(destDir, 'CURRENT'), 'utf8'), 'theirs');
		});
	});

	describe('name collisions', function () {
		it('refuses an exact duplicate', async function () {
			await assertRefused([manifestEntry(), { name: 'x', contents: '1' }, { name: 'x', contents: '2' }], COLLISION);
		});

		it('refuses file names that differ only by case', async function () {
			await assertRefused(
				[manifestEntry(), { name: 'Data.sst', contents: '1' }, { name: 'data.sst', contents: '2' }],
				COLLISION
			);
		});

		it('refuses directories that differ only by case', async function () {
			await assertRefused([manifestEntry(), { name: 'A/x', contents: '1' }, { name: 'a/y', contents: '2' }], COLLISION);
		});

		it('refuses names that differ only by Unicode normalization', async function () {
			const composed = 'café';
			const decomposed = 'café';
			assert.notStrictEqual(composed, decomposed);
			await assertRefused(
				[manifestEntry(), { name: composed, contents: '1' }, { name: decomposed, contents: '2' }],
				COLLISION
			);
		});

		it('refuses a directory entry that repeats a file name', async function () {
			await assertRefused(
				[manifestEntry(), { name: 'x', contents: '1' }, { name: 'x/', type: 'directory' }],
				COLLISION
			);
		});

		it('refuses an entry beneath a file', async function () {
			await assertRefused([manifestEntry(), { name: 'x', contents: '1' }, { name: 'x/y', contents: '2' }], /a file/);
		});

		it('accepts an explicit directory entry after the directory was implied', async function () {
			const archive = await writeArchive([
				manifestEntry(),
				{ name: 'a/x', contents: '1' },
				{ name: 'a/', type: 'directory' },
			]);
			const result = await extractArchive(archive, destDir, { ledger: ledger() });
			assert.strictEqual(result.directories, 1);
		});
	});

	describe('limits', function () {
		it('exports its defaults', function () {
			assert.strictEqual(DEFAULT_ARCHIVE_LIMITS.maxEntries, 1_000_000);
			assert.strictEqual(DEFAULT_ARCHIVE_LIMITS.maxPathBytes, 1024);
			assert.ok(Object.isFrozen(DEFAULT_ARCHIVE_LIMITS));
		});

		it('caps the entry count', async function () {
			await assertRefused(
				[manifestEntry(), { name: 'a', contents: '' }, { name: 'b', contents: '' }, { name: 'c', contents: '' }],
				/more than 3 entries/,
				{ limits: { maxEntries: 3 } }
			);
		});

		it('caps a single entry', async function () {
			await assertRefused([manifestEntry(), { name: 'big', contents: 'x'.repeat(2000) }], /limit is 1000/, {
				limits: { maxEntryBytes: 1000 },
			});
		});

		it('caps the total', async function () {
			const limit = Buffer.byteLength(MANIFEST) + 1000;
			await assertRefused(
				[manifestEntry(), { name: 'a', contents: 'x'.repeat(600) }, { name: 'b', contents: 'x'.repeat(600) }],
				new RegExp(`exceed ${limit} bytes in total`),
				{ limits: { maxTotalBytes: limit } }
			);
		});
	});

	describe('decompression bombs', function () {
		it('refuses an entry that inflates past the metered total before writing any of it', async function () {
			const bombSize = 64 * 1024 * 1024;
			const archive = await writeArchive([manifestEntry(), { name: 'bomb', contents: Buffer.alloc(bombSize) }]);
			assert.ok(readFileSync(archive).length < bombSize / 100, 'the fixture must actually be a bomb');
			await assert.rejects(
				extractArchive(archive, destDir, { ledger: ledger(), limits: { maxTotalBytes: 1024 * 1024 } }),
				/in total/
			);
			assertNothingExtracted();
		});

		it('refuses a stream that inflates without producing entries', async function () {
			const tar = await tarOf([manifestEntry()]);
			// tar-stream skips zero blocks, so a run of them inflates forever without yielding an entry
			const archive = join(workDir, 'zeros.tar.gz');
			writeFileSync(
				archive,
				gzipSync(Buffer.concat([tar.subarray(0, tar.length - 1024), Buffer.alloc(64 * 1024 * 1024)]))
			);
			await assert.rejects(extractArchive(archive, destDir, { ledger: ledger() }), /decompression bomb/);
			assertNothingExtracted();
			await assert.rejects(tallyArchive(archive, { bsize: 4096 }), /decompression bomb/);
		});

		it('refuses an entry that does not fit the ledger before writing it', async function () {
			const archive = await writeArchive([manifestEntry(), { name: 'big', contents: 'x'.repeat(100_000) }]);
			await assert.rejects(extractArchive(archive, destDir, { ledger: ledger({ available: 50_000 }) }), (error) => {
				assert.strictEqual(error.statusCode, 507);
				assert.ok(error.message.includes(destDir), error.message);
				return true;
			});
			assertNothingExtracted();
		});
	});

	describe('write failures', function () {
		for (const code of ['ENOSPC', 'EDQUOT']) {
			it(`surfaces ${code} from the writer as 507 and removes everything it created`, async function () {
				writeFileSync(join(destDir, 'owner.json'), '{}');
				const archive = await writeArchive([
					manifestEntry(),
					{ name: 'a/one', contents: 'first' },
					{ name: 'a/b/two', contents: 'x'.repeat(10_000) },
				]);
				let opened = 0;
				const failing = (handle) => {
					if (++opened < 3) return handle.createWriteStream();
					return new Writable({
						write(_chunk, _encoding, callback) {
							callback(Object.assign(new Error(`${code}: no space left`), { code }));
						},
					});
				};
				await assert.rejects(
					extractArchive(archive, destDir, { ledger: ledger(), createWriteStream: failing }),
					(error) => {
						assert.strictEqual(error.statusCode, 507);
						assert.match(error.message, new RegExp(code));
						assert.strictEqual(error.cause.code, code);
						return true;
					}
				);
				assert.deepStrictEqual(readdirSync(destDir), ['owner.json'], 'only what extraction created is removed');
			});
		}
	});
});
