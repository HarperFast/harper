// Concurrent DELETE vs write (PATCH/PUT/addTo/recreate) race consistency.
// Key invariant: point-read/scan/index agree after the race.
// Recreate-vs-delete outcome is engine-divergent (observational). Both engines.
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'delete-update-race-consistency');
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';
const ROUNDS = 40;
const WORKERS = 4;
const TAG = `[delete-race:${ENGINE}]`;
const skipSuite = process.platform === 'win32';

suite(
	`delete-update race consistency [${ENGINE}] [threads=${WORKERS}]`,
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let httpURL: string;
		let opsURL: string;
		let auth: string;
		let client: ReturnType<typeof createApiClient>;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: WORKERS } },
				env: {},
			});
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			opsURL = ctx.harper.operationsAPIURL;
			auth = client.headers.Authorization;

			// Readiness poll — wait until /Widget/ is up
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					const probe = await fetch(`${httpURL}/Widget/`, { headers: { Authorization: auth } });
					if (probe.status !== 404) break;
				} catch {
					/* not ready */
				}
				await sleep(250);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		// ------------------------------------------------------------------
		// Helpers
		// ------------------------------------------------------------------

		async function fireRace(key: string, op: string, extra: Record<string, unknown> = {}): Promise<any> {
			const res = await fetch(`${httpURL}/RaceOp/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': auth },
				body: JSON.stringify({ key, op, ...extra }),
			});
			try {
				return await res.json();
			} catch {
				return {};
			}
		}

		/** GET /Widget/K — returns body or null if 404 */
		async function pointRead(key: string): Promise<any | null> {
			const r = await fetch(`${httpURL}/Widget/${encodeURIComponent(key)}`, {
				headers: { Authorization: auth },
			});
			if (r.status === 200) return r.json();
			if (r.status === 404) return null;
			throw new Error(`pointRead ${key}: unexpected status ${r.status}`);
		}

		/** GET /Widget/ — returns array */
		async function scanAll(): Promise<any[]> {
			const r = await fetch(`${httpURL}/Widget/`, { headers: { Authorization: auth } });
			if (r.status === 200) return r.json();
			return [];
		}

		/** SQL COUNT(*) of Widget */
		async function sqlCount(): Promise<number> {
			const r = await fetch(opsURL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': auth },
				body: JSON.stringify({ operation: 'sql', sql: 'SELECT COUNT(*) FROM data.Widget' }),
			});
			const body = await r.json();
			return body?.[0]?.['COUNT(*)'] ?? -1;
		}

		/** search_by_value on category field */
		async function searchByCategory(category: string): Promise<any[]> {
			const r = await fetch(opsURL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': auth },
				body: JSON.stringify({
					operation: 'search_by_value',
					schema: 'data',
					table: 'Widget',
					search_attribute: 'category',
					search_value: category,
					get_attributes: ['*'],
				}),
			});
			if (r.status === 200) return r.json();
			return [];
		}

		/** Hard-delete a key (clean up between rounds) */
		async function hardDelete(key: string): Promise<void> {
			await fetch(`${httpURL}/Widget/${encodeURIComponent(key)}`, {
				method: 'DELETE',
				headers: { Authorization: auth },
			});
		}

		// ------------------------------------------------------------------
		// (a) DELETE vs PATCH
		// ------------------------------------------------------------------
		test(`(a) DELETE vs PATCH: ${ROUNDS} rounds [${ENGINE}]`, async () => {
			let goneFinal = 0;
			let resurFinal = 0; // record present after race (either outcome)
			let crashedRounds = 0;
			const finalStates: string[] = [];

			for (let r = 0; r < ROUNDS; r++) {
				const key = `race-a-${r}-${ENGINE}`;
				const result = await fireRace(key, 'patch', { value: `patched-${r}` });

				if (result.deleteError && result.writeError) {
					crashedRounds++;
				}

				const rec = await pointRead(key);
				const finalState = rec === null ? 'GONE' : `ALIVE:${rec.value}`;
				finalStates.push(finalState);
				if (rec === null) goneFinal++;
				else resurFinal++;

				await hardDelete(key);
			}

			const goneRate = goneFinal / ROUNDS;
			const resurRate = resurFinal / ROUNDS;
			const deterministic = goneFinal === ROUNDS || resurFinal === ROUNDS;

			console.log(
				`${TAG}(a) DELETE-vs-PATCH SUMMARY: gone=${goneFinal}/${ROUNDS} (${(goneRate * 100).toFixed(1)}%) ` +
					`alive(resurrect)=${resurFinal}/${ROUNDS} (${(resurRate * 100).toFixed(1)}%) ` +
					`crashed=${crashedRounds} deterministic=${deterministic} ` +
					`states_sample=${finalStates.slice(0, 10).join(' ')}`
			);

			// No hard assertion on gone/alive (LWW expected to vary); crash is a defect
			strictEqual(crashedRounds, 0, `${TAG}(a) both ops crashed in ${crashedRounds} rounds — unexpected`);
		});

		// ------------------------------------------------------------------
		// (b) DELETE vs PUT
		// ------------------------------------------------------------------
		test(`(b) DELETE vs PUT: ${ROUNDS} rounds [${ENGINE}]`, async () => {
			let goneFinal = 0;
			let resurFinal = 0;
			let crashedRounds = 0;
			const finalStates: string[] = [];

			for (let r = 0; r < ROUNDS; r++) {
				const key = `race-b-${r}-${ENGINE}`;
				const result = await fireRace(key, 'put', { value: `put-${r}` });

				if (result.deleteError && result.writeError) crashedRounds++;

				const rec = await pointRead(key);
				const finalState = rec === null ? 'GONE' : `ALIVE:${rec.value}`;
				finalStates.push(finalState);
				if (rec === null) goneFinal++;
				else resurFinal++;

				await hardDelete(key);
			}

			const goneRate = goneFinal / ROUNDS;
			const resurRate = resurFinal / ROUNDS;
			const deterministic = goneFinal === ROUNDS || resurFinal === ROUNDS;

			console.log(
				`${TAG}(b) DELETE-vs-PUT SUMMARY: gone=${goneFinal}/${ROUNDS} (${(goneRate * 100).toFixed(1)}%) ` +
					`alive(resurrect)=${resurFinal}/${ROUNDS} (${(resurRate * 100).toFixed(1)}%) ` +
					`crashed=${crashedRounds} deterministic=${deterministic} ` +
					`states_sample=${finalStates.slice(0, 10).join(' ')}`
			);

			strictEqual(crashedRounds, 0, `${TAG}(b) both ops crashed in ${crashedRounds} rounds`);
		});

		// ------------------------------------------------------------------
		// (c) Index / scan consistency — THE CRITICAL CHECK
		//
		// After each race (a few rounds of DELETE vs PUT), cross-check:
		//   point-read, scan, COUNT, search_by_value
		// Any divergence is a real defect.
		// ------------------------------------------------------------------
		test(`(c) index/scan consistency after DELETE vs PUT race [${ENGINE}]`, async () => {
			const CONSISTENCY_ROUNDS = 20;
			let inconsistencies = 0;
			const details: string[] = [];

			// Use unique category per round so search_by_value is unambiguous
			for (let r = 0; r < CONSISTENCY_ROUNDS; r++) {
				const key = `race-c-${r}-${ENGINE}`;
				const cat = `cat-c-${r}-${ENGINE}`;

				// Seed with a known category
				await fetch(`${httpURL}/Widget/${encodeURIComponent(key)}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json', 'Authorization': auth },
					body: JSON.stringify({ id: key, value: 'seed', counter: 0, category: cat }),
				});

				// Race: DELETE vs PUT (overwrites category to 'put')
				await fireRace(key, 'put', { value: `put-c-${r}` });
				// Small settle delay — let any async index writes land
				await sleep(50);

				// --- Cross-view consistency check ---
				const rec = await pointRead(key);
				const exists = rec !== null;

				const scanRecs = await scanAll();
				const inScan = scanRecs.some((s: any) => s.id === key);

				const _count = await sqlCount();
				// We'll check by searching for both possible categories
				const sbvPut = await searchByCategory('put');
				const sbvSeed = await searchByCategory(cat);
				const inSbv = sbvPut.some((s: any) => s.id === key) || sbvSeed.some((s: any) => s.id === key);

				// Consistency: point-read, scan, and sbv must all agree on existence
				// (COUNT is global so can't be checked per-key this simply, skip)
				const consistent = exists === inScan && exists === inSbv;
				if (!consistent) {
					inconsistencies++;
					const msg =
						`r=${r} key=${key}: pointRead=${exists} inScan=${inScan} inSbv=${inSbv} ` +
						`rec=${JSON.stringify(rec)} sbvPut=${sbvPut.length} sbvSeed=${sbvSeed.length}`;
					details.push(msg);
					console.log(`${TAG}(c) INCONSISTENCY: ${msg}`);
				} else {
					console.log(`${TAG}(c) r=${r} key=${key}: exists=${exists} inScan=${inScan} inSbv=${inSbv} — CONSISTENT`);
				}

				await hardDelete(key);
			}

			console.log(
				`${TAG}(c) CONSISTENCY SUMMARY: inconsistencies=${inconsistencies}/${CONSISTENCY_ROUNDS} ` +
					`${inconsistencies > 0 ? '>>> INDEX/SCAN INCONSISTENCY DEFECT <<<' : 'ALL CONSISTENT'}`
			);
			if (details.length > 0) {
				console.log(`${TAG}(c) Inconsistency details:\n  ${details.join('\n  ')}`);
			}

			strictEqual(
				inconsistencies,
				0,
				`${TAG}(c) ${inconsistencies}/${CONSISTENCY_ROUNDS} rounds showed point-read / scan / index inconsistency — DEFECT`
			);
		});

		// ------------------------------------------------------------------
		// (d) addTo vs DELETE — counter resurrection?
		// ------------------------------------------------------------------
		test(`(d) addTo vs DELETE: ${ROUNDS} rounds [${ENGINE}]`, async () => {
			let goneFinal = 0;
			let resurFinal = 0;
			let counterAnomalies = 0;
			const details: string[] = [];

			for (let r = 0; r < ROUNDS; r++) {
				const key = `race-d-${r}-${ENGINE}`;
				await fireRace(key, 'addTo', { delta: 5 });

				const rec = await pointRead(key);
				if (rec === null) {
					goneFinal++;
				} else {
					resurFinal++;
					// If resurrected: counter might be 5 (addTo applied to fresh 0) or
					// original seed value. A non-5, non-0 counter after addTo+delete would be anomalous.
					// The seed counter is 0. addTo 5 = 5. Anything else is a potential anomaly.
					if (rec.counter !== 5 && rec.counter !== 0) {
						counterAnomalies++;
						details.push(`r=${r} key=${key} counter=${rec.counter} (expected 0 or 5)`);
					}
				}

				await hardDelete(key);
			}

			console.log(
				`${TAG}(d) addTo-vs-DELETE SUMMARY: gone=${goneFinal}/${ROUNDS} ` +
					`resurrected=${resurFinal}/${ROUNDS} ` +
					`counterAnomalies=${counterAnomalies} ` +
					`${counterAnomalies > 0 ? '>>> COUNTER ANOMALY <<<' : 'counters sane'}`
			);
			if (details.length) console.log(`${TAG}(d) anomalies: ${details.join(' | ')}`);

			strictEqual(counterAnomalies, 0, `${TAG}(d) counter anomalies in ${counterAnomalies} rounds after addTo+DELETE`);
		});

		// ------------------------------------------------------------------
		// (e) DELETE vs DELETE — idempotent or crash?
		// ------------------------------------------------------------------
		test(`(e) DELETE vs DELETE: ${ROUNDS} rounds [${ENGINE}]`, async () => {
			let bothOk = 0;
			let oneOk = 0;
			let crashes = 0;

			for (let r = 0; r < ROUNDS; r++) {
				const key = `race-e-${r}-${ENGINE}`;
				// Seed
				await fetch(`${httpURL}/Widget/${encodeURIComponent(key)}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json', 'Authorization': auth },
					body: JSON.stringify({ id: key, value: 'seed', counter: 0, category: 'seed' }),
				});

				const result = await fireRace(key, 'delete-delete');

				const del1Ok = result.del1 === 'ok';
				const del2Ok = result.del2 === 'ok';

				if (del1Ok && del2Ok) bothOk++;
				else if (del1Ok || del2Ok) oneOk++;
				else crashes++;

				// Final state must be gone
				const rec = await pointRead(key);
				ok(rec === null, `${TAG}(e) r=${r}: key ${key} should be GONE after two DELETEs, got ${JSON.stringify(rec)}`);
			}

			console.log(
				`${TAG}(e) DELETE-vs-DELETE SUMMARY: bothOk=${bothOk}/${ROUNDS} ` +
					`oneOk(idempotent)=${oneOk}/${ROUNDS} ` +
					`crashes=${crashes}/${ROUNDS} ` +
					`${crashes > 0 ? '>>> CRASH on double-delete <<<' : 'no crashes'}`
			);

			strictEqual(crashes, 0, `${TAG}(e) both deletes returned error in ${crashes} rounds`);
		});

		// ------------------------------------------------------------------
		// (f) DELETE racing with immediate CREATE (recreate-after-delete)
		// ------------------------------------------------------------------
		test(`(f) recreate racing with DELETE: ${ROUNDS} rounds [${ENGINE}]`, async () => {
			let goneFinal = 0; // delete won, create swallowed / 409-ed
			let createWon = 0; // create landed, record visible
			let crashedRounds = 0;
			const finalStates: string[] = [];

			for (let r = 0; r < ROUNDS; r++) {
				const key = `race-f-${r}-${ENGINE}`;
				const result = await fireRace(key, 'recreate');

				if (result.deleteError && result.writeError) crashedRounds++;

				const rec = await pointRead(key);
				if (rec === null) {
					goneFinal++;
					finalStates.push('GONE');
				} else {
					createWon++;
					finalStates.push(`ALIVE:${rec.value}:${rec.counter}`);
				}

				await hardDelete(key);
			}

			const deterministic = goneFinal === ROUNDS || createWon === ROUNDS;
			console.log(
				`${TAG}(f) RECREATE-vs-DELETE SUMMARY: gone=${goneFinal}/${ROUNDS} ` +
					`createLanded=${createWon}/${ROUNDS} ` +
					`crashed=${crashedRounds} deterministic=${deterministic} ` +
					`states_sample=${finalStates.slice(0, 10).join(' ')}`
			);

			strictEqual(crashedRounds, 0, `${TAG}(f) both ops crashed in ${crashedRounds} rounds`);
		});

		// ------------------------------------------------------------------
		// (g) Cross-view final sweep — after ALL race rounds, is the Widget table
		//     internally consistent? (No ghost rows in index vs base)
		// ------------------------------------------------------------------
		test(`(g) final cross-view sweep — no ghost index rows [${ENGINE}]`, async () => {
			// Seed a few clean records with known categories
			const CLEAN_KEYS = 5;
			for (let i = 0; i < CLEAN_KEYS; i++) {
				await fetch(`${httpURL}/Widget/clean-${i}-${ENGINE}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json', 'Authorization': auth },
					body: JSON.stringify({ id: `clean-${i}-${ENGINE}`, value: `v${i}`, counter: i, category: 'clean-sweep' }),
				});
			}

			await sleep(200); // let async index writes settle

			const scanRecs = (await scanAll()).filter((s: any) => s.category === 'clean-sweep');
			const sbv = await searchByCategory('clean-sweep');

			const scanIds = new Set(scanRecs.map((s: any) => s.id));
			const sbvIds = new Set(sbv.map((s: any) => s.id));

			const onlyInScan = [...scanIds].filter((id) => !sbvIds.has(id));
			const onlyInSbv = [...sbvIds].filter((id) => !scanIds.has(id));

			console.log(
				`${TAG}(g) SWEEP: scanCount=${scanRecs.length} sbvCount=${sbv.length} ` +
					`onlyInScan=${onlyInScan.length} onlyInSbv=${onlyInSbv.length} ` +
					`${onlyInScan.length === 0 && onlyInSbv.length === 0 ? 'CONSISTENT' : '>>> GHOST INDEX ROWS <<<'}`
			);

			if (onlyInScan.length > 0) console.log(`${TAG}(g) in scan but not sbv: ${onlyInScan.join(', ')}`);
			if (onlyInSbv.length > 0) console.log(`${TAG}(g) in sbv but not scan: ${onlyInSbv.join(', ')}`);

			strictEqual(onlyInScan.length, 0, `${TAG}(g) ${onlyInScan.length} rows in scan but not search_by_value`);
			strictEqual(onlyInSbv.length, 0, `${TAG}(g) ${onlyInSbv.length} rows in search_by_value but not scan`);
		});
	}
);
