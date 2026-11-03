/**
 * End-to-end regression coverage for harper#2048 channel 3 (`copy-db` never copied the blob store),
 * fixed by harper#2098.
 *
 * A record's blob bytes live outside the LMDB environment, under `{rootPath}/blobs/{db}/`, and are
 * addressed by database NAME rather than by the environment file's path, so an environment copy on
 * its own carries every `fileId` reference and none of the files they resolve to. `copyDb()` now
 * writes the source's blob roots to `<target>-blobs/<rootIndex>/` beside the copy.
 *
 * harper#2098's unit coverage (`unitTests/bin/copyDbIntegrity.test.js`) drives `copyDb()` directly.
 * This suite is the public-CLI counterpart: it seeds over HTTP, runs `copy-db <source> <target>`,
 * performs the restore the companion directory's README documents, restarts Harper onto it, and
 * reads every seeded record back. The source environment and blob root are removed — and asserted
 * gone — first, so the read-back cannot be answered by surviving source files, and each blob is
 * compared against the sha256 its seed call returned.
 *
 * What it does not cover: restoring under a different database name (that is
 * `unitTests/bin/copyDbIntegrity.test.js:250`), restoring a database with more than one blob root
 * (`unitTests/dataLayer/blobBackup.test.js:232` copies a second root, but nothing restores one), and
 * channel 4's failure path, since no per-record copy failure is induced here — only the healthy
 * exit-0 shape is asserted.
 *
 * `copy-db` is LMDB-only (`copyDb` rejects a RocksDB database outright), hence the engine pin.
 * The CLI reads `ROOTPATH`, not `HARPER_ROOT_PATH`.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdirSync, statSync, existsSync, mkdtempSync } from 'node:fs';
import { rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
	type StartHarperOptions,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const run = promisify(execFile);
const FIXTURE_PATH = resolve(import.meta.dirname, 'copy-db-blob-store');
const BLOB_SIZE = 256 * 1024; // comfortably above the inline threshold, so these are real files
const BLOB_DOCS = 6;
const INLINE_DOCS = 4; // controls: no blob attribute at all, so they survive on the environment copy alone
const DATABASE = 'data';
const HARPER_OPTIONS: StartHarperOptions = {
	config: { logging: { console: true, level: 'error' } },
	env: { HARPER_STORAGE_ENGINE: 'lmdb' },
};
const SEED_TIMEOUT_MS = 60_000;
const COPY_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 60_000;
// The framework's own CI startup ceiling; the budgets below add to it so a slow boot fails with
// startHarper's diagnosis rather than with a bare test timeout.
const BOOT_TIMEOUT_MS = 300_000;

/** Every non-empty file under a tree, relative to it. Disk truth, not API truth. */
function filesUnder(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string, rel: string) => {
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch (error: any) {
			// An absent directory is an answer; anything else would report as an empty tree and be
			// misread as data loss.
			if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
			throw error;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(p, r);
			else if (statSync(p).size > 0) out.push(r);
		}
	};
	walk(dir, '');
	return out.sort();
}

suite('copy-db and the blob store (harper#2048)', { skip: process.platform === 'win32' }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	const dbPath = () => join(ctx.harper.dataRootDir, 'database', `${DATABASE}.mdb`);
	const blobRoot = () => join(ctx.harper.dataRootDir, 'blobs', DATABASE);

	let copyRoot = '';
	let copyTarget = '';
	let copyExit: number | null = null;
	let copyOut = '';
	let sourceBlobCount = 0;
	// sha256 of each seeded blob, as reported by the seeding call — the byte-exact expectation the
	// restored read-back is compared against.
	const seededBlobSha = new Map<string, string>();
	const seededInlineNote = new Map<string, string>();

	// Never restartHttpWorkers() against a pre-installed fixture: it is fire-and-forget and races
	// the worker respawn.
	async function waitForFixtureRoute(label: string) {
		client = createApiClient(ctx.harper);
		const deadline = Date.now() + READY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Verify/?key=none').timeout(2000);
				if (probe.status === 200) return;
			} catch {
				/* not up yet */
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		ok(false, `harper did not serve /Verify/ with 200 within ${READY_TIMEOUT_MS}ms ${label} — boot failed`);
	}

	async function verify(key: string) {
		const response = await client.reqRest(`/Verify/?key=${key}`).timeout(10_000);
		strictEqual(response.status, 200, `GET /Verify/?key=${key} => ${response.status}: ${response.text?.slice(0, 300)}`);
		return response.body;
	}

	before(
		async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, HARPER_OPTIONS);
			await waitForFixtureRoute('on first boot');

			const seed = async (payload: Record<string, unknown>) => {
				const r = await fetch(`${ctx.harper.httpURL}/Seed/`, {
					method: 'POST',
					headers: { 'Authorization': client.headers.Authorization, 'content-type': 'application/json' },
					body: JSON.stringify(payload),
					signal: AbortSignal.timeout(SEED_TIMEOUT_MS),
				});
				const text = await r.text();
				ok(r.status < 300, `seed ${JSON.stringify(payload)} expected 2xx, got ${r.status}: ${text.slice(0, 300)}`);
				return JSON.parse(text);
			};
			for (let i = 0; i < BLOB_DOCS; i++) {
				const key = `blob-${i}`;
				const seeded = await seed({ kind: 'blob', key, size: BLOB_SIZE });
				ok(
					seeded.sha,
					`seeding ${key} returned no sha to compare the restored blob against: ${JSON.stringify(seeded)}`
				);
				strictEqual(
					seeded.size,
					BLOB_SIZE,
					`seeding ${key} stored ${seeded.size} bytes, not the requested ${BLOB_SIZE}`
				);
				seededBlobSha.set(key, seeded.sha);
			}
			for (let i = 0; i < INLINE_DOCS; i++) {
				const key = `inline-${i}`;
				const note = `inline-control-${i}`;
				await seed({ kind: 'inline', key, note });
				seededInlineNote.set(key, note);
			}
		},
		{ timeout: BOOT_TIMEOUT_MS + READY_TIMEOUT_MS + SEED_TIMEOUT_MS }
	);

	after(async () => {
		try {
			await teardownHarper(ctx);
		} finally {
			if (copyRoot) await rm(copyRoot, { recursive: true, force: true });
		}
	});

	test('the seeded blobs are file-backed on disk and read back from the source', async () => {
		sourceBlobCount = filesUnder(blobRoot()).length;
		ok(
			sourceBlobCount >= BLOB_DOCS,
			`expected >= ${BLOB_DOCS} blob files under ${blobRoot()}, found ${sourceBlobCount}. Without ` +
				`file-backed blobs every assertion below is vacuous.`
		);
		// The same read-back the restored copy is held to: a failure here is a seeding problem.
		for (const [key, sha] of seededBlobSha) {
			const record = await verify(key);
			strictEqual(record.sha, sha, `source ${key} does not read back as seeded: ${JSON.stringify(record)}`);
		}
		for (const [key, note] of seededInlineNote) {
			const record = await verify(key);
			strictEqual(record.note, note, `source ${key} does not read back as seeded: ${JSON.stringify(record)}`);
		}
	});

	test(
		'copy-db copies the database to an external target, exits 0, and logs no per-record failure',
		{ timeout: COPY_TIMEOUT_MS + READY_TIMEOUT_MS },
		async () => {
			copyRoot = mkdtempSync(join(tmpdir(), 'copydb-'));
			copyTarget = join(copyRoot, 'data-copy.mdb');

			await killHarper(ctx); // the CLI opens the environment itself
			const cli = resolve(import.meta.dirname, '../../dist/bin/harper.js');
			ok(existsSync(cli), `expected a built CLI at ${cli} — run npm run build first`);

			try {
				const r = await run(process.execPath, [cli, 'copy-db', DATABASE, copyTarget], {
					env: { ...process.env, ...HARPER_OPTIONS.env, ROOTPATH: ctx.harper.dataRootDir },
					maxBuffer: 32 * 1024 * 1024,
					timeout: COPY_TIMEOUT_MS,
				});
				copyExit = 0;
				copyOut = `${r.stdout}\n${r.stderr}`;
			} catch (e: any) {
				// e.code is a signal name (string) when the child was killed (timeout, maxBuffer overrun)
				// — normalize so downstream `copyExit === 0` comparisons don't silently pass a string.
				copyExit = typeof e.code === 'number' ? e.code : 1;
				copyOut = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
				if (e.killed) copyOut += `\ncopy-db was killed after ${COPY_TIMEOUT_MS}ms (${e.signal}) without completing`;
			}

			// A successful run always logs its progress, so empty output means the CLI never located
			// the database — a setup failure rather than a copy-db defect.
			ok(
				copyOut.trim().length > 0,
				`copy-db produced no output at all — it almost certainly never located the database. exit=${copyExit}`
			);
			ok(existsSync(copyTarget), `copy-db should have produced ${copyTarget}. Output:\n${copyOut.slice(-1500)}`);

			const recordFailures = (copyOut.match(/Error copying record/g) ?? []).length;
			strictEqual(
				recordFailures,
				0,
				`copy-db logged ${recordFailures} per-record copy failure(s). Output:\n${copyOut.slice(-1500)}`
			);
			strictEqual(copyExit, 0, `copy-db exited ${copyExit}. Output:\n${copyOut.slice(-1500)}`);
		}
	);

	test('the copy carries the blob store, and the README its restore is defined by', () => {
		const blobCompanion = `${copyTarget}-blobs`;
		ok(
			existsSync(blobCompanion),
			`copy-db must write the source's blob roots to ${blobCompanion}; copy tree: ${JSON.stringify(filesUnder(copyRoot).slice(0, 20))}`
		);
		// The only instruction an operator gets for the restore this suite performs below.
		ok(existsSync(join(blobCompanion, 'README.md')), `${blobCompanion} must document its layout in README.md`);
		const copiedBlobs = filesUnder(blobCompanion).filter((f) => f !== 'README.md');
		ok(
			copiedBlobs.length >= BLOB_DOCS,
			`copy-db produced a non-restorable copy: ${sourceBlobCount} blob file(s) in the source, ` +
				`${copiedBlobs.length} beside the copy. Companion tree: ${JSON.stringify(copiedBlobs.slice(0, 20))}`
		);
	});

	test('copy-db leaves the source blob roots in place', () => {
		// The precondition `compactOnStart` relies on: it copies with `blobs: 'preserve-source-roots'`
		// because it swaps the copy back into the same rootPath under the same database name, so the
		// existing roots have to still resolve.
		const stillThere = filesUnder(blobRoot()).length;
		ok(stillThere >= BLOB_DOCS, `copy-db must not disturb the source blob root — found ${stillThere} file(s)`);
	});

	test(
		'the copy restores byte-exact: blob payloads and inline attributes read back',
		{ timeout: BOOT_TIMEOUT_MS + READY_TIMEOUT_MS },
		async () => {
			// Checked before anything is removed: without both halves of the copy this test would tear
			// down the source and then fail on a missing file, which reads as a restore defect.
			ok(
				existsSync(copyTarget) && existsSync(`${copyTarget}-blobs`),
				`the copy step must have produced both ${copyTarget} and its -blobs companion before the restore`
			);

			// The restore the companion README documents: the environment file goes back to
			// database/{db}.mdb, and each `<rootIndex>/` tree goes back into the matching blob root of
			// the database name the copy is restored as. Index 0 is the single default root,
			// `<rootPath>/blobs/<db>`.
			await rm(dbPath(), { force: true });
			await rm(`${dbPath()}-lock`, { force: true });
			await rm(blobRoot(), { recursive: true, force: true });
			ok(
				!existsSync(dbPath()) && !existsSync(blobRoot()),
				`the source environment and blob root must be gone before the restore, or the read-back below ` +
					`could be answered by surviving source files rather than by the copy`
			);

			await cp(copyTarget, dbPath());
			await cp(join(`${copyTarget}-blobs`, '0'), blobRoot(), { recursive: true });

			await startHarper(ctx, HARPER_OPTIONS);
			await waitForFixtureRoute('after restoring the copy');

			for (const [key, sha] of seededBlobSha) {
				const record = await verify(key);
				ok(record.present, `${key} is missing from the restored copy: ${JSON.stringify(record)}`);
				ok(record.hasPayload, `${key} restored without its blob attribute: ${JSON.stringify(record)}`);
				strictEqual(record.size, BLOB_SIZE, `${key} restored with ${record.size} bytes: ${JSON.stringify(record)}`);
				strictEqual(
					record.sha,
					sha,
					`${key}'s blob bytes did not survive the copy: seeded sha256 ${sha}, restored ${record.sha}. ` +
						`A copy whose fileId references resolve to the wrong bytes fails here and nowhere else.`
				);
			}
			for (const [key, note] of seededInlineNote) {
				const record = await verify(key);
				ok(record.present, `inline control ${key} is missing from the restored copy: ${JSON.stringify(record)}`);
				strictEqual(
					record.hasPayload,
					false,
					`inline control ${key} has a blob attribute, so it no longer controls for the "inline data ` +
						`survives while blob bytes do not" half of harper#2048: ${JSON.stringify(record)}`
				);
				strictEqual(record.note, note, `inline control ${key} did not survive byte-exact: ${JSON.stringify(record)}`);
			}
		}
	);
});
