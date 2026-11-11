/**
 * SQA-179 (PR scenario mode, harper#4191): a rejected credential stays unauthenticated on the
 * operations API, SSE and WebSocket subscribe surfaces, and the failed-auth dedupe resets with
 * server.onInvalidatedUser. Contract: a request whose only credential is not a valid scheme +
 * credential is 401 on every surface; a rejected credential is audited once per cache window.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { consumeSse } from '../utils/sseStream.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/auth-failed-marker-surfaces');
const SEEDED = { id: 'seeded-secret-1', title: 'classified' };
const RECORD_PATH = `/AnyPrincipalSecret/${SEEDED.id}`;

suite(
	'SQA-179 rejected credential on ops API / SSE / WebSocket and after user invalidation',
	(ctx: ContextWithHarper) => {
		let restURL = '';
		let opsURL = '';
		let admin = '';
		let logPath = '';
		let titleSeq = 0;

		async function rest(method: string, path: string, authorization?: string, body?: unknown) {
			const headers: Record<string, string> = { Accept: 'application/json' };
			if (authorization !== undefined) headers.Authorization = authorization;
			if (body !== undefined) headers['Content-Type'] = 'application/json';
			const res = await fetch(new URL(path, restURL), {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			return { status: res.status, text: await res.text() };
		}

		async function ops(authorization: string | undefined, body: unknown) {
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (authorization !== undefined) headers.Authorization = authorization;
			const res = await fetch(opsURL, { method: 'POST', headers, body: JSON.stringify(body) });
			const text = await res.text();
			let json: any;
			try {
				json = JSON.parse(text);
			} catch {
				json = undefined;
			}
			return { status: res.status, text, json };
		}

		async function adminUpdate(): Promise<string> {
			const title = `published-${++titleSeq}`;
			const res = await rest('PUT', RECORD_PATH, admin, { id: SEEDED.id, title });
			ok(res.status >= 200 && res.status < 300, `admin PUT ${res.status} ${res.text}`);
			return title;
		}

		// SSE: status plus whether a write published while the stream is open reaches it
		async function sse(authorization: string) {
			const pending = consumeSse(new URL(RECORD_PATH, restURL).href, { Authorization: authorization }, 2500);
			await sleep(700);
			const title = await adminUpdate();
			const result = await pending;
			return { status: result.status, sawPublished: result.raw.includes(title), raw: result.raw.slice(0, 300) };
		}

		// WebSocket: upgrade outcome plus whether a write published after open reaches it
		async function wsProbe(authorization: string) {
			const url = new URL(RECORD_PATH, restURL).href.replace(/^http/, 'ws');
			const ws = new WebSocket(url, { headers: { Authorization: authorization } });
			const frames: string[] = [];
			ws.on('message', (d: Buffer) => frames.push(d.toString()));
			const outcome = await new Promise<{ opened: boolean; upgradeStatus?: number }>((res) => {
				const timer = setTimeout(() => res({ opened: false }), 5000);
				ws.once('open', () => {
					clearTimeout(timer);
					res({ opened: true });
				});
				ws.once('unexpected-response', (_req, r) => {
					clearTimeout(timer);
					res({ opened: false, upgradeStatus: r.statusCode });
				});
				ws.once('error', () => {
					clearTimeout(timer);
					res({ opened: false });
				});
			});
			let closeCode: number | undefined;
			ws.once('close', (code) => (closeCode = code));
			let title = '';
			if (outcome.opened) {
				await sleep(300);
				title = await adminUpdate();
				await sleep(1200);
			}
			const sawPublished = title !== '' && frames.some((f) => f.includes(title));
			ws.terminate();
			return { ...outcome, sawPublished, closeCode, frames: frames.join(' | ').slice(0, 300) };
		}

		function failureEntries(username: string): number {
			if (!existsSync(logPath)) return 0;
			return readFileSync(logPath, 'utf8')
				.split(/(?=^\d{4}-\d{2}-\d{2}T)/m)
				.filter(
					(e) => e.includes('[auth-event]') && e.includes(`username: '${username}'`) && e.includes("status: 'failure'")
				).length;
		}

		// one worker writes its log in order, so a later marker entry proves earlier entries are on disk
		async function flushAudit(tag: string) {
			const user = `qa179-flush-${tag}`;
			const res = await rest('GET', RECORD_PATH, `Basic ${Buffer.from(`${user}:x`).toString('base64')}`);
			strictEqual(res.status, 401, res.text);
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline && failureEntries(user) < 1) await sleep(50);
			ok(failureEntries(user) >= 1, `flush marker ${user} never reached ${logPath}`);
		}

		// every surface is measured before any assertion, so a red run reports all five
		async function assertBareRejectedEverywhere(bare: string, label: string) {
			const userInfo = await ops(bare, { operation: 'user_info' });
			const readLog = await ops(bare, { operation: 'read_log', limit: 1 });
			const restRead = await rest('GET', RECORD_PATH, bare);
			const s = await sse(bare);
			const w = await wsProbe(bare);
			const seen = JSON.stringify({
				userInfo: [userInfo.status, userInfo.text.slice(0, 160)],
				readLog: [readLog.status, readLog.text.slice(0, 160)],
				rest: [restRead.status, restRead.text.slice(0, 160)],
				sse: s,
				ws: w,
			});
			console.log(`SQA179 ${label}`, seen);
			strictEqual(userInfo.status, 401, `${label} ops user_info: ${seen}`);
			ok(typeof userInfo.json?.username !== 'string', `${label} ops user_info returned a username: ${seen}`);
			strictEqual(readLog.status, 401, `${label} ops read_log: ${seen}`);
			strictEqual(restRead.status, 401, `${label} REST GET: ${seen}`);
			strictEqual(s.status, 401, `${label} SSE: ${seen}`);
			strictEqual(s.sawPublished, false, `${label} SSE received a published row: ${seen}`);
			strictEqual(w.sawPublished, false, `${label} WebSocket received a published row: ${seen}`);
			// WebSocket authorizes after the handshake and rejects with close code 3000 (the cold arm pins that shape)
			strictEqual(w.closeCode, 3000, `${label} WebSocket was not closed as unauthorized: ${seen}`);
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					threads: { count: 1 },
					authentication: { authorizeLocal: false, cacheTTL: 3_600_000 },
					logging: { auditAuthEvents: { logFailed: true } },
				},
			});
			restURL = ctx.harper.httpURL;
			opsURL = ctx.harper.operationsAPIURL;
			admin = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
			logPath = join(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'), 'hdb.log');
			const deadline = Date.now() + 30_000;
			let ready = false;
			while (Date.now() < deadline && !ready) {
				const put = await rest('PUT', RECORD_PATH, admin, SEEDED).catch(() => ({ status: 0 }));
				ready = put.status >= 200 && put.status < 300;
				if (!ready) await sleep(200);
			}
			ok(ready, 'fixture never accepted the admin seed write');
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('positive control: admin passes every surface and receives published rows', async () => {
			const info = await ops(admin, { operation: 'user_info' });
			strictEqual(info.status, 200, info.text);
			strictEqual(info.json?.username, ctx.harper.admin.username);
			strictEqual((await ops(admin, { operation: 'read_log', limit: 1 })).status, 200);
			strictEqual((await rest('GET', RECORD_PATH, admin)).status, 200);
			const s = await sse(admin);
			strictEqual(s.status, 200, JSON.stringify(s));
			strictEqual(s.sawPublished, true, JSON.stringify(s));
			const w = await wsProbe(admin);
			strictEqual(w.opened, true, JSON.stringify(w));
			strictEqual(w.sawPublished, true, JSON.stringify(w));
		});

		test('cold: bare header with no prior rejection is 401 everywhere', async () => {
			await assertBareRejectedEverywhere(Buffer.from('qa179-cold:wrong').toString('base64'), 'cold');
		});

		function failureLines(username: string): string[] {
			if (!existsSync(logPath)) return [];
			return readFileSync(logPath, 'utf8')
				.split(/(?=^\d{4}-\d{2}-\d{2}T)/m)
				.filter(
					(e) => e.includes('[auth-event]') && e.includes(`username: '${username}'`) && e.includes("status: 'failure'")
				)
				.map((e) => e.split('\n')[0].slice(0, 160));
		}

		async function invalidations(): Promise<number> {
			const r = await rest('GET', '/InvalidationProbe/x', admin);
			strictEqual(r.status, 200, r.text);
			return JSON.parse(r.text).invalidations;
		}

		test('arm 1: Basic <X> rejected on ops API and REST, then bare <X> is 401 on ops API, SSE and WebSocket', async () => {
			const x = Buffer.from('qa179-ghost-1:wrong').toString('base64');
			const opsFirst = await ops(`Basic ${x}`, { operation: 'user_info' });
			strictEqual(opsFirst.status, 401, opsFirst.text);
			const restFirst = await rest('GET', RECORD_PATH, `Basic ${x}`);
			strictEqual(restFirst.status, 401, restFirst.text);
			await assertBareRejectedEverywhere(x, 'arm1');
		});

		test('arm 1b (audit, diagnostic): dedupe per port - Basic <X> twice on ops only, twice on REST only', async () => {
			const xo = Buffer.from('qa179-ghost-ops:wrong').toString('base64');
			const xr = Buffer.from('qa179-ghost-rest:wrong').toString('base64');
			for (let i = 0; i < 2; i++) strictEqual((await ops(`Basic ${xo}`, { operation: 'user_info' })).status, 401);
			for (let i = 0; i < 2; i++) strictEqual((await rest('GET', RECORD_PATH, `Basic ${xr}`)).status, 401);
			await flushAudit('arm1b');
			const report = JSON.stringify({
				crossPort: failureLines('qa179-ghost-1'),
				opsOnly: failureLines('qa179-ghost-ops'),
				restOnly: failureLines('qa179-ghost-rest'),
			});
			console.log('SQA179 audit', report);
			strictEqual(failureLines('qa179-ghost-ops').length, 1, `ops-only repeat must be deduplicated: ${report}`);
			strictEqual(failureLines('qa179-ghost-rest').length, 1, `REST-only repeat must be deduplicated: ${report}`);
		});

		test('arm 2: after add_user / alter_user (which do not fire onInvalidatedUser), repeated Basic <X> and bare <X> stay 401', async () => {
			const x = Buffer.from('qa179-ghost-2:wrong').toString('base64');
			strictEqual((await rest('GET', RECORD_PATH, `Basic ${x}`)).status, 401);
			await assertBareRejectedEverywhere(x, 'arm2-before');
			const before = await invalidations();
			const add = await ops(admin, {
				operation: 'add_user',
				role: 'super_user',
				username: 'qa179-invalidator',
				password: 'qa179-pass-1',
				active: true,
			});
			strictEqual(add.status, 200, add.text);
			const alter = await ops(admin, {
				operation: 'alter_user',
				username: 'qa179-invalidator',
				password: 'qa179-pass-2',
			});
			strictEqual(alter.status, 200, alter.text);
			await sleep(500);
			const afterUserOps = await invalidations();
			console.log('SQA179 invalidations', JSON.stringify({ before, afterUserOps }));
			strictEqual((await rest('GET', RECORD_PATH, `Basic ${x}`)).status, 401);
			await assertBareRejectedEverywhere(x, 'arm2-after-user-ops');
			await flushAudit('arm2');
			console.log('SQA179 arm2 audit', JSON.stringify(failureLines('qa179-ghost-2')));
		});

		test('arm 3: server.invalidateUser() fires onInvalidatedUser; repeated Basic <X> is audited again and bare <X> stays 401', async () => {
			const user = 'qa179-ghost-3';
			const x = Buffer.from(`${user}:wrong`).toString('base64');
			strictEqual((await rest('GET', RECORD_PATH, `Basic ${x}`)).status, 401);
			strictEqual((await rest('GET', RECORD_PATH, `Basic ${x}`)).status, 401);
			await flushAudit('arm3-before');
			strictEqual(failureLines(user).length, 1, 'repeat within cacheTTL is deduplicated (control for the reset)');

			const before = await invalidations();
			const fire = await rest('POST', '/InvalidationProbe/', admin, {});
			ok(fire.status >= 200 && fire.status < 300, fire.text);
			strictEqual(await invalidations(), before + 1, 'probe fired onInvalidatedUser on this worker');

			strictEqual((await rest('GET', RECORD_PATH, `Basic ${x}`)).status, 401);
			await assertBareRejectedEverywhere(x, 'arm3-after');
			await flushAudit('arm3-after');
			strictEqual(
				failureLines(user).length,
				2,
				`after onInvalidatedUser the failed-credential dedupe must reset: ${JSON.stringify(failureLines(user))}`
			);
		});
	}
);
