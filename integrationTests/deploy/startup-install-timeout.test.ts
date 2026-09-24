/**
 * Startup waits for component preparation at most `deployment.startupInstallTimeout` (harper#2072). Before it,
 * `installApplications()` awaited every preparation with no bound, and listeners open only after it returns, so
 * one component whose install never finished kept the whole node down — no operations API, no status — silently.
 *
 * The component's install command blocks until a sentinel file appears, so the test decides when it finishes,
 * and counts its starts so a restart during the stall can be shown not to begin a second install.
 *
 * Run: npm run test:integration -- "integrationTests/deploy/startup-install-timeout.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
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

async function probeStatus(ctx: ContextWithHarper): Promise<number> {
	const response = await fetch(`${ctx.harper.httpURL}/StalledInstallProbe/`, {
		headers: { Authorization: authHeader(ctx) },
	});
	await response.body?.cancel();
	return response.status;
}

/** `restart_service` only queues a job; the restart (and the installApplications() it runs) is done when that is. */
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
	'startup stops waiting for a component install after deployment.startupInstallTimeout',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let fixtureDir: string;
		let gateDir: string;
		const releasePath = () => join(gateDir, 'release');
		const startsPath = () => join(gateDir, 'starts');
		const installStarts = async () =>
			existsSync(startsPath()) ? (await readFile(startsPath(), 'utf8')).split('\n').filter(Boolean).length : 0;

		before(async () => {
			gateDir = await mkdtemp(join(tmpdir(), 'startup-install-gate-'));
			// A throwaway copy, because loading the component links node_modules/harper into its directory.
			fixtureDir = await mkdtemp(join(tmpdir(), 'startup-install-fixture-'));
			await writeFile(join(fixtureDir, 'package.json'), JSON.stringify({ name: PROJECT, version: '1.0.0' }));
			await writeFile(join(fixtureDir, 'config.yaml'), 'rest: true\njsResource:\n  files: resource.js\n');
			await writeFile(
				join(fixtureDir, 'resource.js'),
				'export class StalledInstallProbe extends Resource {\n\tget() {\n\t\treturn { ok: true };\n\t}\n}\n'
			);
			await writeFile(join(fixtureDir, 'install.cjs'), INSTALL_SCRIPT);
			await startHarper(ctx, {
				config: {
					deployment: { startupInstallTimeout: STARTUP_INSTALL_TIMEOUT_MS },
					[PROJECT]: {
						package: `file:${fixtureDir}`,
						install: { command: `node install.cjs ${releasePath()} ${startsPath()}` },
					},
				},
				env: {},
			});
		});

		after(async () => {
			try {
				// The install runs in its own process group, which tearing Harper down does not reach.
				if (gateDir) await writeFile(releasePath(), '');
				await teardownHarper(ctx);
			} finally {
				if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
				if (gateDir) await rm(gateDir, { recursive: true, force: true });
			}
		});

		test('the node starts while the install is still running, without that component', async () => {
			strictEqual(await installStarts(), 1, 'the install had started');
			ok(!existsSync(releasePath()), 'and cannot have finished');
			const status = await operation(ctx, { operation: 'get_status' });
			ok(status, 'the operations API answers');
			strictEqual(await probeStatus(ctx), 404, 'the component is not loaded');
			const log = await readFile(join(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'), 'hdb.log'), 'utf8');
			match(log, new RegExp(`Startup is no longer waiting for ${PROJECT}: its preparation has not finished`));
		});

		test('a worker restart during the stall waits on the same install instead of starting another', async () => {
			await restartWorkers(ctx);
			strictEqual(await installStarts(), 1);
			strictEqual(await getRestartRequired(ctx), false, 'nothing has finished yet');
		});

		test('when the install finishes it is recorded, a restart is requested, and a restart loads it', async () => {
			await writeFile(releasePath(), '');
			await waitUntil('get_status reports restartRequired', () => getRestartRequired(ctx));
			strictEqual(await installStarts(), 1, 'the install ran exactly once');
			const lock = JSON.parse(await readFile(join(ctx.harper.dataRootDir, 'harper-application-lock.json'), 'utf8'));
			deepStrictEqual(Object.keys(lock.applications), [PROJECT], 'the completed install is recorded');

			await restartWorkers(ctx);
			await waitUntil('the component serves', async () => (await probeStatus(ctx)) === 200);
			strictEqual(await installStarts(), 1, 'the restart reused the recorded install');
		});
	}
);
