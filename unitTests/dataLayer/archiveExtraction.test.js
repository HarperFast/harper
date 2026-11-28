'use strict';

const assert = require('node:assert');
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { PassThrough, Readable, Writable } = require('node:stream');
const { gzipSync } = require('node:zlib');
const { pack } = require('tar-stream');
const { extractArchiveStream } = require('#src/dataLayer/archiveExtraction');
const { archiveRouter, createStagingAreas, mintStagingId, planStaging } = require('#src/dataLayer/archiveStaging');
const {
	ARCHIVE_MANIFEST_ENTRY,
	buildArchiveManifest,
	serializeArchiveManifest,
} = require('#src/dataLayer/backupArchiveManifest');

/** A tar of `entries` ({ name, body?, type?, linkname? }) as a buffer, ending with tar's two zero blocks. */
async function tarOf(entries) {
	const archive = pack();
	const chunks = [];
	archive.on('data', (chunk) => chunks.push(chunk));
	const ended = new Promise((resolve, reject) => {
		archive.on('end', resolve);
		archive.on('error', reject);
	});
	for (const { body, ...header } of entries) {
		await new Promise((resolve, reject) => archive.entry(header, body, (error) => (error ? reject(error) : resolve())));
	}
	archive.finalize();
	await ended;
	return Buffer.concat(chunks);
}

function manifestEntry(fields = {}) {
	const manifest = {
		...buildArchiveManifest({ databaseName: 'orders', blobs: true, blobRootCount: 1, roles: null }),
		...fields,
	};
	return { name: ARCHIVE_MANIFEST_ENTRY, body: serializeArchiveManifest(manifest) };
}

function archiveOf(entries, { manifest = {} } = {}) {
	return tarOf(manifest === null ? entries : [manifestEntry(manifest), ...entries]);
}

function listTree(root) {
	const found = [];
	const visit = (directory, prefix) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				found.push(`${path}/`);
				visit(join(directory, entry.name), path);
			} else found.push(path);
		}
	};
	visit(root, '');
	return found.sort();
}

describe('archive extraction from a stream', function () {
	let root;
	let plan;
	let waived;
	const escapes = [];
	const onEscape = (error) => escapes.push(error);

	before(function () {
		process.on('unhandledRejection', onEscape);
		process.on('uncaughtException', onEscape);
	});

	after(function () {
		process.off('unhandledRejection', onEscape);
		process.off('uncaughtException', onEscape);
	});

	beforeEach(function () {
		root = mkdtempSync(join(tmpdir(), 'harper.unit-test.archive-extraction-'));
		plan = planStaging(join(root, 'database', 'orders'), [join(root, 'blobs', 'orders')], mintStagingId());
		createStagingAreas(plan);
		waived = undefined;
	});

	afterEach(async function () {
		// a stream left erroring after its handler returned surfaces here, not in the test that caused it
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setTimeout(resolve, 20));
		if (root) rmSync(root, { recursive: true, force: true });
		assert.deepStrictEqual(escapes.splice(0), [], 'nothing rejected or threw outside the extraction');
	});

	function extract(input, options = {}) {
		const { acceptIncompatible = false, allowEngineOnly = false, budget = 1024 ** 3, ...rest } = options;
		const budgets = new Map();
		for (const part of plan.parts) budgets.set(String(require('node:fs').statSync(part.staged).dev), budget);
		return extractArchiveStream(Buffer.isBuffer(input) ? Readable.from([input]) : input, {
			router: archiveRouter(plan, {
				acceptIncompatible,
				allowEngineOnly,
				onManifest(_manifest, foundWaived) {
					waived = foundWaived;
				},
			}),
			budgets,
			allowMissingManifest: acceptIncompatible,
			...rest,
		});
	}

	const engine = () => plan.parts[0].staged;
	const blobRoot = () => plan.parts[1].staged;

	it('writes engine files and blob trees to their parts, drops the READMEs, and hashes the bytes as received', async function () {
		const archive = gzipSync(
			await archiveOf([
				{ name: 'CURRENT', body: 'MANIFEST-000001\n' },
				{ name: 'transaction_logs/', type: 'directory' },
				{ name: 'transaction_logs/local/1.txnlog', body: 'log' },
				{ name: 'blobs/', type: 'directory' },
				{ name: 'blobs/0/', type: 'directory' },
				{ name: 'blobs/0/0/000/001', body: 'blob body' },
				{ name: 'blobs/README.md', body: 'about blobs' },
				{ name: 'README.md', body: 'about the archive' },
			])
		);
		const result = await extract(archive);
		assert.strictEqual(result.sha256, createHash('sha256').update(archive).digest('hex'));
		assert.strictEqual(result.archiveBytes, archive.length);
		assert.strictEqual(result.manifest.database, 'orders');
		assert.deepStrictEqual(waived, []);
		assert.deepStrictEqual(listTree(engine()), [
			'CURRENT',
			'transaction_logs/',
			'transaction_logs/local/',
			'transaction_logs/local/1.txnlog',
		]);
		assert.deepStrictEqual(listTree(blobRoot()), ['0/', '0/000/', '0/000/001']);
		assert.strictEqual(readFileSync(join(blobRoot(), '0/000/001'), 'utf8'), 'blob body');
		// owner-only, whatever mode the tar header carried
		assert.strictEqual(require('node:fs').statSync(join(engine(), 'CURRENT')).mode & 0o777, 0o600);
		assert.strictEqual(require('node:fs').statSync(join(engine(), 'transaction_logs')).mode & 0o777, 0o700);
	});

	describe('refuses an entry that could reach outside its part or merge with another', function () {
		const cases = [
			['an absolute path', [{ name: '/etc/passwd', body: 'x' }], /absolute path/],
			['a parent segment', [{ name: 'a/../../escape', body: 'x' }], /'\.\.' segment/],
			['a backslash', [{ name: 'a\\b', body: 'x' }], /NUL, backslash or colon/],
			['a colon', [{ name: 'a:b', body: 'x' }], /NUL, backslash or colon/],
			['a symlink', [{ name: 'link', type: 'symlink', linkname: '/etc' }], /symlink entry/],
			[
				'a hard link',
				[
					{ name: 'CURRENT', body: 'x' },
					{ name: 'hard', type: 'link', linkname: 'CURRENT' },
				],
				/link entry/,
			],
			[
				'two names differing by case',
				[
					{ name: 'Data/x', body: 'x' },
					{ name: 'data/y', body: 'y' },
				],
				/collides/,
			],
			[
				'a repeated name',
				[
					{ name: 'CURRENT', body: 'x' },
					{ name: 'CURRENT', body: 'y' },
				],
				/collides/,
			],
			[
				'two normalizations of one name',
				[
					{ name: 'café', body: 'x' },
					{ name: 'café', body: 'y' },
				],
				/collides/,
			],
			[
				'a file under a file',
				[
					{ name: 'CURRENT', body: 'x' },
					{ name: 'CURRENT/inner', body: 'y' },
				],
				/inside "CURRENT", a file/,
			],
			['a blob root index with a leading zero', [{ name: 'blobs/01/x', body: 'x' }], /blobs\/<root index>/],
			[
				'a blob root past the configured ones',
				[{ name: 'blobs/1/x', body: 'x' }],
				/blob root 1, but this instance has 1/,
			],
			['a file directly under blobs', [{ name: 'blobs/stray', body: 'x' }], /blobs\/<root index>/],
			['a second manifest', [{ name: ARCHIVE_MANIFEST_ENTRY, body: '{}' }], /only be the first entry/],
		];
		for (const [label, entries, refusal] of cases) {
			it(label, async function () {
				await assert.rejects(extract(gzipSync(await archiveOf(entries))), refusal);
				assert.deepStrictEqual(
					listTree(root).filter((path) => !path.startsWith('database/') && !path.startsWith('blobs/')),
					[],
					'nothing written beside the staging'
				);
			});
		}
	});

	it('refuses a manifest whose capability this build lacks before any engine byte is written', async function () {
		const archive = gzipSync(
			await archiveOf([{ name: 'CURRENT', body: 'x' }], {
				manifest: { requires: ['rocksdb-stream-backup', 'a-future-format'] },
			})
		);
		await assert.rejects(extract(archive), /a-future-format/);
		assert.deepStrictEqual(listTree(engine()), []);
	});

	it('refuses an archive made with exclude_blobs unless allow_engine_only, and one with more blob roots than this instance', async function () {
		const engineOnly = { manifest: { blobs: false, blob_root_count: 0 } };
		await assert.rejects(
			extract(gzipSync(await archiveOf([{ name: 'CURRENT', body: 'x' }], engineOnly))),
			/exclude_blobs=true and carries no blob files.*pass allow_engine_only=true/
		);
		assert.deepStrictEqual(listTree(engine()), []);
		await extract(gzipSync(await archiveOf([{ name: 'CURRENT', body: 'x' }], engineOnly)), { allowEngineOnly: true });
		assert.deepStrictEqual(listTree(engine()), ['CURRENT']);
		rmSync(join(engine(), 'CURRENT'));
		await assert.rejects(
			extract(
				gzipSync(
					await archiveOf(
						[
							{ name: 'CURRENT', body: 'x' },
							{ name: 'blobs/0/0/0/1', body: 'y' },
						],
						engineOnly
					)
				),
				{ allowEngineOnly: true }
			),
			/"blobs\/0\/0\/0\/1" is a blob file, but the archive's manifest says it was made with exclude_blobs/
		);
		// refused at the entry, after the engine file before it; the stager removes the area
		rmSync(join(engine(), 'CURRENT'));
		await assert.rejects(
			extract(gzipSync(await archiveOf([{ name: 'CURRENT', body: 'x' }], { manifest: { blob_root_count: 2 } }))),
			/2 blob root\(s\), but this instance has 1/
		);
		assert.deepStrictEqual(listTree(engine()), []);
	});

	it('refuses a manifest past its size limit, and a malformed one', async function () {
		const oversized = { name: ARCHIVE_MANIFEST_ENTRY, body: Buffer.alloc(1024 * 1024 + 1, 0x20) };
		await assert.rejects(extract(gzipSync(await tarOf([oversized]))), /1048577 bytes; the limit is 1048576/);
		await assert.rejects(
			extract(gzipSync(await tarOf([{ name: ARCHIVE_MANIFEST_ENTRY, body: '{"archive_schema' }]))),
			/not valid JSON/
		);
	});

	it('requires the manifest first unless the restore accepts an archive from before manifests', async function () {
		const archive = gzipSync(await archiveOf([{ name: 'CURRENT', body: 'x' }], { manifest: null }));
		await assert.rejects(extract(archive), /first entry must be harper-backup.json/);
		assert.deepStrictEqual(listTree(engine()), []);
		const result = await extract(archive, { acceptIncompatible: true });
		assert.strictEqual(result.manifest, null);
		assert.deepStrictEqual(listTree(engine()), ['CURRENT']);
	});

	it('refuses a gzip stream cut short', async function () {
		const archive = gzipSync(await archiveOf([{ name: 'CURRENT', body: Buffer.alloc(64 * 1024, 7) }]));
		await assert.rejects(extract(archive.subarray(0, archive.length - 9)), /not a whole get_backup archive/);
	});

	it('refuses a gzip stream whose checksum does not match what it inflates to', async function () {
		const archive = gzipSync(await archiveOf([{ name: 'CURRENT', body: Buffer.alloc(64 * 1024, 7) }]));
		const flipped = Buffer.from(archive);
		// the trailer is CRC32 then ISIZE: the inflated bytes are intact, only the check disagrees
		flipped[flipped.length - 8] ^= 0xff;
		await assert.rejects(extract(flipped), /not a whole get_backup archive/);
		const corrupted = Buffer.from(archive);
		corrupted[Math.floor(corrupted.length / 2)] ^= 0x10;
		// wherever the damage lands, it is refused as the client's archive
		await assert.rejects(extract(corrupted), (error) => error.statusCode === 400);
	});

	it('refuses a plain tar cut at an entry boundary, which tar itself would read as whole', async function () {
		const tar = await archiveOf([
			{ name: 'CURRENT', body: 'x' },
			{ name: 'MANIFEST-000001', body: 'y' },
		]);
		const whole = await extract(tar);
		assert.strictEqual(whole.files, 2);
		rmSync(join(engine(), 'CURRENT'));
		rmSync(join(engine(), 'MANIFEST-000001'));
		await assert.rejects(extract(tar.subarray(0, tar.length - 1024)), /end-of-archive marker/);
	});

	it('refuses a plain tar cut exactly after an entry whose contents end in zero blocks', async function () {
		const entries = [
			manifestEntry(),
			{ name: 'CURRENT', body: 'x' },
			{ name: 'MANIFEST-000001', body: Buffer.alloc(4096) },
		];
		const tar = await tarOf(entries);
		const boundary = entries.reduce(
			(total, { body }) => total + 512 + Math.ceil(Buffer.byteLength(body) / 512) * 512,
			0
		);
		assert.ok(
			tar.subarray(boundary - 1024, boundary).every((byte) => byte === 0),
			'precondition: it ends in zeros'
		);
		await assert.rejects(extract(tar.subarray(0, boundary)), /end-of-archive marker/);
	});

	it('refuses a stream that inflates past what its entries account for', async function () {
		const tar = await archiveOf([{ name: 'CURRENT', body: 'x' }]);
		const bomb = gzipSync(Buffer.concat([tar, Buffer.alloc(8 * 1024 * 1024)]));
		await assert.rejects(extract(bomb), /decompression bomb/);
	});

	it('accepts a plain tar delivered in chunks larger than the meter allowance', async function () {
		const tar = await archiveOf([
			{ name: 'CURRENT', body: Buffer.alloc(3 * 1024 * 1024, 1) },
			{ name: 'MANIFEST-000001', body: Buffer.alloc(2 * 1024 * 1024, 2) },
		]);
		const result = await extract(Readable.from([tar]));
		assert.strictEqual(result.files, 2);
	});

	it('does not let the declared size of an entry it drops pay for inflated bytes', async function () {
		const tar = await archiveOf([
			{ name: 'CURRENT', body: 'x' },
			{ name: 'README.md', body: Buffer.alloc(4 * 1024 * 1024, 0x61) },
		]);
		await assert.rejects(extract(gzipSync(tar)), /decompression bomb/);
	});

	it('reports a fault of its own as itself, not as a client archive', async function () {
		const archive = gzipSync(await archiveOf([{ name: 'CURRENT', body: 'x' }]));
		const router = archiveRouter(plan, { acceptIncompatible: false, onManifest() {} });
		await assert.rejects(
			extract(archive, {
				router: {
					admitManifest: router.admitManifest,
					// a bug: reads past what the router was given
					route: (segments) => segments.nothing.here,
				},
			}),
			(error) => error instanceof TypeError && error.statusCode === undefined
		);
	});

	it('holds entries to the configured limits', async function () {
		const entries = [
			{ name: 'a', body: 'x' },
			{ name: 'b', body: 'x' },
			{ name: 'c', body: 'x' },
		];
		await assert.rejects(
			extract(gzipSync(await archiveOf(entries)), { limits: { maxEntries: 3 } }),
			/more than 3 entries/
		);
		await assert.rejects(
			extract(gzipSync(await archiveOf([{ name: 'big', body: Buffer.alloc(2048) }])), {
				limits: { maxEntryBytes: 1024 },
			}),
			/is 2048 bytes; the limit is 1024/
		);
		await assert.rejects(
			extract(gzipSync(await archiveOf([{ name: 'x'.repeat(40), body: 'x' }])), { limits: { maxPathBytes: 32 } }),
			/longer than 32 bytes/
		);
	});

	it('stops with 507 once a filesystem budget is spent', async function () {
		const archive = gzipSync(await archiveOf([{ name: 'CURRENT', body: Buffer.alloc(4096, 1) }]));
		await assert.rejects(extract(archive, { budget: 1000 }), (error) => error.statusCode === 507);
	});

	describe('contains a stream failure to the extraction', function () {
		it('when the upload aborts mid-entry', async function () {
			const archive = gzipSync(await archiveOf([{ name: 'CURRENT', body: Buffer.alloc(512 * 1024, 3) }]));
			const input = new PassThrough();
			const extraction = extract(input);
			input.write(archive.subarray(0, Math.floor(archive.length / 2)));
			setImmediate(() => input.destroy(Object.assign(new Error('client went away'), { code: 'ECONNRESET' })));
			await assert.rejects(extraction, /client went away/);
			assert.strictEqual(input.destroyed, true);
		});

		it('when the first entry is refused', async function () {
			const archive = gzipSync(await tarOf([{ name: 'link', type: 'symlink', linkname: '/' }]));
			const input = Readable.from([archive]);
			await assert.rejects(extract(input), /symlink entry/);
			assert.strictEqual(input.destroyed, true);
		});

		it('when the bytes are not an archive at all', async function () {
			const input = Readable.from([Buffer.from('this is not a tar file, and it is not gzip either'.repeat(40))]);
			await assert.rejects(extract(input), (error) => error.statusCode === 400);
			assert.strictEqual(input.destroyed, true);
		});

		it('when the writer fails', async function () {
			const archive = gzipSync(await archiveOf([{ name: 'CURRENT', body: Buffer.alloc(256 * 1024, 5) }]));
			const input = Readable.from([archive]);
			await assert.rejects(
				extract(input, {
					createWriteStream: () =>
						new Writable({
							write(_chunk, _encoding, callback) {
								callback(Object.assign(new Error('device went away'), { code: 'EIO' }));
							},
						}),
				}),
				/device went away/
			);
			assert.strictEqual(input.destroyed, true);
		});

		it('when the device fills up, as a 507', async function () {
			const archive = gzipSync(await archiveOf([{ name: 'CURRENT', body: Buffer.alloc(1024, 5) }]));
			await assert.rejects(
				extract(Readable.from([archive]), {
					createWriteStream: () =>
						new Writable({
							write(_chunk, _encoding, callback) {
								callback(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
							},
						}),
				}),
				(error) => error.statusCode === 507 && /ENOSPC/.test(error.message)
			);
		});
	});

	it('leaves nothing behind outside the parts it was given', async function () {
		mkdirSync(join(root, 'unrelated'));
		await extract(gzipSync(await archiveOf([{ name: 'CURRENT', body: 'x' }])));
		assert.ok(existsSync(join(root, 'unrelated')));
		assert.deepStrictEqual(
			listTree(root).filter((path) => !path.startsWith('database/') && !path.startsWith('blobs/')),
			['unrelated/']
		);
	});
});
