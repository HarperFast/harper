/**
 * Shutdown-drain end-to-end verification — PR#1621 (components/shutdownDrain.ts).
 *
 * Pins: (A) in-flight work registered via a ShutdownDrain survives a genuine worker
 * restart — the worker's EXIT marker appears only AFTER the task's DONE marker; (B) a
 * permanently-stalled drain is force-killed at the configured ceiling
 * (replication.blobSendDrainTimeout) rather than hanging shutdown indefinitely.
 *
 * Run: npm run build && HARPER_INTEGRATION_TEST_INSTALL_SCRIPT=dist/bin/harper.js \
 *      npm run test:integration -- "integrationTests/components/shutdown-drain-e2e.test.ts"
 * (HARPER_INTEGRATION_TEST_INSTALL_SCRIPT is required so the test runs against this repo's
 * own dist build, not an independently-installed `harper` package.)
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/shutdown-drain-e2e');
const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SHUTDOWN_DRAIN_ABS_PATH = resolve(REPO_ROOT, 'dist/components/shutdownDrain.js');
const MARKER_FILE = resolve(tmpdir(), `shutdown-drain-e2e-${randomUUID()}.log`);

const TASK_DELAY_MS = 2000;
const CEILING_MS = 5000;

const skipSuite = process.platform === 'win32';

interface Marker {
	t: number;
	pid: number;
	tid: number;
}

function readMarkers(): Record<string, Marker[]> {
	if (!existsSync(MARKER_FILE)) return {};
	const lines = readFileSync(MARKER_FILE, 'utf8').trim().split('\n').filter(Boolean);
	const byTag: Record<string, Marker[]> = {};
	for (const line of lines) {
		const m = line.match(/^(\S+) t=(\d+) pid=(\d+) tid=(\d+)/);
		if (!m) continue;
		const [, tag, t, pid, tid] = m;
		(byTag[tag] ??= []).push({ t: Number(t), pid: Number(pid), tid: Number(tid) });
	}
	return byTag;
}

suite('shutdown-drain end-to-end (real worker restart, #1621)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	let auth: string;

	before(async () => {
		if (!existsSync(SHUTDOWN_DRAIN_ABS_PATH)) {
			throw new Error(`dist build missing: ${SHUTDOWN_DRAIN_ABS_PATH} — run \`npm run build\` first`);
		}
		rmSync(MARKER_FILE, { force: true });

		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: 1 },
				replication: { blobSendDrainTimeout: CEILING_MS },
			},
			env: {
				QA519_SHUTDOWN_DRAIN_ABS_PATH: SHUTDOWN_DRAIN_ABS_PATH,
				QA519_MARKER_FILE: MARKER_FILE,
				QA519_TASK_DELAY_MS: String(TASK_DELAY_MS),
			},
		} as any);

		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		auth = client.headers.Authorization;

		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			try {
				const r = await fetch(`${httpURL}/TaskProbe/`, { headers: { Authorization: auth } });
				if (r.status === 200) break;
			} catch {
				/* not ready */
			}
			await sleep(250);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
		rmSync(MARKER_FILE, { force: true });
	});

	async function probe(): Promise<any> {
		const r = await fetch(`${httpURL}/TaskProbe/`, { headers: { Authorization: auth } });
		return r.json();
	}

	async function probeStart(action: string): Promise<any> {
		const r = await fetch(`${httpURL}/TaskProbe/?action=${action}`, { headers: { Authorization: auth } });
		return r.json();
	}

	function fireRestart() {
		fetch(client.operationsURL, {
			method: 'POST',
			headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'restart_service', service: 'http_workers' }),
			signal: AbortSignal.timeout(90_000),
		}).catch(() => {
			/* response may not return if its handling worker is the one being recycled */
		});
	}

	test(
		'A: real in-flight task survives a genuine worker restart (drain waits for it)',
		{ timeout: 60_000 },
		async () => {
			const start = await probeStart('start');
			const originalTid = start.tid;
			ok(typeof originalTid === 'number', `expected a numeric threadId, got ${JSON.stringify(start)}`);
			const startedAt = Date.now();

			await sleep(300);
			const shutdownTriggeredAt = Date.now();
			fireRestart();

			let newTid: number | undefined;
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					const p = await probe();
					if (p.tid !== originalTid) {
						newTid = p.tid;
						break;
					}
				} catch {
					/* worker mid-restart */
				}
				await sleep(200);
			}
			ok(newTid !== undefined, `worker never rolled to a new thread (still tid=${originalTid})`);

			await sleep(500);
			const markers = readMarkers();
			const forTid = (tag: string) => (markers[tag] ?? []).filter((m) => m.tid === originalTid);
			const done = forTid('A_DONE')[0];
			const drainEnter = forTid('A_DRAIN_ENTER')[0];
			const drainExit = forTid('A_DRAIN_EXIT')[0];
			const exit = forTid('A_EXIT')[0];

			console.log(
				`[shutdown-drain-A] tid=${originalTid}→${newTid} start=${startedAt} shutdown=${shutdownTriggeredAt} ` +
					`DRAIN_ENTER=${drainEnter?.t} DONE=${done?.t} (+${done ? done.t - startedAt : 'N/A'}ms) ` +
					`DRAIN_EXIT=${drainExit?.t} EXIT=${exit?.t}`
			);

			ok(drainEnter, `drain() was never invoked for the original worker (tid=${originalTid})`);
			ok(
				done,
				`in-flight task completion marker (A_DONE) never appeared for tid=${originalTid} — task cut off before finishing`
			);
			ok(
				done.t - startedAt >= TASK_DELAY_MS - 250,
				`task completed too early (elapsed=${done.t - startedAt}ms, expected >= ~${TASK_DELAY_MS}ms)`
			);
			ok(exit, `worker never logged its own EXIT marker (tid=${originalTid})`);
			ok(
				exit.t >= done.t,
				`worker EXITED (t=${exit.t}) BEFORE in-flight task completed (DONE t=${done.t}) — shutdown did not wait`
			);
			ok(drainExit, `drain() was invoked but never resolved for tid=${originalTid}`);
		}
	);

	test(
		'B: permanently-stalled drain is force-killed at the configured ceiling, not left hanging',
		{ timeout: CEILING_MS + 60_000 },
		async () => {
			const start = await probeStart('start-stall');
			const stallTid = start.tid;
			ok(typeof stallTid === 'number', `expected a numeric threadId, got ${JSON.stringify(start)}`);

			const shutdownTriggeredAt = Date.now();
			fireRestart();

			let newTid: number | undefined;
			const deadline = Date.now() + CEILING_MS + 30_000;
			while (Date.now() < deadline) {
				try {
					const p = await probe();
					if (p.tid !== stallTid) {
						newTid = p.tid;
						break;
					}
				} catch {
					/* worker mid-restart */
				}
				await sleep(250);
			}
			ok(
				newTid !== undefined,
				`stalled worker (tid=${stallTid}) never rolled within ceiling+30s — drain hung shutdown indefinitely`
			);

			await sleep(500);
			const markers = readMarkers();
			const forTid = (tag: string) => (markers[tag] ?? []).filter((m) => m.tid === stallTid);
			const drainEnter = forTid('B_DRAIN_ENTER')[0];
			const exit = forTid('B_EXIT')[0];
			const unexpectedExit = forTid('B_DRAIN_EXIT_UNEXPECTED')[0];

			const forceKillDelay = exit ? exit.t - shutdownTriggeredAt : undefined;
			console.log(
				`[shutdown-drain-B] tid=${stallTid}→${newTid} shutdown=${shutdownTriggeredAt} ` +
					`DRAIN_ENTER=${drainEnter?.t} EXIT=${exit?.t} forceKillDelay=${forceKillDelay}ms ceiling=${CEILING_MS}ms`
			);

			ok(drainEnter, `drain() was never invoked for the stalled worker (tid=${stallTid})`);
			ok(!unexpectedExit, `drain() somehow resolved for a promise designed to never resolve — test bug?`);
			ok(exit, `stalled worker never logged its own EXIT marker (tid=${stallTid})`);
			ok(
				forceKillDelay! < CEILING_MS + 20_000,
				`stalled worker took ${forceKillDelay}ms to exit — expected roughly ${CEILING_MS}ms ceiling, not indefinite`
			);
			ok(
				forceKillDelay! >= CEILING_MS - 1500,
				`stalled worker exited suspiciously early (${forceKillDelay}ms) vs ${CEILING_MS}ms ceiling`
			);
		}
	);
});
