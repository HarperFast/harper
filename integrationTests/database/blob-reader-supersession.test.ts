/**
 * Regression anchor for harper commit 85f1c4b72 ("fix(blob): retain superseded blob files while
 * readers can still see them", 2026-08-11; the reader half of #2134).
 *
 * Before the fix, `RecordEncoder` unlinked a superseded row's blob file via a bare
 * `setTimeout(unlink, 500)` with no accounting for outstanding readers: a reader that had
 * resolved the record but opened the file more than ~500ms after a concurrent overwrite/delete
 * got ENOENT (or a truncated body once the response headers were out). The fix adds an explicit
 * hold on the file for the lifetime of a `Blob.stream()`, defers reclamation while an open read
 * snapshot can still see the superseded version, and replaces the fixed 500ms with a
 * configurable retention window (`storage.blobRetention`, default 2000ms).
 *
 * This suite is an empirical check of that contract, not a re-derivation of it: does a slow,
 * deliberately-paused reader get the ORIGINAL bytes back, byte-exact, when the record is
 * concurrently overwritten or deleted?
 *
 * Design choice: the whole suite runs with `storage.blobRetention: 0`. That removes the
 * fixed-delay cushion entirely, so a pass depends ONLY on the explicit hold/snapshot mechanism,
 * not on out-running a timer -- the strictest test of the invariant. (A build without the fix
 * ignores the unknown key and keeps its 500ms timer, which is why Arm 6 below exists.)
 *
 * Arms:
 *   1. PUT a new value to the same key mid-stream (~40% through a slow chunked GET).
 *   2. DELETE the record mid-stream.
 *   3. Same as 1, but the reader goes idle (no reads in flight) for 800ms right after the write
 *      lands, before resuming -- the "slow client" window #2134 names.
 *   4. Control: read to completion with no concurrent writer. Must be byte-exact.
 *   5. Hammer: back-to-back store+supersede+GET with no pauses, many times; every completed read
 *      is EITHER fully-old or fully-new bytes, never truncated/mixed, every live record still
 *      resolves its current blob, and disk stays leak-free after settling.
 *   6. Late open: the reader resolves the record FIRST, the overwrite lands, and only then does
 *      the reader open the file (1500ms later, past the old 500ms timer). This is the arm that
 *      discriminates the fix from its absence: arms 1-3 hold an already-open descriptor, which
 *      POSIX keeps readable through an unlink, so they pass on either build.
 *
 * Oracle per read: sha256 of received bytes vs sha256 of what was written; bytes received vs
 * `Content-Length`; and a disk check under `{dataRootDir}/blobs/<db>/` confirming the superseded
 * file is reclaimed once released (no leak) and the live one is never taken.
 *
 * Fails-on-base: at 871fad0fa (the fix's parent) Arm 6 goes red -- the late open finds the file
 * already unlinked -- while Arms 1-5 stay green.
 *
 * Originating QA scenario: QA-902 (promote candidate P-639).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, notStrictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'blob-reader-supersession');
const BLOB_SIZE = 6 * 1024 * 1024; // 6MB — many 256KB-ish server-side readMore chunks, plenty of race surface
const skipSuite = process.platform === 'win32';

interface ReadResult {
	status: number;
	contentLengthHeader: number | null;
	bytesReceived: number;
	sha256: string;
	error?: string;
}

/** Recursively count files + bytes under the qa902 blob storage tree. */
async function diskUsage(dir: string): Promise<{ files: number; bytes: number }> {
	let files = 0;
	let bytes = 0;
	async function walk(d: string) {
		let entries;
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else {
				try {
					bytes += (await stat(p)).size;
					files++;
				} catch {
					/* raced with unlink */
				}
			}
		}
	}
	await walk(dir);
	return { files, bytes };
}

function fmt(u: { files: number; bytes: number }) {
	return `${u.files}f/${u.bytes}B`;
}

/**
 * Wait for a blob directory's file count to settle. Empirically (diagnostic run against this
 * checkout with `storage.blobRetention: 0`), a supersession's reclaim lands ~1-1.5s after the
 * superseding write, not instantly — so this requires `stableTicks` CONSECUTIVE unchanged reads
 * (not just one) before declaring settled, and always samples for at least `minMs`.
 */
async function waitForDiskSettle(
	dir: string,
	{ minMs = 3000, maxMs = 8000, tickMs = 300, stableTicks = 3 } = {}
): Promise<{ files: number; bytes: number }> {
	const deadline = Date.now() + maxMs;
	let last = await diskUsage(dir);
	let stableCount = 0;
	while (Date.now() < deadline) {
		await sleep(tickMs);
		const next = await diskUsage(dir);
		if (next.files === last.files) stableCount++;
		else stableCount = 0;
		last = next;
		if (Date.now() - (deadline - maxMs) >= minMs && stableCount >= stableTicks) break;
	}
	return last;
}

suite('in-flight blob reader vs concurrent supersession (85f1c4b72)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	const findings: string[] = [];

	function blobDir() {
		return join(ctx.harper.dataRootDir, 'blobs', 'blobreader');
	}

	async function waitReady(probePath: string, timeoutMs = 120_000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest(probePath).timeout(2000);
				if (probe.status !== 404) return;
			} catch {
				/* not ready yet */
			}
			await sleep(250);
		}
		throw new Error(`timed out waiting for route ${probePath} to become ready`);
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				logging: { console: true, level: 'error' },
				storage: { blobRetention: 0 }, // no timer cushion — pass depends only on the hold mechanism
			},
			env: {},
		});
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		await waitReady('/Asset/');
	});

	after(async () => {
		await teardownHarper(ctx);
		console.log(`\n[blob-reader-supersession] FINDINGS`);
		for (const f of findings) console.log('  ' + f);
	});

	async function storeAsset(id: string, size: number, seed: string): Promise<{ sha256: string; size: number }> {
		const res = await fetch(`${httpURL}/AssetCtl/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
			body: JSON.stringify({ action: 'store', id, size, seed }),
		});
		const body = (await res.json()) as any;
		strictEqual(res.status, 200, `store ${id} failed: ${JSON.stringify(body)}`);
		ok(body.ok, `store ${id} not ok: ${JSON.stringify(body)}`);
		return { sha256: body.sha256, size: body.size };
	}

	async function deleteAsset(id: string): Promise<void> {
		const res = await fetch(`${httpURL}/AssetCtl/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
			body: JSON.stringify({ action: 'delete', id }),
		});
		const body = (await res.json()) as any;
		strictEqual(res.status, 200, `delete ${id} failed: ${JSON.stringify(body)}`);
	}

	/**
	 * Slow chunked GET of /AssetStream/{id}. Reads the body in whatever chunks the network layer
	 * hands back, hashing incrementally. Supports a byte-threshold trigger (fires an async action
	 * once, mid-stream) and a byte-threshold idle pause (stops pulling for `ms` before resuming).
	 */
	async function readAssetChunked(
		id: string,
		opts: {
			triggerAtBytes?: number;
			trigger?: () => Promise<unknown>;
			pauseAtBytes?: number;
			pauseMs?: number;
			perChunkDelayMs?: number;
			path?: string;
		} = {}
	): Promise<ReadResult> {
		const res = await fetch(`${httpURL}${opts.path ?? `/AssetStream/${id}`}`, {
			headers: { Authorization: client.headers.Authorization, Accept: '*/*' },
		});
		const contentLengthHeader = res.headers.get('content-length');
		if (res.status !== 200) {
			return {
				status: res.status,
				contentLengthHeader: contentLengthHeader ? Number(contentLengthHeader) : null,
				bytesReceived: 0,
				sha256: '',
				error: await res.text().catch(() => '<unreadable>'),
			};
		}
		const hash = createHash('sha256');
		let bytesReceived = 0;
		let triggered = false;
		let paused = false;
		const reader = (res.body as any).getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const chunk: Uint8Array = value;
				hash.update(chunk);
				bytesReceived += chunk.length;
				if (opts.trigger && !triggered && opts.triggerAtBytes != null && bytesReceived >= opts.triggerAtBytes) {
					triggered = true;
					await opts.trigger(); // await the write landing before we pull more bytes
				}
				if (opts.pauseMs && !paused && opts.pauseAtBytes != null && bytesReceived >= opts.pauseAtBytes) {
					paused = true;
					await sleep(opts.pauseMs); // idle client: no read() calls in flight during this window
				}
				if (opts.perChunkDelayMs) await sleep(opts.perChunkDelayMs);
			}
			return {
				status: res.status,
				contentLengthHeader: contentLengthHeader ? Number(contentLengthHeader) : null,
				bytesReceived,
				sha256: hash.digest('hex'),
			};
		} catch (error) {
			return {
				status: res.status,
				contentLengthHeader: contentLengthHeader ? Number(contentLengthHeader) : null,
				bytesReceived,
				sha256: hash.digest('hex'),
				error: String((error as Error)?.message ?? error),
			};
		}
	}

	// ---- Arm 4 (control) first: establishes the byte-exact baseline before any race arms run ----
	test('Arm 4 — control: read to completion, no concurrent writer, byte-exact', async () => {
		const id = 'ctrl';
		const { sha256: expectedSha } = await storeAsset(id, BLOB_SIZE, 'ctrl-seed');
		const result = await readAssetChunked(id);
		findings.push(
			`[Arm4 control] status=${result.status} bytesReceived=${result.bytesReceived}/${BLOB_SIZE} ` +
				`contentLength=${result.contentLengthHeader} sha=${result.sha256 === expectedSha ? 'MATCH' : 'MISMATCH'} ` +
				`error=${result.error ?? 'none'}`
		);
		strictEqual(result.status, 200, 'control read should return 200');
		strictEqual(result.bytesReceived, BLOB_SIZE, 'control: bytes received must equal blob size');
		strictEqual(result.contentLengthHeader, BLOB_SIZE, 'control: Content-Length must equal blob size');
		strictEqual(result.sha256, expectedSha, 'control: sha256 must match exactly (byte-exact baseline)');
	});

	// ---- Arm 1: PUT a different value to the same key mid-stream ----
	test('Arm 1 — concurrent PUT mid-stream: reader must still get ORIGINAL bytes intact', async () => {
		const id = 'arm1';
		const { sha256: originalSha } = await storeAsset(id, BLOB_SIZE, 'arm1-original');
		const before = await diskUsage(blobDir());

		let newSha = '';
		const result = await readAssetChunked(id, {
			triggerAtBytes: Math.floor(BLOB_SIZE * 0.4),
			trigger: async () => {
				const stored = await storeAsset(id, BLOB_SIZE, 'arm1-superseding');
				newSha = stored.sha256;
			},
		});
		notStrictEqual(newSha, '', 'the concurrent PUT must have actually landed during the read');
		notStrictEqual(newSha, originalSha, 'sanity: superseding write must differ from original');

		const afterRead = await diskUsage(blobDir());
		findings.push(
			`[Arm1 PUT-mid-stream] status=${result.status} bytesReceived=${result.bytesReceived}/${BLOB_SIZE} ` +
				`contentLength=${result.contentLengthHeader} ` +
				`sha=${result.sha256 === originalSha ? 'MATCHES ORIGINAL' : result.sha256 === newSha ? 'MATCHES NEW (defect: wrong version)' : 'MATCHES NEITHER (defect: mixed/truncated)'} ` +
				`error=${result.error ?? 'none'} disk_before=${fmt(before)} disk_after_read=${fmt(afterRead)}`
		);

		strictEqual(result.status, 200, 'Arm1: in-flight read should complete with 200, not error mid-stream');
		strictEqual(result.bytesReceived, BLOB_SIZE, 'Arm1: bytes received must equal the ORIGINAL blob size');
		strictEqual(result.contentLengthHeader, BLOB_SIZE, 'Arm1: Content-Length must equal the ORIGINAL blob size');
		strictEqual(result.sha256, originalSha, 'Arm1: sha256 must match the ORIGINAL bytes, not the superseding write');

		// Verify the new version really is live now (the PUT was not a no-op).
		const verifyNew = await readAssetChunked(id);
		strictEqual(verifyNew.sha256, newSha, 'Arm1: a fresh read after the fact must see the NEW bytes');

		// No-leak check: wait for the superseded file to be reclaimed now that our hold released.
		// `before` was snapshotted AFTER the original write, so a clean 1-for-1 replacement (original
		// reclaimed, new version persists) nets to a delta of exactly 0.
		const settled = await waitForDiskSettle(blobDir());
		const delta = settled.files - before.files;
		findings.push(
			`[Arm1] disk before=${fmt(before)} after_read=${fmt(afterRead)} after_settle=${fmt(settled)} delta=${delta}f`
		);
		strictEqual(delta, 0, 'Arm1: net 0 live blob files after settle (1-for-1 replace; original reclaimed, no leak)');
	});

	// ---- Arm 2: DELETE the record mid-stream ----
	test('Arm 2 — concurrent DELETE mid-stream: reader must still get ORIGINAL bytes intact', async () => {
		const id = 'arm2';
		const { sha256: originalSha } = await storeAsset(id, BLOB_SIZE, 'arm2-original');
		const before = await diskUsage(blobDir());

		let deleted = false;
		const result = await readAssetChunked(id, {
			triggerAtBytes: Math.floor(BLOB_SIZE * 0.4),
			trigger: async () => {
				await deleteAsset(id);
				deleted = true;
			},
		});
		ok(deleted, 'the concurrent DELETE must have actually landed during the read');

		findings.push(
			`[Arm2 DELETE-mid-stream] status=${result.status} bytesReceived=${result.bytesReceived}/${BLOB_SIZE} ` +
				`contentLength=${result.contentLengthHeader} ` +
				`sha=${result.sha256 === originalSha ? 'MATCHES ORIGINAL' : 'MISMATCH (defect: truncated/wrong bytes)'} ` +
				`error=${result.error ?? 'none'}`
		);

		strictEqual(result.status, 200, 'Arm2: in-flight read should complete with 200, not error mid-stream');
		strictEqual(result.bytesReceived, BLOB_SIZE, 'Arm2: bytes received must equal the ORIGINAL blob size');
		strictEqual(result.contentLengthHeader, BLOB_SIZE, 'Arm2: Content-Length must equal the ORIGINAL blob size');
		strictEqual(result.sha256, originalSha, 'Arm2: sha256 must match the ORIGINAL bytes despite the delete');

		// Confirm the record really is gone now.
		const verifyGone = await readAssetChunked(id);
		strictEqual(verifyGone.status, 404, 'Arm2: a fresh read after the fact must see the record gone (404)');

		// No-leak check: `before` was snapshotted AFTER the original write, so once our hold releases
		// and the delete's supersession reclaims, this id's file should vanish — a net delta of -1
		// relative to that baseline.
		const settled = await waitForDiskSettle(blobDir());
		const delta = settled.files - before.files;
		findings.push(
			`[Arm2] disk before=${fmt(before)} after_settle=${fmt(settled)} delta=${delta}f (expect -1: delete leaves nothing)`
		);
		strictEqual(delta, -1, 'Arm2: net -1 live blob files after settle (delete should leave nothing, no leak)');
	});

	// ---- Arm 3: PUT mid-stream, then the reader goes idle >500ms (the exact window #2134 names) ----
	test('Arm 3 — concurrent PUT + reader idle 800ms mid-stream (slow-client window from #2134)', async () => {
		const id = 'arm3';
		const { sha256: originalSha } = await storeAsset(id, BLOB_SIZE, 'arm3-original');

		let newSha = '';
		const t0 = Date.now();
		const result = await readAssetChunked(id, {
			triggerAtBytes: Math.floor(BLOB_SIZE * 0.3),
			trigger: async () => {
				const stored = await storeAsset(id, BLOB_SIZE, 'arm3-superseding');
				newSha = stored.sha256;
			},
			pauseAtBytes: Math.floor(BLOB_SIZE * 0.3), // pause right after the trigger fires
			pauseMs: 800, // > the original 500ms window this issue names
		});
		const elapsed = Date.now() - t0;
		ok(elapsed >= 800, `sanity: the idle pause must have actually elapsed (got ${elapsed}ms)`);

		findings.push(
			`[Arm3 PUT+800ms-idle] elapsed=${elapsed}ms status=${result.status} bytesReceived=${result.bytesReceived}/${BLOB_SIZE} ` +
				`contentLength=${result.contentLengthHeader} ` +
				`sha=${result.sha256 === originalSha ? 'MATCHES ORIGINAL' : result.sha256 === newSha ? 'MATCHES NEW (defect)' : 'MISMATCH (defect)'} ` +
				`error=${result.error ?? 'none'}`
		);

		strictEqual(result.status, 200, 'Arm3: in-flight read should complete with 200 despite the idle window');
		strictEqual(result.bytesReceived, BLOB_SIZE, 'Arm3: bytes received must equal the ORIGINAL blob size');
		strictEqual(result.contentLengthHeader, BLOB_SIZE, 'Arm3: Content-Length must equal the ORIGINAL blob size');
		strictEqual(result.sha256, originalSha, 'Arm3: sha256 must match the ORIGINAL bytes across the idle window');

		// Drain the reclamation queue before the next test's disk-usage baseline is taken — a
		// still-pending reclaim here would otherwise land mid-run in a later arm and throw off its
		// before/after delta by exactly 1 (this is what a first pass of this suite actually hit).
		await waitForDiskSettle(blobDir());
	});

	// ---- Arm 5 (bonus): hammer the residual "record decoded, stream() not yet called" gap ----
	test(
		'Arm 5 — bonus: rapid-fire store+resupersede+GET hammer, no pauses, disk stays leak-free',
		{ timeout: 60_000 },
		async () => {
			const N = 40;
			const SMALL_SIZE = 64 * 1024; // smaller blobs so N iterations stay fast; still file-backed
			let matchedOld = 0;
			let matchedNew = 0;
			let mismatched = 0;
			let cleanErrors = 0;
			const before = await diskUsage(blobDir());
			const expectedFinalSha = new Map<string, string>();

			for (let i = 0; i < N; i++) {
				const id = `hammer-${i}`;
				const { sha256: originalSha } = await storeAsset(id, SMALL_SIZE, `hammer-orig-${i}`);
				// Fire the GET and the superseding write with no artificial delay between them —
				// this is the tightest window the fix's comments call "residual": decode -> stream().
				const [result, stored] = await Promise.all([
					readAssetChunked(id),
					storeAsset(id, SMALL_SIZE, `hammer-new-${i}`),
				]);
				expectedFinalSha.set(id, stored.sha256);
				if (result.status === 200) {
					if (result.sha256 === originalSha) matchedOld++;
					else if (result.sha256 === stored.sha256) matchedNew++;
					else {
						mismatched++;
						findings.push(
							`[Arm5 hammer #${i}] MISMATCH: got sha=${result.sha256}, expected old=${originalSha} or new=${stored.sha256}, bytes=${result.bytesReceived}/${SMALL_SIZE}`
						);
					}
				} else {
					// A clean, prompt error (e.g. the narrow pre-hold gap resolving to a fresh 404/503) is
					// an acceptable outcome for this arm; a 200 with wrong bytes is not.
					cleanErrors++;
				}
			}

			findings.push(
				`[Arm5 hammer] N=${N} matchedOld=${matchedOld} matchedNew=${matchedNew} cleanErrors=${cleanErrors} mismatched=${mismatched}`
			);
			strictEqual(
				mismatched,
				0,
				`Arm5: ${mismatched}/${N} reads returned 200 with WRONG bytes (truncated/mixed) — real data corruption`
			);

			// Direct oracle for "live record references a deleted blob file" (#2134's exact symptom):
			// read every surviving id's CURRENT value back and confirm it resolves byte-exact, rather
			// than inferring live/dead from disk file counts alone.
			let liveReadFailures = 0;
			for (const [id, expectedSha] of expectedFinalSha) {
				const verify = await readAssetChunked(id);
				if (verify.status !== 200 || verify.sha256 !== expectedSha) {
					liveReadFailures++;
					findings.push(
						`[Arm5 hammer] LIVE-RECORD READ FAILURE for ${id}: status=${verify.status} sha=${verify.sha256 || '<none>'} ` +
							`expected=${expectedSha} error=${verify.error ?? 'none'} — matches #2134's exact symptom if this fires`
					);
				}
			}
			strictEqual(
				liveReadFailures,
				0,
				`Arm5: ${liveReadFailures}/${N} live records failed to read back their current blob (dangling reference to a deleted blob file)`
			);

			// No-leak-ish check across the whole hammer run: each surviving id should net exactly 1
			// live blob file. `delta < N` would mean a still-referenced (live) file got deleted —
			// the dangerous direction, and a hard failure. `delta > N` means a superseded file is
			// still on disk after settle; the shared 4096-slot hold table (blob.ts HOLD_TABLE_SLOTS)
			// is fixed-size and hash-shared by design ("a collision defers someone else's
			// reclamation, it never unlinks early" — blob.ts comment), so a small number of
			// collision-deferred stragglers is expected/documented behavior, not data loss (delta
			// is logged either way; a persistent leak WAY beyond N would still be worth a follow-up).
			const settled = await waitForDiskSettle(blobDir(), { minMs: 4000, maxMs: 20_000 });
			const delta = settled.files - before.files;
			findings.push(
				`[Arm5 hammer] disk before=${fmt(before)} after-settle=${fmt(settled)} delta=${delta}f (expect >= ${N}, exactly ${N} absent hold-table hash collisions)`
			);
			ok(
				delta >= N,
				`Arm5: DANGER direction — delta=${delta} < N=${N} means a still-live file was deleted (premature reclamation / real data-loss risk)`
			);
			if (delta > N) {
				findings.push(
					`[Arm5 hammer] NOTE: ${delta - N} superseded file(s) still on disk after 20s settle — consistent with the ` +
						`documented hash-collision over-retention in the shared hold table, not data loss (0 mismatched reads above).`
				);
			}
		}
	);

	// ---- Arm 6: record resolved BEFORE the overwrite, blob file opened AFTER it (the discriminating arm) ----
	test('Arm 6 -- record resolved, then PUT lands, then the blob is opened 1500ms later: reader must get the ORIGINAL bytes', async () => {
		const id = 'arm6';
		const LATE_OPEN_MS = 1500; // > the pre-fix fixed 500ms unlink timer; the fix has no such timer to beat
		const { sha256: originalSha } = await storeAsset(id, BLOB_SIZE, 'arm6-original');
		const before = await diskUsage(blobDir());

		// The late reader loads the record (and so its Blob handle) immediately, reports that through
		// /AssetLateState/, waits LATE_OPEN_MS, and only then returns the body -- which is when the
		// file is actually opened.
		const lateRead = readAssetChunked(id, { path: `/AssetLateStream/${id}?delayMs=${LATE_OPEN_MS}` });
		const resolvedDeadline = Date.now() + 10_000;
		let lateState = 'none';
		while (Date.now() < resolvedDeadline) {
			const res = await fetch(`${httpURL}/AssetLateState/?id=${id}`, {
				headers: { Authorization: client.headers.Authorization },
			});
			lateState = ((await res.json()) as { state: string }).state;
			if (lateState === 'resolved') break;
			await sleep(20);
		}
		strictEqual(lateState, 'resolved', 'the late reader must have resolved the record before the overwrite is issued');

		const { sha256: newSha } = await storeAsset(id, BLOB_SIZE, 'arm6-superseding');
		notStrictEqual(newSha, originalSha, 'sanity: superseding write must differ from original');
		const result = await lateRead;
		findings.push(
			`[Arm6 late-open] status=${result.status} bytesReceived=${result.bytesReceived}/${BLOB_SIZE} ` +
				`contentLength=${result.contentLengthHeader} ` +
				`sha=${result.sha256 === originalSha ? 'MATCHES ORIGINAL' : result.sha256 === newSha ? 'MATCHES NEW (defect: wrong version)' : 'MATCHES NEITHER (defect: gone/truncated)'} ` +
				`error=${result.error ?? 'none'}`
		);

		strictEqual(
			result.status,
			200,
			`Arm6: a reader that resolved the record before the overwrite must still be served its blob ` +
				`(got ${result.status}: ${result.error ?? 'no error body'}) -- the superseded file was reclaimed under a live reader`
		);
		strictEqual(result.bytesReceived, BLOB_SIZE, 'Arm6: bytes received must equal the ORIGINAL blob size');
		strictEqual(result.sha256, originalSha, 'Arm6: sha256 must match the ORIGINAL bytes, not the superseding write');

		const verifyNew = await readAssetChunked(id);
		strictEqual(verifyNew.sha256, newSha, 'Arm6: a fresh read after the fact must see the NEW bytes');

		const settled = await waitForDiskSettle(blobDir());
		const delta = settled.files - before.files;
		findings.push(`[Arm6] disk before=${fmt(before)} after_settle=${fmt(settled)} delta=${delta}f`);
		strictEqual(delta, 0, 'Arm6: net 0 live blob files after settle (original reclaimed once released, no leak)');
	});
});
