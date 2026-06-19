/**
 * sourcedFrom cache WRITE / write-through semantics.
 *
 * Prior waves covered the READ side of a sourcedFrom cache. This probes the WRITE
 * side: when you PUT / PATCH / DELETE a record on a cache table that is sourcedFrom()
 * an external origin, does the write reach the ORIGIN (write-through), only update
 * the local cache (cache-only / silent divergence from the system of record), or error?
 *
 * The in-test origin (Node http.createServer) is the SYSTEM OF RECORD. It owns a Map
 * store and a write log; every GET/PUT/DELETE it receives is recorded with op+id+value,
 * so the test reads back EXACTLY which writes propagated, independent of Harper's HTTP
 * response.
 *
 * Two cache tables share that origin but differ in the SOURCE resource (fixture resources.js):
 *   CacheWT — source defines get() + put() + delete()  => write-through expected
 *   CacheRO — source defines ONLY get()                => write-through impossible
 *
 * Matrix probed (create / update / delete) x (resident / cold) x {write-through, cache-only, rejected},
 * plus read-after-write consistency on the cache. resident = key was read from origin first (cache
 * populated); cold = key was NEVER read from origin before the write.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as http from 'node:http';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'sourcedfrom-write-through');
const ORIGIN_PORT = 39147;
const skipSuite = process.platform === 'win32';

interface WriteLogEntry {
	op: 'PUT' | 'DELETE';
	id: string;
	value?: unknown;
}

interface ResultRow {
	scenario: string;
	table: string;
	op: string;
	state: string;
	httpStatus: number | string;
	originWrites: string; // what the origin actually received for this id
	cacheAfter: string; // what the cache returns after the write
	originAfter: string; // what the origin store holds after the write
	verdict: string;
}

suite('sourcedFrom cache WRITE semantics', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let restURL: string;
	let headers: Record<string, string>;
	let server: http.Server;

	// ---- ORIGIN = system of record: a store + a write log, all in the test process ----
	const store = new Map<string, { id: string; value: unknown }>();
	const writeLog: WriteLogEntry[] = [];
	const getHits = new Map<string, number>();

	const results: ResultRow[] = [];

	function startServer(): Promise<void> {
		return new Promise((r) => server.listen(ORIGIN_PORT, '127.0.0.1', r));
	}
	function stopServer(): Promise<void> {
		return new Promise((r) => server.close(() => r()));
	}
	function writesFor(id: string): WriteLogEntry[] {
		return writeLog.filter((w) => w.id === id);
	}

	/** Raw REST request so we see exact status without supertest throwing. */
	async function rest(
		method: string,
		path: string,
		body?: unknown,
		timeoutMs = 15_000
	): Promise<{ status: number | string; body: string }> {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), timeoutMs);
		try {
			const res = await fetch(restURL + path, {
				method,
				headers: { ...headers, 'content-type': 'application/json' },
				body: body == null ? undefined : JSON.stringify(body),
				signal: ac.signal,
			});
			const text = await res.text();
			return { status: res.status, body: text };
		} catch (e: any) {
			return { status: e?.name === 'AbortError' ? 'CLIENT-ABORT' : `ERR:${e?.message}`, body: '' };
		} finally {
			clearTimeout(t);
		}
	}

	function originSnapshot(id: string): string {
		const v = store.get(id);
		return v ? `value=${JSON.stringify(v.value)}` : 'ABSENT';
	}

	before(async () => {
		server = http.createServer((req, res) => {
			const m = /^\/item\/(.+)$/.exec(req.url ?? '');
			if (!m) {
				res.writeHead(404).end('no');
				return;
			}
			const id = decodeURIComponent(m[1]);
			const chunks: Buffer[] = [];
			req.on('data', (c) => chunks.push(c as Buffer));
			req.on('end', () => {
				const raw = Buffer.concat(chunks).toString('utf8');
				if (req.method === 'GET') {
					getHits.set(id, (getHits.get(id) ?? 0) + 1);
					const rec = store.get(id);
					if (!rec) {
						res.writeHead(404).end('not found');
						return;
					}
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify(rec));
					return;
				}
				if (req.method === 'PUT') {
					let parsed: any = {};
					try {
						parsed = raw ? JSON.parse(raw) : {};
					} catch {
						parsed = { value: raw };
					}
					store.set(id, { id, value: parsed.value });
					writeLog.push({ op: 'PUT', id, value: parsed.value });
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ id, value: parsed.value }));
					return;
				}
				if (req.method === 'DELETE') {
					store.delete(id);
					writeLog.push({ op: 'DELETE', id });
					res.writeHead(204).end();
					return;
				}
				res.writeHead(405).end('method not allowed');
			});
		});
		await startServer();

		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {},
			env: { QA147_ORIGIN_PORT: String(ORIGIN_PORT) },
		});
		client = createApiClient(ctx.harper);
		restURL = client.restURL.replace(/\/$/, '');
		headers = client.headers;

		// readiness poll
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const r = await rest('GET', '/CacheWT/__ready__', undefined, 4_000);
			if (r.status === 200 || r.status === 404) break;
			await sleep(250);
		}
	});

	after(async () => {
		console.log('\n================ sourcedFrom CACHE-WRITE SEMANTICS MATRIX ================');
		console.log(
			'scenario                         | table   | op     | state    | http  | origin-writes-for-id        | cache-after            | origin-after          | verdict'
		);
		console.log(
			'---------------------------------+---------+--------+----------+-------+-----------------------------+------------------------+-----------------------+--------------------'
		);
		for (const r of results) {
			console.log(
				`${r.scenario.padEnd(32)} | ${r.table.padEnd(7)} | ${r.op.padEnd(6)} | ${r.state.padEnd(8)} | ${String(
					r.httpStatus
				).padEnd(
					5
				)} | ${r.originWrites.padEnd(27)} | ${r.cacheAfter.padEnd(22)} | ${r.originAfter.padEnd(21)} | ${r.verdict}`
			);
		}
		console.log('====================================================================\n');
		try {
			await teardownHarper(ctx);
		} finally {
			await stopServer();
		}
	});

	/** Make a key cache-RESIDENT by seeding the origin and doing a cold read so the cache populates. */
	async function makeResident(table: string, id: string, seedValue: string) {
		store.set(id, { id, value: seedValue });
		const r = await rest('GET', `/${table}/${id}`);
		ok(r.status === 200, `expected residency read 200 for ${table}/${id}, got ${r.status}`);
	}

	function verdictFor(opTookEffectAtOrigin: boolean, httpStatus: number | string, expectOriginWrite: boolean): string {
		const http2xx = typeof httpStatus === 'number' && httpStatus >= 200 && httpStatus < 300;
		if (!http2xx) return opTookEffectAtOrigin ? 'REJECTED(but-origin-wrote!)' : 'REJECTED';
		if (opTookEffectAtOrigin) return 'WRITE-THROUGH';
		return expectOriginWrite ? 'SILENT-DIVERGENCE' : 'CACHE-ONLY';
	}

	// ============================================================ CacheWT (write-through source)
	test('WT-1 CREATE cold key (never read): PUT new id -> reaches origin?', async () => {
		const id = 'wt-create-cold';
		writeLog.length = 0;
		const r = await rest('PUT', `/CacheWT/${id}`, { id, value: 'created-cold' });
		await sleep(150);
		const cache = await rest('GET', `/CacheWT/${id}`);
		const w = writesFor(id);
		results.push({
			scenario: 'WT-1 create cold',
			table: 'CacheWT',
			op: 'PUT',
			state: 'cold',
			httpStatus: r.status,
			originWrites: w.map((x) => x.op).join(',') || 'NONE',
			cacheAfter: `${cache.status}:${cache.body.slice(0, 30)}`,
			originAfter: originSnapshot(id),
			verdict: verdictFor(
				w.some((x) => x.op === 'PUT'),
				r.status,
				true
			),
		});
		ok(true);
	});

	test('WT-2 CREATE then READ-AFTER-WRITE consistency', async () => {
		const id = 'wt-raw';
		writeLog.length = 0;
		const w0 = await rest('PUT', `/CacheWT/${id}`, { id, value: 'v-raw' });
		const cache = await rest('GET', `/CacheWT/${id}`);
		let consistent = false;
		try {
			consistent = JSON.parse(cache.body)?.value === 'v-raw';
		} catch {
			/* ignore */
		}
		results.push({
			scenario: 'WT-2 read-after-write',
			table: 'CacheWT',
			op: 'PUT',
			state: 'cold',
			httpStatus: w0.status,
			originWrites:
				writesFor(id)
					.map((x) => x.op)
					.join(',') || 'NONE',
			cacheAfter: `${cache.status}:${cache.body.slice(0, 30)}`,
			originAfter: originSnapshot(id),
			verdict: consistent ? 'RAW-CONSISTENT' : 'RAW-STALE/INCONSISTENT',
		});
		ok(true);
	});

	test('WT-3 UPDATE resident key: PUT over a populated key -> reaches origin?', async () => {
		const id = 'wt-update-resident';
		await makeResident('CacheWT', id, 'origin-seed');
		writeLog.length = 0;
		const r = await rest('PUT', `/CacheWT/${id}`, { id, value: 'updated-resident' });
		await sleep(150);
		const cache = await rest('GET', `/CacheWT/${id}`);
		const w = writesFor(id);
		results.push({
			scenario: 'WT-3 update resident',
			table: 'CacheWT',
			op: 'PUT',
			state: 'resident',
			httpStatus: r.status,
			originWrites: w.map((x) => `${x.op}(${JSON.stringify(x.value)})`).join(',') || 'NONE',
			cacheAfter: `${cache.status}:${cache.body.slice(0, 30)}`,
			originAfter: originSnapshot(id),
			verdict: verdictFor(
				w.some((x) => x.op === 'PUT'),
				r.status,
				true
			),
		});
		ok(true);
	});

	test('WT-4 DELETE resident key -> deletes at origin?', async () => {
		const id = 'wt-delete-resident';
		await makeResident('CacheWT', id, 'to-be-deleted');
		writeLog.length = 0;
		const r = await rest('DELETE', `/CacheWT/${id}`);
		await sleep(150);
		const w = writesFor(id);
		results.push({
			scenario: 'WT-4 delete resident',
			table: 'CacheWT',
			op: 'DELETE',
			state: 'resident',
			httpStatus: r.status,
			originWrites: w.map((x) => x.op).join(',') || 'NONE',
			cacheAfter: 'n/a',
			originAfter: originSnapshot(id),
			verdict: verdictFor(
				w.some((x) => x.op === 'DELETE'),
				r.status,
				true
			),
		});
		ok(true);
	});

	test('WT-5 DELETE cold key (never read) -> deletes at origin?', async () => {
		const id = 'wt-delete-cold';
		store.set(id, { id, value: 'exists-at-origin-only' }); // present at origin, never cached
		writeLog.length = 0;
		const r = await rest('DELETE', `/CacheWT/${id}`);
		await sleep(150);
		const w = writesFor(id);
		results.push({
			scenario: 'WT-5 delete cold',
			table: 'CacheWT',
			op: 'DELETE',
			state: 'cold',
			httpStatus: r.status,
			originWrites: w.map((x) => x.op).join(',') || 'NONE',
			cacheAfter: 'n/a',
			originAfter: originSnapshot(id),
			verdict: verdictFor(
				w.some((x) => x.op === 'DELETE'),
				r.status,
				true
			),
		});
		ok(true);
	});

	// ============================================================ CacheRO (read-only source: no put/delete)
	test('RO-1 CREATE cold key on read-only source -> cache-only, rejected, or SILENT divergence?', async () => {
		const id = 'ro-create-cold';
		writeLog.length = 0;
		const r = await rest('PUT', `/CacheRO/${id}`, { id, value: 'ro-created' });
		await sleep(150);
		const cache = await rest('GET', `/CacheRO/${id}`);
		const w = writesFor(id);
		results.push({
			scenario: 'RO-1 create cold (no source.put)',
			table: 'CacheRO',
			op: 'PUT',
			state: 'cold',
			httpStatus: r.status,
			originWrites: w.map((x) => x.op).join(',') || 'NONE',
			cacheAfter: `${cache.status}:${cache.body.slice(0, 30)}`,
			originAfter: originSnapshot(id),
			verdict: verdictFor(w.length > 0, r.status, true),
		});
		ok(true);
	});

	test('RO-2 UPDATE resident key on read-only source -> silent divergence?', async () => {
		const id = 'ro-update-resident';
		await makeResident('CacheRO', id, 'ro-origin-seed');
		writeLog.length = 0;
		const r = await rest('PUT', `/CacheRO/${id}`, { id, value: 'ro-updated' });
		await sleep(150);
		const cache = await rest('GET', `/CacheRO/${id}`);
		let cacheVal: unknown;
		try {
			cacheVal = JSON.parse(cache.body)?.value;
		} catch {
			/* ignore */
		}
		const w = writesFor(id);
		const cacheShowsNew = cacheVal === 'ro-updated';
		const originStillOld = store.get(id)?.value === 'ro-origin-seed';
		results.push({
			scenario: 'RO-2 update resident (no source.put)',
			table: 'CacheRO',
			op: 'PUT',
			state: 'resident',
			httpStatus: r.status,
			originWrites: w.map((x) => x.op).join(',') || 'NONE',
			cacheAfter: `${cache.status}:val=${JSON.stringify(cacheVal)}`,
			originAfter: originSnapshot(id),
			verdict:
				w.length === 0 && cacheShowsNew && originStillOld
					? 'SILENT-DIVERGENCE'
					: verdictFor(w.length > 0, r.status, true),
		});
		ok(true);
	});

	test('RO-3 DELETE resident key on read-only source -> origin still has it?', async () => {
		const id = 'ro-delete-resident';
		await makeResident('CacheRO', id, 'ro-keep-at-origin');
		writeLog.length = 0;
		const r = await rest('DELETE', `/CacheRO/${id}`);
		await sleep(150);
		const cache = await rest('GET', `/CacheRO/${id}`); // may re-populate from origin
		const w = writesFor(id);
		results.push({
			scenario: 'RO-3 delete resident (no source.delete)',
			table: 'CacheRO',
			op: 'DELETE',
			state: 'resident',
			httpStatus: r.status,
			originWrites: w.map((x) => x.op).join(',') || 'NONE',
			cacheAfter: `${cache.status}:${cache.body.slice(0, 30)}`,
			originAfter: originSnapshot(id),
			verdict:
				w.length === 0 && store.has(id)
					? 'CACHE-ONLY-DELETE(origin-retains)'
					: verdictFor(
							w.some((x) => x.op === 'DELETE'),
							r.status,
							true
						),
		});
		ok(true);
	});

	test('RO-4 PATCH resident key on read-only source -> divergence?', async () => {
		const id = 'ro-patch-resident';
		await makeResident('CacheRO', id, 'ro-patch-seed');
		writeLog.length = 0;
		const r = await rest('PATCH', `/CacheRO/${id}`, { value: 'ro-patched' });
		await sleep(150);
		const cache = await rest('GET', `/CacheRO/${id}`);
		let cacheVal: unknown;
		try {
			cacheVal = JSON.parse(cache.body)?.value;
		} catch {
			/* ignore */
		}
		const w = writesFor(id);
		results.push({
			scenario: 'RO-4 patch resident (no source.patch)',
			table: 'CacheRO',
			op: 'PATCH',
			state: 'resident',
			httpStatus: r.status,
			originWrites: w.map((x) => x.op).join(',') || 'NONE',
			cacheAfter: `${cache.status}:val=${JSON.stringify(cacheVal)}`,
			originAfter: originSnapshot(id),
			verdict:
				w.length === 0 && cacheVal === 'ro-patched' && store.get(id)?.value === 'ro-patch-seed'
					? 'SILENT-DIVERGENCE'
					: verdictFor(w.length > 0, r.status, true),
		});
		ok(true);
	});
});
