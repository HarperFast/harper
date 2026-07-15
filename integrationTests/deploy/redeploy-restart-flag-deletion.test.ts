/**
 * Redeploy of an active jsResource component that *deletes* a resource file must also flag
 * restartRequired (harper#1817 follow-up).
 *
 * The original harper#1817 fix (see redeploy-restart-flag.test.ts) handles a redeployed file whose
 * *contents* changed: the fresh post-redeploy chokidar scan re-emits every surviving file as `'add'`,
 * and jsResource treats a re-`add` of an already-loaded file like a change. But a redeploy that
 * removes a resource file entirely produces no event at all for it — no re-`add`, no `unlink` —
 * because the fresh watcher's initial scan only reports what's currently on disk and has no memory
 * of the prior tree. Left unhandled, the deleted resource stays registered and active in memory,
 * with no signal to the operator that anything changed.
 *
 * This test deploys a jsResource component with a single resource file, then redeploys with that
 * file entirely absent (restart:false), and asserts `get_status.restartRequired` flips to `true`.
 * Against the pre-fix code this test fails: no event fires for the missing file at all, so nothing
 * ever calls requestRestart().
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { startHarper, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';

const PROJECT = 'redeploy-restart-flag-deletion-app';

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
	return status ? status.restartRequired === true : false;
}

/**
 * Build a tar.gz payload for the fixture app. `includeResourceFile: false` omits resources.js
 * entirely — simulating a redeploy that deletes the component's only resource file — while still
 * deploying a valid app (config.yaml alone is a legal, if resource-less, jsResource component).
 */
async function buildPayload(includeResourceFile: boolean): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'redeploy-deletion-fixture-'));
	try {
		await writeFile(join(dir, 'config.yaml'), 'jsResource:\n  files: resources.js\nrest: true\n');
		if (includeResourceFile) {
			await writeFile(
				join(dir, 'resources.js'),
				'export class Version extends Resource {\n' +
					'\tstatic loadAsInstance = false;\n' +
					'\tget() {\n' +
					'\t\treturn { version: 1 };\n' +
					'\t}\n' +
					'}\n'
			);
		}
		return await targz(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function readVersion(ctx: ContextWithHarper): Promise<number | undefined> {
	let response: Response;
	try {
		response = await fetch(`${ctx.harper.httpURL}/Version`, { headers: { Authorization: authHeader(ctx) } });
	} catch {
		return undefined;
	}
	if (response.status !== 200) {
		await response.body?.cancel();
		return undefined;
	}
	const body = (await response.json()) as { version?: number } | null;
	return body ? body.version : undefined;
}

suite('Redeploy deleting a resource file flags restartRequired (harper#1817 follow-up)', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('initial deploy (restart:true) serves the Version resource', async () => {
		const body = await operation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			payload: await buildPayload(true),
			restart: true,
		});
		ok(body.message?.includes(`Successfully deployed: ${PROJECT}`), `unexpected deploy message: ${body.message}`);

		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if ((await readVersion(ctx)) === 1) return;
			await sleep(250);
		}
		throw new Error('Timed out waiting for deployed Version resource to serve version 1');
	});

	test('redeploy (restart:false) that deletes resources.js flags restartRequired', async () => {
		// A fresh restart resets the flag; confirm the clean baseline before the redeploy.
		strictEqual(await getRestartRequired(ctx), false, 'expected restartRequired=false after a fresh restart');

		await operation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			payload: await buildPayload(false),
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
		ok(flagged, 'redeploy deleting resources.js did not flag restartRequired (harper#1817 deletion-gap regression)');

		// No restart was requested by the operator, so the stale, still-registered resource keeps
		// serving — the point is that restartRequired now tells the operator a restart is needed.
		strictEqual(await readVersion(ctx), 1, 'expected the stale Version resource to remain live until a restart');
	});
});
