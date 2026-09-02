/**
 * harper#1877: `logging.rotation.maxSize` was only ever checked by the 60-second audit tick, so the
 * real ceiling on the active log was `write-rate x 60s` — QA measured 1.36 GB against a 64K cap.
 *
 * This drives request-shaped log volume through real HTTP workers, which is where that volume comes
 * from in production and where the old code had no rotator at all, and finishes well inside one
 * audit interval so nothing but the write path can be doing the rotating.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/log-rotation-write-path');
const MAX_SIZE_BYTES = 64000;
const REQUEST_COUNT = 120;
const WORKERS = 2;

suite('Log rotation is enforced on the write path (#1877)', (ctx: ContextWithHarper) => {
	let logDir: string;
	let rotatedDir: string;

	before(async () => {
		// Pinned rather than discovered: the archive directory defaults relative to the config's
		// rootPath, which the harness relocates, and this test needs to read the generations back.
		rotatedDir = mkdtempSync(join(tmpdir(), 'harper-1877-rotated-'));
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: WORKERS },
				logging: {
					level: 'notify',
					file: true,
					// compress on: the only configuration in which an archive is destroyed, and therefore
					// the only one that exercises the generation coordinator's release-then-unlink path
					// through the real thread mesh rather than a fake transport.
					rotation: { enabled: true, maxSize: '64K', compress: true, path: rotatedDir },
				},
			},
		});
		// The runner points logging.root at a per-suite directory when it is collecting logs; without
		// it Harper's default (<rootPath>/log) applies.
		logDir = ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log');
	});

	after(async () => {
		await teardownHarper(ctx);
		rmSync(rotatedDir, { recursive: true, force: true });
	});

	function archivePaths(): string[] {
		try {
			return readdirSync(rotatedDir)
				.filter((name) => name.endsWith('.log') && name !== 'hdb.log')
				.map((name) => join(rotatedDir, name));
		} catch {
			return [];
		}
	}

	function compressedArchivePaths(): string[] {
		try {
			return readdirSync(rotatedDir)
				.filter((name) => name.endsWith('.gz'))
				.map((name) => join(rotatedDir, name));
		} catch {
			return [];
		}
	}

	test('bounds every generation and keeps every request marker exactly once', { timeout: 120_000 }, async () => {
		for (let i = 0; i < REQUEST_COUNT; i++) {
			const response = await fetch(new URL(`/LogBurst/request-${i}`, ctx.harper.httpURL));
			strictEqual(response.status, 200, `request ${i} failed`);
			await response.json();
		}

		const archives = archivePaths();
		ok(archives.length > 0, 'expected the write path to rotate the log inside one audit interval');

		// Compression only happens after every writing thread has answered that it released the
		// archived inode, so a published .gz is the coordinator working through the real thread mesh.
		const deadline = Date.now() + 30_000;
		while (compressedArchivePaths().length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		ok(compressedArchivePaths().length > 0, 'expected at least one archive to be compressed and published');

		// Every generation is bounded by the cap plus one check quantum and one in-flight payload per
		// writing thread — a function of maxSize and thread count, never of how fast the log is written.
		const bound = MAX_SIZE_BYTES * 4;
		for (const archive of [...archives, join(logDir, 'hdb.log')]) {
			let size: number;
			try {
				size = statSync(archive).size;
			} catch {
				continue;
			}
			ok(size < bound, `${archive} reached ${size} bytes against a ${MAX_SIZE_BYTES}-byte cap`);
		}

		const contents = [join(logDir, 'hdb.log'), ...archives, ...compressedArchivePaths()]
			.map((file) => {
				try {
					return file.endsWith('.gz') ? gunzipSync(readFileSync(file)).toString('utf8') : readFileSync(file, 'utf8');
				} catch {
					return '';
				}
			})
			.join('');
		for (let i = 0; i < REQUEST_COUNT; i++) {
			const occurrences = contents.split(`rotation-marker request-${i}:0 `).length - 1;
			strictEqual(occurrences, 1, `request-${i}'s first marker appeared ${occurrences} times across generations`);
		}
	});
});
