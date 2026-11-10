/**
 * HarperFast/harper#4134 (PR #4138): a worker thread forwards an operation that only the main
 * thread registered (here the built-in agent's `get_agent_config`) to the main thread, which
 * applies the operation's permission check to the forwarded user.
 *
 * The operations API, served by the main thread, gives the reference answer for each principal.
 * Two worker surfaces must answer the same, on every worker: the application port's legacy
 * operations route (`hdbCore.request`) and `server.operation(op, { user }, true)` inside a
 * Resource. A role whose `operations` allowlist names one agent operation is honoured per
 * operation across the hop, and errors keep their status and text.
 *
 * Without the forward the worker-surface arms answer 400 "not found"; with the main thread's
 * permission check made inert they answer 200 with the agent config.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/security/main-thread-operation-authz.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { WORKER_COUNT, NO_FULL_WORKER_COVERAGE, assertEveryWorkerStarted } from '../database/recordCachingWorkers.ts';
import { fetchOnNewConnection, observeEveryWorker } from '../utils/connectionPerRequest.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/main-thread-operation-authz');
const REQUEST_TIMEOUT_MS = 10_000;
const PASS = 'MainThreadOp-pw!2026';
const LIMITED = { role: 'main_thread_op_limited_role', username: 'main_thread_op_limited' };
const DELEGATE = { role: 'main_thread_op_delegate_role', username: 'main_thread_op_delegate' };
const GRANTED_OP = 'get_agent_config';
const SIBLING_OP = 'list_agent_sessions';
const UNKNOWN_OP = 'definitely_not_registered_anywhere';

interface Reply {
	status: number;
	json: any;
	text: string;
	thread: number;
}

suite(
	'main-thread-only operations reached from worker threads keep their permission check (#4134)',
	(ctx: ContextWithHarper) => {
		let opsURL = '';
		let appURL = '';
		let adminAuth = '';
		const limitedAuth = `Basic ${Buffer.from(`${LIMITED.username}:${PASS}`).toString('base64')}`;
		const delegateAuth = `Basic ${Buffer.from(`${DELEGATE.username}:${PASS}`).toString('base64')}`;
		let referenceConfig: any;
		let referenceDenial = '';

		// `authorization: null` sends no Authorization header. `undefined` must not be used for that:
		// it would take a default parameter and send the admin credentials.
		async function http(url: string, authorization: string | null, body?: unknown): Promise<Reply> {
			const headers: Record<string, string> = { Accept: 'application/json' };
			if (authorization) headers.Authorization = authorization;
			if (body !== undefined) headers['Content-Type'] = 'application/json';
			const response = await fetchOnNewConnection(url, {
				method: body === undefined ? 'GET' : 'POST',
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const text = await response.text();
			let json: any;
			try {
				json = JSON.parse(text);
			} catch {
				json = undefined;
			}
			const stamp = response.headers.get('x-operation-thread') ?? '';
			ok(!stamp || stamp.endsWith(':worker'), `legacy route answered from ${stamp}`);
			return { status: response.status, json, text, thread: stamp ? Number(stamp.split(':')[0]) : NaN };
		}

		const ops = (body: unknown, authorization: string | null = adminAuth) => http(opsURL, authorization, body);
		const legacy = (body: unknown, authorization: string | null) => http(`${appURL}/ops`, authorization, body);
		const probe = (operation: string, authorization: string | null) =>
			http(`${appURL}/Probe/?op=${operation}`, authorization);

		// Where one worker serves HTTP (Windows, macOS) or connections are not spread (Bun), the same
		// assertions run a bounded number of times without the every-worker claim.
		function onEveryWorker<T>(request: () => Promise<T>, workerIdOf: (reply: T) => number): Promise<T[]> {
			if (NO_FULL_WORKER_COVERAGE) return Promise.all(Array.from({ length: WORKER_COUNT }, request));
			return observeEveryWorker(request, workerIdOf, { workerCount: WORKER_COUNT });
		}
		const legacyThread = (reply: Reply) => reply.thread;
		const probeThread = (reply: Reply) => reply.json.threadId;

		function assertDenied(reply: Reply, context: string): void {
			strictEqual(reply.status, 403, `${context}: ${reply.status} ${reply.text}`);
			strictEqual(reply.json?.error, referenceDenial, `${context}: denial text ${reply.text}`);
			ok(!reply.text.includes('"permission"') && !reply.text.includes('hdb_user'), `${context}: ${reply.text}`);
		}

		function assertProbeDenied(reply: Reply, context: string): void {
			strictEqual(reply.status, 200, `${context}: ${reply.status} ${reply.text}`);
			strictEqual(reply.json.operation.ok, false, `${context}: ${JSON.stringify(reply.json.operation)}`);
			strictEqual(reply.json.operation.statusCode, 403, `${context}: ${JSON.stringify(reply.json.operation)}`);
			strictEqual(reply.json.operation.error, referenceDenial, `${context}: ${JSON.stringify(reply.json.operation)}`);
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					threads: { count: WORKER_COUNT },
					agent: { enabled: true },
					authentication: { authorizeLocal: false },
					logging: { console: true, level: 'error' },
				},
				// The harness passes `--AUTHENTICATION_AUTHORIZELOCAL=true` on the command line; the
				// environment variable is what turns the loopback trust off.
				env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
			});
			opsURL = ctx.harper.operationsAPIURL;
			appURL = ctx.harper.httpURL;
			adminAuth = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;

			const deadline = Date.now() + 120_000;
			for (;;) {
				const r = await http(`${appURL}/WhoAmI/`, adminAuth).catch(() => ({ status: 0 }) as Reply);
				if (r.status === 200) break;
				ok(Date.now() < deadline, `fixture never became ready (last status ${r.status})`);
				await new Promise((resolveWait) => setTimeout(resolveWait, 250));
			}
			if (!NO_FULL_WORKER_COVERAGE) await assertEveryWorkerStarted(ctx);

			for (const [spec, permission] of [
				[LIMITED, { super_user: false }],
				[DELEGATE, { super_user: false, operations: [GRANTED_OP] }],
			] as const) {
				let r = await ops({ operation: 'add_role', role: spec.role, permission });
				strictEqual(r.status, 200, `add_role ${spec.role}: ${r.text}`);
				r = await ops({
					operation: 'add_user',
					role: spec.role,
					username: spec.username,
					password: PASS,
					active: true,
				});
				strictEqual(r.status, 200, `add_user ${spec.username}: ${r.text}`);
			}

			const admin = await ops({ operation: GRANTED_OP });
			strictEqual(admin.status, 200, `admin reference call: ${admin.text}`);
			strictEqual(admin.json?.enabled, true, admin.text);
			referenceConfig = admin.json;
			const limited = await ops({ operation: GRANTED_OP }, limitedAuth);
			strictEqual(limited.status, 403, `limited reference call: ${limited.status} ${limited.text}`);
			ok(typeof limited.json?.error === 'string' && limited.json.error.length > 0, limited.text);
			referenceDenial = limited.json.error;
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('operations API: no credentials is 401, the allowlist role reaches only its operation', async () => {
			const anonymous = await ops({ operation: GRANTED_OP }, null);
			strictEqual(anonymous.status, 401, `anonymous ops call: ${anonymous.status} ${anonymous.text}`);

			const delegate = await ops({ operation: GRANTED_OP }, delegateAuth);
			strictEqual(delegate.status, 200, `delegate ops call: ${delegate.status} ${delegate.text}`);
			deepStrictEqual(delegate.json, referenceConfig);

			const delegateSibling = await ops({ operation: SIBLING_OP }, delegateAuth);
			strictEqual(delegateSibling.status, 403, `delegate sibling: ${delegateSibling.status} ${delegateSibling.text}`);
			const adminSibling = await ops({ operation: SIBLING_OP });
			strictEqual(adminSibling.status, 200, `admin sibling: ${adminSibling.status} ${adminSibling.text}`);
		});

		test('legacy route on a worker answers like the operations API for every principal', async () => {
			const anonymous = await legacy({ operation: GRANTED_OP }, null);
			strictEqual(anonymous.status, 401, `anonymous legacy call: ${anonymous.status} ${anonymous.text}`);

			const admins = await onEveryWorker(async () => {
				const r = await legacy({ operation: GRANTED_OP }, adminAuth);
				strictEqual(r.status, 200, `admin legacy call (worker ${r.thread}): ${r.status} ${r.text}`);
				deepStrictEqual(r.json, referenceConfig, `admin legacy body (worker ${r.thread})`);
				return r;
			}, legacyThread);
			const limiteds = await onEveryWorker(async () => {
				const r = await legacy({ operation: GRANTED_OP }, limitedAuth);
				assertDenied(r, `limited legacy call (worker ${r.thread})`);
				return r;
			}, legacyThread);
			console.log(
				`legacy: admin ${admins.length} × 200 from workers [${[...new Set(admins.map(legacyThread))].sort().join(',')}], ` +
					`limited ${limiteds.length} × 403 from workers [${[...new Set(limiteds.map(legacyThread))].sort().join(',')}]`
			);
		});

		test('server.operation(op, { user }, true) on a worker is checked as that user', async () => {
			// A Resource's custom get() is reached without a principal; the forward then carries none,
			// and the main thread refuses it without running the operation.
			const anonymous = await probe(GRANTED_OP, null);
			strictEqual(anonymous.status, 200, `anonymous probe transport: ${anonymous.status} ${anonymous.text}`);
			strictEqual(anonymous.json.username, null, anonymous.text);
			strictEqual(anonymous.json.operation.ok, false, `anonymous probe: ${JSON.stringify(anonymous.json.operation)}`);
			ok(
				[400, 401].includes(anonymous.json.operation.statusCode),
				`anonymous probe: ${JSON.stringify(anonymous.json.operation)}`
			);
			strictEqual(anonymous.json.operation.result, undefined, `anonymous probe leaked a result: ${anonymous.text}`);

			const admins = await onEveryWorker(async () => {
				const r = await probe(GRANTED_OP, adminAuth);
				strictEqual(r.status, 200, `admin probe: ${r.status} ${r.text}`);
				strictEqual(r.json.isMainThread, false, r.text);
				strictEqual(r.json.username, ctx.harper.admin.username, r.text);
				strictEqual(
					r.json.operation.ok,
					true,
					`admin probe (worker ${r.json.threadId}): ${JSON.stringify(r.json.operation)}`
				);
				deepStrictEqual(r.json.operation.result, referenceConfig, `admin probe body (worker ${r.json.threadId})`);
				return r;
			}, probeThread);
			const limiteds = await onEveryWorker(async () => {
				const r = await probe(GRANTED_OP, limitedAuth);
				strictEqual(r.json.username, LIMITED.username, r.text);
				assertProbeDenied(r, `limited probe (worker ${r.json.threadId})`);
				return r;
			}, probeThread);
			console.log(
				`probe: admin ${admins.length} × ok from workers [${[...new Set(admins.map(probeThread))].sort().join(',')}], ` +
					`limited ${limiteds.length} × 403 from workers [${[...new Set(limiteds.map(probeThread))].sort().join(',')}]`
			);
		});

		test('a role allowlist naming one agent operation is honoured per operation on both worker surfaces', async () => {
			await onEveryWorker(async () => {
				const r = await legacy({ operation: GRANTED_OP }, delegateAuth);
				strictEqual(r.status, 200, `delegate legacy granted (worker ${r.thread}): ${r.status} ${r.text}`);
				deepStrictEqual(r.json, referenceConfig, `delegate legacy body (worker ${r.thread})`);
				return r;
			}, legacyThread);
			await onEveryWorker(async () => {
				const r = await legacy({ operation: SIBLING_OP }, delegateAuth);
				strictEqual(r.status, 403, `delegate legacy sibling (worker ${r.thread}): ${r.status} ${r.text}`);
				return r;
			}, legacyThread);
			await onEveryWorker(async () => {
				const r = await probe(GRANTED_OP, delegateAuth);
				strictEqual(r.status, 200, `delegate probe transport: ${r.status} ${r.text}`);
				strictEqual(r.json.username, DELEGATE.username, r.text);
				strictEqual(
					r.json.operation.ok,
					true,
					`delegate probe (worker ${r.json.threadId}): ${JSON.stringify(r.json.operation)}`
				);
				deepStrictEqual(r.json.operation.result, referenceConfig, `delegate probe body (worker ${r.json.threadId})`);
				return r;
			}, probeThread);
			await onEveryWorker(async () => {
				const r = await probe(SIBLING_OP, delegateAuth);
				assertProbeDenied(r, `delegate probe sibling (worker ${r.json.threadId})`);
				return r;
			}, probeThread);
		});

		test('errors keep their shape across the hop; an unknown operation never leaves the worker', async () => {
			const started = Date.now();
			const unknown = await legacy({ operation: UNKNOWN_OP }, adminAuth);
			const elapsed = Date.now() - started;
			strictEqual(unknown.status, 400, `unknown op: ${unknown.status} ${unknown.text}`);
			ok(/not found/i.test(unknown.json?.error ?? ''), `unknown op error text: ${unknown.text}`);
			ok(elapsed < 5_000, `unknown op took ${elapsed} ms`);

			const prompt = {
				operation: 'agent_prompt',
				message: 'hello',
				session_id: 'main-thread-operation-missing-session',
			};
			const missing = await legacy(prompt, adminAuth);
			strictEqual(missing.status, 404, `missing session: ${missing.status} ${missing.text}`);
			ok(/Unknown session/.test(missing.json?.error ?? ''), `missing session error text: ${missing.text}`);

			const limitedMissing = await legacy(prompt, limitedAuth);
			strictEqual(limitedMissing.status, 403, `limited agent_prompt: ${limitedMissing.status} ${limitedMissing.text}`);
		});
	}
);
