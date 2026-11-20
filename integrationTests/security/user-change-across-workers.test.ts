/**
 * A user or role change holds on every HTTP worker once the operation that made it returns, though no
 * worker is told about it: authentication reads hdb_user/hdb_role through the record cache and checks
 * each cached credential against those records' versions (security/user.ts). Every worker's
 * authorization cache is primed first, so a worker serving a stale cached principal fails the suite.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { Client } from 'undici';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
import { WORKER_COUNT, NO_FULL_WORKER_COVERAGE, assertEveryWorkerStarted } from '../database/recordCachingWorkers.ts';
import { fetchOnNewConnection, observeEveryWorker } from '../utils/connectionPerRequest.ts';
import { waitFor } from '../../unitTests/waitFor.js';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures', 'user-change-across-workers');
const ROLE = 'ucaw_role';
const USERNAME = 'ucaw_user';
const DROP_ROLE = 'ucaw_drop_role';
const DROP_ITERATIONS = 10;

type WhoAmI = { threadId: number; username: string | null; superUser: boolean };
type Credential = Record<string, string>;
type Probe = readonly [label: string, credential: Credential];
type PinnedConnection = { threadId: number; connection: Client; connects: number; probe: Probe };

suite(
	'user and role changes hold on every worker at acknowledgement',
	{ skip: NO_FULL_WORKER_COVERAGE },
	(ctx: ContextWithHarper) => {
		let client: any;
		let httpURL: string;
		let origin: string;
		let password = 'ucaw-password-1';

		const basic = (secret: string, username = USERNAME): Credential => ({
			Authorization: 'Basic ' + Buffer.from(`${username}:${secret}`).toString('base64'),
		});

		async function whoAmI(credential: Credential): Promise<{ status: number; body?: WhoAmI }> {
			const response = await fetchOnNewConnection(`${httpURL}/WhoAmI/`, { headers: credential });
			if (response.status !== 200) {
				await response.text().catch(() => undefined);
				return { status: response.status };
			}
			return { status: 200, body: (await response.json()) as WhoAmI };
		}

		function onEveryWorker(credential: Credential, username = USERNAME): Promise<WhoAmI[]> {
			return observeEveryWorker(
				async () => {
					const { status, body } = await whoAmI(credential);
					strictEqual(status, 200, `expected ${username} to authenticate`);
					strictEqual(body!.username, username);
					return body!;
				},
				(body) => body.threadId,
				{ workerCount: WORKER_COUNT }
			);
		}

		async function rejectedEverywhere(credential: Credential, label = 'the credential'): Promise<void> {
			const responses = await Promise.all(Array.from({ length: WORKER_COUNT * 8 }, () => whoAmI(credential)));
			for (const { status, body } of responses) {
				strictEqual(status, 401, `worker ${body?.threadId} still accepted ${label}`);
			}
		}

		async function operationToken(username: string, secret: string): Promise<Credential> {
			const { body } = await client
				.req()
				.send({ operation: 'create_authentication_tokens', username, password: secret, expires_in: '10m' })
				.expect(200);
			ok(body.operation_token, 'expected an operation token');
			return { Authorization: `Bearer ${body.operation_token}` };
		}

		async function sessionCookie(username: string, secret: string): Promise<Credential> {
			const response = await client
				.reqAs({ 'Content-Type': 'application/json', 'Origin': origin })
				.send({ operation: 'login', username, password: secret })
				.expect(200);
			const cookie = (response.headers['set-cookie'] as string[] | undefined)
				?.map((value) => value.split(';')[0])
				.find((value) => value.includes('-hdb-session='));
			ok(cookie, 'expected a session cookie');
			const credential = { Cookie: cookie, Origin: origin };
			// login acknowledges before its session write commits
			await waitFor(async () => (await whoAmI(credential)).body?.username === username, {
				timeout: 10_000,
				message: `the session for ${username} never authenticated`,
			});
			return credential;
		}

		async function ask(connection: Client, credential: Credential): Promise<{ status: number; body?: WhoAmI }> {
			const response = await connection.request({ path: '/WhoAmI/', method: 'GET', headers: credential });
			const text = await response.body.text();
			return { status: response.statusCode, body: response.statusCode === 200 ? JSON.parse(text) : undefined };
		}

		/**
		 * A rejection names no worker. SO_REUSEPORT picks the worker per connection, so the kept user's
		 * answer on a keep-alive connection names the worker for the probe sent on it afterwards.
		 * `pinned` is filled as connections open, so a failure part-way leaves them for the caller to close.
		 */
		async function pinEveryWorker(kept: Credential, probe: Probe, pinned: PinnedConnection[]): Promise<void> {
			const reached = new Set<number>();
			for (let attempt = 0; attempt < WORKER_COUNT * 32 && reached.size < WORKER_COUNT; attempt++) {
				const connection = new Client(origin, { pipelining: 1 });
				const entry: PinnedConnection = { threadId: -1, connection, connects: 0, probe };
				connection.on('connect', () => entry.connects++);
				pinned.push(entry);
				const { status, body } = await ask(connection, kept);
				strictEqual(status, 200, 'the kept user must name the worker');
				entry.threadId = body!.threadId;
				reached.add(entry.threadId);
			}
			strictEqual(reached.size, WORKER_COUNT, `pinned connections reached only workers [${[...reached]}]`);
		}

		async function rejectedOnPinnedConnection(pinned: PinnedConnection, kept: Credential): Promise<void> {
			const { threadId, connection, probe } = pinned;
			strictEqual((await ask(connection, probe[1])).status, 401, `worker ${threadId} still accepted ${probe[0]}`);
			const { status, body } = await ask(connection, kept);
			strictEqual(status, 200, `worker ${threadId} refused the kept user`);
			strictEqual(body!.threadId, threadId, 'the pinned connection changed workers');
			strictEqual(pinned.connects, 1, 'the pinned connection was reopened');
		}

		before(async () => {
			// No loopback trust: a request authenticates by the credential it presents or not at all.
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: WORKER_COUNT }, authentication: { authorizeLocal: false } },
				env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
			});
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			origin = new URL(httpURL).origin;
			await assertEveryWorkerStarted(ctx);
			await client
				.req()
				.send({ operation: 'add_role', role: ROLE, permission: { super_user: true } })
				.expect(200);
			await client
				.req()
				.send({ operation: 'add_user', role: ROLE, username: USERNAME, password, active: true })
				.expect(200);
			const deadline = Date.now() + 60_000;
			while ((await whoAmI(basic(password))).status !== 200) {
				ok(Date.now() < deadline, 'the WhoAmI resource never became reachable');
				await sleep(250);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('a role permission change', async () => {
			for (const body of await onEveryWorker(basic(password))) strictEqual(body.superUser, true);
			const roles = await client.req().send({ operation: 'list_roles' }).expect(200);
			const role = roles.body.find((candidate: any) => candidate.role === ROLE);
			await client
				.req()
				.send({ operation: 'alter_role', id: role.id, role: ROLE, permission: { super_user: false } })
				.expect(200);
			for (const body of await onEveryWorker(basic(password))) {
				strictEqual(body.superUser, false, `worker ${body.threadId} served the role as it was before alter_role`);
			}
		});

		test('a password change', async () => {
			await onEveryWorker(basic(password));
			const previous = password;
			password = 'ucaw-password-2';
			await client.req().send({ operation: 'alter_user', username: USERNAME, password }).expect(200);
			await rejectedEverywhere(basic(previous));
			await onEveryWorker(basic(password));
		});

		test('a deactivation', async () => {
			await onEveryWorker(basic(password));
			await client.req().send({ operation: 'alter_user', username: USERNAME, active: false }).expect(200);
			await rejectedEverywhere(basic(password));
		});

		// https://github.com/HarperFast/harper/issues/4124
		test('a drop: operation token and session cookie', async () => {
			const secret = 'ucaw-drop-password';
			await client
				.req()
				.send({ operation: 'add_role', role: DROP_ROLE, permission: { super_user: false } })
				.expect(200);
			for (let iteration = 1; iteration <= DROP_ITERATIONS; iteration++) {
				const droppedUser = `ucaw_dropped_${iteration}`;
				const keptUser = `ucaw_kept_${iteration}`;
				for (const username of [droppedUser, keptUser]) {
					await client
						.req()
						.send({ operation: 'add_user', role: DROP_ROLE, username, password: secret, active: true })
						.expect(200);
				}
				const dropped: Probe[] = [
					[`${droppedUser}'s operation token`, await operationToken(droppedUser, secret)],
					[`${droppedUser}'s session cookie`, await sessionCookie(droppedUser, secret)],
				];
				const kept = [await operationToken(keptUser, secret), await sessionCookie(keptUser, secret)];
				for (const [, credential] of dropped) await onEveryWorker(credential, droppedUser);
				for (const credential of kept) await onEveryWorker(credential, keptUser);

				const pinned: PinnedConnection[] = [];
				try {
					for (const probe of dropped) await pinEveryWorker(kept[0], probe, pinned);
					await client.req().send({ operation: 'drop_user', username: droppedUser }).expect(200);
					await Promise.all([
						...pinned.map((entry) => rejectedOnPinnedConnection(entry, kept[0])),
						...dropped.map(([label, credential]) => rejectedEverywhere(credential, label)),
					]);
				} finally {
					await Promise.all(pinned.map(({ connection }) => connection.close()));
				}
				for (const credential of kept) await onEveryWorker(credential, keptUser);
			}
		});
	}
);
