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
 * The narrowings a worker applies to a principal are what the main thread enforces, because they
 * are data on `hdb_user` and survive the structured-clone hop: a scoped token's `operations`
 * allowlist and `super_user: false`, an `impersonate` downgrade applied by the legacy route before
 * dispatch, and a component's own `server.getUser` principal (recordless; the operations API cannot
 * authenticate it, so a worker-local super_user-only operation is its reference). `impersonate` in
 * a `server.operation()` body is inert on a local and a forwarded operation alike; a getUser
 * principal whose privilege sits on a prototype is normalized away at authentication, before any
 * hop; and a principal the hop cannot clone is a 500, never a grant. Impersonation errors answer
 * the same status and text on both surfaces; the measured status is reported next to the
 * documented one.
 *
 * On uWS HTTP a legacy route re-authenticates against hdb_user (#4326), so the getUser legacy-route
 * tests skip there; their server.operation() counterparts run on every transport.
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
const UNSCOPED_OP = 'describe_all';
// A worker-local operation restricted to super_user: the reference for principals the operations
// API (main thread) cannot authenticate — a component's getUser view loads on workers only.
const LOCAL_SU_OP = 'get_configuration';
const INACTIVE_USERNAME = 'main_thread_op_inactive';
const UNKNOWN_USERNAME = 'main_thread_op_nobody';
const OVERRIDE_PASSWORD = 'Override-pw!2026';
const GETUSER_LEGACY_SKIP = process.env.HARPER_UWS_HTTP
	? 'uWS: the legacy route re-authenticates against hdb_user, so a component getUser principal is a 401 (#4326)'
	: false;

const basic = (username: string, password: string) =>
	`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const ovrLimited = basic('ovr-limited', OVERRIDE_PASSWORD);
const ovrSuper = basic('ovr-super', OVERRIDE_PASSWORD);
// `ovr-proto` keeps super_user on a prototype getter: authentication copies own properties only
// (cloneUserView), so the worker's own view is not super before any hop. `ovr-fn` carries an own
// function property: super in the worker's own view, but the forward cannot structured-clone it.
const ovrProto = basic('ovr-proto', OVERRIDE_PASSWORD);
const ovrFn = basic('ovr-fn', OVERRIDE_PASSWORD);
const FORWARD_CLONE_ERROR = /could not be forwarded to another thread/;

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
		const limitedAuth = basic(LIMITED.username, PASS);
		const delegateAuth = basic(DELEGATE.username, PASS);
		let referenceConfig: any;
		let referenceDenial = '';
		let scopedDenyAuth = '';
		let scopedGrantAuth = '';

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
		const probeWith = (query: string, authorization: string | null) => http(`${appURL}/Probe/?${query}`, authorization);

		// Where one worker serves HTTP (Windows, macOS) or connections are not spread (Bun), the same
		// assertions run a bounded number of times without the every-worker claim.
		function onEveryWorker<T>(request: () => Promise<T>, workerIdOf: (reply: T) => number): Promise<T[]> {
			if (NO_FULL_WORKER_COVERAGE) return Promise.all(Array.from({ length: WORKER_COUNT }, request));
			return observeEveryWorker(request, workerIdOf, { workerCount: WORKER_COUNT });
		}
		const legacyThread = (reply: Reply) => reply.thread;
		const probeThread = (reply: Reply) => reply.json.threadId;
		const workers = (replies: Reply[], by: (r: Reply) => number) =>
			`[${[...new Set(replies.map(by))].sort().join(',')}]`;

		function assertDenied(reply: Reply, context: string, denial = referenceDenial): void {
			strictEqual(reply.status, 403, `${context}: ${reply.status} ${reply.text}`);
			strictEqual(reply.json?.error, denial, `${context}: denial text ${reply.text}`);
			ok(!reply.text.includes('"permission"') && !reply.text.includes('hdb_user'), `${context}: ${reply.text}`);
		}

		function assertProbeDenied(reply: Reply, context: string, denial = referenceDenial): void {
			strictEqual(reply.status, 200, `${context}: ${reply.status} ${reply.text}`);
			strictEqual(reply.json.operation.ok, false, `${context}: ${JSON.stringify(reply.json.operation)}`);
			strictEqual(reply.json.operation.statusCode, 403, `${context}: ${JSON.stringify(reply.json.operation)}`);
			strictEqual(reply.json.operation.error, denial, `${context}: ${JSON.stringify(reply.json.operation)}`);
		}

		// A worker-local denial appends the restriction detail to the text a forwarded denial carries.
		function assertProbeLocalDenied(reply: Reply, context: string): void {
			strictEqual(reply.status, 200, `${context}: ${reply.status} ${reply.text}`);
			strictEqual(reply.json?.operation?.statusCode, 403, `${context}: ${JSON.stringify(reply.json?.operation)}`);
			ok(reply.json.operation.error.startsWith(referenceDenial), `${context}: ${JSON.stringify(reply.json.operation)}`);
		}

		function assertProbeGranted(reply: Reply, context: string): void {
			strictEqual(reply.status, 200, `${context}: ${reply.status} ${reply.text}`);
			strictEqual(reply.json.isMainThread, false, `${context}: ${reply.text}`);
			strictEqual(reply.json.operation.ok, true, `${context}: ${JSON.stringify(reply.json.operation)}`);
			deepStrictEqual(reply.json.operation.result, referenceConfig, `${context}: body`);
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					threads: { count: WORKER_COUNT },
					agent: { enabled: true },
					// With the fixture's `rest.webSocket: false`, nothing registers a WebSocket listener on the
					// application port. One would put Bun's port on node:http, where the legacy route is
					// unreachable (#2355); without it Bun serves the port through Bun.serve.
					mqtt: { webSocket: false },
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
			const inactive = await ops({
				operation: 'add_user',
				role: LIMITED.role,
				username: INACTIVE_USERNAME,
				password: PASS,
				active: false,
			});
			strictEqual(inactive.status, 200, `add_user ${INACTIVE_USERNAME}: ${inactive.text}`);

			const admin = await ops({ operation: GRANTED_OP });
			strictEqual(admin.status, 200, `admin reference call: ${admin.text}`);
			strictEqual(admin.json?.enabled, true, admin.text);
			referenceConfig = admin.json;
			const limited = await ops({ operation: GRANTED_OP }, limitedAuth);
			strictEqual(limited.status, 403, `limited reference call: ${limited.status} ${limited.text}`);
			ok(typeof limited.json?.error === 'string' && limited.json.error.length > 0, limited.text);
			referenceDenial = limited.json.error;

			for (const [label, operations] of [
				['deny', [UNSCOPED_OP]],
				['grant', [GRANTED_OP]],
			] as const) {
				const mint = await ops({
					operation: 'create_authentication_tokens',
					username: `main_thread_op_scoped_${label}`,
					role: { permission: { super_user: false, operations } },
				});
				strictEqual(mint.status, 200, `scoped ${label} mint: ${mint.status} ${mint.text}`);
				ok(typeof mint.json?.operation_token === 'string', `scoped ${label} mint body: ${mint.text}`);
				if (label === 'deny') scopedDenyAuth = `Bearer ${mint.json.operation_token}`;
				else scopedGrantAuth = `Bearer ${mint.json.operation_token}`;
			}
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

		test('a scoped token keeps its allowlist across the hop on both worker surfaces', async () => {
			const refDeny = await ops({ operation: GRANTED_OP }, scopedDenyAuth);
			strictEqual(refDeny.status, 403, `scoped deny on ops API: ${refDeny.status} ${refDeny.text}`);
			const scopedDenial = refDeny.json.error;
			ok(typeof scopedDenial === 'string' && scopedDenial.length > 0, refDeny.text);
			const refGrant = await ops({ operation: GRANTED_OP }, scopedGrantAuth);
			strictEqual(refGrant.status, 200, `scoped grant on ops API: ${refGrant.status} ${refGrant.text}`);
			deepStrictEqual(refGrant.json, referenceConfig);
			const refOwnOp = await ops({ operation: UNSCOPED_OP }, scopedDenyAuth);
			strictEqual(refOwnOp.status, 200, `scoped deny token on its own op: ${refOwnOp.status} ${refOwnOp.text}`);

			const denies = await onEveryWorker(async () => {
				const r = await legacy({ operation: GRANTED_OP }, scopedDenyAuth);
				assertDenied(r, `scoped deny legacy (worker ${r.thread})`, scopedDenial);
				return r;
			}, legacyThread);
			const grants = await onEveryWorker(async () => {
				const r = await legacy({ operation: GRANTED_OP }, scopedGrantAuth);
				strictEqual(r.status, 200, `scoped grant legacy (worker ${r.thread}): ${r.status} ${r.text}`);
				deepStrictEqual(r.json, referenceConfig, `scoped grant legacy body (worker ${r.thread})`);
				return r;
			}, legacyThread);
			const probeDenies = await onEveryWorker(async () => {
				const r = await probe(GRANTED_OP, scopedDenyAuth);
				strictEqual(r.json?.scopedToken, true, `probe principal is the scoped token: ${r.text}`);
				assertProbeDenied(r, `scoped deny probe (worker ${r.json.threadId})`, scopedDenial);
				return r;
			}, probeThread);
			const probeGrants = await onEveryWorker(async () => {
				const r = await probe(GRANTED_OP, scopedGrantAuth);
				strictEqual(r.json?.scopedToken, true, `probe principal is the scoped token: ${r.text}`);
				assertProbeGranted(r, `scoped grant probe (worker ${r.json.threadId})`);
				return r;
			}, probeThread);
			console.log(
				`scoped: legacy deny ${denies.length} × 403 ${workers(denies, legacyThread)}, grant ${grants.length} × 200 ${workers(grants, legacyThread)}; ` +
					`probe deny ${probeDenies.length} × 403 ${workers(probeDenies, probeThread)}, grant ${probeGrants.length} × ok ${workers(probeGrants, probeThread)}`
			);
		});

		test('impersonation applied on the legacy route is what the main thread authorizes', async () => {
			const byUsername = { operation: GRANTED_OP, impersonate: { username: LIMITED.username } };
			const byInlineDeny = { operation: GRANTED_OP, impersonate: { role: { permission: { super_user: false } } } };
			const byInlineGrant = {
				operation: GRANTED_OP,
				impersonate: { role: { permission: { super_user: false, operations: [GRANTED_OP] } } },
			};

			assertDenied(await ops(byUsername), 'impersonate username on ops API');
			assertDenied(await ops(byInlineDeny), 'impersonate inline deny on ops API');
			const refInlineGrant = await ops(byInlineGrant);
			strictEqual(
				refInlineGrant.status,
				200,
				`impersonate inline grant on ops API: ${refInlineGrant.status} ${refInlineGrant.text}`
			);
			deepStrictEqual(refInlineGrant.json, referenceConfig);

			// Impersonation errors: docs/reference/security/impersonation.md documents 403 for a caller
			// that is not super_user (:35), 404 for an unknown target and 403 for an inactive one (:59).
			// Both surfaces share authHandler, so they must agree; the measured status is reported next
			// to the documented one rather than assumed.
			const errorArms = [
				['not-super', byUsername, limitedAuth, 403],
				['unknown-target', { operation: GRANTED_OP, impersonate: { username: UNKNOWN_USERNAME } }, adminAuth, 404],
				['inactive-target', { operation: GRANTED_OP, impersonate: { username: INACTIVE_USERNAME } }, adminAuth, 403],
			] as const;
			const measured: Record<string, { status: number; error: string; documented: number }> = {};
			for (const [label, body, authorization, documented] of errorArms) {
				const ref = await ops(body, authorization);
				ok(ref.status >= 400 && ref.status < 500, `${label} on ops API: ${ref.status} ${ref.text}`);
				ok(typeof ref.json?.error === 'string', `${label} on ops API body: ${ref.text}`);
				measured[label] = { status: ref.status, error: ref.json.error, documented };
				// These fail inside the route's authHandler, before the handler stamps the worker id, so
				// the replies carry no thread: repeat on fresh connections a bounded number of times.
				await Promise.all(
					Array.from({ length: WORKER_COUNT * 2 }, async () => {
						const r = await legacy(body, authorization);
						strictEqual(r.status, ref.status, `${label} legacy: ${r.status} ${r.text}`);
						strictEqual(r.json?.error, ref.json.error, `${label} legacy text: ${r.text}`);
					})
				);
			}
			console.log(
				`impersonation errors (ops API = legacy, ${WORKER_COUNT * 2} connections each): ${JSON.stringify(measured)}`
			);

			const users = await onEveryWorker(async () => {
				const r = await legacy(byUsername, adminAuth);
				assertDenied(r, `impersonate username legacy (worker ${r.thread})`);
				return r;
			}, legacyThread);
			const inlineDenies = await onEveryWorker(async () => {
				const r = await legacy(byInlineDeny, adminAuth);
				assertDenied(r, `impersonate inline deny legacy (worker ${r.thread})`);
				return r;
			}, legacyThread);
			const inlineGrants = await onEveryWorker(async () => {
				const r = await legacy(byInlineGrant, adminAuth);
				strictEqual(r.status, 200, `impersonate inline grant legacy (worker ${r.thread}): ${r.status} ${r.text}`);
				deepStrictEqual(r.json, referenceConfig, `impersonate inline grant legacy body (worker ${r.thread})`);
				return r;
			}, legacyThread);
			console.log(
				`impersonate legacy: username ${users.length} × 403 ${workers(users, legacyThread)}, inline deny ${inlineDenies.length} × 403 ${workers(inlineDenies, legacyThread)}, ` +
					`inline grant ${inlineGrants.length} × 200 ${workers(inlineGrants, legacyThread)}`
			);
		});

		test('an impersonate field in a server.operation() body is inert on a local and a forwarded operation', async () => {
			// Impersonation is applied only by the HTTP authHandler; server.operation() never reads the field.
			const local = await probeWith('op=user_info&impersonate=username', adminAuth);
			strictEqual(local.status, 200, `local user_info transport: ${local.status} ${local.text}`);
			strictEqual(local.json.operation.ok, true, `local user_info: ${JSON.stringify(local.json.operation)}`);
			deepStrictEqual(
				local.json.operation.result,
				{ username: ctx.harper.admin.username, superUser: true, impersonated: false },
				`local user_info effective principal: ${JSON.stringify(local.json.operation.result)}`
			);

			const hops = await onEveryWorker(async () => {
				const r = await probeWith(`op=${GRANTED_OP}&impersonate=username`, adminAuth);
				strictEqual(r.json.username, ctx.harper.admin.username, r.text);
				assertProbeGranted(r, `hop with an impersonate field (worker ${r.json.threadId})`);
				return r;
			}, probeThread);
			console.log(
				`server.operation impersonate: ignored locally; hop ${hops.length} × 200 as admin ${workers(hops, probeThread)}`
			);
		});

		// The override authenticates on the worker, and a worker-local super_user-only operation shows the
		// privilege the worker's own view carries. (user_info is no oracle here: it re-reads the role from
		// hdb_role by id, which a recordless role does not have.)
		test(
			'a component getUser principal is authorized on the main thread as the worker built it: legacy route',
			{ skip: GETUSER_LEGACY_SKIP },
			async () => {
				assertDenied(await legacy({ operation: LOCAL_SU_OP }, ovrLimited), `ovr-limited local ${LOCAL_SU_OP}`);
				const localSuper = await legacy({ operation: LOCAL_SU_OP }, ovrSuper);
				strictEqual(localSuper.status, 200, `ovr-super local ${LOCAL_SU_OP}: ${localSuper.status} ${localSuper.text}`);
				ok('threads' in (localSuper.json ?? {}), localSuper.text.slice(0, 200));
				const rejected = await legacy({ operation: LOCAL_SU_OP }, basic('ovr-super', 'nope'));
				strictEqual(rejected.status, 401, `ovr wrong password: ${rejected.status} ${rejected.text}`);

				const limiteds = await onEveryWorker(async () => {
					const r = await legacy({ operation: GRANTED_OP }, ovrLimited);
					assertDenied(r, `ovr-limited legacy (worker ${r.thread})`);
					return r;
				}, legacyThread);
				const supers = await onEveryWorker(async () => {
					const r = await legacy({ operation: GRANTED_OP }, ovrSuper);
					strictEqual(r.status, 200, `ovr-super legacy (worker ${r.thread}): ${r.status} ${r.text}`);
					deepStrictEqual(r.json, referenceConfig, `ovr-super legacy body (worker ${r.thread})`);
					return r;
				}, legacyThread);
				console.log(
					`getUser legacy: limited ${limiteds.length} × 403 ${workers(limiteds, legacyThread)}, super ${supers.length} × 200 ${workers(supers, legacyThread)}`
				);
			}
		);

		test('a component getUser principal is authorized on the main thread as the worker built it: server.operation()', async () => {
			assertProbeLocalDenied(await probe(LOCAL_SU_OP, ovrLimited), `ovr-limited local ${LOCAL_SU_OP} probe`);
			const localSuper = await probe(LOCAL_SU_OP, ovrSuper);
			strictEqual(
				localSuper.json?.operation?.ok,
				true,
				`ovr-super local ${LOCAL_SU_OP} probe: ${localSuper.text.slice(0, 200)}`
			);
			ok('threads' in (localSuper.json.operation.result ?? {}), localSuper.text.slice(0, 200));
			// The component did not load on the main thread, so the operations API cannot authenticate
			// the override user; the worker's local operation above is its reference.
			const opsView = await ops({ operation: LOCAL_SU_OP }, ovrSuper);
			strictEqual(
				opsView.status,
				401,
				`ops API (main) sees ovr-super: ${opsView.status} ${opsView.text.slice(0, 120)}`
			);

			const probeLimiteds = await onEveryWorker(async () => {
				const r = await probe(GRANTED_OP, ovrLimited);
				strictEqual(r.json?.username, 'ovr-limited', r.text);
				assertProbeDenied(r, `ovr-limited probe (worker ${r.json.threadId})`);
				return r;
			}, probeThread);
			const probeSupers = await onEveryWorker(async () => {
				const r = await probe(GRANTED_OP, ovrSuper);
				strictEqual(r.json?.username, 'ovr-super', r.text);
				assertProbeGranted(r, `ovr-super probe (worker ${r.json.threadId})`);
				return r;
			}, probeThread);
			console.log(
				`getUser probe: limited ${probeLimiteds.length} × 403 ${workers(probeLimiteds, probeThread)}, super ${probeSupers.length} × ok ${workers(probeSupers, probeThread)}`
			);
		});

		test(
			'a getUser principal is normalized at authentication; one the hop cannot clone is a 500, never a grant: legacy route',
			{ skip: GETUSER_LEGACY_SKIP },
			async () => {
				assertDenied(await legacy({ operation: LOCAL_SU_OP }, ovrProto), `ovr-proto local ${LOCAL_SU_OP}`);
				assertDenied(await legacy({ operation: GRANTED_OP }, ovrProto), 'ovr-proto hop');

				const local = await legacy({ operation: LOCAL_SU_OP }, ovrFn);
				strictEqual(local.status, 200, `ovr-fn local ${LOCAL_SU_OP}: ${local.status} ${local.text}`);
				const hop = await legacy({ operation: GRANTED_OP }, ovrFn);
				strictEqual(hop.status, 500, `ovr-fn hop: ${hop.status} ${hop.text}`);
				ok(FORWARD_CLONE_ERROR.test(hop.json?.error ?? ''), `ovr-fn hop text: ${hop.text}`);
				ok(!hop.text.includes('"permission"') && !hop.text.includes('hdb_user'), `ovr-fn hop body: ${hop.text}`);
			}
		);

		test('a getUser principal is normalized at authentication; one the hop cannot clone is a 500, never a grant: server.operation()', async () => {
			assertProbeLocalDenied(await probe(LOCAL_SU_OP, ovrProto), `ovr-proto local ${LOCAL_SU_OP} probe`);
			assertProbeDenied(await probe(GRANTED_OP, ovrProto), 'ovr-proto probe');

			const local = await probe(LOCAL_SU_OP, ovrFn);
			strictEqual(local.json?.operation?.ok, true, `ovr-fn local ${LOCAL_SU_OP} probe: ${local.text.slice(0, 200)}`);
			const hopProbe = await probe(GRANTED_OP, ovrFn);
			strictEqual(hopProbe.status, 200, `ovr-fn probe transport: ${hopProbe.status} ${hopProbe.text}`);
			strictEqual(hopProbe.json.operation.ok, false, `ovr-fn probe: ${JSON.stringify(hopProbe.json.operation)}`);
			strictEqual(hopProbe.json.operation.statusCode, 500, `ovr-fn probe: ${JSON.stringify(hopProbe.json.operation)}`);
			ok(FORWARD_CLONE_ERROR.test(hopProbe.json.operation.error ?? ''), `ovr-fn probe text: ${hopProbe.text}`);
			strictEqual(hopProbe.json.operation.result, undefined, `ovr-fn probe leaked a result: ${hopProbe.text}`);
		});
	}
);
