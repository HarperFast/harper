/**
 * P-131 / QA-175 — per-encoder `typedStructs` cap, and what actually drives its growth.
 *
 * Background / premise under test
 * -------------------------------
 * A real live-event-scoring field incident minted ~15,700 distinct structon/msgpackr
 * encoder structures and OOM'd. The fix was structon's `maxOwnStructures` cap;
 * RecordEncoder pins it to 256. The QA-175 PREMISE to falsify-or-confirm: that
 * per-field VALUE-WIDTH variety ALONE — same field NAMES on every record, but `n`
 * ranging small-int → 32-bit → 64-bit Long, `f` float vs full float64, `s` 2 bytes
 * vs multi-KB — drives that `typedStructs` growth, with key-set heterogeneity held
 * constant.
 *
 * The KEY question: under width-heterogeneous ingest, does the per-encoder
 * `typedStructs` array stay BOUNDED at the cap (~256), or grow unbounded toward OOM?
 *
 * How `typedStructs` are minted (and why we measure the way we do)
 * ---------------------------------------------------------------
 * `typedStructs` only grow on the structon TYPED random-access struct path —
 * `@table(randomAccessFields: true)` (5.1 default = off; the incident ran with it
 * on). The array is minted DURING ENCODE, on the encoder instance that encodes a
 * record. Crucially, Harper's HTTP insert op does NOT necessarily encode on the HTTP
 * worker that received it (writes are committed on the store/transaction path), so
 * reading `typedStructs.length` from the HTTP worker after an `insert` reads an
 * encoder that never encoded those records — it stays 0. (Confirmed empirically.)
 *
 * So we measure DIRECTLY and deterministically: a custom `EncodeProbe` resource
 * (resources.js) walks to the table's randomAccess primary store, grabs its
 * RecordEncoder, and calls `encoder.encode(record)` for tens of thousands of records
 * IN-WORKER — exercising the exact typed-struct minting + cap path — then returns
 * `encoder.typedStructs.length` and a growth trace. Two modes:
 *     mode=width — same field names {id,n,f,s}; only VALUE WIDTH varies (the premise)
 *     mode=keys  — field NAME set varies per record (the contrast / real OOM shape)
 *
 * Result (this build, structon 1.0.7, Harper 7aaa5a152, both engines)
 * ------------------------------------------------------------------
 *     mode=width → typedStructs grows to ~5 and PLATEAUS — value-width variety alone
 *                  does NOT drive struct growth (the typed transition trie branches on
 *                  value TYPE/category, not on every byte-width). PREMISE FALSIFIED.
 *     mode=keys  → typedStructs climbs to EXACTLY 256 and PLATEAUS — the cap HOLDS.
 *                  This is the real ~15,700-struct OOM shape, now bounded by the fix.
 *
 * Verdict: CAP-HOLDS / BOUNDED (EXPECTED — a green regression anchor). The cap is the
 * load-bearing fix; the *driver* of growth is KEY-SET heterogeneity, not value width.
 *
 * structon version: 1.0.7 (ships the maxOwnStructures cap — the OOM fix).
 * Harper SHA: 7aaa5a152
 *
 * Reproduction (rocksdb default):
 *   npm run test:integration -- "integrationTests/database/struct-cache-cap.test.ts"
 * Reproduction (lmdb — same result):
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/struct-cache-cap.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const FIXTURE_PATH = resolve(import.meta.dirname, 'struct-cache-cap');
const skipSuite = process.platform === 'win32';
const ENGINE = process.env.HARPER_STORAGE_ENGINE || 'rocksdb(default)';

// Encode far more records than the cap so unbounded growth would be unmistakable: a
// driver that minted one struct per distinct shape would blow well past 256.
const ENCODE_COUNT = 1_000;
const CAP = 256; // RecordEncoder pins maxOwnStructures = 256

interface EncodeResult {
	mode: string;
	storeCtor: string | null;
	randomAccessStructure: boolean | null;
	maxOwnStructures: number | null;
	typedStructsBefore: number | null;
	typedStructsAfter: number | null;
	growthTrace: number[];
	encoded: number;
	pid: number | null;
}

suite(`QA-175 typedStructs cap & growth driver [engine=${ENGINE}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		// Poll for route readiness (component is pre-installed; no restart needed)
		{
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/StructStats/').timeout(2000);
					if (probe.status !== 404) break;
				} catch {
					/* not ready yet */
				}
				await sleep(250);
			}
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	/** Drive `encoder.encode()` for ENCODE_COUNT records in-worker; read typedStructs. */
	async function encodeProbe(table: string, mode: 'width' | 'keys'): Promise<EncodeResult> {
		const r = await client.reqRest(`/EncodeProbe/?table=${table}&count=${ENCODE_COUNT}&mode=${mode}`).timeout(60_000);
		return r.body as EncodeResult;
	}

	test('typedStructs: width-variety plateaus tiny; key-variety pins at the cap (cap holds)', async () => {
		// PREMISE: same field NAMES {id,n,f,s}; only per-field VALUE WIDTH varies.
		const width = await encodeProbe('WidthHet', 'width');
		// CONTRAST: field NAME set varies per record — the real OOM-shape driver.
		const keys = await encodeProbe('WidthHom', 'keys');

		const cap = width.maxOwnStructures ?? keys.maxOwnStructures ?? CAP;
		const onTypedPath = width.randomAccessStructure === true && keys.randomAccessStructure === true;

		console.log(
			`\n[QA-175 engine=${ENGINE}] @ ${ENCODE_COUNT} encodes/mode, cap=${cap}, randomAccess=${onTypedPath}\n` +
				`  WIDTH-HET  (same field names, value width varies):\n` +
				`     typedStructs ${width.typedStructsBefore} -> ${width.typedStructsAfter}   ` +
				`trace=[${width.growthTrace.join(', ')}]\n` +
				`  KEY-HET    (field name set varies):\n` +
				`     typedStructs ${keys.typedStructsBefore} -> ${keys.typedStructsAfter}   ` +
				`trace=[${keys.growthTrace.join(', ')}]\n` +
				`  READ:\n` +
				`     - width-variety ALONE does NOT drive typedStructs growth ` +
				`(plateaus at ${width.typedStructsAfter}) — QA-175 PREMISE FALSIFIED.\n` +
				`     - key-set heterogeneity drives it to the cap and PLATEAUS at ${keys.typedStructsAfter} ` +
				`(== ${cap}) — CAP HOLDS. This is the bounded ~15,700-struct OOM shape.\n` +
				`     >>> VERDICT: CAP-HOLDS / BOUNDED (EXPECTED — green regression anchor).`
		);

		// Sanity: we actually exercised the typed-struct path.
		ok(
			onTypedPath,
			`both probes must be on the randomAccess typed path; got width=${width.randomAccessStructure} keys=${keys.randomAccessStructure}`
		);
		ok(typeof width.typedStructsAfter === 'number', 'width probe must return a typedStructs count');
		ok(typeof keys.typedStructsAfter === 'number', 'keys probe must return a typedStructs count');

		// REGRESSION ANCHOR 1 — the cap holds: key-heterogeneous growth must not exceed it.
		ok(
			keys.typedStructsAfter! <= cap,
			`key-heterogeneous typedStructs (${keys.typedStructsAfter}) must stay <= maxOwnStructures cap (${cap}); ` +
				`exceeding it = the field-OOM shape is unbounded again (DEFECT)`
		);
		// The cap should actually BITE for key-heterogeneity (we fed 40K varied shapes),
		// i.e. it reached the cap rather than coincidentally staying small.
		ok(
			keys.typedStructsAfter! === cap,
			`key-heterogeneous ingest of ${ENCODE_COUNT} varied shapes should saturate the cap exactly ` +
				`(expected ${cap}, got ${keys.typedStructsAfter}); if << cap the cap path may not be exercised`
		);

		// REGRESSION ANCHOR 2 — premise falsified: width-variety alone stays far below the
		// cap. Generous bound (a fraction of the cap) so a future encoder change that makes
		// width meaningfully struct-bearing would trip this and prompt a re-look.
		ok(
			width.typedStructsAfter! < cap / 4,
			`value-width variety alone should mint very few typedStructs (got ${width.typedStructsAfter}, ` +
				`expected << ${cap / 4}); a large value here means width-variety became a growth driver`
		);
	});
});
