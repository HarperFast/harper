/**
 * QA-595 — EAV product catalog fronted by a cache-sourced (`sourcedFrom`) resource:
 * read-consistency of the assembled view under concurrent attribute-by-attribute writes.
 *
 * A "product" is not a row. It's assembled at read time from N Attribute rows (one row
 * per entity+attribute-name — a real EAV junction table, keyed `${entityId}:${attrName}`).
 * Product is a `@table(expiration: 3)` cache resource whose sourcedFrom get() reads those
 * 5 rows ONE AT A TIME (deterministic order: name, price, color, stock, description) and
 * returns the assembled view. The EAV substrate's unit of write (one row, one independent
 * HTTP PUT) and the cache's unit of consistency (one assembled product, one cache entry)
 * disagree — attribute-by-attribute mutation is inherently non-atomic from the cache's
 * point of view.
 *
 * Three probes:
 *   P1 bulk natural-conditions race hunt — 60 products x 5 attrs (300 rows) mutated
 *      attribute-by-attribute (independent PUTs, no shared txn) with concurrent reads
 *      racing the mutation, at realistic speed (no artificial delay). Looks for a
 *      "torn" view (mixed old/new attrs in one assembled response) and — the actual
 *      defect signature — whether any such view is still served after a full TTL+settle
 *      window (permanently pinned) vs. self-heals (transient, expected).
 *   P2 deterministic invalidate-vs-in-flight-fill race — widen the fill's window via a
 *      controllable per-attribute read delay, start a slow fill BEFORE a mutation, mutate
 *      all 5 attrs, THEN call the real `Table.invalidate(id)` API, and let the slow fill
 *      (which read pre-mutation values) complete and write back to cache AFTER the
 *      invalidate call lands. Confirms the race actually happened, observes whether the
 *      stale write wins immediately, then hard-asserts eventual convergence past TTL+settle.
 *   P3 TTL-expiry-mid-fill sanity — mutate attributes timed to straddle a cache entry's
 *      natural TTL expiry while spraying concurrent reads across the boundary. Checks for
 *      no hang/error and eventual convergence to the raw-Attribute-row oracle.
 *
 * Originating QA-id: QA-595. Promoted from the qa-explorer promote-candidates snapshot
 * (P-382) after a cold gate rerun on main. Pairs with sourcedfrom-snapshot-scoping.test.ts
 * (QA-596), which establishes WHY this holds (single-store transaction reuse) rather than
 * just observing that it does.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations; runtime resolves fine
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'sourcedfrom-eav-cache-coherence');
const skipSuite = process.platform === 'win32';

const ATTR_NAMES = ['name', 'price', 'color', 'stock', 'description'];
const TTL_MS = 3000; // matches schema.graphql's Product @table(expiration: 3)
const SETTLE_MS = 2500; // extra buffer past TTL before trusting convergence

const N_PRODUCTS = 60; // 60 x 5 attrs = 300 EAV rows for the bulk probe
const READS_PER_PRODUCT_DURING_BURST = 3;

interface ProductBody {
	id: string;
	attrs: Record<string, string | null>;
	gens: Record<string, number | null>;
	fillSeq: number;
	assembledAt: number;
}

function attrRow(entityId: string, attrName: string, gen: number) {
	return { id: `${entityId}:${attrName}`, entityId, name: attrName, value: `${attrName}-g${gen}-${entityId}`, gen };
}

suite('QA-595 EAV catalog x sourcedFrom cache coherence', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let restURL: string;
	let headers: Record<string, string>;

	async function putAttribute(entityId: string, attrName: string, gen: number): Promise<number> {
		const key = `${entityId}:${attrName}`;
		const res = await fetch(`${restURL}/Attribute/${encodeURIComponent(key)}`, {
			method: 'PUT',
			headers,
			body: JSON.stringify(attrRow(entityId, attrName, gen)),
		});
		await res.text().catch(() => undefined);
		if (![200, 201, 204].includes(res.status)) throw new Error(`PUT Attribute/${key} -> ${res.status}`);
		return res.status;
	}

	async function getProduct(entityId: string): Promise<{ status: number; body: ProductBody | null }> {
		const res = await fetch(`${restURL}/Product/${encodeURIComponent(entityId)}`, { headers });
		const text = await res.text();
		let body: ProductBody | null = null;
		try {
			body = JSON.parse(text);
		} catch {
			/* leave null */
		}
		return { status: res.status, body };
	}

	async function attrScan(entityId: string): Promise<Record<string, { value: string; gen: number } | null>> {
		const res = await fetch(`${restURL}/AttrScan/?id=${encodeURIComponent(entityId)}`, { headers });
		if (res.status !== 200) throw new Error(`AttrScan/${entityId} -> ${res.status}`);
		return res.json();
	}

	async function productRaw(
		entityId: string
	): Promise<{ exists: boolean; value: ProductBody | null; version: number | null }> {
		const res = await fetch(`${restURL}/ProductRaw/?id=${encodeURIComponent(entityId)}`, { headers });
		if (res.status !== 200) throw new Error(`ProductRaw/${entityId} -> ${res.status}`);
		return res.json();
	}

	async function invalidateProduct(entityId: string): Promise<void> {
		const res = await fetch(`${restURL}/InvalidateProduct/`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ id: entityId }),
		});
		if (res.status !== 200) throw new Error(`InvalidateProduct/${entityId} -> ${res.status}: ${await res.text()}`);
		await res.text().catch(() => undefined);
	}

	async function setReadDelay(ms: number): Promise<void> {
		const res = await fetch(`${restURL}/Control/`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ readDelayMs: ms }),
		});
		if (res.status !== 200) throw new Error(`Control readDelayMs=${ms} -> ${res.status}`);
		await res.text().catch(() => undefined);
	}

	function allGen1(gens: Record<string, number | null> | undefined): boolean {
		const vals = Object.values(gens ?? {});
		return vals.length === ATTR_NAMES.length && vals.every((g) => g === 1);
	}

	function matchesOracle(
		attrs: Record<string, string | null> | undefined,
		oracle: Record<string, { value: string; gen: number } | null>
	): boolean {
		if (!attrs) return false;
		return ATTR_NAMES.every((a) => attrs[a] === (oracle[a]?.value ?? null));
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		restURL = ctx.harper.httpURL;
		headers = { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization };

		await restartHttpWorkers(client, '/AttrScan/');

		// Seed the EAV substrate: N_PRODUCTS + 2 fixture products, 5 attrs each, all gen 0.
		const seedRows: any[] = [];
		for (let i = 0; i < N_PRODUCTS; i++) {
			for (const a of ATTR_NAMES) seedRows.push(attrRow(`P${i}`, a, 0));
		}
		for (const id of ['RACE0', 'TTLBOUND0']) {
			for (const a of ATTR_NAMES) seedRows.push(attrRow(id, a, 0));
		}
		const insertRes = await client
			.req()
			.send({ operation: 'insert', table: 'Attribute', records: seedRows })
			.timeout(30_000);
		strictEqual(insertRes.status, 200, `seed insert failed: ${JSON.stringify(insertRes.body).slice(0, 300)}`);
		console.log(`[QA-595] seeded ${seedRows.length} EAV Attribute rows`);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test(
		'P1: bulk attribute-by-attribute burst (300 rows, 60 products) — torn view persists past TTL+settle?',
		{ timeout: 30_000 },
		async () => {
			const ids = Array.from({ length: N_PRODUCTS }, (_, i) => `P${i}`);
			const observations = new Map<string, Array<Record<string, number | null>>>();

			const ops: Array<Promise<unknown>> = [];
			for (const id of ids) {
				for (const attrName of ATTR_NAMES) ops.push(putAttribute(id, attrName, 1));
				for (let k = 0; k < READS_PER_PRODUCT_DURING_BURST; k++) {
					ops.push(
						getProduct(id).then((r) => {
							if (r.status === 200 && r.body) {
								const arr = observations.get(id) ?? [];
								arr.push(r.body.gens);
								observations.set(id, arr);
							}
						})
					);
				}
			}
			await Promise.all(ops);

			let tornCount = 0;
			const tornSamples: Array<{ id: string; gens: Record<string, number | null> }> = [];
			for (const [id, obsList] of observations) {
				for (const gens of obsList) {
					if (new Set(Object.values(gens)).size > 1) {
						tornCount++;
						if (tornSamples.length < 8) tornSamples.push({ id, gens });
					}
				}
			}
			console.log(
				`[QA-595 P1] observations captured=${[...observations.values()].reduce((n, a) => n + a.length, 0)} ` +
					`torn(mixed-gen)=${tornCount}\n  samples: ${JSON.stringify(tornSamples)}`
			);

			// settle well past TTL, then check convergence against the independent raw-row oracle
			await sleep(TTL_MS + SETTLE_MS);

			const staleAfterSettle: Array<{ id: string; gens: unknown; attrs: unknown; oracle: unknown }> = [];
			for (const id of ids) {
				const [prodRes, oracle] = await Promise.all([getProduct(id), attrScan(id)]);
				ok(prodRes.status === 200 && prodRes.body, `GET /Product/${id} failed post-settle: ${prodRes.status}`);
				const body = prodRes.body as ProductBody;
				if (!allGen1(body.gens) || !matchesOracle(body.attrs, oracle)) {
					staleAfterSettle.push({ id, gens: body.gens, attrs: body.attrs, oracle });
				}
			}
			console.log(
				`[QA-595 P1] products still stale/torn after TTL+settle: ${staleAfterSettle.length}/${N_PRODUCTS}\n` +
					(staleAfterSettle.length ? `  samples: ${JSON.stringify(staleAfterSettle.slice(0, 5))}` : '')
			);

			strictEqual(
				staleAfterSettle.length,
				0,
				`DEFECT: stale/torn cache view still pinned after TTL+settle for ${staleAfterSettle.length} product(s): ` +
					JSON.stringify(staleAfterSettle.slice(0, 5))
			);
		}
	);

	test(
		'P2: invalidate() vs in-flight slow fill race — does a stale fill overwrite the cache AFTER invalidate?',
		{ timeout: 20_000 },
		async () => {
			const id = 'RACE0';
			await setReadDelay(150); // ~750-900ms total fill duration across 5 sequential reads

			const fillPromise = getProduct(id); // triggers a slow fill reading PRE-mutation (gen0) values

			await sleep(220); // let the slow fill get partway through its 5 sequential reads
			const mutateAt = Date.now();
			await Promise.all(ATTR_NAMES.map((a) => putAttribute(id, a, 1))); // fast, independent burst mutation

			await sleep(60);
			const invalidateAt = Date.now();
			await invalidateProduct(id);

			const fillResult = await fillPromise;
			const fillFinishedAt = Date.now();

			ok(fillResult.status === 200 && fillResult.body, `slow fill GET failed: ${fillResult.status}`);
			const raceConfirmed = fillFinishedAt > invalidateAt;
			const fillBody = fillResult.body as ProductBody;
			console.log(
				`[QA-595 P2] mutateAt=+0ms invalidateAt=+${invalidateAt - mutateAt}ms fillFinishedAt=+${fillFinishedAt - mutateAt}ms ` +
					`raceConfirmed(fill finished after invalidate)=${raceConfirmed}\n` +
					`  the slow fill's OWN assembled view: gens=${JSON.stringify(fillBody?.gens)} attrs=${JSON.stringify(fillBody?.attrs)} ` +
					`(torn=${new Set(Object.values(fillBody?.gens ?? {})).size > 1})`
			);
			ok(
				raceConfirmed,
				'test setup invalid: slow fill finished BEFORE invalidate landed — race window not achieved, adjust timings'
			);

			// Immediately after, BEFORE issuing any further GET (which could itself trigger a fresh
			// fill and mask the answer): peek the RAW stored cache entry to see exactly what the
			// slow fill's write-back left behind, undisturbed.
			const rawAfterRace = await productRaw(id);
			console.log(
				`[QA-595 P2] raw cache entry immediately after race (no triggering read): exists=${rawAfterRace.exists} ` +
					`version=${rawAfterRace.version} gens=${JSON.stringify(rawAfterRace.value?.gens)}`
			);

			// Now a normal GET (this may itself trigger a fresh fill if the raw entry above was
			// absent/invalidated/expired — that's fine, it's the "does the client-visible read
			// recover" question, distinct from the raw-entry question above).
			const immediateAfter = await getProduct(id);
			await setReadDelay(0);
			const immediateBody = immediateAfter.body as ProductBody;
			const immediateOk = allGen1(immediateBody?.gens);
			console.log(
				`[QA-595 P2] immediately after race (via normal GET): gens=${JSON.stringify(immediateBody?.gens)} allGen1=${immediateOk}`
			);

			// Settle past TTL and re-check: MUST converge to fully-gen1, matching raw oracle, regardless
			// of what happened immediately after the race (a briefly-stale entry that self-heals is fine;
			// one that stays wrong past TTL+settle is the actual defect).
			await sleep(TTL_MS + SETTLE_MS);
			const [settled, oracle] = await Promise.all([getProduct(id), attrScan(id)]);
			const settledBody = settled.body as ProductBody;
			const settledAllGen1 = allGen1(settledBody?.gens);
			const settledMatchesOracle = matchesOracle(settledBody?.attrs, oracle);

			console.log(
				`[QA-595 P2] post-settle: gens=${JSON.stringify(settledBody?.gens)} attrs=${JSON.stringify(settledBody?.attrs)} ` +
					`allGen1=${settledAllGen1} matchesOracle=${settledMatchesOracle}` +
					(!immediateOk
						? settledAllGen1
							? ' — VERDICT: SURPRISING-OK, stale fill won the immediate race but self-healed by next TTL cycle'
							: ' — VERDICT: DEFECT, stale entry remained pinned past a full TTL+settle window'
						: ' — VERDICT: CLEAN, invalidate/race produced no observable staleness')
			);

			strictEqual(
				settledAllGen1,
				true,
				`DEFECT: product view still not fully gen1 after TTL+settle following invalidate-vs-fill race: ${JSON.stringify(settledBody?.gens)}`
			);
			strictEqual(
				settledMatchesOracle,
				true,
				`DEFECT: post-settle product attrs diverge from raw Attribute oracle: attrs=${JSON.stringify(
					settledBody?.attrs
				)} oracle=${JSON.stringify(oracle)}`
			);
		}
	);

	test(
		'P3: attribute mutation straddling natural TTL expiry — no hang/error, eventual convergence',
		{ timeout: 20_000 },
		async () => {
			const id = 'TTLBOUND0';
			await setReadDelay(0);

			const primeRes = await getProduct(id); // gen0 — starts this entry's TTL clock
			ok(primeRes.status === 200, `prime GET failed: ${primeRes.status}`);
			const primedAt = Date.now();

			const spraySamples: Array<{ t: number; status: number | string }> = [];
			const spray = (async () => {
				const until = primedAt + TTL_MS + 1200;
				while (Date.now() < until) {
					const r = await getProduct(id).catch((e: Error) => ({ status: `ERR:${e.message}`, body: null }) as const);
					spraySamples.push({ t: Date.now() - primedAt, status: r.status as any });
					await sleep(80);
				}
			})();

			// fire the burst mutation timed to overlap this entry's natural expiry moment
			await sleep(Math.max(0, TTL_MS - 300));
			const mutateAtOffset = Date.now() - primedAt;
			await Promise.all(ATTR_NAMES.map((a) => putAttribute(id, a, 1)));

			await spray;

			const errors = spraySamples.filter((s) => typeof s.status !== 'number' || s.status >= 400);
			console.log(
				`[QA-595 P3] spray samples=${spraySamples.length} mutate@+${mutateAtOffset}ms errors=${errors.length}` +
					(errors.length ? ` samples: ${JSON.stringify(errors.slice(0, 5))}` : '')
			);
			strictEqual(
				errors.length,
				0,
				`unexpected errors/hangs during TTL-boundary spray: ${JSON.stringify(errors.slice(0, 5))}`
			);

			await sleep(TTL_MS + SETTLE_MS);
			const [settled, oracle] = await Promise.all([getProduct(id), attrScan(id)]);
			const settledBody = settled.body as ProductBody;
			const settledAllGen1 = allGen1(settledBody?.gens);
			const settledMatchesOracle = matchesOracle(settledBody?.attrs, oracle);
			console.log(
				`[QA-595 P3] post-settle: gens=${JSON.stringify(settledBody?.gens)} allGen1=${settledAllGen1} matchesOracle=${settledMatchesOracle}`
			);
			strictEqual(
				settledAllGen1 && settledMatchesOracle,
				true,
				`DEFECT: TTL-boundary mutation left product view unconverged: gens=${JSON.stringify(
					settledBody?.gens
				)} attrs=${JSON.stringify(settledBody?.attrs)} oracle=${JSON.stringify(oracle)}`
			);
		}
	);
});
