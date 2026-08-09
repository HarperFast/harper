/**
 * `copy-db` and the blob store — harper#2048 channel 3.
 *
 * `copyDb()` (bin/copyDb.ts:158, behind the documented `copy-db <source> <target>` CLI verb at
 * bin/harper.ts:153) walks the source environment's dbis and byte-copies each one, deliberately
 * bypassing encode/decode. That faithfully copies every record's blob `fileId` reference, but the
 * blob BYTES live outside LMDB at `{rootPath}/blobs/{db}/`, and nothing in the function visits
 * that path — so the copy contains records referencing files that exist nowhere near it.
 *
 * WHY THE CONTRACT TESTS ARE `todo` RATHER THAN ASSERTIONS OF CURRENT BEHAVIOUR.
 * The tempting version of this test asserts what happens today — "the copy contains zero blob
 * files" — which passes now and goes RED the moment #2048 is fixed, reading as a regression when
 * it is the opposite. That failure mode is not hypothetical: it is exactly why
 * txnlog-purge-stale-read-blast arm 5 sat red on main for a day (159b4bbd9). So the contract
 * tests below assert what SHOULD be true and carry `todo`, which runs them, keeps their failure
 * off the CI result, and surfaces the moment they start passing — at which point the marker comes
 * off and this becomes an ordinary regression anchor for the fix.
 *
 * Scope note: #2048 also reaches `storage.compactOnStart`, but not with this consequence.
 * compactOnStart (bin/copyDb.ts:38) swaps the copy into the SAME rootPath and moves only
 * `database/{db}.mdb`, leaving `blobs/{db}/` adjacent and resolvable. Only an external target
 * loses the blobs. Asserted below so nobody "fixes" compactOnStart chasing this.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdirSync, statSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
	setupHarperWithFixture,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const run = promisify(execFile);
const FIXTURE_PATH = resolve(import.meta.dirname, 'copy-db-blob-store');
const BLOB_SIZE = 256 * 1024; // comfortably above the inline threshold, so these are real files
const BLOB_DOCS = 6;
const INLINE_DOCS = 4; // controls: small enough to live inside the record, must survive the copy

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

suite(
	'copy-db and the blob store (harper#2048 ch.3)',
	{ skip: process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;
		const blobRoot = () => join(ctx.harper.dataRootDir, 'blobs', 'data');

		// Populated by the copy step so the contract tests can assert against one real invocation
		// rather than each shelling the CLI again.
		let copyRoot = '';
		let copyExit: number | null = null;
		let copyOut = '';
		let sourceBlobCount = 0;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { logging: { console: true, level: 'error' } },
				env: { HARPER_STORAGE_ENGINE: 'lmdb' }, // copy-db is the LMDB path
			});
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;

			// Poll the fixture route directly until it answers; never restartHttpWorkers() against a
			// pre-installed fixture (fire-and-forget, races the worker respawn).
			const deadline = Date.now() + 60_000;
			let ready = false;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/Verify/?key=none').timeout(2000);
					if (probe.status === 200) {
						ready = true;
						break;
					}
				} catch {
					/* not up yet */
				}
				await new Promise((r) => setTimeout(r, 250));
			}
			ok(ready, 'harper did not serve /Verify/ with 200 within 60s — boot failed');

			const seed = async (payload: Record<string, unknown>) => {
				const r = await fetch(`${httpURL}/Seed/`, {
					method: 'POST',
					headers: { 'Authorization': client.headers.Authorization, 'content-type': 'application/json' },
					body: JSON.stringify(payload),
				});
				const text = await r.text();
				ok(r.status < 300, `seed ${JSON.stringify(payload)} expected 2xx, got ${r.status}: ${text.slice(0, 300)}`);
			};
			for (let i = 0; i < BLOB_DOCS; i++) await seed({ kind: 'blob', key: `blob-${i}`, size: BLOB_SIZE });
			for (let i = 0; i < INLINE_DOCS; i++) await seed({ kind: 'inline', key: `inline-${i}` });
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('PRECONDITION: the seeded blobs are file-backed on disk', () => {
			sourceBlobCount = filesUnder(blobRoot()).length;
			ok(
				sourceBlobCount >= BLOB_DOCS,
				`NON-VACUOUS PRECONDITION: expected >= ${BLOB_DOCS} blob files under ${blobRoot()}, found ${sourceBlobCount}. ` +
					`Without file-backed blobs every assertion below is vacuous.`
			);
		});

		test('copy-db runs against the instance and produces a target', async () => {
			const target = join(mkdtempSync(join(tmpdir(), 'copydb-')), 'data-copy.mdb');
			copyRoot = resolve(target, '..');

			await killHarper(ctx); // the CLI opens the environment itself
			const cli = resolve(import.meta.dirname, '../../dist/bin/harper.js');
			ok(existsSync(cli), `expected a built CLI at ${cli} — run npm run build first`);

			try {
				const r = await run(process.execPath, [cli, 'copy-db', 'data', target], {
					env: { ...process.env, ROOTPATH: ctx.harper.dataRootDir },
					maxBuffer: 32 * 1024 * 1024,
				});
				copyExit = 0;
				copyOut = `${r.stdout}\n${r.stderr}`;
			} catch (e: any) {
				copyExit = e.code ?? 1;
				copyOut = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
			}

			// Distinguish "the CLI ran and did something" from "the CLI never found the database".
			// The latter is a harness problem and must not be reported as a finding about copy-db.
			ok(
				copyOut.trim().length > 0,
				`copy-db produced no output at all — it almost certainly never located the database (harness problem, not a defect). exit=${copyExit}`
			);
			ok(existsSync(target), `copy-db should have produced ${target}. Output:\n${copyOut.slice(-1500)}`);
		});

		test(
			'the copy contains the blob store',
			{ todo: 'fails until harper#2048 channel 3 is fixed; remove this marker when it starts passing' },
			() => {
				const inCopy = filesUnder(copyRoot);
				const blobFiles = inCopy.filter((f) => /blobs?\//i.test(f));
				ok(inCopy.length > 0, 'the copy should contain the database files');
				ok(
					blobFiles.length >= BLOB_DOCS,
					`copy-db produced a non-restorable copy: ${sourceBlobCount} blob file(s) in the source, ` +
						`${blobFiles.length} in the copy. Records in the copy carry fileId references that resolve ` +
						`to nothing, while inline attributes survive byte-exact — so the loss is partial and silent. ` +
						`Copy tree: ${JSON.stringify(inCopy.slice(0, 20))}`
				);
			}
		);

		test(
			'copy-db does not report success when records fail to copy',
			{ todo: 'fails until harper#2048 channel 4 is fixed; remove this marker when it starts passing' },
			() => {
				// The audit-store copy opens its target on the SOURCE rootStore (bin/copyDb.ts:223,
				// where every other dbi uses targetEnv at :217) and is not awaited (:225 vs :220), so
				// per-record failures are logged and the exit code stays 0.
				const failures = (copyOut.match(/Error copying record/g) ?? []).length;
				strictEqual(
					failures > 0 && copyExit === 0,
					false,
					`copy-db logged ${failures} per-record copy failure(s) and still exited ${copyExit}. ` +
						`A backup verb that reports success while dropping records is what turns this into data loss.`
				);
			}
		);

		test('SCOPE: compactOnStart is unaffected — it leaves blobs/ adjacent in the same rootPath', () => {
			// Recorded as an assertion rather than a comment so the distinction survives: compactOnStart
			// moves database/{db}.mdb into backup/ and the copy into its place, both inside rootPath.
			const stillThere = filesUnder(blobRoot()).length;
			ok(
				stillThere >= BLOB_DOCS,
				`blobs/ must remain in the source rootPath — that is why the compactOnStart channel survives — found ${stillThere}`
			);
		});
	}
);
