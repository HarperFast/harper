/**
 * Redeploying an active jsResource component with `restart: false` under concurrent in-flight
 * HTTP traffic and repeated `restart: false` calls preserves response atomicity, keeps old code
 * live without torn/premature swaps, maintains `restartRequired === true` across consecutive
 * redeploys, and serves the final deployed version after an explicit worker restart
 * (harper#1817 / harper#1820).
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { setupHarperWithFixture, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations; runtime resolves fine
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures/redeploy-inflight-idempotence');
const PROJECT = 'redeploy-inflight-idempotence';
const DELAY_MS = 250;
const ROUTE = '/SlowVersion/';
const skipSuite = process.platform === 'win32';

/** Build a tar.gz payload of the fixture with `resources.js` rewritten to report `version`. */
async function buildPayload(version: number): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'redeploy-inflight-'));
	try {
		await writeFile(join(dir, 'config.yaml'), 'jsResource:\n  files: resources.js\nrest: true\n');
		await writeFile(
			join(dir, 'resources.js'),
			`import { setTimeout as sleep } from 'node:timers/promises';\n` +
				`const VERSION = ${version};\n\n` +
				`export class SlowVersion extends Resource {\n` +
				`\tstatic loadAsInstance = false;\n` +
				`\tasync get() {\n` +
				`\t\tawait sleep(${DELAY_MS});\n` +
				`\t\treturn { version: VERSION };\n` +
				`\t}\n` +
				`}\n`
		);
		return await targz(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function operation(client: any, body: Record<string, unknown>): Promise<any> {
	const res = await client.req().send(body);
	strictEqual(res.status, 200, `operation ${body.operation} failed: ${JSON.stringify(res.body)}`);
	return res.body;
}

async function getRestartRequired(client: any): Promise<boolean> {
	const status = await operation(client, { operation: 'get_status' });
	return status ? status.restartRequired === true : false;
}

/** Fire `count` GETs against `path`, one every `intervalMs`, without waiting for responses in between. */
function fireGetBurst(client: any, path: string, count: number, intervalMs: number): Promise<any[]> {
	const results: Promise<any>[] = [];
	let chain = Promise.resolve();
	for (let i = 0; i < count; i++) {
		results.push(
			client
				.reqRest(path)
				.timeout(10_000)
				.then((r: any) => ({ status: r.status, body: r.body }))
				.catch((e: any) => ({ error: String(e) }))
		);
		chain = chain.then(() => sleep(intervalMs));
	}
	return Promise.all(results).then(async (r) => {
		await chain;
		return r;
	});
}

suite(
	'Redeploy with restart:false under in-flight traffic and repeat-redeploy idempotence (harper#1817)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: any;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_DIR, { config: {}, env: {} });
			client = createApiClient(ctx.harper);
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest(ROUTE).timeout(3_000);
					if (probe.status === 200) break;
				} catch {
					// Wait for component route readiness.
				}
				await sleep(200);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('baseline: fresh boot serves version 1, restartRequired is false', async () => {
			strictEqual(await getRestartRequired(client), false, 'expected restartRequired=false after a fresh boot');
			const res = await client.reqRest(ROUTE);
			strictEqual(res.status, 200);
			strictEqual(res.body.version, 1);
		});

		test('in-flight traffic during restart:false redeploy: no torn/stale-as-new responses', async () => {
			const burstPromise = fireGetBurst(client, ROUTE, 40, 20);
			await sleep(150);
			const deployPromise = operation(client, {
				operation: 'deploy_component',
				project: PROJECT,
				payload: await buildPayload(2),
				restart: false,
			});

			const [burstResults, deployResult] = await Promise.all([burstPromise, deployPromise]);
			ok(
				deployResult.message?.includes(`Successfully deployed: ${PROJECT}`),
				`unexpected deploy message: ${deployResult.message}`
			);

			for (const r of burstResults) {
				ok(!r.error, `request errored during redeploy: ${r.error}`);
				strictEqual(r.status, 200, `unexpected status during redeploy: ${JSON.stringify(r)}`);
				strictEqual(
					r.body?.version,
					1,
					`expected stale version 1 during in-flight redeploy, got: ${JSON.stringify(r.body)}`
				);
			}

			let flagged = false;
			const deadline = Date.now() + 8_000;
			while (Date.now() < deadline) {
				if (await getRestartRequired(client)) {
					flagged = true;
					break;
				}
				await sleep(150);
			}
			ok(flagged, 'restart:false redeploy under in-flight traffic did not flag restartRequired (harper#1817)');

			const after1 = await client.reqRest(ROUTE);
			strictEqual(after1.status, 200);
			strictEqual(after1.body.version, 1, 'expected old code to remain live after restart:false redeploy, pre-restart');
		});

		test('repeat redeploy (restart:false x2) does not wedge or clear restartRequired', async () => {
			const d1 = await operation(client, {
				operation: 'deploy_component',
				project: PROJECT,
				payload: await buildPayload(3),
				restart: false,
			});
			ok(d1.message?.includes(`Successfully deployed: ${PROJECT}`), `unexpected deploy message: ${d1.message}`);
			ok(
				await getRestartRequired(client),
				'restartRequired unexpectedly cleared after a second restart:false redeploy'
			);

			const start = Date.now();
			const d2 = await Promise.race([
				operation(client, {
					operation: 'deploy_component',
					project: PROJECT,
					payload: await buildPayload(3),
					restart: false,
				}),
				sleep(30_000).then(() => {
					throw new Error('second consecutive restart:false redeploy appears to have wedged (>30s)');
				}),
			]);
			ok(d2.message?.includes(`Successfully deployed: ${PROJECT}`), `unexpected deploy message: ${d2.message}`);
			ok(Date.now() - start < 30_000, 'repeat redeploy took unexpectedly long');
			ok(await getRestartRequired(client), 'restartRequired unexpectedly cleared after idempotent repeat redeploy');

			const res = await client.reqRest(ROUTE);
			strictEqual(res.status, 200);
			strictEqual(
				res.body.version,
				1,
				'expected version 1 to still be live; nothing should have silently taken effect'
			);
		});

		test('explicit restart after the redeploy chain serves the LAST deployed version', async () => {
			await restartHttpWorkers(client, ROUTE);
			let version: number | undefined;
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				const res = await client.reqRest(ROUTE);
				if (res.status === 200) {
					version = res.body.version;
					if (version === 3) break;
				}
				await sleep(200);
			}
			strictEqual(version, 3, `expected the last deployed version (3) after restart, got ${version}`);
			strictEqual(await getRestartRequired(client), false, 'expected restartRequired=false after a fresh restart');
		});
	}
);
