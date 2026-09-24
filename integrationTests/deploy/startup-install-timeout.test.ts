import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { killHarper, startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { authHeader, getRestartRequired, operation } from './redeploy-restart-flag-helpers.ts';

const PROJECT = 'startup-install-stall';
const STARTUP_INSTALL_TIMEOUT_MS = 2000;

const INSTALL_SCRIPT = `const { appendFileSync, existsSync } = require('node:fs');
const [release, starts] = process.argv.slice(2);
appendFileSync(starts, 'started\\n');
const poll = setInterval(() => {
	if (existsSync(release)) clearInterval(poll);
}, 50);
`;

// Worker restarts on Windows routinely outlast the readiness deadlines below (harper#1813).
const skipSuite = process.platform === 'win32';

/** A component serving `{ version }` at /StalledInstallProbe/. Always a throwaway copy: loading it links node_modules/harper into it. */
async function writeFixture(version: number, withInstallScript: boolean): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'startup-install-fixture-'));
	await writeFile(join(dir, 'package.json'), JSON.stringify({ name: PROJECT, version: `${version}.0.0` }));
	await writeFile(join(dir, 'config.yaml'), 'rest: true\njsResource:\n  files: resource.js\n');
	await writeFile(
		join(dir, 'resource.js'),
		`export class StalledInstallProbe extends Resource {\n\tget() {\n\t\treturn { version: ${version} };\n\t}\n}\n`
	);
	if (withInstallScript) await writeFile(join(dir, 'install.cjs'), INSTALL_SCRIPT);
	return dir;
}

async function createGate() {
	const dir = await mkdtemp(join(tmpdir(), 'startup-install-gate-'));
	const release = join(dir, 'release');
	const starts = join(dir, 'starts');
	return {
		dir,
		release,
		installCommand: `node install.cjs ${release} ${starts}`,
		starts: async () => (existsSync(starts) ? (await readFile(starts, 'utf8')).split('\n').filter(Boolean).length : 0),
		open: () => writeFile(release, ''),
	};
}

async function probe(ctx: ContextWithHarper): Promise<{ status: number; body?: any }> {
	const response = await fetch(`${ctx.harper.httpURL}/StalledInstallProbe/`, {
		headers: { Authorization: authHeader(ctx), Accept: 'application/json' },
	});
	if (response.status !== 200) {
		await response.body?.cancel();
		return { status: response.status };
	}
	return { status: 200, body: await response.json() };
}

function readBootLog(ctx: ContextWithHarper): Promise<string> {
	return readFile(join(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'), 'hdb.log'), 'utf8');
}

// `restart_service` only queues a job; the installApplications() the restart runs is done when the job is.
async function restartWorkers(ctx: ContextWithHarper): Promise<void> {
	const { job_id: jobId } = await operation(ctx, { operation: 'restart_service', service: 'http_workers' });
	ok(jobId, 'restart_service returned a job id');
	let job: any;
	await waitUntil('the worker restart job completes', async () => {
		const result = await operation(ctx, { operation: 'get_job', id: jobId });
		job = Array.isArray(result) ? result[0] : result;
		return job?.status === 'COMPLETE' || job?.status === 'ERROR';
	});
	strictEqual(job.status, 'COMPLETE', `restart job failed: ${JSON.stringify(job)}`);
}

async function waitUntil(description: string, condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition().catch(() => false))) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting until ${description}`);
		await sleep(200);
	}
}

suite(
	'startup stops waiting for a new component install after deployment.startupInstallTimeout',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let fixtureDir: string;
		let gate: Awaited<ReturnType<typeof createGate>>;

		before(async () => {
			gate = await createGate();
			fixtureDir = await writeFixture(1, true);
			await startHarper(ctx, {
				config: {
					deployment: { startupInstallTimeout: STARTUP_INSTALL_TIMEOUT_MS },
					[PROJECT]: { package: `file:${fixtureDir}`, install: { command: gate.installCommand } },
				},
				env: {},
			});
		});

		after(async () => {
			try {
				// The install runs in its own process group, which tearing Harper down does not reach.
				if (gate) await gate.open();
				await teardownHarper(ctx);
			} finally {
				if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
				if (gate) await rm(gate.dir, { recursive: true, force: true });
			}
		});

		test('the node starts while the install is still running, without that component', async () => {
			await waitUntil('the install starts', async () => (await gate.starts()) === 1);
			ok(!existsSync(gate.release), 'and cannot have finished');
			ok(await operation(ctx, { operation: 'get_status' }), 'the operations API answers');
			strictEqual((await probe(ctx)).status, 404, 'the component is not loaded');
			match(
				await readBootLog(ctx),
				new RegExp(`Startup is no longer waiting for ${PROJECT}: its preparation is still running`)
			);
		});

		test('a worker restart during the stall neither starts a second install nor waits for the first', async () => {
			await restartWorkers(ctx);
			strictEqual(await gate.starts(), 1);
			strictEqual(await getRestartRequired(ctx), false, 'nothing has finished yet');
		});

		test('when the install finishes it is recorded, a restart is requested, and a restart loads it', async () => {
			await gate.open();
			await waitUntil('get_status reports restartRequired', () => getRestartRequired(ctx));
			strictEqual(await gate.starts(), 1, 'the install ran exactly once');
			const lock = JSON.parse(await readFile(join(ctx.harper.dataRootDir, 'harper-application-lock.json'), 'utf8'));
			deepStrictEqual(Object.keys(lock.applications), [PROJECT], 'the completed install is recorded');

			await restartWorkers(ctx);
			await waitUntil('the component serves', async () => (await probe(ctx)).status === 200);
			strictEqual(await gate.starts(), 1, 'the restart reused the recorded install');
		});
	}
);

for (const threadCount of [1, 0]) {
	suite(
		`an existing component whose reinstall stalls keeps its installed version (threads.count: ${threadCount})`,
		// Under Bun a threads.count: 0 boot already fails before any install stalls: the main thread binds the
		// operations port twice ("Listen method has been called more than once without closing").
		{ skip: skipSuite || (threadCount === 0 && process.env.HARPER_RUNTIME === 'bun') },
		(ctx: ContextWithHarper) => {
			let installedDir: string;
			let replacementDir: string;
			let gate: Awaited<ReturnType<typeof createGate>>;
			const config = (component: Record<string, unknown>) => ({
				threads: { count: threadCount },
				deployment: { startupInstallTimeout: STARTUP_INSTALL_TIMEOUT_MS },
				[PROJECT]: component,
			});

			before(async () => {
				gate = await createGate();
				installedDir = await writeFixture(1, false);
				replacementDir = await writeFixture(2, true);
				await startHarper(ctx, { config: config({ package: `file:${installedDir}` }), env: {} });
				await waitUntil('version 1 serves', async () => (await probe(ctx)).body?.version === 1);
				await killHarper(ctx);
				await startHarper(ctx, {
					config: config({ package: `file:${replacementDir}`, install: { command: gate.installCommand } }),
					env: {},
				});
			});

			after(async () => {
				try {
					if (gate) await gate.open();
					await teardownHarper(ctx);
				} finally {
					for (const dir of [installedDir, replacementDir, gate?.dir]) {
						if (dir) await rm(dir, { recursive: true, force: true });
					}
				}
			});

			test('the node starts and serves the installed version while the reinstall runs', async () => {
				await waitUntil('the reinstall starts', async () => (await gate.starts()) === 1);
				ok(!existsSync(gate.release));
				await waitUntil('version 1 serves', async () => (await probe(ctx)).body?.version === 1);
			});

			test('when the reinstall finishes it is recorded and a restart is requested', async () => {
				await gate.open();
				await waitUntil('get_status reports restartRequired', () => getRestartRequired(ctx));
				const lock = JSON.parse(await readFile(join(ctx.harper.dataRootDir, 'harper-application-lock.json'), 'utf8'));
				strictEqual(lock.applications[PROJECT]?.package, `file:${replacementDir}`);
			});
		}
	);
}
