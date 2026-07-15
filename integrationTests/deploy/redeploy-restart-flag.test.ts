/**
 * Redeploy of an active jsResource component with `restart: false` must flag restartRequired
 * (harper#1817).
 *
 * The regression: a redeploy pauses/resumes the component's file watcher; the fresh chokidar scan
 * re-emits every existing file as `'add'`. jsResource only requested a restart on non-`'add'`
 * events, so a redeploy with changed code never flagged restartRequired and silently kept serving
 * the old module. This test deploys a jsResource component, redeploys a modified copy with
 * `restart: false`, and asserts `get_status.restartRequired` flips to `true` (and, because no
 * restart is performed, the old code is still what's served — the operator is informed rather than
 * left guessing). Against the pre-fix code the flag stays `false` and this test fails.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { startHarper, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';

const PROJECT = 'redeploy-restart-flag-app';
const FIXTURE_DIR = join(import.meta.dirname, 'redeploy-restart-flag-fixture');

function authHeader(ctx: ContextWithHarper): string {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

async function operation(ctx: ContextWithHarper, body: Record<string, unknown>): Promise<any> {
	const response = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Authorization': authHeader(ctx), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	strictEqual(response.status, 200, `operation ${body.operation} failed with ${response.status}`);
	return response.json();
}

async function getRestartRequired(ctx: ContextWithHarper): Promise<boolean> {
	const status = await operation(ctx, { operation: 'get_status' });
	return status.restartRequired === true;
}

/** Build a tar.gz of the fixture with `resources.js` rewritten to report `version`. */
async function buildPayload(version: number): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'redeploy-fixture-'));
	try {
		await copyFile(join(FIXTURE_DIR, 'config.yaml'), join(dir, 'config.yaml'));
		await writeFile(
			join(dir, 'resources.js'),
			`const VERSION = ${version};\n` +
				`export class Version extends Resource {\n` +
				`\tstatic loadAsInstance = false;\n` +
				`\tget() {\n` +
				`\t\treturn { version: VERSION };\n` +
				`\t}\n` +
				`}\n`
		);
		return await targz(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function readVersion(ctx: ContextWithHarper): Promise<number | undefined> {
	const response = await fetch(`${ctx.harper.httpURL}/Version`, { headers: { Authorization: authHeader(ctx) } });
	if (response.status !== 200) {
		await response.body?.cancel();
		return undefined;
	}
	const body = (await response.json()) as { version?: number };
	return body.version;
}

suite('Redeploy with restart:false flags restartRequired (harper#1817)', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('initial deploy (restart:true) serves version 1', async () => {
		const body = await operation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			payload: await buildPayload(1),
			restart: true,
		});
		ok(body.message?.includes(`Successfully deployed: ${PROJECT}`), `unexpected deploy message: ${body.message}`);

		// restart:true returns before the new process is fully listening; poll until the resource is live.
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if ((await readVersion(ctx)) === 1) return;
			await sleep(250);
		}
		throw new Error('Timed out waiting for deployed Version resource to serve version 1');
	});

	test('redeploy (restart:false) with changed code flags restartRequired', async () => {
		// A fresh restart resets the flag; confirm the clean baseline before the redeploy.
		strictEqual(await getRestartRequired(ctx), false, 'expected restartRequired=false after a fresh restart');

		await operation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			payload: await buildPayload(2),
			restart: false,
		});

		// The post-redeploy watcher rescan is asynchronous; poll until the flag flips.
		let flagged = false;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (await getRestartRequired(ctx)) {
				flagged = true;
				break;
			}
			await sleep(250);
		}
		ok(flagged, 'redeploy with restart:false did not flag restartRequired (harper#1817 regression)');

		// No restart was requested by the operator, so the old code is still what's served — the point
		// is that restartRequired now tells them a restart is needed, instead of failing silently.
		strictEqual(await readVersion(ctx), 1, 'expected old code (version 1) to remain live until a restart');
	});
});
