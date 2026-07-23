/**
 * QA-593 — nested GraphQL @relationship expansion: cross-level read consistency under
 * concurrent atomic child writes.
 *
 * Model: Publisher 1--* Series (Series.publisherId) 1--* Article (Article.seriesId), a
 * 3-level @relationship graph at moderate scale (4 publishers x 8 series x 25 articles =
 * 836 rows). Harper's relationship expander runs one search() at the parent level
 * (Series) and a separate search() at the child level (Article) to fill in a nested
 * GraphQL selection. A same-table bulk `update` ops-array call with no validation errors
 * runs inside one transaction (atomic, all-or-nothing), so if a writer atomically
 * bulk-updates all N children of a series to a new `gen` value, a single read of
 * "articles for seriesId=X" nested under that series must see EITHER the fully-old
 * generation OR the fully-new generation for the sibling set — never a mix (a torn read)
 * — if the nested expansion reads the child collection through one consistent snapshot.
 *
 * Parent-vs-child generation SKEW across levels is expected and not itself a defect:
 * Series.gen and its Article.gen values are written in two separate transactions
 * (children first, then parent), so some skew across levels is normal.
 *
 * Originating QA-id: QA-593. Promoted from the qa-explorer promote-candidates snapshot
 * (P-380) after a cold gate rerun on main.
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

const FIXTURE_PATH = resolve(import.meta.dirname, 'relationship-graphql-snapshot-consistency');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const PUBLISHERS = 4;
const SERIES_PER_PUB = 8;
const ARTICLES_PER_SERIES = 25;
const WRITE_ITERATIONS = 150;

const pubId = (p: number) => `pub${p}`;
const seriesId = (p: number, s: number) => `ser-${p}-${s}`;
const articleId = (p: number, s: number, a: number) => `art-${p}-${s}-${a}`;

suite(
	'QA-593 content-catalog 3-level @relationship graph x GraphQL cross-level snapshot consistency',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		const findings: string[] = [];

		async function gql(query: string) {
			return client.reqGraphQl().send({ query }).timeout(10_000);
		}
		async function insert(table: string, records: any[]) {
			return client.req().send({ operation: 'insert', table, records }).expect(200);
		}
		async function update(table: string, records: any[]) {
			return client.req().send({ operation: 'update', table, records }).timeout(10_000);
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
			client = createApiClient(ctx.harper);

			// Routes register async post-setup; only assert after this poll (per ttl.test.ts pattern).
			await restartHttpWorkers(client, '/Publisher/', 120_000);

			const publishers: any[] = [];
			const series: any[] = [];
			const articles: any[] = [];
			for (let p = 0; p < PUBLISHERS; p++) {
				publishers.push({ id: pubId(p), name: `publisher-${p}` });
				for (let s = 0; s < SERIES_PER_PUB; s++) {
					series.push({ id: seriesId(p, s), publisherId: pubId(p), name: `series-${p}-${s}`, gen: 0 });
					for (let a = 0; a < ARTICLES_PER_SERIES; a++) {
						articles.push({
							id: articleId(p, s, a),
							seriesId: seriesId(p, s),
							title: `article-${p}-${s}-${String(a).padStart(3, '0')}`,
							gen: 0,
						});
					}
				}
			}
			await insert('Publisher', publishers);
			await insert('Series', series);
			for (let i = 0; i < articles.length; i += 200) await insert('Article', articles.slice(i, i + 200));

			await sleep(1000); // index settle
			console.log(
				`[QA-593] seeded: publishers=${publishers.length} series=${series.length} articles=${articles.length}`
			);
		});

		after(async () => {
			await teardownHarper(ctx);
			for (const f of findings) console.log('  ' + f);
		});

		// ============================================================== sanity / control
		test('S sanity: static full-graph nested GraphQL traversal is complete and correctly parented at scale', async () => {
			const t0 = performance.now();
			const r = await gql('{ Publisher { id series { id publisherId gen articles { id seriesId gen } } } }');
			const elapsed = performance.now() - t0;
			strictEqual(r.status, 200, r.text);
			const pubs = r.body?.data?.Publisher ?? [];
			strictEqual(pubs.length, PUBLISHERS, 'must return all publishers');

			let seriesCount = 0;
			let articleCount = 0;
			let misparented = 0;
			for (const pub of pubs) {
				for (const ser of pub.series ?? []) {
					seriesCount++;
					if (ser.publisherId !== pub.id) misparented++;
					for (const art of ser.articles ?? []) {
						articleCount++;
						if (art.seriesId !== ser.id) misparented++;
					}
				}
			}
			const msg = `S sanity: publishers=${pubs.length} series=${seriesCount}/${PUBLISHERS * SERIES_PER_PUB} articles=${articleCount}/${PUBLISHERS * SERIES_PER_PUB * ARTICLES_PER_SERIES} misparented=${misparented} elapsed=${elapsed.toFixed(0)}ms`;
			console.log(`[S] ${msg}`);
			findings.push(msg);

			strictEqual(seriesCount, PUBLISHERS * SERIES_PER_PUB, 'full series fan-out at scale');
			strictEqual(articleCount, PUBLISHERS * SERIES_PER_PUB * ARTICLES_PER_SERIES, 'full article fan-out at scale');
			strictEqual(misparented, 0, 'every child must resolve under its correct parent (no cross-wiring)');
			ok(
				elapsed < 15_000,
				`full 836-row 3-level traversal should not take unreasonably long (got ${elapsed.toFixed(0)}ms)`
			);
		});

		// ============================================================== main experiment
		test('R cross-level snapshot consistency: nested GraphQL Series->articles under concurrent atomic child writes', async () => {
			const hotSeries = seriesId(0, 0);
			const hotArticleIds = Array.from({ length: ARTICLES_PER_SERIES }, (_, a) => articleId(0, 0, a));

			const state = { done: false, writeErrors: 0, lastGenWritten: 0 };
			const samples: { articlesLen: number; distinctChildGens: number; childGen: number | null; seriesGen: number }[] =
				[];
			let readErrors = 0;

			async function writer() {
				for (let i = 1; i <= WRITE_ITERATIONS; i++) {
					try {
						// Children first, atomically (single ops-array transaction), THEN parent
						// (separate transaction) -- deliberately maximizing the parent/child skew
						// window while keeping each individual write atomic within its own table.
						const childRecords = hotArticleIds.map((id) => ({ id, gen: i }));
						const childRes = await update('Article', childRecords);
						if (childRes.status !== 200) state.writeErrors++;
						const parentRes = await update('Series', [{ id: hotSeries, gen: i }]);
						if (parentRes.status !== 200) state.writeErrors++;
						state.lastGenWritten = i;
					} catch {
						state.writeErrors++;
					}
				}
				state.done = true;
			}

			async function reader() {
				while (!state.done) {
					try {
						const r = await gql(`{ Series(id: "${hotSeries}") { id gen articles { id gen } } }`);
						if (r.status !== 200) {
							readErrors++;
							continue;
						}
						const ser = r.body?.data?.Series?.[0];
						const arts: { id: string; gen: number }[] = ser?.articles ?? [];
						const distinctGens = new Set(arts.map((a) => a.gen));
						samples.push({
							articlesLen: arts.length,
							distinctChildGens: distinctGens.size,
							childGen: distinctGens.size === 1 ? [...distinctGens][0] : null,
							seriesGen: ser?.gen,
						});
					} catch {
						readErrors++;
					}
				}
			}

			await Promise.all([writer(), reader()]);

			const tornSamples = samples.filter((s) => s.distinctChildGens > 1);
			const incompleteSamples = samples.filter((s) => s.articlesLen !== ARTICLES_PER_SERIES);
			const skewSamples = samples.filter((s) => s.distinctChildGens === 1 && s.childGen !== s.seriesGen);

			const msg =
				`R race result: writeIters=${WRITE_ITERATIONS} writeErrors=${state.writeErrors} readErrors=${readErrors} ` +
				`samples=${samples.length} torn(child-level mixed gens)=${tornSamples.length} incomplete(articlesLen!=${ARTICLES_PER_SERIES})=${incompleteSamples.length} ` +
				`parentChildSkew=${skewSamples.length}/${samples.length} (${((skewSamples.length / Math.max(samples.length, 1)) * 100).toFixed(1)}%)`;
			console.log(`[R] ${msg}`);
			if (tornSamples.length) console.log(`[R] first torn sample: ${JSON.stringify(tornSamples[0])}`);
			findings.push(
				msg +
					(tornSamples.length === 0 && incompleteSamples.length === 0
						? ' -> READ-SIDE CONSISTENT'
						: ' -> DEFECT SUSPECTED')
			);
			findings.push(
				`R parent/child skew is EXPECTED (two separate transactions racing) and not itself a defect; only torn/incomplete child-set reads are.`
			);

			strictEqual(
				state.writeErrors,
				0,
				'writer must not encounter ops-API errors (rules out harness/setup error before judging read side)'
			);
			ok(
				samples.length > 20,
				`reader should have gathered a meaningful number of samples during the race (got ${samples.length})`
			);
			strictEqual(
				incompleteSamples.length,
				0,
				'every nested articles[] must have exactly ARTICLES_PER_SERIES entries (no dropped siblings mid-race)'
			);
			strictEqual(
				tornSamples.length,
				0,
				'sibling Article rows returned under one Series in one response must never show mixed generations (atomic write must not be observable as torn on read)'
			);
		});
	}
);
