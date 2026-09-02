/**
 * `copy-db` and the blob store — end-to-end regression coverage for harper#2048 (channels 3 and 4),
 * fixed by harper#2098.
 *
 * A record's blob BYTES live outside the LMDB environment, under `{rootPath}/blobs/{db}/`, and are
 * addressed by database NAME rather than by the environment file's path. `copyDb()` (bin/copyDb.ts,
 * behind the documented `copy-db <source> <target>` CLI verb at bin/harper.ts) byte-copies the
 * environment's dbis, so before harper#2098 the copy carried every record's `fileId` reference and
 * none of the files those references resolve to — a partial, silent loss, because inline attributes
 * survived byte-exact. It also kept exit 0 through per-record copy failures.
 *
 * harper#2098's unit coverage (unitTests/bin/copyDbIntegrity.test.js) drives `copyDb()` directly;
 * this suite is the complementary end-to-end proof through the public CLI: it seeds file-backed
 * blobs plus inline controls over HTTP, runs `copy-db` at an external target, then performs the
 * restore the copy's own README documents — the environment file back to `database/{db}.mdb`, each
 * `<rootIndex>/` tree of the `<target>-blobs` companion directory back into the matching blob root —
 * and reads every seeded record back through HTTP.
 *
 * The read-back is the assertion that carries the contract. Counting files under a `blobs`-shaped
 * path only proves that something landed there; it cannot tell a restorable copy from one whose
 * records are undecodable or point at the wrong bytes. So the source environment and blob root are
 * REMOVED before the restore (asserted gone, so the read-back cannot be answered by surviving source
 * files), and every blob is compared against the sha256 its seed call returned.
 *
 * Scope note: harper#2048 also reached `storage.compactOnStart`, but not with this consequence.
 * compactOnStart swaps the copy into the SAME rootPath and moves only `database/{db}.mdb`, leaving
 * `blobs/{db}/` adjacent and resolvable — which is why it copies with `blobs: 'preserve-source-roots'`.
 * Asserted below so nobody "fixes" compactOnStart chasing this.
 *
 * Harness note: the CLI reads `ROOTPATH` (not `HARPER_ROOT_PATH`), and an empty CLI output means it
 * never located the database — a harness problem, asserted separately so it is never scored as a
 * finding about `copy-db`.
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
	env: { HARPER_STORAGE_ENGINE: 'lmdb' }, // copy-db is the LMDB path
};

/** Every non-empty file under a tree, relative to it. Disk truth, not API truth. */
function filesUnder(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string, rel: string) => {
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
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

	// Populated by the copy step so the later tests assert against one real invocation rather
	// than each shelling the CLI again.
	let copyRoot = '';
	let copyTarget = '';
	let copyExit: number | null = null;
	let copyOut = '';
	let sourceBlobCount = 0;
	// sha256 of each seeded blob, as reported by the seeding call — the byte-exact expectation
	// the restored read-back is compared against.
	const seededBlobSha = new Map<string, string>();
	const seededInlineNote = new Map<string, string>();

	// Poll the fixture route directly until it answers; never restartHttpWorkers() against a
	// pre-installed fixture (fire-and-forget, races the worker respawn).
	async function waitForFixtureRoute(label: string) {
		client = createApiClient(ctx.harper);
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Verify/?key=none').timeout(2000);
				if (probe.status === 200) return;
			} catch {
				/* not up yet */
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		ok(false, `harper did not serve /Verify/ with 200 within 60s ${label} — boot failed`);
	}

	async function verify(key: string) {
		const response = await client.reqRest(`/Verify/?key=${key}`).timeout(10_000);
		strictEqual(response.status, 200, `GET /Verify/?key=${key} => ${response.status}: ${response.text?.slice(0, 300)}`);
		return response.body;
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, HARPER_OPTIONS);
		await waitForFixtureRoute('on first boot');

		const seed = async (payload: Record<string, unknown>) => {
			const r = await fetch(`${ctx.harper.httpURL}/Seed/`, {
				method: 'POST',
				headers: { 'Authorization': client.headers.Authorization, 'content-type': 'application/json' },
				body: JSON.stringify(payload),
			});
			const text = await r.text();
			ok(r.status < 300, `seed ${JSON.stringify(payload)} expected 2xx, got ${r.status}: ${text.slice(0, 300)}`);
			return JSON.parse(text);
		};
		for (let i = 0; i < BLOB_DOCS; i++) {
			const key = `blob-${i}`;
			const seeded = await seed({ kind: 'blob', key, size: BLOB_SIZE });
			ok(seeded.sha, `seeding ${key} returned no sha to compare the restored blob against: ${JSON.stringify(seeded)}`);
			strictEqual(seeded.size, BLOB_SIZE, `seeding ${key} stored ${seeded.size} bytes, not the requested ${BLOB_SIZE}`);
			seededBlobSha.set(key, seeded.sha);
		}
		for (let i = 0; i < INLINE_DOCS; i++) {
			const key = `inline-${i}`;
			const note = `inline-control-${i}`;
			await seed({ kind: 'inline', key, note });
			seededInlineNote.set(key, note);
		}
	});

	after(async () => {
		try {
			await teardownHarper(ctx);
		} finally {
			if (copyRoot) await rm(copyRoot, { recursive: true, force: true });
		}
	});

	test('PRECONDITION: the seeded blobs are file-backed on disk and read back from the source', async () => {
		sourceBlobCount = filesUnder(blobRoot()).length;
		ok(
			sourceBlobCount >= BLOB_DOCS,
			`NON-VACUOUS PRECONDITION: expected >= ${BLOB_DOCS} blob files under ${blobRoot()}, found ${sourceBlobCount}. ` +
				`Without file-backed blobs every assertion below is vacuous.`
		);
		// The same read-back the restored copy is held to, run against the source first: a failure
		// here is a seeding/fixture problem, not a copy-db one.
		for (const [key, sha] of seededBlobSha) {
			const record = await verify(key);
			strictEqual(record.sha, sha, `source ${key} does not read back as seeded: ${JSON.stringify(record)}`);
		}
		for (const [key, note] of seededInlineNote) {
			const record = await verify(key);
			strictEqual(record.note, note, `source ${key} does not read back as seeded: ${JSON.stringify(record)}`);
		}
	});

	test('copy-db runs against the instance and reports success without per-record failures', async () => {
		copyTarget = join(mkdtempSync(join(tmpdir(), 'copydb-')), 'data-copy.mdb');
		copyRoot = resolve(copyTarget, '..');

		await killHarper(ctx); // the CLI opens the environment itself
		const cli = resolve(import.meta.dirname, '../../dist/bin/harper.js');
		ok(existsSync(cli), `expected a built CLI at ${cli} — run npm run build first`);

		try {
			const r = await run(process.execPath, [cli, 'copy-db', DATABASE, copyTarget], {
				env: { ...process.env, ROOTPATH: ctx.harper.dataRootDir },
				maxBuffer: 32 * 1024 * 1024,
			});
			copyExit = 0;
			copyOut = `${r.stdout}\n${r.stderr}`;
		} catch (e: any) {
			// e.code is a signal name (string) when the child was killed (e.g. maxBuffer overrun) —
			// normalize so downstream `copyExit === 0` comparisons don't silently pass a string.
			copyExit = typeof e.code === 'number' ? e.code : 1;
			copyOut = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
		}

		// Distinguish "the CLI ran and did something" from "the CLI never found the database".
		// The latter is a harness problem and must not be reported as a finding about copy-db.
		ok(
			copyOut.trim().length > 0,
			`copy-db produced no output at all — it almost certainly never located the database (harness problem, not a defect). exit=${copyExit}`
		);
		ok(existsSync(copyTarget), `copy-db should have produced ${copyTarget}. Output:\n${copyOut.slice(-1500)}`);

		// harper#2048 ch.4: per-record failures were logged while the exit code stayed 0, which is
		// what turned a degraded copy into silent data loss.
		const recordFailures = (copyOut.match(/Error copying record/g) ?? []).length;
		strictEqual(
			recordFailures,
			0,
			`copy-db logged ${recordFailures} per-record copy failure(s). Output:\n${copyOut.slice(-1500)}`
		);
		strictEqual(copyExit, 0, `copy-db exited ${copyExit}. Output:\n${copyOut.slice(-1500)}`);
	});

	test('the copy carries the blob store in its companion directory', () => {
		const blobCompanion = `${copyTarget}-blobs`;
		ok(
			existsSync(blobCompanion),
			`copy-db must write the source's blob roots to ${blobCompanion}; copy tree: ${JSON.stringify(filesUnder(copyRoot).slice(0, 20))}`
		);
		// `<rootIndex>/<shard1>/<shard2>/<fileId>`, plus the README documenting that layout.
		const copiedBlobs = filesUnder(blobCompanion).filter((f) => f !== 'README.md');
		ok(
			copiedBlobs.length >= BLOB_DOCS,
			`copy-db produced a non-restorable copy: ${sourceBlobCount} blob file(s) in the source, ` +
				`${copiedBlobs.length} beside the copy. Companion tree: ${JSON.stringify(copiedBlobs.slice(0, 20))}`
		);
	});

	test('SCOPE: compactOnStart is unaffected — copy-db leaves blobs/ in the source rootPath', () => {
		// Recorded as an assertion rather than a comment so the distinction survives: compactOnStart
		// moves database/{db}.mdb into backup/ and the copy into its place, both inside rootPath, so
		// the source blob roots it copies with `preserve-source-roots` have to still be there.
		const stillThere = filesUnder(blobRoot()).length;
		ok(
			stillThere >= BLOB_DOCS,
			`blobs/ must remain in the source rootPath — that is why the compactOnStart channel survives — found ${stillThere}`
		);
	});

	test('the copy restores byte-exact: blob payloads and inline attributes read back', async () => {
		// Checked before anything is removed: without both halves of the copy this test would tear
		// down the source and then fail on a missing file, which reads as a restore defect.
		ok(
			existsSync(copyTarget) && existsSync(`${copyTarget}-blobs`),
			`the copy step must have produced both ${copyTarget} and its -blobs companion before the restore`
		);

		// The documented restore (see the companion directory's README.md): the environment file
		// goes back to database/{db}.mdb, and each `<rootIndex>/` tree goes back into the matching
		// blob root of the database name the copy is restored as. Index 0 is the single default
		// root, `<rootPath>/blobs/<db>`.
		await rm(dbPath(), { force: true });
		await rm(`${dbPath()}-lock`, { force: true });
		await rm(blobRoot(), { recursive: true, force: true });
		ok(
			!existsSync(dbPath()) && !existsSync(blobRoot()),
			`NON-VACUOUS PRECONDITION: the source environment and blob root must be gone before the restore, ` +
				`or the read-back below could be answered by surviving source files rather than by the copy`
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
				`inline control ${key} is not inline — it has a blob attribute, so it no longer controls for the ` +
					`"inline attributes survive while blob bytes do not" half of harper#2048: ${JSON.stringify(record)}`
			);
			strictEqual(record.note, note, `inline control ${key} did not survive byte-exact: ${JSON.stringify(record)}`);
		}
	});
});
