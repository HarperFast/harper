/**
 * A PR preview end to end: a payload deploy that makes itself an isolated, host-bound, branched application with
 * preview metadata, the shared port refusing its host, and its drop.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import {
	startHarper,
	teardownHarper,
	targz,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const PROJECT = 'shop-pr-12';
const HOST = 'pr-12.app.qa.test';
// Windows has no UDS mirrors, so admission refuses a dedicated worker there; the Bun listener path is not yet exercised.
const UNSUPPORTED_HERE = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

type ThreadInfo = { threadId: number; name: string; application?: string };

async function waitFor<T>(probe: () => Promise<T>, accept: (value: T) => boolean, what: string, ms = 20000) {
	const deadline = Date.now() + ms;
	let last: T;
	do {
		last = await probe();
		if (accept(last)) return last;
		await new Promise((resolve) => setTimeout(resolve, 250));
	} while (Date.now() < deadline);
	throw new Error(`${what}: ${JSON.stringify(last)}`);
}

async function dedicatedWorkers(ctx: ContextWithHarper): Promise<ThreadInfo[]> {
	const info = await sendOperation(ctx.harper, { operation: 'system_information', attributes: ['threads'] });
	return (info.threads as ThreadInfo[]).filter((thread) => thread.application === PROJECT);
}

async function rootConfigEntry(ctx: ContextWithHarper): Promise<any> {
	return parse(await readFile(join(ctx.harper.dataRootDir, 'harper-config.yaml'), 'utf8'))?.[PROJECT];
}

function getWithHost(url: string, host: string): Promise<{ status: number; headers: Record<string, any> }> {
	return new Promise((resolve, reject) => {
		const { hostname, port } = new URL(url);
		const req = request({ hostname, port, path: '/', headers: { host } }, (res) => {
			res.resume();
			res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
		});
		req.on('error', reject);
		req.end();
	});
}

suite('a PR preview deployed from a build (harper#3042)', { skip: UNSUPPORTED_HERE }, (ctx: ContextWithHarper) => {
	let payload: string;

	before(async () => {
		const source = await mkdtemp(join(tmpdir(), 'preview-fixture-'));
		try {
			await mkdir(source, { recursive: true });
			await writeFile(join(source, 'package.json'), JSON.stringify({ name: PROJECT, version: '1.0.0' }));
			await writeFile(join(source, 'config.yaml'), 'rest: true\njsResource:\n  files: resources.js\n');
			await writeFile(
				join(source, 'resources.js'),
				"export class Probe extends Resource { get() { return { application: 'preview' }; } }\n"
			);
			payload = await targz(source);
		} finally {
			await rm(source, { recursive: true, force: true });
		}
		await startHarper(ctx, {
			config: { threads: { count: 1, maxIsolated: 2 }, tls: { unixDomainSockets: true } },
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a payload deploy makes itself an isolated, host-bound, branched application with its preview metadata', async () => {
		const preview = { app: 'shop', pr: 12, branch: 'fix/cart', sha: 'abc1234', expiresAt: '2099-01-01T00:00:00.000Z' };
		await sendOperation(ctx.harper, {
			operation: 'deploy_component',
			project: PROJECT,
			payload,
			isolated: true,
			host: HOST,
			branchedDatabases: true,
			preview,
			restart: true,
		});

		deepStrictEqual(await rootConfigEntry(ctx), { host: HOST, isolated: true, branchedDatabases: true });
		await waitFor(
			() => dedicatedWorkers(ctx),
			(workers) => workers.length === 1,
			'no dedicated worker started'
		);
		const components = await sendOperation(ctx.harper, { operation: 'get_components' });
		const entry = components.entries.find((component: any) => component.name === PROJECT);
		deepStrictEqual(entry.preview, preview);
		strictEqual(entry.host, HOST);
		const { deployments } = await sendOperation(ctx.harper, { operation: 'list_deployments', project: PROJECT });
		deepStrictEqual(deployments[0].preview, preview);
	});

	test("the shared port answers 503 for the preview's host instead of running its own routes", async () => {
		const refused = await getWithHost(ctx.harper.httpURL, HOST);
		strictEqual(refused.status, 503);
		strictEqual(refused.headers['retry-after'], '5');
		const other = await getWithHost(ctx.harper.httpURL, 'unrelated.qa.test');
		ok(other.status !== 503, `another host still reaches the pool's routes: ${other.status}`);
	});

	test('a redeploy that omits the routing keeps it', async () => {
		await sendOperation(ctx.harper, { operation: 'deploy_component', project: PROJECT, payload, restart: true });
		deepStrictEqual(await rootConfigEntry(ctx), { host: HOST, isolated: true, branchedDatabases: true });
	});

	test('dropping it stops its worker and removes its entry', async () => {
		await sendOperation(ctx.harper, { operation: 'drop_component', project: PROJECT, restart: true });
		await waitFor(
			() => dedicatedWorkers(ctx),
			(workers) => workers.length === 0,
			'dedicated worker still listed'
		);
		strictEqual(await rootConfigEntry(ctx), undefined);
	});
});
