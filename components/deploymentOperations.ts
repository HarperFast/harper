'use strict';

// Read-side operations against system.hdb_deployment.
// Write-side lives in deploymentRecorder.ts; this module only reads.

import { databases } from '../resources/databases.ts';
import * as terms from '../utility/hdbTerms.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import { getActiveEmitter } from './deploymentRecorder.ts';
import type { ProgressEmitter } from '../server/serverHelpers/progressEmitter.ts';

const DEPLOYMENT_TABLE = terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME;
const TERMINAL_STATUSES = new Set(['success', 'failed', 'rolled_back']);

interface ListRequest {
	project?: string;
	status?: string;
	since?: number;
	until?: number;
	limit?: number;
	offset?: number;
}

interface GetRequest {
	deployment_id: string;
	// Set by serverHandlers.js when the client asks for `Accept: text/event-stream`.
	progress?: ProgressEmitter;
}

function deploymentTable() {
	const table = (databases as any).system?.[DEPLOYMENT_TABLE];
	if (!table) {
		throw new ClientError(
			`Deployment tracking is not initialized on this node (system.${DEPLOYMENT_TABLE} missing). ` +
				`Run upgrade or restart the server to provision the table.`
		);
	}
	return table;
}

// Strip the blob attribute from a row; the bytes never travel over the operations API.
// A separate get_deployment_payload operation streams the raw bytes when callers need them.
function stripBlob(row: any): any {
	if (!row || typeof row !== 'object') return row;
	const { payload_blob, ...rest } = row;
	rest.payload_blob_present = payload_blob != null;
	return rest;
}

export async function handleListDeployments(req: ListRequest = {}): Promise<{ deployments: any[]; total: number }> {
	const table = deploymentTable();
	const conditions: any[] = [];
	if (req.project) conditions.push({ attribute: 'project', value: req.project });
	if (req.status) conditions.push({ attribute: 'status', value: req.status });
	if (req.since != null)
		conditions.push({ attribute: 'started_at', value: req.since, comparator: 'greater_than_equal' });
	if (req.until != null) conditions.push({ attribute: 'started_at', value: req.until, comparator: 'less_than_equal' });

	const collected: any[] = [];
	for await (const row of table.search(conditions)) {
		collected.push(stripBlob(row));
	}
	// Newest first by started_at; ties broken by deployment_id for stability.
	collected.sort(
		(a, b) => (b.started_at ?? 0) - (a.started_at ?? 0) || String(a.deployment_id).localeCompare(b.deployment_id)
	);

	const total = collected.length;
	const offset = Math.max(0, req.offset ?? 0);
	const limit = req.limit != null ? Math.max(0, req.limit) : collected.length;
	return { deployments: collected.slice(offset, offset + limit), total };
}

export async function handleGetDeployment(req: GetRequest): Promise<any> {
	if (!req || !req.deployment_id) {
		throw new ClientError(`'deployment_id' is required`);
	}
	const table = deploymentTable();
	const row = await table.get(req.deployment_id);
	if (!row) {
		throw new ClientError(`No deployment found with id '${req.deployment_id}'`);
	}

	// SSE content-negotiated branch — when serverHandlers.js detects
	// `Accept: text/event-stream` it attaches a ProgressEmitter as req.progress and wraps
	// our return as the operation's final SSE event. We replay event_log on connect, then
	// tail the deployment's live emitter (if it's still running on this node) until it
	// reaches a terminal status. The final return value becomes the SSE `done` event.
	if (req.progress && typeof (req.progress as any).emit === 'function') {
		const sse = req.progress;
		const liveEmitter = getActiveEmitter(req.deployment_id);

		// Subscribe FIRST, before reading the row, so any event the recorder emits between
		// "now" and the moment we finish reading the historical log still lands. Buffer
		// those live events; dedupe by recording the timestamp of the last replayed entry
		// and skipping any live event whose timestamp is <= that. Forward everything else.
		let lastReplayedTs = 0;
		let resolveLive: (() => void) | null = null;
		let liveDone = false;
		const liveBuffer: Array<{ t: number; event: { event: string; data: unknown } }> = [];
		const forwardLive = (e: { event: string; data: unknown }) => {
			sse.emit(e.event, e.data);
			// A terminal signal — either explicit success/error event from the lifecycle, or
			// the recorder's `_recorder_finished` sentinel emitted before it unsubscribes.
			const isTerminalEvent =
				e.event === '_recorder_finished' ||
				e.event === 'error' ||
				(e.event === 'phase' &&
					e.data &&
					typeof e.data === 'object' &&
					(e.data as { phase?: string }).phase === 'success');
			if (isTerminalEvent && !liveDone) {
				liveDone = true;
				resolveLive?.();
			}
		};
		const unsubscribe = liveEmitter
			? liveEmitter.subscribe((event) => {
					const t = Date.now();
					if (resolveLive) {
						// Replay phase finished; we own the live forward path now.
						if (t > lastReplayedTs) forwardLive(event);
					} else {
						// Still replaying; stash for dedup-and-forward once replay completes.
						liveBuffer.push({ t, event });
					}
				})
			: null;

		try {
			for (const entry of row.event_log ?? []) {
				sse.emit(entry.event, entry.data);
				if (typeof entry.t === 'number') lastReplayedTs = Math.max(lastReplayedTs, entry.t);
			}

			if (liveEmitter && !TERMINAL_STATUSES.has(row.status)) {
				await new Promise<void>((resolve) => {
					resolveLive = resolve;
					// Flush anything that arrived during replay, filtering to events the replay missed.
					for (const buffered of liveBuffer) {
						if (buffered.t > lastReplayedTs) forwardLive(buffered.event);
					}
					if (liveDone) resolve();
					// Safety net — if the in-memory emitter is dropped (recorder finished or
					// the process recycled) before signaling, poll the row's status as a
					// fallback so the client never hangs indefinitely.
					const pollTimer = setInterval(async () => {
						if (liveDone) {
							clearInterval(pollTimer);
							return;
						}
						const live = getActiveEmitter(req.deployment_id);
						if (!live || live !== liveEmitter) {
							clearInterval(pollTimer);
							const latest = await table.get(req.deployment_id);
							if (latest && TERMINAL_STATUSES.has(latest.status) && !liveDone) {
								liveDone = true;
								resolve();
							}
						}
					}, 500);
				});
			}
			// Re-read the row so the final SSE payload reflects the post-deploy state.
			const finalRow = await table.get(req.deployment_id);
			return stripBlob(finalRow ?? row);
		} finally {
			unsubscribe?.();
		}
	}

	return stripBlob(row);
}
