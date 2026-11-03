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
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
import { WORKER_COUNT, NO_FULL_WORKER_COVERAGE, assertEveryWorkerStarted } from '../database/recordCachingWorkers.ts';
import { fetchOnNewConnection, observeEveryWorker } from '../utils/connectionPerRequest.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures', 'user-change-across-workers');
const ROLE = 'ucaw_role';
const USERNAME = 'ucaw_user';

type WhoAmI = { threadId: number; username: string | null; superUser: boolean };

suite(
	'user and role changes hold on every worker at acknowledgement',
	{ skip: NO_FULL_WORKER_COVERAGE },
	(ctx: ContextWithHarper) => {
		let client: any;
		let httpURL: string;
		let password = 'ucaw-password-1';

		const basic = (secret: string) => 'Basic ' + Buffer.from(`${USERNAME}:${secret}`).toString('base64');

		async function whoAmI(secret: string): Promise<{ status: number; body?: WhoAmI }> {
			const response = await fetchOnNewConnection(`${httpURL}/WhoAmI/`, { headers: { Authorization: basic(secret) } });
			if (response.status !== 200) {
				await response.text().catch(() => undefined);
				return { status: response.status };
			}
			return { status: 200, body: (await response.json()) as WhoAmI };
		}

		function onEveryWorker(secret: string): Promise<WhoAmI[]> {
			return observeEveryWorker(
				async () => {
					const { status, body } = await whoAmI(secret);
					strictEqual(status, 200, `expected ${USERNAME} to authenticate`);
					return body!;
				},
				(body) => body.threadId,
				{ workerCount: WORKER_COUNT }
			);
		}

		async function rejectedEverywhere(secret: string): Promise<void> {
			const responses = await Promise.all(Array.from({ length: WORKER_COUNT * 8 }, () => whoAmI(secret)));
			for (const { status, body } of responses) {
				strictEqual(status, 401, `worker ${body?.threadId} still accepted the credential`);
			}
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: { threads: { count: WORKER_COUNT } } });
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
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
			while ((await whoAmI(password)).status !== 200) {
				ok(Date.now() < deadline, 'the WhoAmI resource never became reachable');
				await sleep(250);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('a role permission change', async () => {
			for (const body of await onEveryWorker(password)) strictEqual(body.superUser, true);
			const roles = await client.req().send({ operation: 'list_roles' }).expect(200);
			const role = roles.body.find((candidate: any) => candidate.role === ROLE);
			await client
				.req()
				.send({ operation: 'alter_role', id: role.id, role: ROLE, permission: { super_user: false } })
				.expect(200);
			for (const body of await onEveryWorker(password)) {
				strictEqual(body.superUser, false, `worker ${body.threadId} served the role as it was before alter_role`);
			}
		});

		test('a password change', async () => {
			await onEveryWorker(password);
			const previous = password;
			password = 'ucaw-password-2';
			await client.req().send({ operation: 'alter_user', username: USERNAME, password }).expect(200);
			await rejectedEverywhere(previous);
			await onEveryWorker(password);
		});

		test('a deactivation', async () => {
			await onEveryWorker(password);
			await client.req().send({ operation: 'alter_user', username: USERNAME, active: false }).expect(200);
			await rejectedEverywhere(password);
		});
	}
);
