/**
 * Starting and stopping one isolated application leaves every other worker alone (harper#3045, harper#3091): a new
 * isolated application's first deploy starts only its own dedicated worker, certified by its canary, and a drop stops
 * only that worker, with or without `restart`. Dropping a component that is not on this node restarts nothing.
 *
 * The worker-thread drop is the path a replicated peer runs: replication receives operations on a worker.
 *
 * Run: npm run test:integration -- "integrationTests/components/isolated-application-lifecycle.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, match, notDeepStrictEqual, ok, strictEqual } from 'node:assert';
import { join, resolve } from 'node:path';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	startHarper,
	killHarper,
	teardownHarper,
	sendOperation,
	targz,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const POOL = 2;
const SIBLING = 'iso_sibling';
const DROPPER = 'dropper';
const CONFIG = {
	config: {
		threads: { count: POOL, maxIsolated: 8 },
		tls: { unixDomainSockets: true },
		[SIBLING]: { isolated: true },
	},
};

// Windows has no UDS mirrors, so admission refuses a dedicated worker there; the Bun listener path is not yet exercised.
const UNSUPPORTED_HERE = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

type ThreadInfo = { threadId: number; name: string; application?: string };
type Release = { version: number; throwAtLoad?: boolean; loadDelayMs?: number };

function resourceName(project: string): string {
	return project.replace(/(^|_)(\w)/g, (_match, _sep, letter: string) => letter.toUpperCase());
}

async function writeRelease(dir: string, project: string, { version, throwAtLoad = false, loadDelayMs = 0 }: Release) {
	await writeFile(
		join(dir, 'package.json'),
		JSON.stringify({ name: project, version: `${version}.0.0`, type: 'module' })
	);
	await writeFile(join(dir, 'config.yaml'), 'jsResource:\n  files: resources.js\nrest: true\n');
	await writeFile(
		join(dir, 'resources.js'),
		"import { threadId } from 'node:worker_threads';\n" +
			// blocking, since a resource module has no top-level await: only this worker's load is held up
			(loadDelayMs ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${loadDelayMs});\n` : '') +
			(throwAtLoad ? "throw new Error('lifecycle probe: broken at load');\n" : '') +
			`export class ${resourceName(project)} extends Resource {\n` +
			'\tstatic loadAsInstance = false;\n' +
			`\tget() { return { application: '${project}', version: ${version}, threadId }; }\n` +
			'}\n' +
			'export class SelfDrop extends Resource {\n' +
			'\tstatic loadAsInstance = false;\n' +
			`\tpost() { return server.operation({ operation: 'drop_component', project: '${project}', replicated: false }); }\n` +
			'}\n'
	);
}

async function writeDropper(dir: string) {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'config.yaml'), 'jsResource:\n  files: resources.js\nrest: true\n');
	await writeFile(
		join(dir, 'resources.js'),
		'export class WorkerDrop extends Resource {\n' +
			'\tstatic loadAsInstance = false;\n' +
			'\tasync post(target, data) {\n' +
			'\t\tconst { project, ...options } = await data;\n' +
			"\t\treturn server.operation({ operation: 'drop_component', project, ...options, replicated: false });\n" +
			'\t}\n' +
			'}\n'
	);
}

suite(
	'one isolated application starts and stops without touching the other workers',
	{ skip: UNSUPPORTED_HERE },
	(ctx: ContextWithHarper) => {
		let packageDir: string;

		/** A tarball, which installs as a tree of its own; a `file:` directory installs as a link, which is not certified. */
		async function packageTarball(project: string, release: Release): Promise<string> {
			const sourceRoot = join(packageDir, `${project}-${release.version}-source`);
			await mkdir(join(sourceRoot, 'package'), { recursive: true });
			await writeRelease(join(sourceRoot, 'package'), project, release);
			const tarball = join(packageDir, `${project}-${release.version}.0.0.tgz`);
			await writeFile(tarball, Buffer.from(await targz(sourceRoot), 'base64'));
			return `file:${tarball}`;
		}

		const auth = () =>
			`Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;

		async function rawOperation(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
			const response = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'authorization': auth() },
				body: JSON.stringify(body),
			});
			return { status: response.status, body: await response.json().catch(() => undefined) };
		}

		async function deployIsolated(project: string, release: Release, isolated = true) {
			return rawOperation({
				operation: 'deploy_component',
				project,
				package: await packageTarball(project, release),
				isolated,
				restart: true,
			});
		}

		async function threads(): Promise<ThreadInfo[]> {
			const info = await sendOperation(ctx.harper, { operation: 'system_information', attributes: ['threads'] });
			ok(Array.isArray(info.threads), 'system_information reports threads');
			return (info.threads as ThreadInfo[]).filter((thread) => thread.name === 'http');
		}

		const ids = (list: ThreadInfo[]) => list.map((thread) => thread.threadId).sort((a, b) => a - b);
		const pool = (list: ThreadInfo[]) => ids(list.filter((thread) => !thread.application));
		const dedicatedTo = (list: ThreadInfo[], application: string) =>
			list.filter((thread) => thread.application === application);
		const othersThan = (list: ThreadInfo[], application: string) =>
			ids(list.filter((thread) => thread.application !== application));

		const socketsDir = () => join(ctx.harper.dataRootDir, 'sockets');
		async function mirrorsOf(application: string): Promise<string[]> {
			return (await readdir(socketsDir()).catch(() => [] as string[])).filter((name) =>
				name.startsWith(`app-${application}-`)
			);
		}

		async function waitFor<T>(probe: () => Promise<T>, accept: (value: T) => boolean, what: string, ms = 30000) {
			const deadline = Date.now() + ms;
			let last: T;
			do {
				last = await probe();
				if (accept(last)) return last;
				await sleep(200);
			} while (Date.now() < deadline);
			throw new Error(`${what}: ${JSON.stringify(last)}`);
		}

		/** Holds for `ms`: what a stopped worker's restarted copy would undo, it would undo within that window. */
		async function staysTrue(probe: () => Promise<boolean>, what: string, ms = 3000) {
			const deadline = Date.now() + ms;
			while (Date.now() < deadline) {
				ok(await probe(), what);
				await sleep(200);
			}
		}

		function requestMirror(
			application: string,
			path: string,
			method = 'GET'
		): Promise<{ status: number; body: string }> {
			return mirrorsOf(application).then(
				(mirrors) =>
					new Promise((resolveRequest, reject) => {
						const mirror = mirrors.find((name) => name.endsWith(':9927.sock'));
						if (!mirror) return reject(new Error(`no HTTPS mirror for ${application} among ${mirrors.join(', ')}`));
						const req = request(
							{ socketPath: join(socketsDir(), mirror), path, method, headers: { authorization: auth() } },
							(res) => {
								let data = '';
								res.on('data', (chunk) => (data += chunk));
								res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, body: data }));
							}
						);
						req.on('error', reject);
						req.end();
					})
			);
		}

		async function dropOnWorker(body: Record<string, unknown>): Promise<any> {
			const response = await fetch(new URL('/WorkerDrop', ctx.harper.httpURL), {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'authorization': auth() },
				body: JSON.stringify(body),
			});
			const text = await response.text();
			strictEqual(response.status, 200, text);
			return JSON.parse(text);
		}

		async function served(application: string, version: number) {
			const response = await waitFor(
				() =>
					requestMirror(application, `/${resourceName(application)}`).catch((error) => ({
						status: 0,
						body: String(error),
					})),
				(answer) => answer.status === 200,
				`${application} never answered through its mirror`
			);
			const body = JSON.parse(response.body);
			strictEqual(body.application, application);
			strictEqual(body.version, version);
			return body;
		}

		before(async () => {
			packageDir = await mkdtemp(join(tmpdir(), 'isolated-lifecycle-'));
			const dataRootDir = await mkdtemp(
				join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
			);
			ctx.harper = { dataRootDir } as any;
			await cp(resolve(import.meta.dirname, 'fixtures/isolated-app-two'), join(dataRootDir, 'components', SIBLING), {
				recursive: true,
				dereference: true,
			});
			await writeDropper(join(dataRootDir, 'components', DROPPER));
			await startHarper(ctx, CONFIG);
			await waitFor(threads, (list) => dedicatedTo(list, SIBLING).length === 1, 'the sibling never got its worker');
		});

		after(async () => {
			await teardownHarper(ctx);
			if (packageDir) await rm(packageDir, { recursive: true, force: true });
		});

		test('the first deploy of a new isolated application starts only its own worker, certified', async () => {
			const before = await threads();
			let settled = false;
			const deploying = deployIsolated('preview_one', { version: 1, loadDelayMs: 5000 }).finally(
				() => (settled = true)
			);
			// Its tree is live while its first worker is still loading it: nothing may answer for it until that load reports.
			await waitFor(
				async () => (await readdir(join(ctx.harper.dataRootDir, 'components', 'preview_one')).catch(() => [])).length,
				(entries) => entries > 0 || settled,
				'preview_one never went live on disk'
			);
			const holdEnds = Date.now() + 2000;
			while (!settled && Date.now() < holdEnds) {
				// its mirror metadata is written while it loads; the socket that serves is bound only once it is admitted
				deepStrictEqual(
					(await mirrorsOf('preview_one')).filter((name) => name.endsWith('.sock')),
					[],
					'a mirror was bound before its canary reported'
				);
				await sleep(200);
			}
			ok(!settled || Date.now() >= holdEnds, 'the deploy answered before its canary could have reported');
			const { status, body } = await deploying;
			strictEqual(status, 200, JSON.stringify(body));
			strictEqual(body.certification, 'certified', 'its first deploy is decided by its canary');

			const after = await waitFor(
				threads,
				(list) => dedicatedTo(list, 'preview_one').length === 1,
				'no dedicated worker for preview_one'
			);
			deepStrictEqual(othersThan(after, 'preview_one'), ids(before), 'every other worker kept its thread');
			const answer = await served('preview_one', 1);
			strictEqual(answer.threadId, dedicatedTo(after, 'preview_one')[0].threadId);
		});

		test('a new isolated application that fails at load is refused: no worker, no mirror', async () => {
			const before = await threads();
			const { status, body } = await deployIsolated('preview_broken', { version: 1, throwAtLoad: true });
			strictEqual(status, 400, JSON.stringify(body));
			strictEqual(body.certification?.status, 'rejected', JSON.stringify(body));
			match(JSON.stringify(body.certification), /lifecycle probe: broken at load/);
			await staysTrue(
				async () => dedicatedTo(await threads(), 'preview_broken').length === 0,
				'a refused first release left a dedicated worker running'
			);
			deepStrictEqual(await mirrorsOf('preview_broken'), [], 'and no mirror');
			deepStrictEqual(ids(await threads()), ids(before), 'nothing else was restarted');
		});

		test('dropping an isolated application without restart stops only its worker', async () => {
			const before = await threads();
			ok(dedicatedTo(before, 'preview_one').length === 1, 'preview_one is running');
			const { status, body } = await rawOperation({ operation: 'drop_component', project: 'preview_one' });
			strictEqual(status, 200, JSON.stringify(body));
			strictEqual(body.componentRemoved, true, JSON.stringify(body));
			strictEqual(body.workerStopped, true, JSON.stringify(body));
			strictEqual(body.branchesRemoved, false, JSON.stringify(body));
			ok(typeof body.node === 'string' && body.node.length > 0, 'the result names this node');

			const after = await threads();
			deepStrictEqual(dedicatedTo(after, 'preview_one'), [], 'its worker is gone when the drop answers');
			deepStrictEqual(ids(after), othersThan(before, 'preview_one'), 'every other worker kept its thread');
			deepStrictEqual(await mirrorsOf('preview_one'), [], 'its mirrors are gone');
		});

		test('dropping an isolated application with restart: true also stops only its worker', async () => {
			strictEqual((await deployIsolated('preview_two', { version: 1 })).status, 200);
			const before = await waitFor(
				threads,
				(list) => dedicatedTo(list, 'preview_two').length === 1,
				'no dedicated worker for preview_two'
			);
			const { status, body } = await rawOperation({
				operation: 'drop_component',
				project: 'preview_two',
				restart: true,
			});
			strictEqual(status, 200, JSON.stringify(body));
			strictEqual(body.componentRemoved, true, JSON.stringify(body));
			strictEqual(body.workerStopped, true, JSON.stringify(body));
			deepStrictEqual(ids(await threads()), othersThan(before, 'preview_two'));
			deepStrictEqual(await mirrorsOf('preview_two'), []);
		});

		test('a drop run on a worker thread, as a peer runs it, stops only the worker and reports it', async () => {
			strictEqual((await deployIsolated('preview_three', { version: 1 })).status, 200);
			const before = await waitFor(
				threads,
				(list) => dedicatedTo(list, 'preview_three').length === 1,
				'no dedicated worker for preview_three'
			);
			const result = await dropOnWorker({ project: 'preview_three' });
			strictEqual(result.componentRemoved, true, JSON.stringify(result));
			strictEqual(result.workerStopped, true, JSON.stringify(result));
			strictEqual(result.branchesRemoved, false, JSON.stringify(result));
			deepStrictEqual(ids(await threads()), othersThan(before, 'preview_three'));
			deepStrictEqual(await mirrorsOf('preview_three'), []);
		});

		for (const restart of [true, false]) {
			test(`dropping a component this node does not have (restart: ${restart}) restarts nothing`, async () => {
				const before = await threads();
				const { status, body } = await rawOperation({ operation: 'drop_component', project: 'never_here', restart });
				strictEqual(status, 200, JSON.stringify(body));
				strictEqual(body.componentRemoved, false, JSON.stringify(body));
				strictEqual(body.workerStopped, false, JSON.stringify(body));
				strictEqual(body.branchesRemoved, false, JSON.stringify(body));
				await staysTrue(async () => {
					const now = await threads();
					return JSON.stringify(ids(now)) === JSON.stringify(ids(before));
				}, 'a worker was restarted');
			});
		}

		test('the same absent drop run on a worker thread restarts nothing either', async () => {
			const before = await threads();
			const result = await dropOnWorker({ project: 'never_here', restart: true });
			strictEqual(result.componentRemoved, false, JSON.stringify(result));
			await staysTrue(
				async () => JSON.stringify(ids(await threads())) === JSON.stringify(ids(before)),
				'a worker was restarted'
			);
		});

		test('flipping an existing shared application to isolated still restarts the pool', async () => {
			strictEqual((await deployIsolated('flipper', { version: 1 }, false)).status, 200);
			const shared = await threads();
			deepStrictEqual(dedicatedTo(shared, 'flipper'), [], 'it starts out shared');
			const { status, body } = await deployIsolated('flipper', { version: 2 });
			strictEqual(status, 200, JSON.stringify(body));
			const after = await waitFor(
				threads,
				(list) => dedicatedTo(list, 'flipper').length === 1,
				'the flipped application got no worker'
			);
			strictEqual(pool(after).length, POOL);
			for (const id of pool(after)) ok(!pool(shared).includes(id), `pool worker ${id} was replaced`);
			notDeepStrictEqual(pool(after), pool(shared));
			deepStrictEqual(
				ids(dedicatedTo(after, SIBLING)),
				ids(dedicatedTo(shared, SIBLING)),
				'the sibling kept its worker'
			);
		});

		test('flipping it back to shared restarts the pool and stops its worker', async () => {
			const isolated = await threads();
			const { status, body } = await deployIsolated('flipper', { version: 3 }, false);
			strictEqual(status, 200, JSON.stringify(body));
			const after = await waitFor(
				threads,
				(list) => dedicatedTo(list, 'flipper').length === 0,
				'its worker kept running'
			);
			for (const id of pool(after)) ok(!pool(isolated).includes(id), `pool worker ${id} was replaced`);
			deepStrictEqual(
				ids(dedicatedTo(after, SIBLING)),
				ids(dedicatedTo(isolated, SIBLING)),
				'the sibling kept its worker'
			);
		});

		test('an application the pool loaded while it was shared restarts the pool when it comes back isolated', async () => {
			strictEqual((await deployIsolated('reborn', { version: 1 }, false)).status, 200);
			const loaded = await threads();
			const dropped = await rawOperation({ operation: 'drop_component', project: 'reborn', restart: false });
			strictEqual(dropped.status, 200, JSON.stringify(dropped.body));
			deepStrictEqual(ids(await threads()), ids(loaded), 'a drop without restart restarts nothing');

			const { status, body } = await deployIsolated('reborn', { version: 2 });
			strictEqual(status, 200, JSON.stringify(body));
			const after = await waitFor(threads, (list) => dedicatedTo(list, 'reborn').length === 1, 'reborn got no worker');
			for (const id of pool(after)) ok(!pool(loaded).includes(id), `pool worker ${id} was replaced`);
			await served('reborn', 2);
		});

		test("another application's first deploy starts no other pending isolated application", async () => {
			const pending = await rawOperation({
				operation: 'deploy_component',
				project: 'pending_app',
				package: await packageTarball('pending_app', { version: 1 }),
				isolated: true,
				restart: false,
			});
			strictEqual(pending.status, 200, JSON.stringify(pending.body));
			const before = await threads();
			deepStrictEqual(dedicatedTo(before, 'pending_app'), [], 'a deploy without restart starts nothing');

			const { status, body } = await deployIsolated('preview_four', { version: 1 });
			strictEqual(status, 200, JSON.stringify(body));
			const after = await waitFor(threads, (list) => dedicatedTo(list, 'preview_four').length === 1, 'no worker');
			deepStrictEqual(dedicatedTo(after, 'pending_app'), [], 'the pending application stays pending');
			deepStrictEqual(othersThan(after, 'preview_four'), ids(before));
		});

		test('an isolated application can drop itself from its own worker', async () => {
			strictEqual((await deployIsolated('selfish', { version: 1 })).status, 200);
			await served('selfish', 1);
			const before = await threads();
			const response = await requestMirror('selfish', '/SelfDrop', 'POST');
			strictEqual(response.status, 200, response.body);
			const result = JSON.parse(response.body);
			strictEqual(result.componentRemoved, true, response.body);
			strictEqual(result.workerStopped, null, 'answered before its own worker stopped');
			const after = await waitFor(threads, (list) => dedicatedTo(list, 'selfish').length === 0, 'it kept running');
			deepStrictEqual(ids(after), othersThan(before, 'selfish'));
			await waitFor(
				() => mirrorsOf('selfish'),
				(mirrors) => mirrors.length === 0,
				'its mirrors stayed'
			);
		});

		test('a refused first release stays refused across a restart, and a fixed deploy is certified', async () => {
			await killHarper(ctx);
			await startHarper(ctx, CONFIG);
			await waitFor(threads, (list) => dedicatedTo(list, SIBLING).length === 1, 'the sibling never got its worker');
			await staysTrue(
				async () => dedicatedTo(await threads(), 'preview_broken').length === 0,
				'a refused release got a dedicated worker at boot'
			);
			deepStrictEqual(await mirrorsOf('preview_broken'), []);

			const before = await threads();
			const { status, body } = await deployIsolated('preview_broken', { version: 2 });
			strictEqual(status, 200, JSON.stringify(body));
			strictEqual(body.certification, 'certified');
			const after = await waitFor(threads, (list) => dedicatedTo(list, 'preview_broken').length === 1, 'no worker');
			deepStrictEqual(othersThan(after, 'preview_broken'), ids(before));
			await served('preview_broken', 2);
		});
	}
);
