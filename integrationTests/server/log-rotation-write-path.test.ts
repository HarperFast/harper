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
import { readdirSync, readFileSync } from 'node:fs';
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
		// Beside the runner's log directory rather than in os.tmpdir(): the harness points logging.root
		// there, and on Windows those are different volumes, where a rename can never succeed.
		rotatedDir = mkdtempSync(join(process.env.HARPER_INTEGRATION_TEST_LOG_DIR ?? tmpdir(), 'harper-1877-rotated-'));
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

	function compressedArchivePaths(): string[] {
		try {
			return readdirSync(rotatedDir)
				.filter((name) => name.endsWith('.gz'))
				.map((name) => join(rotatedDir, name));
		} catch {
			return [];
		}
	}

	/**
	 * One entry per archived generation, keyed by its archive name and read from the compressed copy
	 * when there is one. Publishing writes the `.gz` and then unlinks the plain archive, so a listing
	 * taken across that window holds both representations of one generation - counting them both
	 * would report every record in it twice.
	 */
	function archivedGenerations(): Map<string, string> {
		const byName = new Map<string, string>();
		let names: string[];
		try {
			names = readdirSync(rotatedDir);
		} catch {
			return byName;
		}
		for (const name of names) {
			const compressed = name.endsWith('.gz');
			const generation = compressed ? name.slice(0, -3) : name;
			if (!generation.endsWith('.log') || generation === 'hdb.log') continue;
			if (!compressed && byName.has(generation)) continue;
			try {
				const raw = readFileSync(join(rotatedDir, name));
				byName.set(generation, compressed ? gunzipSync(raw).toString('utf8') : raw.toString('utf8'));
			} catch {
				// Compressed or reclaimed between the listing and the read; the other representation
				// carries the same records.
			}
		}
		return byName;
	}

	test('bounds every generation and keeps every request marker exactly once', { timeout: 120_000 }, async () => {
		for (let i = 0; i < REQUEST_COUNT; i++) {
			const response = await fetch(new URL(`/LogBurst/request-${i}`, ctx.harper.httpURL));
			strictEqual(response.status, 200, `request ${i} failed`);
			await response.json();
		}

		ok(archivedGenerations().size > 0, 'expected the write path to rotate the log inside one audit interval');

		// Compression only happens after every writing thread has answered that it released the
		// archived inode, so a published .gz is the coordinator working through the real thread mesh.
		const deadline = Date.now() + 30_000;
		while (compressedArchivePaths().length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		ok(compressedArchivePaths().length > 0, 'expected at least one archive to be compressed and published');

		// One listing for both assertions below, so a rotation between them cannot make the size check
		// and the marker count disagree about which generations exist.
		const generations = archivedGenerations();
		generations.set('hdb.log', readFileSync(join(logDir, 'hdb.log'), 'utf8'));

		// Every generation is bounded by the cap plus one check quantum and one in-flight payload per
		// writing thread — a function of maxSize and thread count, never of how fast the log is
		// written. Measured on the records, not on the file, so a compressed generation is held to the
		// same bound as a plain one.
		const bound = MAX_SIZE_BYTES * 4;
		for (const [name, content] of generations) {
			const size = Buffer.byteLength(content);
			ok(size < bound, `${name} reached ${size} bytes against a ${MAX_SIZE_BYTES}-byte cap`);
		}

		const contents = [...generations.values()].join('');
		for (let i = 0; i < REQUEST_COUNT; i++) {
			const occurrences = contents.split(`rotation-marker request-${i}:0 `).length - 1;
			strictEqual(occurrences, 1, `request-${i}'s first marker appeared ${occurrences} times across generations`);
		}
	});
});
