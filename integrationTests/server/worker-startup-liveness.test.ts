/**
 * Regression test for the pre-ready worker event-loop drain (harper#2312, "Worker (index N)
 * exited with code 0 before reporting ready"): a worker whose component load awaits a
 * completion delivered through a non-ref-holding source must stay alive until the ready
 * handshake instead of clean-exiting when its ref'd-handle set drains.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/worker-startup-liveness');
const WORKERS = 2;

suite('worker startup liveness (pre-ready event-loop drain)', (ctx: ContextWithHarper) => {
	let rootFixtureCopy: string;

	before(async () => {
		// Mount the fixture twice: as a regular app (app-component window) and as a root config
		// component (root-component window, where the CI failures die). The root mount points at a
		// throwaway copy because symlinkHarperModule writes a node_modules/harper symlink into the
		// mounted directory, which must never land in the source tree.
		rootFixtureCopy = await mkdtemp(join(tmpdir(), 'harper-liveness-root-'));
		await cp(FIXTURE_PATH, rootFixtureCopy, { recursive: true });
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				'threads': { count: WORKERS },
				'liveness-root': { package: `file:${rootFixtureCopy}` },
			},
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
		if (rootFixtureCopy) await rm(rootFixtureCopy, { recursive: true, force: true });
	});

	test('workers survive a load-time await with no ref-holding completion source', async () => {
		ok(ctx.harper.process && ctx.harper.process.exitCode === null, 'Harper process should be running');
		const { username, password } = ctx.harper.admin;
		const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
		const response = await fetch(`${ctx.harper.httpURL}/LivenessProbe/`, {
			headers: { Authorization: authorization },
		});
		strictEqual(response.status, 200, `expected the fixture resource to serve; got ${response.status}`);
	});

	test('no worker exited before reporting ready', async () => {
		const logDir = ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log');
		let contents = '';
		try {
			contents = await readFile(join(logDir, 'hdb.log'), 'utf8');
		} catch {
			// no log file means nothing was logged — acceptable
		}
		ok(
			!/exited with code \d+ before reporting ready/.test(contents),
			`a worker exited before reporting ready:\n${contents.slice(-2000)}`
		);
	});
});
