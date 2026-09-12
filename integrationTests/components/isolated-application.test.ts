import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { resolve, join, basename } from 'node:path';
import { cp, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import {
	startHarper,
	killHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const ISOLATED = resolve(import.meta.dirname, 'fixtures/isolated-app');
const SHARED = resolve(import.meta.dirname, 'fixtures/shared-sibling');
const ISOLATED_TWO = resolve(import.meta.dirname, 'fixtures/isolated-app-two');
const ISOLATED_TWO_NAME = 'iso-two';
const POOL = 2;
const CONFIG = {
	config: {
		'threads': { count: POOL, maxIsolated: 2 },
		// a secure port (the harness adds one when tls is configured) and UDS mirrors: the only surface a
		// dedicated worker binds
		'tls': { unixDomainSockets: true },
		'stale-isolated': { isolated: true },
		'isolated-app': { isolated: true, host: 'iso.qa.test' },
		[ISOLATED_TWO_NAME]: { isolated: true },
	},
};

type ThreadInfo = { threadId: number; name: string; application?: string };

async function threads(ctx: ContextWithHarper): Promise<ThreadInfo[]> {
	const info = await sendOperation(ctx.harper, { operation: 'system_information', attributes: ['threads'] });
	ok(Array.isArray(info.threads), 'system_information reports threads');
	return info.threads as ThreadInfo[];
}
async function waitFor<T>(
	probe: () => Promise<T>,
	accept: (value: T) => boolean,
	what: string,
	ms = 20000
): Promise<T> {
	const deadline = Date.now() + ms;
	let last: T;
	do {
		last = await probe();
		if (accept(last)) return last;
		await new Promise((r) => setTimeout(r, 250));
	} while (Date.now() < deadline);
	throw new Error(`${what}: ${JSON.stringify(last)}`);
}
const pool = (list: ThreadInfo[]) =>
	list
		.filter((t) => t.name === 'http' && !t.application)
		.map((t) => t.threadId)
		.sort();
const dedicated = (list: ThreadInfo[], app = 'isolated-app') => list.filter((t) => t.application === app);

// Windows has no UDS mirrors, so admission refuses a dedicated worker there by design; the Bun listener
// path is not yet exercised (design note).
const UNSUPPORTED_HERE = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

suite(
	'an isolated application runs in a thread of its own (harper#642 tier 2)',
	{ skip: UNSUPPORTED_HERE },
	(ctx: ContextWithHarper) => {
		before(async () => {
			const dataRootDir = await mkdtemp(
				join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
			);
			ctx.harper = { dataRootDir } as any;
			for (const fixture of [ISOLATED, SHARED]) {
				await cp(fixture, join(dataRootDir, 'components', basename(fixture)), { recursive: true, dereference: true });
			}
			await cp(ISOLATED_TWO, join(dataRootDir, 'components', ISOLATED_TWO_NAME), {
				recursive: true,
				dereference: true,
			});
			await startHarper(ctx, CONFIG);
		});
		after(async () => {
			await killHarper(ctx);
			await teardownHarper(ctx);
		});

		test('gets exactly one dedicated http worker, numbered past the pool', async () => {
			const list = await threads(ctx);
			strictEqual(dedicated(list).length, 1, JSON.stringify(list));
			strictEqual(dedicated(list, ISOLATED_TWO_NAME).length, 1, 'and so does its isolated sibling');
			strictEqual(pool(list).length, POOL, 'the pool is untouched by the extra worker');
		});

		test('rejects another isolated deployment when the dedicated-worker budget is full', async () => {
			const response = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					operation: 'deploy_component',
					project: 'third-isolated',
					package: 'unused-because-admission-runs-first',
					isolated: true,
					restart: false,
				}),
			});
			const body = await response.text();
			strictEqual(response.status, 409, body);
			ok(body.includes('already runs 2 isolated application(s)'), body);
		});

		test('the shared port serves the shared application but never the isolated one', async () => {
			// several requests so both pool workers are hit
			for (let i = 0; i < 6; i++) {
				const shared = await fetch(new URL('/Shared/probe', ctx.harper.httpURL));
				strictEqual(shared.status, 200);
				deepStrictEqual((await shared.json()).application, 'shared-sibling');
				const isolated = await fetch(new URL('/Isolated/probe', ctx.harper.httpURL));
				strictEqual(isolated.status, 404, 'no pool worker loaded the isolated application');
			}
		});

		test('is reachable through its own application-named UDS mirror, which publishes its route', async () => {
			const socketsDir = join(ctx.harper.dataRootDir, 'sockets');
			const names = await readdir(socketsDir);
			// the HTTPS mirror, not the one MQTT's per-thread listener publishes under the same application name
			const mirror = names.find((name) => name.startsWith('app-isolated-app-') && name.endsWith(':9927.sock'));
			ok(mirror, `no application mirror among ${names.join(', ')}`);
			const yaml = await readFile(join(socketsDir, mirror.replace(/\.sock$/, '.yaml')), 'utf8');
			ok(yaml.includes('application: "isolated-app"'), yaml);
			ok(yaml.includes('- "iso.qa.test"'), yaml);

			const body = await new Promise<string>((resolve, reject) => {
				const req = request(
					{
						socketPath: join(socketsDir, mirror),
						path: '/Isolated/probe',
						headers: {
							host: 'iso.qa.test',
							// the mirror carries the secure port's chain, authentication included
							authorization: `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
						},
					},
					(res) => {
						strictEqual(res.statusCode, 200);
						let data = '';
						res.on('data', (chunk) => (data += chunk));
						res.on('end', () => resolve(data));
					}
				);
				req.on('error', reject);
				req.end();
			});
			strictEqual(JSON.parse(body).application, 'isolated-app');
		});

		test('dropping a shared application restarts the pool and leaves the dedicated worker alone', async () => {
			const beforeList = await threads(ctx);
			const isolatedBefore = dedicated(beforeList)[0].threadId;
			const poolBefore = pool(beforeList);

			await sendOperation(ctx.harper, { operation: 'drop_component', project: 'shared-sibling', restart: true });

			const afterList = await threads(ctx);
			strictEqual(dedicated(afterList)[0]?.threadId, isolatedBefore, 'the isolated thread survived the restart');
			const poolAfter = pool(afterList);
			strictEqual(poolAfter.length, POOL);
			for (const id of poolAfter) ok(!poolBefore.includes(id), `pool worker ${id} was replaced`);
			const gone = await fetch(new URL('/Shared/probe', ctx.harper.httpURL));
			strictEqual(gone.status, 404);
		});

		test('dropping the isolated application stops its worker and restarts nothing else', async () => {
			const beforeList = await threads(ctx);
			const poolBefore = pool(beforeList);
			const siblingBefore = dedicated(beforeList, ISOLATED_TWO_NAME)[0].threadId;

			await sendOperation(ctx.harper, { operation: 'drop_component', project: 'isolated-app', restart: true });

			// its shutdown drains asynchronously after the operation answers
			const afterList = await waitFor(
				() => threads(ctx),
				(list) => dedicated(list).length === 0,
				'dedicated worker still listed'
			);
			deepStrictEqual(pool(afterList), poolBefore, 'the pool was not restarted');
			strictEqual(
				dedicated(afterList, ISOLATED_TWO_NAME)[0]?.threadId,
				siblingBefore,
				'nor was the other isolated application'
			);
		});
	}
);
