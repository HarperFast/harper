/**
 * SQA-181 (security lane) — a component operation registered ONLY on the main thread
 * (`startOnMainThread`, `server.registerOperation`) under each `requiresSuperUser` declaration
 * shape, reached from a worker through the worker -> main operation forward (HarperFast/harper#4134,
 * PR #4138).
 *
 * `server.registerOperation` declares authorization tri-state (server/serverHelpers/serverUtilities.ts
 * OperationDefinition): `true` = super_user unless a role's `operations` allowlist names it;
 * `false` = grantable AND open to any authenticated user with a valid role; omitted = no central
 * permission entry. The main thread announces each name with its grantability, and a worker mirrors
 * the grantable names into the registry `add_role` / `alter_role` validate against
 * (registeredOperations.ts `recordMainThreadOperation`, operationPermissions.ts `workerRegisteredOps`).
 *
 * Contract asserted here, per declaration shape and principal:
 *   R — the operations API (main thread, no hop) answers from `verifyPerms` as the reference:
 *       super_user 200 on all three; a plain role: su 403 (restricted to super_user), open 200,
 *       bare 400 (no permission entry: fails closed); a role listing su+open: 200, 200, bare refused;
 *       a role listing neither: 403 "not permitted for this role's operations configuration".
 *   L — the legacy operations route on every worker (`hdbCore.request`) answers status and body
 *       identical to R for every (principal, op) pair.
 *   P — `server.operation(op, { user }, true)` inside a Resource on every worker answers like R.
 *   B — `server.operation(op, { user }, false)` from a worker crosses the hop with the bypass: a plain
 *       role runs su and bare, and the main thread sees that user as `hdb_user`.
 *   A — `add_role` accepts `sqa181_su` and `sqa181_open` and rejects `sqa181_bare` in an `operations`
 *       allowlist, on the operations API (main) AND on the legacy route (every worker's mirror).
 *
 * Run (from the harper worktree):
 *   npm run test:integration -- "integrationTests/security/main-thread-operation-tristate.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { WORKER_COUNT, NO_FULL_WORKER_COVERAGE, assertEveryWorkerStarted } from '../database/recordCachingWorkers.ts';
import { fetchOnNewConnection, observeEveryWorker } from '../utils/connectionPerRequest.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/main-thread-operation-tristate');
// `@/` resolves against the harper package root (componentLoader.ts importTrustedPlugin).
const MAIN_MODULE = '@/integrationTests/security/fixtures/main-thread-operation-tristate/main.js';
const REQUEST_TIMEOUT_MS = 10_000;
const PASS = 'Tristate-pw!2026';
const OPS = { su: 'sqa181_su', open: 'sqa181_open', bare: 'sqa181_bare' } as const;
type OpKey = keyof typeof OPS;
const PRINCIPALS = {
	plain: { role: 'sqa181_plain_role', username: 'sqa181_plain', permission: { super_user: false } },
	listed: {
		role: 'sqa181_listed_role',
		username: 'sqa181_listed',
		permission: { super_user: false, operations: [OPS.su, OPS.open, 'user_info'] },
	},
	unlisted: {
		role: 'sqa181_unlisted_role',
		username: 'sqa181_unlisted',
		permission: { super_user: false, operations: ['user_info'] },
	},
} as const;
type PrincipalKey = keyof typeof PRINCIPALS | 'admin';
const PRINCIPAL_KEYS: PrincipalKey[] = ['admin', 'plain', 'listed', 'unlisted'];
const OP_KEYS: OpKey[] = ['su', 'open', 'bare'];

interface Reply {
	status: number;
	json: any;
	text: string;
	thread: number;
}
interface Reference {
	status: number;
	error: string | undefined;
	// The operations API carries the specific denial in `unauthorized_access[0]`.
	detail: string | undefined;
	shape: string | undefined;
	username: string | null | undefined;
	mainThread: boolean | undefined;
}

const basic = (username: string, password: string) =>
	`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

suite(
	'SQA-181: main-only operations under each requiresSuperUser shape across the worker -> main forward',
	(ctx: ContextWithHarper) => {
		let opsURL = '';
		let appURL = '';
		const auth: Record<PrincipalKey, string> = { admin: '', plain: '', listed: '', unlisted: '' };
		const reference = {} as Record<PrincipalKey, Record<OpKey, Reference>>;

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
		const ops = (body: unknown, authorization: string | null = auth.admin) => http(opsURL, authorization, body);
		const legacy = (body: unknown, authorization: string | null) => http(`${appURL}/ops`, authorization, body);
		const probe = (query: string, authorization: string | null) => http(`${appURL}/Probe/?${query}`, authorization);

		function onEveryWorker<T>(request: () => Promise<T>, workerIdOf: (reply: T) => number): Promise<T[]> {
			if (NO_FULL_WORKER_COVERAGE) return Promise.all(Array.from({ length: WORKER_COUNT }, request));
			return observeEveryWorker(request, workerIdOf, { workerCount: WORKER_COUNT });
		}
		const legacyThread = (reply: Reply) => reply.thread;
		const probeThread = (reply: Reply) => reply.json.threadId;
		const workers = (replies: Reply[], by: (r: Reply) => number) =>
			`[${[...new Set(replies.map(by))].sort().join(',')}]`;

		function toReference(reply: Reply): Reference {
			return {
				status: reply.status,
				error: reply.json?.error,
				detail: reply.json?.unauthorized_access?.[0],
				shape: reply.json?.shape,
				username: reply.json?.username,
				mainThread: reply.json?.isMainThread,
			};
		}
		function assertLikeReference(reply: Reply, principal: PrincipalKey, op: OpKey, context: string): void {
			const expected = reference[principal][op];
			const actual = toReference(reply);
			deepStrictEqual(actual, expected, `${context} ${principal}/${OPS[op]}: ${reply.status} ${reply.text}`);
			if (expected.status !== 200) {
				ok(!reply.text.includes('"permission"') && !reply.text.includes('hdb_user'), `${context}: ${reply.text}`);
			}
		}
		function assertProbeLikeReference(reply: Reply, principal: PrincipalKey, op: OpKey, context: string): void {
			const expected = reference[principal][op];
			strictEqual(reply.status, 200, `${context}: ${reply.status} ${reply.text}`);
			strictEqual(reply.json.isMainThread, false, `${context}: ${reply.text}`);
			const outcome = reply.json.operation;
			if (expected.status === 200) {
				strictEqual(outcome.ok, true, `${context} ${principal}/${OPS[op]}: ${JSON.stringify(outcome)}`);
				strictEqual(outcome.result.shape, expected.shape, `${context}: ${JSON.stringify(outcome)}`);
				strictEqual(
					outcome.result.isMainThread,
					true,
					`${context}: ran off the main thread ${JSON.stringify(outcome)}`
				);
				strictEqual(outcome.result.username, expected.username, `${context}: ${JSON.stringify(outcome)}`);
			} else {
				strictEqual(outcome.ok, false, `${context} ${principal}/${OPS[op]}: ${JSON.stringify(outcome)}`);
				strictEqual(outcome.statusCode, expected.status, `${context}: ${JSON.stringify(outcome)}`);
				strictEqual(outcome.error, expected.error, `${context}: ${JSON.stringify(outcome)}`);
				strictEqual(outcome.body?.unauthorized_access?.[0], expected.detail, `${context}: ${JSON.stringify(outcome)}`);
			}
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					threads: { count: WORKER_COUNT },
					// With the fixture's `rest.webSocket: false`, nothing registers a WebSocket listener on the
					// application port. One would put Bun's port on node:http, where the legacy route is
					// unreachable (#2355); without it Bun serves the port through Bun.serve.
					mqtt: { webSocket: false },
					authentication: { authorizeLocal: false },
					logging: { console: true, level: 'error' },
				},
				// The harness passes `--AUTHENTICATION_AUTHORIZELOCAL=true` on the command line; the
				// environment variable is what turns the loopback trust off.
				env: { AUTHENTICATION_AUTHORIZELOCAL: 'false', HARPER_BUILTIN_COMPONENTS: `sqa181Ops=${MAIN_MODULE}` },
			});
			opsURL = ctx.harper.operationsAPIURL;
			appURL = ctx.harper.httpURL;
			auth.admin = basic(ctx.harper.admin.username, ctx.harper.admin.password);

			const deadline = Date.now() + 120_000;
			for (;;) {
				const r = await http(`${appURL}/WhoAmI/`, auth.admin).catch(() => ({ status: 0 }) as Reply);
				if (r.status === 200) break;
				ok(Date.now() < deadline, `fixture never became ready (last status ${r.status})`);
				await new Promise((resolveWait) => setTimeout(resolveWait, 250));
			}
			if (!NO_FULL_WORKER_COVERAGE) await assertEveryWorkerStarted(ctx);

			const anonymous = await ops({ operation: 'user_info' }, null);
			strictEqual(anonymous.status, 401, `authorizeLocal must be off: ${anonymous.status} ${anonymous.text}`);

			for (const key of ['plain', 'listed', 'unlisted'] as const) {
				const spec = PRINCIPALS[key];
				let r = await ops({ operation: 'add_role', role: spec.role, permission: spec.permission });
				strictEqual(r.status, 200, `add_role ${spec.role}: ${r.text}`);
				r = await ops({
					operation: 'add_user',
					role: spec.role,
					username: spec.username,
					password: PASS,
					active: true,
				});
				strictEqual(r.status, 200, `add_user ${spec.username}: ${r.text}`);
				auth[key] = basic(spec.username, PASS);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('R: the operations API answers each declaration shape per principal as verifyPerms specifies', async () => {
			const replies = {} as Record<PrincipalKey, Record<OpKey, Reply>>;
			for (const principal of PRINCIPAL_KEYS) {
				reference[principal] = {} as Record<OpKey, Reference>;
				replies[principal] = {} as Record<OpKey, Reply>;
				for (const op of OP_KEYS) {
					const r = await ops({ operation: OPS[op] }, auth[principal]);
					reference[principal][op] = toReference(r);
					replies[principal][op] = r;
				}
			}
			console.log(`SQA-181 R reference: ${JSON.stringify(reference)}`);
			for (const principal of PRINCIPAL_KEYS) {
				for (const op of OP_KEYS) {
					const r = replies[principal][op];
					const specific = r.json?.unauthorized_access?.[0] ?? r.json?.error ?? '';
					const context = `ops API ${principal}/${OPS[op]}: ${r.status} ${r.text}`;
					if (
						principal === 'admin' ||
						(principal === 'plain' && op === 'open') ||
						(principal === 'listed' && op !== 'bare')
					) {
						strictEqual(r.status, 200, context);
						strictEqual(r.json.shape, op, context);
						strictEqual(r.json.isMainThread, true, context);
						strictEqual(
							r.json.username,
							principal === 'admin' ? ctx.harper.admin.username : PRINCIPALS[principal].username,
							context
						);
					} else if (principal === 'plain' && op === 'su') {
						strictEqual(r.status, 403, context);
						strictEqual(specific, `Operation '${OPS.su}' is restricted to 'super_user' roles`, context);
					} else if (principal === 'plain' && op === 'bare') {
						// No permission entry: hasPermissions fails closed with OP_NOT_FOUND, keyed by the handler.
						strictEqual(r.status, 400, context);
						ok(/not found/.test(specific), context);
					} else {
						strictEqual(r.status, 403, context);
						ok(specific.endsWith("is not permitted for this role's operations configuration"), context);
					}
				}
			}
		});

		test('L: the legacy route on every worker answers identically to the operations API', async () => {
			for (const principal of PRINCIPAL_KEYS) {
				for (const op of OP_KEYS) {
					const replies = await onEveryWorker(() => legacy({ operation: OPS[op] }, auth[principal]), legacyThread);
					for (const r of replies) assertLikeReference(r, principal, op, 'legacy');
					console.log(
						`SQA-181 L ${principal}/${OPS[op]}: ${replies.length}x${replies[0].status} workers ${workers(replies, legacyThread)}`
					);
				}
			}
		});

		test('P: server.operation(op, { user }, true) on every worker answers identically to the operations API', async () => {
			for (const principal of PRINCIPAL_KEYS) {
				for (const op of OP_KEYS) {
					const replies = await onEveryWorker(
						() => probe(`op=${OPS[op]}&authorize=true`, auth[principal]),
						probeThread
					);
					for (const r of replies) assertProbeLikeReference(r, principal, op, 'probe');
					console.log(
						`SQA-181 P ${principal}/${OPS[op]}: ${replies.length}x ok=${replies[0].json.operation.ok} workers ${workers(replies, probeThread)}`
					);
				}
			}
		});

		test('B: server.operation(op, { user }, false) carries the bypass across the hop for a plain role', async () => {
			for (const op of OP_KEYS) {
				const replies = await onEveryWorker(() => probe(`op=${OPS[op]}&authorize=false`, auth.plain), probeThread);
				for (const r of replies) {
					const context = `bypass plain/${OPS[op]}: ${r.text}`;
					strictEqual(r.status, 200, context);
					strictEqual(r.json.operation.ok, true, context);
					strictEqual(r.json.operation.result.shape, op, context);
					strictEqual(r.json.operation.result.isMainThread, true, context);
					strictEqual(r.json.operation.result.username, PRINCIPALS.plain.username, context);
				}
				console.log(`SQA-181 B plain/${OPS[op]}: ${replies.length}x ok workers ${workers(replies, probeThread)}`);
			}
			// Positive control for the bypass flag itself: the same principal with authorize=true is refused.
			const checked = await probe(`op=${OPS.su}&authorize=true`, auth.plain);
			strictEqual(checked.json.operation.ok, false, `authorize=true control: ${checked.text}`);
			strictEqual(checked.json.operation.statusCode, 403, `authorize=true control: ${checked.text}`);
		});

		test('A: add_role grants su and open and refuses bare, on the main thread and on every worker mirror', async () => {
			const roleName = (op: OpKey, where: string) => `sqa181_grant_${op}_${where}`;
			async function dropRoles(prefix: string, atLeast: number): Promise<void> {
				const list = await ops({ operation: 'list_roles' });
				strictEqual(list.status, 200, `list_roles: ${list.text}`);
				const rows = list.json.filter((entry: any) => typeof entry.role === 'string' && entry.role.startsWith(prefix));
				ok(rows.length >= atLeast, `${rows.length} roles listed under ${prefix}, expected at least ${atLeast}`);
				for (const row of rows) {
					const drop = await ops({ operation: 'drop_role', id: row.id });
					strictEqual(drop.status, 200, `drop_role ${row.role} (${row.id}): ${drop.text}`);
				}
			}
			const grant = (op: OpKey, where: string) => ({
				operation: 'add_role',
				role: roleName(op, where),
				permission: { super_user: false, operations: [OPS[op]] },
			});
			// Main thread: the registering thread's own registry.
			for (const op of OP_KEYS) {
				const r = await ops(grant(op, 'main'));
				const context = `add_role main ${OPS[op]}: ${r.status} ${r.text}`;
				if (op === 'bare') {
					strictEqual(r.status, 400, context);
					ok(r.text.includes(OPS.bare), context);
				} else {
					strictEqual(r.status, 200, context);
					await dropRoles(roleName(op, 'main'), 1);
				}
			}
			// Every worker: the mirrored registry, exercised through the legacy route (add_role is a
			// built-in, so it runs on the worker that received it, not on main).
			for (const op of OP_KEYS) {
				let attempt = 0;
				const replies = await onEveryWorker(() => legacy(grant(op, `w${attempt++}`), auth.admin), legacyThread);
				for (const r of replies) {
					const context = `add_role worker ${r.thread} ${OPS[op]}: ${r.status} ${r.text}`;
					if (op === 'bare') {
						strictEqual(r.status, 400, context);
						ok(r.text.includes(OPS.bare), context);
					} else {
						strictEqual(r.status, 200, context);
					}
				}
				console.log(
					`SQA-181 A ${OPS[op]}: ${replies.length}x${replies[0].status} workers ${workers(replies, legacyThread)}`
				);
				if (op !== 'bare') await dropRoles(roleName(op, 'w'), replies.length);
			}
			// Control for the mirror: a name nothing registered is refused the same way everywhere.
			const never = await legacy(
				{ operation: 'add_role', role: 'sqa181_never', permission: { operations: ['sqa181_never_declared'] } },
				auth.admin
			);
			strictEqual(never.status, 400, `never-declared control: ${never.status} ${never.text}`);
		});
	}
);
