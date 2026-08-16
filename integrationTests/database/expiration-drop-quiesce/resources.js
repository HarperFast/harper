import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { threadId } from 'node:worker_threads';

const controlDirectory = process.env.EXPIRATION_QUIESCE_CONTROL;
const CONTROL_REQUEST = 'expiration-quiesce-control-request';
const CONTROL_RESPONSE = 'expiration-quiesce-control-response';
const pendingRequests = new Map();
let nextRequestId = 1;

function publishWorkerMarker(path) {
	const temporaryPath = `${path}.${threadId}.tmp`;
	writeFileSync(temporaryPath, JSON.stringify({ threadId }));
	renameSync(temporaryPath, path);
}

async function performControl(body) {
	const Table = databases[body.database]?.[body.table];
	if (!Table) return { available: false, threadId };
	if (body.action === 'seed') {
		const expiresAt = Date.now() - 10_000;
		if (body.kind === 'indexed') await Table.put(body.id, { id: body.id, expiresAt });
		else await Table.put(body.id, { id: body.id, value: 'expired' }, { expiresAt });
		return { seeded: true, threadId };
	}
	const started = join(controlDirectory, `${body.runId}.started`);
	const release = join(controlDirectory, `${body.releaseRunId ?? body.runId}.release`);
	if (body.action === 'drop') {
		publishWorkerMarker(started);
		await Table.dropTable();
		return { completed: true, threadId };
	}
	const hooks = {
		beforeBatchCommit: async () => {
			publishWorkerMarker(started);
			while (!existsSync(release)) await delay(20);
		},
	};
	if (body.kind === 'indexed') await Table.runRecordExpirationSweepForTests(hooks);
	else await Table.runPrimaryCleanupScanForTests(hooks);
	return { completed: true, threadId };
}

threads.onMessageByType(CONTROL_REQUEST, async (message) => {
	if (message.targetThreadId !== threadId) return;
	try {
		const result = await performControl(message.body);
		threads.sendToThread(message.originThreadId, { type: CONTROL_RESPONSE, requestId: message.requestId, result });
	} catch (error) {
		threads.sendToThread(message.originThreadId, {
			type: CONTROL_RESPONSE,
			requestId: message.requestId,
			error: error?.stack ?? error?.message ?? String(error),
		});
	}
});

threads.onMessageByType(CONTROL_RESPONSE, (message) => {
	const pending = pendingRequests.get(message.requestId);
	if (!pending) return;
	pendingRequests.delete(message.requestId);
	clearTimeout(pending.timer);
	if (message.error) pending.reject(new Error(message.error));
	else pending.resolve(message.result);
});

function performControlOnWorker(body, targetThreadId) {
	if (targetThreadId === threadId) return performControl(body);
	return new Promise((resolve, reject) => {
		const requestId = `${threadId}:${nextRequestId++}`;
		const timer = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error(`Timed out dispatching expiration quiesce control to worker ${targetThreadId}`));
		}, 120_000);
		timer.unref();
		pendingRequests.set(requestId, { resolve, reject, timer });
		if (
			!threads.sendToThread(targetThreadId, {
				type: CONTROL_REQUEST,
				requestId,
				originThreadId: threadId,
				targetThreadId,
				body,
			})
		) {
			clearTimeout(timer);
			pendingRequests.delete(requestId);
			reject(new Error(`Worker ${targetThreadId} is not reachable`));
		}
	});
}

export class QuiesceControl extends Resource {
	static loadAsInstance = false;

	async post(_query, body) {
		if (body.action === 'probe') {
			const workerIds = [threadId, ...threads.map((port) => port.threadId)].filter((id) => id > 0);
			return { ready: true, threadId, workerIds: [...new Set(workerIds)] };
		}
		if (body.targetThreadId !== undefined) return performControlOnWorker(body, body.targetThreadId);
		return performControl(body);
	}
}
