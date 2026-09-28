/**
 * `deploy_component` executed on a worker thread, the way a replicated peer executes it, under each lockdown
 * mode. The deployer component calls `server.operation()` from a worker, so a single node reaches that path.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { startHarper, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';
import { authHeader, operation } from './redeploy-restart-flag-helpers.ts';

const DEPLOYER_PROJECT = 'worker-deployer';

async function buildDeployerPayload(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'worker-deployer-'));
	try {
		await writeFile(join(directory, 'config.yaml'), 'jsResource:\n  files: resources.js\nrest: true\n');
		await writeFile(
			join(directory, 'resources.js'),
			"import { isMainThread } from 'node:worker_threads';\n" +
				'export class WorkerDeploy extends Resource {\n' +
				'\tstatic loadAsInstance = false;\n' +
				'\tasync post(target, data) {\n' +
				'\t\tconst { project, payload } = await data;\n' +
				'\t\tif (!project) return { ready: true };\n' +
				'\t\ttry {\n' +
				"\t\t\tconst result = await server.operation({ operation: 'deploy_component', project, payload, restart: false, replicated: false });\n" +
				'\t\t\treturn { ok: true, isMainThread, message: result?.message };\n' +
				'\t\t} catch (error) {\n' +
				'\t\t\treturn { ok: false, isMainThread, error: String(error?.message ?? error) };\n' +
				'\t\t}\n' +
				'\t}\n' +
				'}\n'
		);
		return await targz(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/**
 * A component whose npm dependency (installed from a vendored tarball, so it lands in a real
 * `node_modules/` and is loaded natively, exactly like reflect-metadata) defines a property on
 * `Reflect` when it is evaluated.
 */
async function buildReflectExtendingPayload(project: string, property: string, version: number): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'reflect-extending-'));
	const packageRoot = await mkdtemp(join(tmpdir(), 'reflect-extender-package-'));
	try {
		await mkdir(join(packageRoot, 'package'));
		await writeFile(
			join(packageRoot, 'package', 'package.json'),
			JSON.stringify({ name: 'reflect-extender', version: '1.0.0', main: 'index.js' }) + '\n'
		);
		await writeFile(
			join(packageRoot, 'package', 'index.js'),
			'// what reflect-metadata does at load: define its API directly on the global Reflect\n' +
				`Object.defineProperty(Reflect, ${JSON.stringify(property)}, { configurable: true, writable: true, value: function decorate() { return 'decorated'; } });\n` +
				`module.exports = { decorate: () => Reflect[${JSON.stringify(property)}]() };\n`
		);
		await mkdir(join(directory, 'vendor'));
		await writeFile(
			join(directory, 'vendor', 'reflect-extender-1.0.0.tgz'),
			Buffer.from(await targz(packageRoot), 'base64')
		);
		await writeFile(
			join(directory, 'package.json'),
			JSON.stringify({
				name: project,
				version: '1.0.0',
				type: 'module',
				dependencies: { 'reflect-extender': 'file:vendor/reflect-extender-1.0.0.tgz' },
			}) + '\n'
		);
		await writeFile(join(directory, 'config.yaml'), 'jsResource:\n  files: resources.js\nrest: true\n');
		const className = resourceName(project);
		await writeFile(
			join(directory, 'resources.js'),
			"import extender from 'reflect-extender';\n" +
				`export class ${className} extends Resource {\n` +
				'\tstatic loadAsInstance = false;\n' +
				`\tget() { return { version: ${version}, decorated: extender.decorate() }; }\n` +
				'}\n'
		);
		return await targz(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
		await rm(packageRoot, { recursive: true, force: true });
	}
}

async function buildThrowingPayload(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'throwing-candidate-'));
	try {
		await writeFile(join(directory, 'config.yaml'), 'jsResource:\n  files: resources.js\nrest: true\n');
		await writeFile(join(directory, 'resources.js'), "throw new Error('candidate is broken at load');\n");
		return await targz(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function resourceName(project: string): string {
	return project.replace(/(^|-)(\w)/g, (_match, _dash, letter: string) => letter.toUpperCase());
}

async function deployFromWorker(
	ctx: ContextWithHarper,
	project: string,
	payload: string
): Promise<{ ok: boolean; isMainThread: boolean; message?: string; error?: string }> {
	const response = await fetch(`${ctx.harper.httpURL}/WorkerDeploy/`, {
		method: 'POST',
		headers: { 'Authorization': authHeader(ctx), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project, payload }),
	});
	strictEqual(response.status, 200, `WorkerDeploy answered ${response.status}: ${await response.clone().text()}`);
	return response.json();
}

async function readResource(ctx: ContextWithHarper, name: string): Promise<{ status?: number; body?: any }> {
	try {
		const response = await fetch(`${ctx.harper.httpURL}/${name}`, { headers: { Authorization: authHeader(ctx) } });
		if (response.status !== 200) return { status: response.status, body: await response.text() };
		return { status: 200, body: await response.json() };
	} catch (error) {
		// restart: true returns before the replacement worker is listening
		return { body: String(error) };
	}
}

async function waitForResource(ctx: ContextWithHarper, name: string, predicate: (body: any) => boolean) {
	const deadline = Date.now() + 60_000;
	let last;
	while (Date.now() < deadline) {
		last = await readResource(ctx, name);
		if (last.status === 200 && predicate(last.body)) return last.body;
		await sleep(250);
	}
	throw new Error(`Timed out waiting for /${name}; last answer ${JSON.stringify(last)}`);
}

async function waitForDeployer(ctx: ContextWithHarper) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${ctx.harper.httpURL}/WorkerDeploy/`, {
				method: 'POST',
				headers: { 'Authorization': authHeader(ctx), 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			await response.body?.cancel();
			if (response.status === 200) return;
		} catch {}
		await sleep(250);
	}
	throw new Error('Timed out waiting for the worker deployer');
}

async function startWithDeployer(ctx: ContextWithHarper, config: Record<string, unknown>) {
	await startHarper(ctx, { config: { threads: { count: 1 }, ...config } });
	await restartWorkersFromMainThread(ctx);
}

/** (Re)deploys the deployer through the operations API, which runs on the main thread, and restarts the workers. */
async function restartWorkersFromMainThread(ctx: ContextWithHarper) {
	await operation(ctx, {
		operation: 'deploy_component',
		project: DEPLOYER_PROJECT,
		payload: await buildDeployerPayload(),
		restart: true,
	});
	await waitForDeployer(ctx);
}

suite('deploy_component on a worker thread under freeze-after-load (harper#2881)', (ctx: ContextWithHarper) => {
	before(async () => {
		await startWithDeployer(ctx, {});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a dependency that extends Reflect at load deploys from a worker on its first load there, and serves once workers restart', async () => {
		const project = 'reflect-first-load';
		const result = await deployFromWorker(
			ctx,
			project,
			await buildReflectExtendingPayload(project, 'harperProbeFirstLoad', 1)
		);
		strictEqual(result.isMainThread, false, 'the deploy must execute on a worker thread to exercise the peer path');
		ok(result.ok, `deploy from a worker failed: ${result.error}`);

		await restartWorkersFromMainThread(ctx);
		await waitForResource(ctx, resourceName(project), (body) => body.version === 1 && body.decorated === 'decorated');
	});

	test('the same dependency redeploys from a worker that loaded the live copy at boot', async () => {
		const project = 'reflect-redeploy';
		// Through the operations API, so the restarted worker loads it at boot, before its intrinsics freeze.
		await operation(ctx, {
			operation: 'deploy_component',
			project,
			payload: await buildReflectExtendingPayload(project, 'harperProbeRedeploy', 1),
			restart: true,
		});
		await waitForResource(ctx, resourceName(project), (body) => body.version === 1 && body.decorated === 'decorated');
		await waitForDeployer(ctx);

		const result = await deployFromWorker(
			ctx,
			project,
			await buildReflectExtendingPayload(project, 'harperProbeRedeploy', 2)
		);
		strictEqual(result.isMainThread, false);
		ok(result.ok, `redeploy from a worker failed: ${result.error}`);
	});

	test('a frozen worker does not load-validate, like the main thread: a candidate that throws at load is activated', async () => {
		const project = 'broken-at-load';
		const result = await deployFromWorker(ctx, project, await buildThrowingPayload());
		strictEqual(result.isMainThread, false);
		ok(result.ok, `the deploy was rejected: ${result.error}`);

		await restartWorkersFromMainThread(ctx);
		const deadline = Date.now() + 30_000;
		let status: string | undefined;
		while (Date.now() < deadline) {
			const { componentStatus = [] } = await operation(ctx, { operation: 'get_status' });
			status = componentStatus.find((entry: { name: string }) => entry.name === `${project}.jsResource`)?.status;
			if (status === 'error') break;
			await sleep(250);
		}
		strictEqual(status, 'error', `expected ${project} to report its load failure`);
	});
});

suite('deploy_component on a worker thread under lockdown: none', (ctx: ContextWithHarper) => {
	before(async () => {
		await startWithDeployer(ctx, { applications: { lockdown: 'none' } });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a dependency that extends Reflect at load deploys from a worker', async () => {
		const project = 'reflect-unfrozen';
		const result = await deployFromWorker(
			ctx,
			project,
			await buildReflectExtendingPayload(project, 'harperProbeUnfrozen', 1)
		);
		strictEqual(result.isMainThread, false);
		ok(result.ok, `deploy from a worker failed: ${result.error}`);
	});

	test('the worker still load-validates: a candidate that throws at load is rejected', async () => {
		const project = 'broken-at-load';
		const result = await deployFromWorker(ctx, project, await buildThrowingPayload());
		strictEqual(result.isMainThread, false);
		strictEqual(result.ok, false, 'a candidate that cannot load must not be activated');
		ok(result.error?.includes('candidate is broken at load'), `unexpected rejection: ${result.error}`);
	});
});

suite('deploy_component on a worker thread under lockdown: freeze', (ctx: ContextWithHarper) => {
	before(async () => {
		await startWithDeployer(ctx, { applications: { lockdown: 'freeze' } });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('the worker still load-validates: a dependency that extends Reflect at load is rejected, as it fails at boot here too', async () => {
		const project = 'reflect-eager-freeze';
		const result = await deployFromWorker(
			ctx,
			project,
			await buildReflectExtendingPayload(project, 'harperProbeEagerFreeze', 1)
		);
		strictEqual(result.isMainThread, false);
		strictEqual(result.ok, false, 'a candidate that cannot load at boot must not be activated');
		ok(
			result.error?.includes('Cannot define property harperProbeEagerFreeze'),
			`unexpected rejection: ${result.error}`
		);
	});
});
