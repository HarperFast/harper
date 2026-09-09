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
// Matches the fixture's LINES_PER_REQUEST.
const LINES_PER_REQUEST = 20;
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

	function archiveNames(): string[] {
		try {
			return readdirSync(rotatedDir)
				.map((name) => (name.endsWith('.gz') ? name.slice(0, -3) : name))
				.filter((name) => name.endsWith('.log') && name !== 'hdb.log')
				.sort();
		} catch {
			return [];
		}
	}

	/**
	 * Read one generation by its archive name. Publishing renames the `.gz` into place and only then
	 * unlinks the plain archive, so trying the compressed copy first and the plain one second always
	 * finds exactly one representation of it — reading a listing entry by entry does not, because a
	 * generation compressed between the listing and the read leaves a plain path that no longer
	 * exists and a `.gz` the listing never saw.
	 */
	function readGeneration(name: string): string {
		try {
			return gunzipSync(readFileSync(join(rotatedDir, `${name}.gz`))).toString('utf8');
		} catch {
			return readFileSync(join(rotatedDir, name), 'utf8');
		}
	}

	function signature(): string {
		return `${archiveNames().join('|')}#${statSync(join(logDir, 'hdb.log')).size}`;
	}

	/**
	 * Every generation, read as of one instant. Reading the active log and the archive set at
	 * different instants lets a rotation in between either duplicate a batch or lose one, and no
	 * exactly-once assertion survives that — so the read is bracketed by the same signature, and
	 * retried when a rotation lands inside it.
	 */
	async function settledGenerations(): Promise<Map<string, string>> {
		for (let attempt = 0; attempt < 40; attempt++) {
			try {
				// Inside the try: a rotation can leave the active pathname absent for as long as it takes
				// the sink to reopen it, and this is the read to retry then, not to abort.
				const before = signature();
				const generations = new Map<string, string>();
				for (const name of archiveNames()) generations.set(name, readGeneration(name));
				generations.set('hdb.log', readFileSync(join(logDir, 'hdb.log'), 'utf8'));
				if (signature() === before) return generations;
			} catch {
				// A generation moved under the read; the retry below takes a fresh set.
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error('the log never stopped rotating long enough to read every generation once');
	}

	test('bounds every generation and keeps every request marker exactly once', { timeout: 120_000 }, async () => {
		for (let i = 0; i < REQUEST_COUNT; i++) {
			const response = await fetch(new URL(`/LogBurst/request-${i}`, ctx.harper.httpURL));
			strictEqual(response.status, 200, `request ${i} failed`);
			await response.json();
		}

		ok(archiveNames().length > 0, 'expected the write path to rotate the log inside one audit interval');

		// Compression only happens after every writing thread has answered that it released the
		// archived inode, so a published .gz is the coordinator working through the real thread mesh.
		const deadline = Date.now() + 30_000;
		while (compressedArchivePaths().length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		ok(compressedArchivePaths().length > 0, 'expected at least one archive to be compressed and published');

		const generations = await settledGenerations();

		// Every generation is bounded by the cap plus one check quantum and one in-flight payload per
		// writing thread — a function of maxSize and thread count, never of how fast the log is
		// written. Measured on the records, not on the file, so a compressed generation is held to the
		// same bound as a plain one.
		const bound = MAX_SIZE_BYTES * 4;
		for (const [name, content] of generations) {
			const size = Buffer.byteLength(content);
			ok(size < bound, `${name} reached ${size} bytes against a ${MAX_SIZE_BYTES}-byte cap`);
		}

		// Every line, not just the first of each request: a batch torn at a rotation boundary loses its
		// tail, which a marker taken from the head of the batch cannot see.
		const contents = [...generations.values()].join('');
		for (let i = 0; i < REQUEST_COUNT; i++) {
			for (let line = 0; line < LINES_PER_REQUEST; line++) {
				const occurrences = contents.split(`rotation-marker request-${i}:${line} `).length - 1;
				strictEqual(
					occurrences,
					1,
					`request-${i}:${line} appeared ${occurrences} times across ${generations.size} generations: ${[...generations]
						.map(([name, content]) => `${name}=${content.length}b`)
						.join(', ')}`
				);
			}
		}
	});
});
