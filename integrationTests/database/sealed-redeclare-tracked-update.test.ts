/**
 * A sealed table keeps refusing undeclared properties on a tracked `Table.update()` instance after a
 * code-first re-declaration, across two HTTP worker threads.
 *
 * Contract (reference/database/schema.md @sealed): a sealed table refuses records with properties beyond
 * those declared. Re-declaring a table without a field retires that field's accessors, so a later
 * assignment is an own property on the tracked instance; commit merges own properties into the validated
 * change set (resources/Table.ts, ownFieldNames). Unit tests cover one process; this covers a handle
 * obtained in worker A, a re-declaration issued in worker B, and the commit in worker A after A's schema
 * converged.
 *
 * One reload for all arms: seven handles are held concurrently in worker A (gate file), worker B
 * re-declares both tables without legacyCode, both workers are polled until legacyCode is gone, then the
 * gate is released. Rejected arms must fail with `unknown_property` and leave the stored row, including
 * `updatedAt`, untouched.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/database/sealed-redeclare-tracked-update.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'sealed-redeclare-tracked-update');
const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';
const ENGINE = process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb';

interface Resp {
	status: number;
	body: any;
	text: string;
}
interface Arm {
	name: string;
	table: 'SealedItem' | 'OpenItem';
	id: string;
	fields: Record<string, unknown>;
	patchLabel?: boolean;
	expect: 'reject' | 'ok';
	/** substring the validation error must mention */
	mentions?: string;
	/** stored label after (rejected arms keep 'seed') */
	label: string;
	legacyCode: number;
}

const HELD: Arm[] = [
	{
		name: 'A1',
		table: 'SealedItem',
		id: 'A1',
		fields: { legacyCode: 99, label: 'A1' },
		expect: 'reject',
		mentions: 'legacyCode',
		label: 'seed',
		legacyCode: 42,
	},
	{
		name: 'A2',
		table: 'SealedItem',
		id: 'A2',
		fields: { legacyCode: 99 },
		expect: 'reject',
		mentions: 'legacyCode',
		label: 'seed',
		legacyCode: 42,
	},
	{
		name: 'A3',
		table: 'SealedItem',
		id: 'A3',
		fields: { neverDeclared: 'x', label: 'A3' },
		expect: 'reject',
		mentions: 'neverDeclared',
		label: 'seed',
		legacyCode: 42,
	},
	{ name: 'A4', table: 'SealedItem', id: 'A4', fields: { label: 'A4' }, expect: 'ok', label: 'A4', legacyCode: 42 },
	{
		name: 'A1p',
		table: 'SealedItem',
		id: 'A1p',
		fields: { legacyCode: 99, label: 'A1p' },
		patchLabel: true,
		expect: 'reject',
		mentions: 'legacyCode',
		label: 'seed',
		legacyCode: 42,
	},
	{
		name: 'A4p',
		table: 'SealedItem',
		id: 'A4p',
		fields: { label: 'A4p' },
		patchLabel: true,
		expect: 'ok',
		label: 'A4p',
		legacyCode: 42,
	},
	{ name: 'D', table: 'OpenItem', id: 'D', fields: { legacyCode: 77 }, expect: 'ok', label: 'seed', legacyCode: 77 },
];
const FRESH: Arm[] = [
	{
		name: 'B1',
		table: 'SealedItem',
		id: 'B1',
		fields: { legacyCode: 99, label: 'B1' },
		expect: 'reject',
		mentions: 'legacyCode',
		label: 'seed',
		legacyCode: 42,
	},
	{
		name: 'B2',
		table: 'SealedItem',
		id: 'B2',
		fields: { legacyCode: 99 },
		expect: 'reject',
		mentions: 'legacyCode',
		label: 'seed',
		legacyCode: 42,
	},
	{
		name: 'B3',
		table: 'SealedItem',
		id: 'B3',
		fields: { neverDeclared: 'x', label: 'B3' },
		expect: 'reject',
		mentions: 'neverDeclared',
		label: 'seed',
		legacyCode: 42,
	},
	{ name: 'B4', table: 'SealedItem', id: 'B4', fields: { label: 'B4' }, expect: 'ok', label: 'B4', legacyCode: 42 },
];
const REST_ROWS = [
	{ table: 'SealedItem' as const, id: 'C1' },
	{ table: 'SealedItem' as const, id: 'C2' },
];
const ALL_ROWS = [...HELD, ...FRESH, ...REST_ROWS.map((r) => ({ ...r, name: r.id }))];
const ATTEMPTED_NUMBERS = [99, 7];
const ATTEMPTED_STRINGS = ['x'];

suite(`sealed re-declaration across two workers [engine=${ENGINE}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let httpURL: string;
	let auth: string;
	let dir: string;
	let threadA: number;
	let threadB: number;

	const heldResp = new Map<string, Resp>();
	const freshResp = new Map<string, Resp & { thread: number }>();
	const evidence: Record<string, any> = {};
	const baseline = new Map<string, any>();
	const reads = new Map<string, { A: any; B: any }>();
	let restC1: Resp;
	let restC2: Resp;

	function request(method: string, path: string, body?: unknown): Promise<Resp> {
		return new Promise((resolveReq, reject) => {
			const payload = body === undefined ? undefined : JSON.stringify(body);
			const req = http.request(
				`${httpURL}${path}`,
				{
					method,
					agent: false, // fresh connection each call so the OS/worker balancer can pick a different worker
					headers: {
						Authorization: auth,
						Connection: 'close',
						...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
					},
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on('data', (c) => chunks.push(c));
					res.on('end', () => {
						const text = Buffer.concat(chunks).toString();
						let parsed: any = text;
						try {
							parsed = JSON.parse(text);
						} catch {
							/* non-JSON body */
						}
						resolveReq({ status: res.statusCode ?? 0, body: parsed, text });
					});
				}
			);
			req.on('error', reject);
			if (payload) req.write(payload);
			req.end();
		});
	}

	const qs = (params: Record<string, string | number>) =>
		Object.entries(params)
			.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
			.join('&');
	const qaGet = (params: Record<string, string | number>) => request('GET', `/Qa/?${qs(params)}`);
	const qaPost = (body: Record<string, unknown>) => request('POST', '/Qa/', body);

	/** Retry on fresh connections until a worker with the wanted thread id serves the request. */
	async function onThread(
		thread: number | 'any',
		send: (t: number | 'any') => Promise<Resp>,
		budgetMs = 60_000
	): Promise<Resp> {
		const deadline = Date.now() + budgetMs;
		for (;;) {
			const r = await send(thread);
			if (!(r.body && r.body.wrongThread)) return r;
			if (Date.now() > deadline) throw new Error(`never reached thread ${thread}`);
			await sleep(10);
		}
	}

	async function discoverThreads() {
		const seen = new Set<number>();
		const deadline = Date.now() + 60_000;
		while (seen.size < 2) {
			if (Date.now() > deadline) throw new Error(`only reached threads ${[...seen]}`);
			const r = await qaGet({ op: 'whoami', thread: 'any' });
			if (r.status === 200 && typeof r.body.threadId === 'number') seen.add(r.body.threadId);
			else await sleep(50);
		}
		[threadA, threadB] = [...seen].sort((a, b) => a - b);
	}

	async function readRow(table: string, id: string, thread: number | 'any') {
		const r = await onThread(thread, (t) => qaGet({ op: 'read', table, id, thread: t }));
		strictEqual(r.status, 200, `read ${table}/${id}: ${r.text}`);
		return r.body.record;
	}

	async function schemaOn(thread: number) {
		const r = await onThread(thread, (t) => qaGet({ op: 'schema', thread: t }));
		strictEqual(r.status, 200, r.text);
		return r.body as { threadId: number; SealedItem: string[]; OpenItem: string[] };
	}

	async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs: number) {
		const deadline = Date.now() + timeoutMs;
		while (!(await cond())) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await sleep(20);
		}
	}

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), 'sealed-redeclare-'));
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: 2 }, logging: { console: true, level: 'error' } },
			env: {},
		});
		httpURL = ctx.harper.httpURL;
		auth = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;

		// Readiness: /Qa/ served (non-404) and /SealedItem/ exported over REST.
		await waitFor(
			'routes ready',
			async () => {
				try {
					const [a, b] = await Promise.all([qaGet({ op: 'whoami', thread: 'any' }), request('GET', '/SealedItem/')]);
					return a.status !== 404 && b.status !== 404;
				} catch {
					return false;
				}
			},
			120_000
		);
		await discoverThreads();
		evidence.threadA = threadA;
		evidence.threadB = threadB;

		// Seed every row (label='seed', legacyCode=42) BEFORE the reload, and snapshot the baseline.
		for (const row of ALL_ROWS) {
			const r = await qaPost({ op: 'seed', table: row.table, id: row.id, thread: 'any' });
			strictEqual(r.status, 200, `seed ${row.id}: ${r.text}`);
		}
		for (const row of ALL_ROWS) baseline.set(row.id, await readRow(row.table, row.id, 'any'));
		const pre = await schemaOn(threadA);
		ok(pre.SealedItem.includes('legacyCode'), `pre-reload A schema has legacyCode: ${pre.SealedItem}`);

		// Hold every handle in worker A, concurrently, across the reload.
		const holdPromises = HELD.map(async (arm) => {
			const r = await onThread(threadA, (t) =>
				qaPost({
					op: 'hold',
					thread: t,
					table: arm.table,
					id: arm.id,
					fields: arm.fields,
					patchLabel: !!arm.patchLabel,
					dir,
					token: arm.name,
				})
			);
			heldResp.set(arm.name, r);
		});
		await waitFor('all handles held', () => HELD.every((arm) => existsSync(join(dir, `held-${arm.name}`))), 60_000);
		evidence.heldMarkers = Object.fromEntries(
			HELD.map((a) => [a.name, Number(readFileSync(join(dir, `held-${a.name}`), 'utf8'))])
		);

		// Reload in worker B.
		const redeclare = await onThread(threadB, (t) => qaPost({ op: 'redeclare', thread: t }));
		strictEqual(redeclare.status, 200, redeclare.text);
		evidence.redeclare = redeclare.body;

		// Converge: both workers must report legacyCode gone before the gate opens.
		const gone = (s: { SealedItem: string[]; OpenItem: string[] }) =>
			!s.SealedItem.includes('legacyCode') && !s.OpenItem.includes('legacyCode');
		const converged: Record<string, any> = {};
		for (const [label, t] of [
			['B', threadB],
			['A', threadA],
		] as const) {
			try {
				await waitFor(
					`worker ${label} schema converged`,
					async () => {
						const s = await schemaOn(t);
						converged[label] = { at: Date.now(), ...s };
						return gone(s);
					},
					30_000
				);
			} catch (e) {
				converged[label] = { ...converged[label], failed: String(e) };
			}
		}
		evidence.converged = converged;
		evidence.releasedAt = Date.now();
		writeFileSync(join(dir, 'gate'), String(evidence.releasedAt));
		await Promise.all(holdPromises);

		// Post-convergence fresh handles (alternating workers).
		for (const [i, arm] of FRESH.entries()) {
			const thread = i % 2 === 0 ? threadA : threadB;
			const r = await onThread(thread, (t) =>
				qaPost({ op: 'fresh', thread: t, table: arm.table, id: arm.id, fields: arm.fields, patchLabel: false })
			);
			freshResp.set(arm.name, { ...r, thread });
		}

		// Ordinary REST PATCH.
		restC1 = await request('PATCH', '/SealedItem/C1', { label: 'C1' });
		restC2 = await request('PATCH', '/SealedItem/C2', { legacyCode: 7 });

		// Read every row back through BOTH workers.
		for (const row of ALL_ROWS) {
			reads.set(row.id, {
				A: await readRow(row.table, row.id, threadA),
				B: await readRow(row.table, row.id, threadB),
			});
		}
	});

	after(async () => {
		await teardownHarper(ctx);
		rmSync(dir, { recursive: true, force: true });
	});

	function assertNoAttempted(rowId: string, resp?: Resp) {
		const r = reads.get(rowId)!;
		for (const [side, rec] of Object.entries(r)) {
			ok(rec, `${rowId} missing on worker ${side}`);
			ok(!('neverDeclared' in rec), `${rowId} worker ${side} stored neverDeclared: ${JSON.stringify(rec)}`);
			for (const [k, v] of Object.entries(rec)) {
				ok(!ATTEMPTED_NUMBERS.includes(v as number), `${rowId} worker ${side} field ${k}=${v}`);
				ok(!ATTEMPTED_STRINGS.includes(v as string), `${rowId} worker ${side} field ${k}=${v}`);
			}
		}
		if (resp) {
			ok(!/\b99\b|\b7\b|'x'|"x"/.test(JSON.stringify(resp.body)), `attempted value echoed in response: ${resp.text}`);
		}
	}

	function assertStored(arm: { id: string; label: string; legacyCode: number }, rejected = false) {
		const r = reads.get(arm.id)!;
		const base = baseline.get(arm.id);
		deepStrictEqual(r.A, r.B, `${arm.id}: workers disagree on the stored row`);
		strictEqual(r.A.label, arm.label, `${arm.id} stored label`);
		strictEqual(r.A.legacyCode, arm.legacyCode, `${arm.id} stored legacyCode`);
		strictEqual(r.A.createdAt, base.createdAt, `${arm.id} createdAt changed`);
		ok(!Number.isNaN(new Date(r.A.createdAt).getTime()), `${arm.id} createdAt valid`);
		ok(!Number.isNaN(new Date(r.A.updatedAt).getTime()), `${arm.id} updatedAt valid`);
		if (rejected) strictEqual(r.A.updatedAt, base.updatedAt, `${arm.id} updatedAt changed on a rejected write`);
		else
			ok(new Date(r.A.updatedAt).getTime() >= new Date(base.updatedAt).getTime(), `${arm.id} updatedAt went backwards`);
	}

	function assertUnknownProperty(name: string, resp: Resp, field: string) {
		strictEqual(resp.body?.detail?.[0]?.code, 'unknown_property', `${name} error code: ${resp.text}`);
		ok(resp.text.includes(field), `${name} error should mention ${field}: ${resp.text}`);
	}

	function assertOutcome(arm: Arm, resp: Resp) {
		if (arm.expect === 'reject') {
			ok(resp.status >= 400 && resp.status < 500, `${arm.name} expected 4xx, got ${resp.status}: ${resp.text}`);
			assertUnknownProperty(arm.name, resp, arm.mentions!);
		} else {
			strictEqual(resp.status, 200, `${arm.name} expected success: ${resp.text}`);
		}
		assertStored(arm, arm.expect === 'reject');
		if (arm.table === 'SealedItem') assertNoAttempted(arm.id, resp);
	}

	test('setup was real: two workers, handles held before the reload, both schemas converged before release', () => {
		ok(threadA !== threadB, 'two distinct worker thread ids');
		for (const arm of HELD) {
			ok(
				evidence.heldMarkers[arm.name] <= evidence.redeclare.startedAt,
				`${arm.name} handle held before reload started`
			);
			strictEqual(heldResp.get(arm.name)!.body.threadId ?? threadA, threadA);
		}
		strictEqual(evidence.redeclare.threadId, threadB, 'reload issued in worker B');
		for (const w of ['A', 'B']) {
			ok(
				!evidence.converged[w].failed,
				`worker ${w} schema did not converge: ${JSON.stringify(evidence.converged[w])}`
			);
			ok(evidence.converged[w].at <= evidence.releasedAt, `worker ${w} converged before release`);
			ok(!evidence.converged[w].SealedItem.includes('legacyCode'));
		}
		strictEqual(evidence.converged.A.threadId, threadA);
		strictEqual(evidence.converged.B.threadId, threadB);
	});

	for (const arm of HELD) {
		test(`${arm.name}: held handle (worker A) across reload on ${arm.table}`, () => {
			if (arm.table === 'OpenItem') {
				const resp = heldResp.get(arm.name)!;
				strictEqual(resp.status, 200, resp.text);
				assertStored(arm);
				return;
			}
			assertOutcome(arm, heldResp.get(arm.name)!);
		});
	}

	for (const [i, arm] of FRESH.entries()) {
		test(`${arm.name}: fresh handle after convergence (worker ${i % 2 === 0 ? 'A' : 'B'})`, () => {
			assertOutcome(arm, freshResp.get(arm.name)!);
		});
	}

	test('C1: REST PATCH label-only succeeds, legacyCode preserved', () => {
		ok(restC1.status >= 200 && restC1.status < 300, `status ${restC1.status}: ${restC1.text}`);
		assertStored({ id: 'C1', label: 'C1', legacyCode: 42 });
		assertNoAttempted('C1');
	});

	test('C2: REST PATCH {legacyCode: 7} is rejected 4xx, row unchanged', () => {
		ok(restC2.status >= 400 && restC2.status < 500, `status ${restC2.status}: ${restC2.text}`);
		assertUnknownProperty('C2', restC2, 'legacyCode');
		assertStored({ id: 'C2', label: 'seed', legacyCode: 42 }, true);
		assertNoAttempted('C2');
	});
});
