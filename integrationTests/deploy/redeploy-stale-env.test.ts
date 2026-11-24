/**
 * Regression anchor for harper#1934 (fixed by harper#1936; requires-isolation):
 * Redeploying an active component with `restart: false` must apply `.env` changes atomically
 * across `loadEnv`, `jsResource`, and `fastifyRoutes` (never applying a newly added `.env` key
 * while leaving a modified existing key stale), flag `restartRequired`, keep old code live
 * pre-restart, and reload both code and `.env` after `deploy_component(..., restart: true)`.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/redeploy-stale-env');
const PROJECT = 'redeploy-stale-env';
const ROUTE = '/redeploy-env-probe';
const FASTIFY_ROUTE = '/redeploy-env-fastify-probe';

const skipSuite = process.platform === 'win32';

interface ProbeBody {
	codeVersion: number;
	changedKey: string | null;
	newKey: string | null;
}

/** Build a tar.gz payload of the fixture with `.env` and `resources.js`/`routes/probe.js` rewritten for `version`. */
async function buildPayload(version: number, changedValue: string, includeNewKey: boolean): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `redeploy-stale-env-v${version}-`));
	try {
		await writeFile(
			join(dir, 'config.yaml'),
			"rest: true\nloadEnv:\n  files: '.env'\njsResource:\n  files: 'resources.js'\nfastifyRoutes:\n  files: 'routes/*.js'\n"
		);
		await writeFile(
			join(dir, '.env'),
			`REDEPLOY_ENV_CHANGED_KEY=${changedValue}\n` +
				(includeNewKey ? `REDEPLOY_ENV_NEW_KEY=added-in-v${version}\n` : '')
		);
		await writeFile(
			join(dir, 'resources.js'),
			`export default {\n\tpath: '${ROUTE}',\n\tasync get() {\n\t\treturn {\n\t\t\tcodeVersion: ${version},\n\t\t\tchangedKey: process.env.REDEPLOY_ENV_CHANGED_KEY ?? null,\n\t\t\tnewKey: process.env.REDEPLOY_ENV_NEW_KEY ?? null,\n\t\t};\n\t},\n};\n`
		);
		const routesDir = join(dir, 'routes');
		await mkdir(routesDir, { recursive: true });
		await writeFile(
			join(routesDir, 'probe.js'),
			`export default async (server) => {\n\tserver.route({\n\t\turl: '${FASTIFY_ROUTE}',\n\t\tmethod: 'GET',\n\t\thandler: (request, reply) => {\n\t\t\treply.send({\n\t\t\t\tcodeVersion: ${version},\n\t\t\t\tchangedKey: process.env.REDEPLOY_ENV_CHANGED_KEY ?? null,\n\t\t\t\tnewKey: process.env.REDEPLOY_ENV_NEW_KEY ?? null,\n\t\t\t});\n\t\t},\n\t});\n};\n`
		);
		return await targz(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

suite(
	'Redeploy .env atomicity across loadEnv, jsResource, and fastifyRoutes (harper#1934)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
			client = createApiClient(ctx.harper);

			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest(ROUTE).timeout(2000);
					if (probe.status !== 404) break;
				} catch {
					/* not ready yet */
				}
				await sleep(250);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		async function readProbe(path: string): Promise<ProbeBody | undefined> {
			try {
				const res = await client.reqRest(path).timeout(2000);
				if (res.status !== 200) return undefined;
				return res.body as ProbeBody;
			} catch {
				return undefined;
			}
		}

		async function getRestartRequired(): Promise<boolean> {
			const res = await client.req().send({ operation: 'get_status' }).timeout(5000);
			return res.body ? res.body.restartRequired === true : false;
		}

		test('initial deploy serves v1 code and v1 env values', async () => {
			const probe = await readProbe(ROUTE);
			ok(probe, 'expected the pre-installed component to be live');
			strictEqual(probe.codeVersion, 1);
			strictEqual(probe.changedKey, 'v1-changed-value');
			strictEqual(probe.newKey, null);

			const fastifyProbe = await readProbe(FASTIFY_ROUTE);
			ok(fastifyProbe, 'expected the pre-installed fastifyRoutes component to be live');
			strictEqual(fastifyProbe.codeVersion, 1);
			strictEqual(fastifyProbe.changedKey, 'v1-changed-value');
		});

		test('redeploy (restart:false) applies .env atomically and flags restartRequired', async () => {
			strictEqual(
				await getRestartRequired(),
				false,
				'expected a clean restartRequired=false baseline before redeploying'
			);

			const payload = await buildPayload(2, 'v2-changed-value', true);
			const deployRes = await client
				.req()
				.send({ operation: 'deploy_component', project: PROJECT, payload, restart: false })
				.timeout(30_000);
			strictEqual(deployRes.status, 200, `deploy_component failed: ${JSON.stringify(deployRes.body)}`);

			let flagged = false;
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				if (await getRestartRequired()) {
					flagged = true;
					break;
				}
				await sleep(250);
			}
			ok(flagged, 'redeploy with restart:false did not flag restartRequired');

			const postRedeployProbe = await readProbe(ROUTE);
			ok(postRedeployProbe, 'route should still be live');
			strictEqual(
				postRedeployProbe.codeVersion,
				1,
				'expected old code to remain live until an explicit restart (#1817 behavior)'
			);

			const changedApplied = postRedeployProbe.changedKey === 'v2-changed-value';
			const newApplied = postRedeployProbe.newKey === 'added-in-v2';
			strictEqual(
				changedApplied,
				newApplied,
				`loadEnv applied the redeployed .env partially: changedKey=${JSON.stringify(postRedeployProbe.changedKey)} ` +
					`(applied=${changedApplied}), newKey=${JSON.stringify(postRedeployProbe.newKey)} (applied=${newApplied}) (harper#1934)`
			);
			ok(
				postRedeployProbe.changedKey === 'v1-changed-value' || changedApplied,
				`changedKey is neither the v1 nor the v2 value: ${JSON.stringify(postRedeployProbe.changedKey)}`
			);

			const fastifyProbe = await readProbe(FASTIFY_ROUTE);
			ok(fastifyProbe, 'fastify route should still be live');
			strictEqual(
				fastifyProbe.changedKey === 'v2-changed-value',
				fastifyProbe.newKey === 'added-in-v2',
				`fastifyRoutes surface saw a partial .env application: ${JSON.stringify(fastifyProbe)} (harper#1934)`
			);
		});

		test('explicit restart (deploy_component restart:true) reloads both code and env', async () => {
			const payload = await buildPayload(3, 'v3-changed-value', true);
			const deployRes = await client
				.req()
				.send({ operation: 'deploy_component', project: PROJECT, payload, restart: true })
				.timeout(30_000);
			strictEqual(deployRes.status, 200, `deploy_component (restart:true) failed: ${JSON.stringify(deployRes.body)}`);

			let probe: ProbeBody | undefined;
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				probe = await readProbe(ROUTE);
				if (probe?.codeVersion === 3) break;
				await sleep(250);
			}
			ok(probe, 'route never came back after restart:true redeploy');
			strictEqual(probe.codeVersion, 3, 'expected code to be reloaded after an explicit restart');
			strictEqual(probe.changedKey, 'v3-changed-value', 'expected a full restart to load the current .env value');
			strictEqual(probe.newKey, 'added-in-v3', 'expected a full restart to load the new key too');

			const fastifyProbe = await readProbe(FASTIFY_ROUTE);
			ok(fastifyProbe, 'fastify route should be live after restart');
			strictEqual(fastifyProbe.codeVersion, 3, 'expected fastifyRoutes code to reload after an explicit restart');
		});
	}
);
