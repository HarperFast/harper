import assert from 'node:assert';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';

const profilePreload = fileURLToPath(new URL('./profile-preload.cjs', import.meta.url));
const churnPreload = fileURLToPath(new URL('./churn-preload.cjs', import.meta.url));

async function waitForFile(path: string, description: string, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function startWorker(preload: string, dir: string, provideGcHook = false) {
	const worker = new Worker(
		`${provideGcHook ? 'globalThis.gc = () => {};' : ''} const { parentPort, threadId } = require("node:worker_threads"); parentPort.postMessage(threadId); setInterval(() => {}, 1000);`,
		{
			eval: true,
			workerData: { name: 'http' },
			env: { ...process.env, WS_SCALE_CONTROL_DIR: dir },
			execArgv: ['--require', preload],
		}
	);
	const [threadId] = await once(worker, 'message');
	return { worker, threadId: Number(threadId) };
}

async function withControlDir(run: (dir: string) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), 'ws-scale-preload-'));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('churn preload ignores profile requests and continues acknowledging GC requests', async () => {
	await withControlDir(async (dir) => {
		const { worker, threadId } = await startWorker(churnPreload, dir, true);
		try {
			writeFileSync(join(dir, 'start'), '0.1');
			for (const request of ['gc-1', 'gc-2']) {
				writeFileSync(join(dir, request), '');
				const acknowledgement = join(dir, `${request}-${threadId}`);
				await waitForFile(acknowledgement, `${request} acknowledgement`);
				assert.ok(JSON.parse(readFileSync(acknowledgement, 'utf8')).heapUsed >= 0);
			}
			assert.strictEqual(existsSync(join(dir, `thread-${threadId}.started`)), false);
			assert.strictEqual(existsSync(join(dir, `thread-${threadId}.cpuprofile`)), false);
		} finally {
			await worker.terminate();
		}
	});
});

test('profile preload ignores GC requests and writes its CPU profile artifact', async () => {
	await withControlDir(async (dir) => {
		const { worker, threadId } = await startWorker(profilePreload, dir);
		try {
			writeFileSync(join(dir, 'gc-1'), '');
			await new Promise((resolve) => setTimeout(resolve, 350));
			assert.strictEqual(existsSync(join(dir, `gc-1-${threadId}`)), false);

			writeFileSync(join(dir, 'start'), '0.15');
			await waitForFile(join(dir, `thread-${threadId}.cpuprofile`), 'CPU profile artifact');
			writeFileSync(join(dir, 'gc-2'), '');
			await new Promise((resolve) => setTimeout(resolve, 350));
			assert.strictEqual(existsSync(join(dir, `gc-2-${threadId}`)), false);
		} finally {
			await worker.terminate();
		}
	});
});
