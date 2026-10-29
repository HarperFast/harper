/**
 * What a `deploy_component` with `restart: false` makes visible, per extension (QA-786).
 *
 * A redeploy pauses and resumes the component's file watcher, and EntryHandler diffs the resumed
 * scan against the pre-deploy snapshot: a genuinely new file arrives as `'add'`, a modified one as
 * `'change'`. The three extensions pinned here answer that pair differently on purpose — jsResource
 * serves a new file at once and keeps the cached module for a changed one, static serves both
 * straight from disk, and graphqlSchema shows neither until a restart.
 *
 * `restartRequired` is only attributable to an extension for a component with no JS modules of its
 * own. Where there are any, `Scope.#onDeployEnd` also consults `RuntimeModuleTracker.finishDeploy()`
 * and requests a restart whenever a tracked module changed or any module loaded during the deploy.
 * So the jsResource leg pins the operator-visible flag, and the graphqlSchema leg pins that
 * extension's own request.
 *
 * fastifyRoutes has no leg here: a route folder new to a running process is still lost until a
 * restart (F-230), so any assertion about it would pin the defect rather than a contract.
 */
import { suite, test, before, after } from 'node:test';
import { AssertionError, ok, strictEqual } from 'node:assert';
import { dirname, join, resolve } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/operations.mjs has no type declarations; runtime resolves fine
import { awaitJobCompleted } from '../apiTests/utils/operations.mjs';

const ROOT = resolve(import.meta.dirname, 'redeploy-extension-freshness');
// `restart_service http_workers` crashes the Harper instance on Windows (harper#549).
const skipRestartSuites = process.platform === 'win32';

const REDEPLOY_SETTLE_TIMEOUT_MS = 20_000;
// A contended shard rotates workers slowly (integrationTests/server/rolling-restart.test.ts budgets 120s).
const RESTART_POLL_TIMEOUT_MS = 60_000;
const RESTART_TEST_TIMEOUT_MS = 2 * RESTART_POLL_TIMEOUT_MS + REDEPLOY_SETTLE_TIMEOUT_MS + 10_000;
const BOOT_TIMEOUT_MS = 60_000;
// A negative sampled once is only true at that instant, so every "still stale", "still absent" and
// "no restart requested" claim holds across this window instead.
const QUIET_WINDOW_MS = 3_000;

type ApiClient = ReturnType<typeof createApiClient>;

// A wrong value is a verdict, so it fails with its own message instead of waiting out the deadline.
async function pollUntil(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 250): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			if (await predicate()) return true;
			if (Date.now() >= deadline) return false;
		} catch (error) {
			if (error instanceof AssertionError || Date.now() >= deadline) throw error;
		}
		await sleep(intervalMs);
	}
}

async function holdInvariant(check: () => Promise<void>, windowMs = QUIET_WINDOW_MS, intervalMs = 250): Promise<void> {
	const deadline = Date.now() + windowMs;
	for (;;) {
		await check();
		if (Date.now() >= deadline) return;
		await sleep(intervalMs);
	}
}

async function getRestartRequired(client: ApiClient): Promise<boolean> {
	const res = await client.req().send({ operation: 'get_status' }).timeout(5000);
	if (res.status !== 200) throw new Error(`get_status returned ${res.status}: ${JSON.stringify(res.body)}`);
	strictEqual(
		typeof res.body?.restartRequired,
		'boolean',
		`get_status returned no restartRequired flag: ${JSON.stringify(res.body)}`
	);
	return res.body.restartRequired;
}

/**
 * `restart_service` returns when the job thread launches, so only the job reaching COMPLETE orders
 * the caller after the restart. This is `restartHttpWorkers` without its non-404 readiness probe:
 * the graphqlSchema component has no REST route to probe, and the jsResource route already answers
 * from the old workers. Each caller polls the observable it actually cares about instead.
 */
async function restartHttpWorkersAndAwaitJob(client: ApiClient, timeoutMs: number): Promise<void> {
	const res = await client.req().send({ operation: 'restart_service', service: 'http_workers' }).timeout(5000);
	strictEqual(res.status, 200, `restart_service failed: ${JSON.stringify(res.body)}`);
	ok(res.body.job_id, `restart_service returned no job_id: ${JSON.stringify(res.body)}`);
	await awaitJobCompleted(client, res.body.job_id, { timeoutSeconds: Math.ceil(timeoutMs / 1000) });
}

async function redeployWithoutRestart(
	client: ApiClient,
	project: string,
	files: Record<string, string>
): Promise<void> {
	const stage = await mkdtemp(join(tmpdir(), 'redeploy-freshness-'));
	try {
		for (const [relativePath, content] of Object.entries(files)) {
			const target = join(stage, relativePath);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content);
		}
		const payload = await targz(stage);
		const res = await client
			.req()
			.send({ operation: 'deploy_component', project, payload, restart: false })
			.timeout(30_000);
		strictEqual(res.status, 200, `deploy_component failed: ${JSON.stringify(res.body)}`);
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

function bodyText(res: { text?: string; body: unknown }): string {
	return (res.text ?? String(res.body)).trim();
}

async function waitForRoute(client: ApiClient, path: string): Promise<void> {
	const registered = await pollUntil(async () => {
		const res = await client.reqRest(path).timeout(2000);
		return res.status === 200;
	}, BOOT_TIMEOUT_MS);
	ok(registered, `route ${path} never served a 200 within ${BOOT_TIMEOUT_MS}ms`);
}

suite(
	'Redeploy freshness: jsResource loads a new file, freezes a changed one (QA-786)',
	{ skip: skipRestartSuites },
	(ctx: ContextWithHarper) => {
		const PROJECT = 'fixture-jsresource-only';
		const EXISTING_ROUTE = '/qa786-js-existing';
		const NEW_ROUTE = '/qa786-js-new';
		let client: ApiClient;

		before(async () => {
			await setupHarperWithFixture(ctx, resolve(ROOT, PROJECT), { config: {}, env: {} });
			client = createApiClient(ctx.harper);
			await waitForRoute(client, EXISTING_ROUTE);
		});
		after(async () => teardownHarper(ctx));

		async function assertExistingStillV1(): Promise<void> {
			const existing = await client.reqRest(EXISTING_ROUTE).timeout(2000);
			strictEqual(existing.status, 200);
			strictEqual(existing.body.version, 1, 'the changed file must keep serving the cached v1 module until a restart');
		}

		test('baseline: v1 is live and no restart is pending', async () => {
			const res = await client.reqRest(EXISTING_ROUTE).timeout(2000);
			strictEqual(res.status, 200);
			strictEqual(res.body.version, 1);
			strictEqual(await getRestartRequired(client), false, 'a freshly booted instance must not already need a restart');
		});

		test('redeploy without restart: new file loads immediately, changed file stays frozen and flags restartRequired', async () => {
			await redeployWithoutRestart(client, PROJECT, {
				'config.yaml': "rest: true\njsResource:\n  files: '*.js'\n",
				'resources.js': `export class Existing extends Resource {\n\tstatic path = '${EXISTING_ROUTE}';\n\tstatic loadAsInstance = false;\n\tasync get() {\n\t\treturn { version: 2 };\n\t}\n}\n`,
				'resources-new.js': `export class Fresh extends Resource {\n\tstatic path = '${NEW_ROUTE}';\n\tstatic loadAsInstance = false;\n\tasync get() {\n\t\treturn { version: 2, isNew: true };\n\t}\n}\n`,
			});

			const flagged = await pollUntil(() => getRestartRequired(client), REDEPLOY_SETTLE_TIMEOUT_MS);
			ok(flagged, 'a redeploy that leaves a stale loaded module behind must flip restartRequired');

			let lastNew: unknown;
			const served = await pollUntil(async () => {
				const res = await client.reqRest(NEW_ROUTE).timeout(2000);
				lastNew = { status: res.status, body: res.body };
				return res.status === 200 && res.body.version === 2 && res.body.isNew === true;
			}, REDEPLOY_SETTLE_TIMEOUT_MS);
			ok(served, `a genuinely new jsResource file must load without a restart; last: ${JSON.stringify(lastNew)}`);

			await holdInvariant(() => assertExistingStillV1());
		});

		test(
			'restart converges the changed file to v2 and clears restartRequired',
			{ timeout: RESTART_TEST_TIMEOUT_MS },
			async () => {
				await assertExistingStillV1();
				await restartHttpWorkersAndAwaitJob(client, RESTART_POLL_TIMEOUT_MS);
				const converged = await pollUntil(async () => {
					const res = await client.reqRest(EXISTING_ROUTE).timeout(2000);
					return res.status === 200 && res.body.version === 2;
				}, RESTART_POLL_TIMEOUT_MS);
				ok(converged, 'a real restart must pick up the changed jsResource file');
				const cleared = await pollUntil(async () => !(await getRestartRequired(client)), REDEPLOY_SETTLE_TIMEOUT_MS);
				ok(cleared, 'restartRequired must clear once the restart has landed');
			}
		);
	}
);

suite('Redeploy freshness: static serves from disk (QA-786)', (ctx: ContextWithHarper) => {
	const PROJECT = 'fixture-static-only';
	const EXISTING_ROUTE = '/qa786-static/existing.txt';
	const NEW_ROUTE = '/qa786-static/new.txt';
	let client: ApiClient;

	before(async () => {
		await setupHarperWithFixture(ctx, resolve(ROOT, PROJECT), { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		await waitForRoute(client, EXISTING_ROUTE);
	});
	after(async () => teardownHarper(ctx));

	test('baseline: V1 is live and no restart is pending', async () => {
		const res = await client.reqRest(EXISTING_ROUTE).timeout(2000);
		strictEqual(res.status, 200);
		strictEqual(bodyText(res), 'V1');
		strictEqual(await getRestartRequired(client), false, 'a freshly booted instance must not already need a restart');
	});

	test('redeploy without restart: changed and new files are both served, and no restart is requested', async () => {
		await redeployWithoutRestart(client, PROJECT, {
			'config.yaml': "static:\n  files: 'public/**'\n  urlPath: '/qa786-static'\n",
			'public/existing.txt': 'V2\n',
			'public/new.txt': 'NEW-V2\n',
		});

		const serves = async (path: string, expected: string): Promise<boolean> => {
			const res = await client.reqRest(path).timeout(2000);
			return res.status === 200 && bodyText(res) === expected;
		};
		ok(
			await pollUntil(() => serves(EXISTING_ROUTE, 'V2'), REDEPLOY_SETTLE_TIMEOUT_MS),
			'static must serve the changed file without a restart'
		);
		ok(
			await pollUntil(() => serves(NEW_ROUTE, 'NEW-V2'), REDEPLOY_SETTLE_TIMEOUT_MS),
			'static must serve a brand-new file without a restart'
		);

		await holdInvariant(async () => {
			ok(await serves(EXISTING_ROUTE, 'V2'), 'the changed static file must keep serving V2');
			ok(await serves(NEW_ROUTE, 'NEW-V2'), 'the new static file must keep serving NEW-V2');
			strictEqual(
				await getRestartRequired(client),
				false,
				'static has no cached state to go stale, so it must never request a restart for an add or a change'
			);
		});
	});
});

suite(
	'Redeploy freshness: graphqlSchema freezes scope-wide (QA-786)',
	{ skip: skipRestartSuites },
	(ctx: ContextWithHarper) => {
		const PROJECT = 'fixture-graphql-only';
		const CONFIG = "graphqlSchema:\n  files: '*.graphql'\n";
		const SCHEMA_V1 = 'type QA786Widget @table @export {\n\tid: ID @primaryKey\n\tnote: String\n}\n';
		const SCHEMA_V2 = 'type QA786Widget @table @export {\n\tid: ID @primaryKey\n\tnote: String\n\tnoteV2: String\n}\n';
		const SCHEMA_SECOND = 'type QA786Widget2 @table @export {\n\tid: ID @primaryKey\n\tlabel: String\n}\n';
		let client: ApiClient;

		before(async () => {
			await setupHarperWithFixture(ctx, resolve(ROOT, PROJECT), { config: {}, env: {} });
			client = createApiClient(ctx.harper);
			// A schema-only component has no HTTP route, so readiness is the baseline table being describable.
			const loaded = await pollUntil(async () => (await describeTable('QA786Widget')).status === 200, BOOT_TIMEOUT_MS);
			ok(loaded, `QA786Widget never became describable within ${BOOT_TIMEOUT_MS}ms`);
		});
		after(async () => teardownHarper(ctx));

		async function describeTable(table: string): Promise<{ status: number; attributes: string[]; body: any }> {
			const res = await client.req().send({ operation: 'describe_table', database: 'data', table }).timeout(5000);
			const attributes = Array.isArray(res.body?.attributes)
				? res.body.attributes.map((attribute: { attribute: string }) => attribute.attribute)
				: [];
			return { status: res.status, attributes, body: res.body };
		}

		async function assertTableMissing(table: string, message: string): Promise<void> {
			const { status, body } = await describeTable(table);
			strictEqual(status, 404, `${message} — expected 404, got ${status}: ${JSON.stringify(body)}`);
			// Rules out a 404 for the whole database rather than this table.
			strictEqual(
				(await describeTable('QA786Widget')).status,
				200,
				`${message} — the baseline table must stay describable`
			);
		}

		async function assertV1SchemaOnly(message: string): Promise<void> {
			const { status, attributes } = await describeTable('QA786Widget');
			strictEqual(status, 200, `${message} — the baseline table must stay describable`);
			ok(attributes.includes('note'), `${message} — expected the v1 note attribute, got ${JSON.stringify(attributes)}`);
			ok(!attributes.includes('noteV2'), `${message} — expected no v2 attribute, got ${JSON.stringify(attributes)}`);
		}

		test('baseline: v1 schema only, and no restart is pending', async () => {
			await assertV1SchemaOnly('at boot');
			await assertTableMissing('QA786Widget2', 'QA786Widget2 must not exist before any redeploy');
			strictEqual(await getRestartRequired(client), false, 'a freshly booted instance must not already need a restart');
		});

		test('redeploy adding only a new schema file: restartRequired flips and the new table stays invisible', async () => {
			await redeployWithoutRestart(client, PROJECT, {
				'config.yaml': CONFIG,
				'schema.graphql': SCHEMA_V1,
				'schema2.graphql': SCHEMA_SECOND,
			});

			const flagged = await pollUntil(() => getRestartRequired(client), REDEPLOY_SETTLE_TIMEOUT_MS);
			ok(
				flagged,
				'a brand-new schema file alone must flip restartRequired: graphqlSchema does not load a post-boot add'
			);
			await holdInvariant(() =>
				assertTableMissing('QA786Widget2', 'a brand-new schema file must stay invisible pre-restart')
			);
		});

		test('restart exposes the new table and clears restartRequired', { timeout: RESTART_TEST_TIMEOUT_MS }, async () => {
			await assertTableMissing('QA786Widget2', 'QA786Widget2 must still be absent just before the restart');
			await restartHttpWorkersAndAwaitJob(client, RESTART_POLL_TIMEOUT_MS);
			const converged = await pollUntil(async () => {
				const { status, attributes } = await describeTable('QA786Widget2');
				return status === 200 && attributes.includes('label');
			}, RESTART_POLL_TIMEOUT_MS);
			ok(converged, 'a real restart must expose the brand-new table with its declared attributes');
			const cleared = await pollUntil(async () => !(await getRestartRequired(client)), REDEPLOY_SETTLE_TIMEOUT_MS);
			ok(cleared, 'restartRequired must clear once the restart has landed');
		});

		test('redeploy changing only an existing schema file: restartRequired flips and the new field stays invisible', async () => {
			await redeployWithoutRestart(client, PROJECT, {
				'config.yaml': CONFIG,
				'schema.graphql': SCHEMA_V2,
				'schema2.graphql': SCHEMA_SECOND,
			});

			const flagged = await pollUntil(() => getRestartRequired(client), REDEPLOY_SETTLE_TIMEOUT_MS);
			ok(flagged, 'a changed schema file alone must flip restartRequired');
			await holdInvariant(async () => {
				await assertV1SchemaOnly('while a changed schema file waits for a restart');
				strictEqual(
					(await describeTable('QA786Widget2')).status,
					200,
					'a change to schema.graphql must not drop the table schema2.graphql declares'
				);
			});
		});

		test(
			'restart exposes the changed field and clears restartRequired',
			{ timeout: RESTART_TEST_TIMEOUT_MS },
			async () => {
				await assertV1SchemaOnly('just before the restart');
				await restartHttpWorkersAndAwaitJob(client, RESTART_POLL_TIMEOUT_MS);
				const converged = await pollUntil(
					async () => (await describeTable('QA786Widget')).attributes.includes('noteV2'),
					RESTART_POLL_TIMEOUT_MS
				);
				ok(converged, 'a real restart must expose the changed field');
				const cleared = await pollUntil(async () => !(await getRestartRequired(client)), REDEPLOY_SETTLE_TIMEOUT_MS);
				ok(cleared, 'restartRequired must clear once the restart has landed');
			}
		);
	}
);
