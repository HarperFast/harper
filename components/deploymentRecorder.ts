'use strict';

// DeploymentRecorder — lifecycle owner for one row in system.hdb_deployment.
//
// Creates the pending row at deploy start, persists the upload payload into the row's
// payload_blob (with sha256 + size), and writes the terminal status at the end.
// Subscribes to a ProgressEmitter so phase transitions and install lines land in
// event_log as they happen — making the deploy observable by Studio polling
// get_deployment without an attached CLI. The persisted payload_blob will also serve
// as the rollback source when that operation lands.

import { randomUUID } from 'node:crypto';
import { createHash, Hash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { databases } from '../resources/databases.ts';
import { createBlob } from '../resources/blob.ts';
import * as terms from '../utility/hdbTerms.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import { hostname } from 'node:os';
import { ProgressEmitter } from '../server/serverHelpers/progressEmitter.ts';

// Bound the event_log so a pathologically chatty install can't grow a row without limit.
// 200 entries comfortably covers a real deploy with headroom (phase events plus install
// line summaries). When we exceed the cap, drop the middle rather than the front — the
// lifecycle spine (prepare → load → replicate → success) is the most valuable context
// for debugging, and naive front-truncation loses it under a chatty `npm install`.
const EVENT_LOG_MAX = 200;
const EVENT_LOG_HEAD_KEEP = 20;

// In-memory registry of live emitters, keyed by deployment_id. Populated for the lifetime
// of an in-progress deploy on the origin node; get_deployment SSE looks here to tail live
// events after replaying event_log. Per-node, not replicated — peers don't see another
// node's in-progress emitters. Cross-node tailing is a later concern.
const activeEmitters = new Map<string, ProgressEmitter>();

export function getActiveEmitter(deploymentId: string): ProgressEmitter | undefined {
	return activeEmitters.get(deploymentId);
}

// Interim cap: ingestPayload currently buffers the entire payload in memory before
// computing the hash and persisting. This cap prevents an OOM on accidentally-huge
// uploads. A follow-up will swap this for a true streaming-hash + blob-source pattern
// that lifts the limit back to whatever the replication path supports.
const PAYLOAD_BUFFER_CAP_BYTES = 200 * 1024 * 1024;

type DeploymentStatus =
	| 'pending'
	| 'extracting'
	| 'installing'
	| 'loading'
	| 'replicating'
	| 'restarting'
	| 'success'
	| 'failed'
	| 'rolled_back';

interface CreateOptions {
	project?: string;
	package_identifier?: string;
	user?: string;
	restart_mode?: 'immediate' | 'rolling' | null;
	rollback_of?: string | null;
	emitter?: ProgressEmitter;
}

export class DeploymentRecorder {
	readonly deploymentId: string;
	private readonly record: Record<string, any>;
	private hash: Hash | null = null;
	private byteCount = 0;
	private finished = false;
	private unsubscribe: (() => void) | null = null;
	private pendingPut: Promise<void> | null = null;
	private dirty = false;
	private sealed = false;

	private constructor(deploymentId: string, initial: Record<string, any>) {
		this.deploymentId = deploymentId;
		this.record = initial;
	}

	static async create(options: CreateOptions): Promise<DeploymentRecorder> {
		const deploymentId = randomUUID();
		const startedAt = Date.now();
		const record: Record<string, any> = {
			deployment_id: deploymentId,
			project: options.project ?? null,
			package_identifier: options.package_identifier ?? null,
			payload_hash: null,
			payload_size: null,
			payload_blob: null,
			status: 'pending' as DeploymentStatus,
			phase: 'pending',
			event_log: [],
			peer_results: [],
			origin_node: hostname(),
			restart_mode: options.restart_mode ?? null,
			started_at: startedAt,
			completed_at: null,
			user: options.user ?? null,
			rollback_of: options.rollback_of ?? null,
			error: null,
		};
		const recorder = new DeploymentRecorder(deploymentId, record);
		await recorder.put();
		if (options.emitter) {
			recorder.subscribeTo(options.emitter);
			activeEmitters.set(deploymentId, options.emitter);
		}
		return recorder;
	}

	/**
	 * Subscribe to a ProgressEmitter. Each event is appended (bounded) to event_log; phase
	 * events also update the row's `status` and `phase` fields. Writes coalesce: a put is
	 * always pending after the first event in a burst, so chatty install output collapses
	 * to one row update per ~100ms instead of one per line.
	 */
	private subscribeTo(emitter: ProgressEmitter): void {
		this.unsubscribe = emitter.subscribe((event) => {
			this.appendEvent(event.event, event.data);
		});
	}

	private appendEvent(event: string, data: unknown): void {
		if (this.finished) return;
		const log = this.record.event_log as Array<Record<string, unknown>>;
		log.push({ t: Date.now(), event, data });
		// Keep the head (lifecycle spine) and tail (most-recent activity); drop the middle.
		if (log.length > EVENT_LOG_MAX) {
			const tailKeep = EVENT_LOG_MAX - EVENT_LOG_HEAD_KEEP - 1; // -1 for the truncation marker
			const removedCount = log.length - EVENT_LOG_HEAD_KEEP - tailKeep;
			log.splice(EVENT_LOG_HEAD_KEEP, log.length - EVENT_LOG_HEAD_KEEP - tailKeep, {
				t: Date.now(),
				event: 'truncated',
				data: { dropped_events: removedCount },
			});
		}
		// Phase events drive the canonical status/phase fields used by list_deployments.
		if (event === 'phase' && data && typeof data === 'object') {
			const p = data as { phase?: string; status?: string };
			if (p.phase) this.record.phase = p.phase;
			if (p.status === 'start') {
				const mapped = startStatusFor(p.phase);
				if (mapped) this.record.status = mapped;
			}
		}
		this.scheduleFlush();
	}

	// Coalesce writes: at most one in-flight put at a time. While a put is running, mark
	// the record dirty; the chained continuation issues a follow-up put once the prior one
	// settles. This keeps event_log writes O(1) puts per burst rather than O(N) per event.
	private scheduleFlush(): void {
		if (this.sealed) {
			// Sealed: accumulate state in memory but don't write. finish() does the single
			// terminal write. See seal() for why. The emitter still emits live SSE events.
			this.dirty = true;
			return;
		}
		if (this.pendingPut) {
			this.dirty = true;
			return;
		}
		this.pendingPut = this.put().finally(() => {
			this.pendingPut = null;
			if (this.dirty) {
				this.dirty = false;
				this.scheduleFlush();
			}
		});
	}

	/**
	 * Drain a payload source (Buffer or Readable) into the row's payload_blob attribute,
	 * computing sha256 and byte count alongside. After this resolves the row has been
	 * committed once with the final hash and size, and `this.row.payload_blob.stream()`
	 * yields a fresh Readable that callers can pass to extraction.
	 *
	 * Buffers the payload in memory (subject to PAYLOAD_BUFFER_CAP_BYTES) so the
	 * hash/size are known synchronously before we commit and so the blob's `saveBlob`
	 * lifecycle doesn't race with our digest() call. A streaming variant is a planned
	 * follow-up that uses the unused `hash`/`byteCount` instance fields below.
	 */
	async ingestPayload(source: Readable | Buffer | string): Promise<void> {
		const hash = createHash('sha256');
		let byteCount = 0;
		let buffer: Buffer;
		if (Buffer.isBuffer(source)) {
			buffer = source;
		} else if (typeof source === 'string') {
			// Legacy CBOR/JSON path: payload arrives as a base64-encoded string.
			buffer = Buffer.from(source, 'base64');
		} else {
			const chunks: Buffer[] = [];
			let collected = 0;
			for await (const chunk of source as AsyncIterable<Buffer | string>) {
				const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
				collected += buf.length;
				if (collected > PAYLOAD_BUFFER_CAP_BYTES) {
					(source as Readable).destroy?.();
					throw new ClientError(
						`Deploy payload exceeds the ${PAYLOAD_BUFFER_CAP_BYTES} byte buffer cap. ` +
							`Use a package identifier (npm:/file:/git:) for larger components.`
					);
				}
				chunks.push(buf);
			}
			buffer = Buffer.concat(chunks);
		}
		if (buffer.length > PAYLOAD_BUFFER_CAP_BYTES) {
			throw new ClientError(
				`Deploy payload (${buffer.length} bytes) exceeds the ${PAYLOAD_BUFFER_CAP_BYTES} byte buffer cap. ` +
					`Use a package identifier (npm:/file:/git:) for larger components.`
			);
		}
		hash.update(buffer);
		byteCount = buffer.length;
		this.record.payload_blob = createBlob(buffer, { type: 'application/gzip' });
		this.record.payload_hash = hash.digest('hex');
		this.record.payload_size = byteCount;
		// Touch the unused private fields so the type system stays happy when a streaming
		// variant lands that uses them.
		this.hash = hash;
		this.byteCount = byteCount;
		await this.put();
	}

	async transitionPhase(phase: string, status?: DeploymentStatus): Promise<void> {
		this.record.phase = phase;
		if (status) this.record.status = status;
		await this.put();
	}

	/**
	 * Upsert a single peer outcome by node name. Called per-peer as each replication
	 * target settles, so the row reflects in-flight progress rather than only the
	 * final aggregate. Routes through `scheduleFlush()` so the write coalesces with
	 * the emitter-driven puts and the latest in-memory state always wins.
	 *
	 * Tolerates unknown shapes — anything we can't interpret becomes a plain
	 * stringified entry so the audit trail at least records that a peer was contacted.
	 */
	recordPeer(result: unknown): void {
		if (this.finished) return;
		const normalized = normalizePeerResult(result);
		// Defensive: rows freshly created via create() always have peer_results=[], but if
		// a replicated row was loaded back where the attribute is absent or null we want
		// to initialize lazily rather than throw on `.findIndex`.
		if (!Array.isArray(this.record.peer_results)) this.record.peer_results = [];
		const list = this.record.peer_results as Array<Record<string, unknown>>;
		// Upsert by node name when present; otherwise append (we can't dedupe without an id).
		const nodeName = normalized.node;
		const idx = nodeName ? list.findIndex((entry) => entry.node === nodeName) : -1;
		if (idx >= 0) {
			list[idx] = normalized;
		} else {
			list.push(normalized);
		}
		this.scheduleFlush();
	}

	/**
	 * Bulk-record a final aggregate of peer outcomes. Equivalent to calling recordPeer()
	 * for each entry. Useful for replication layers that surface results all-at-once
	 * via Promise.allSettled rather than via a per-peer callback.
	 */
	recordPeers(results: unknown): void {
		if (this.finished) return;
		if (!Array.isArray(results)) return;
		for (const result of results) this.recordPeer(result);
	}

	/**
	 * Return the recorded peer outcomes that failed to replicate (status 'failed', as
	 * assigned by normalizePeerResult). replicateOperation does not throw on a per-peer
	 * failure — failures surface only as 'failed' entries in peer_results — so deployComponent
	 * uses this to decide whether to fail the overall deploy with a non-2xx status.
	 */
	getFailedPeers(): Array<Record<string, unknown>> {
		const list = this.record.peer_results;
		return Array.isArray(list) ? list.filter((peer) => peer?.status === 'failed') : [];
	}

	/**
	 * Stop persisting intermediate row updates; accumulate them in memory so finish() writes
	 * the terminal state in a single put. Called before the replicate phase, where the row
	 * otherwise receives a tight burst of puts (replicate phase + per-peer + finish) within
	 * a few ms. That burst can commit out of order on a loaded peer, where an older full
	 * update reverts the terminal `success` write — the row stays stuck at `replicating` and
	 * never converges (harperdb/harper#1170). Collapsing to one terminal write isolates it
	 * from any concurrent same-key write so the receiver converges.
	 *
	 * Tradeoff: the origin's get_deployment *polling* view skips the transient `replicating`
	 * status and incremental peer_results during the final phase; live SSE tailing is
	 * unaffected (the emitter still emits in real time). Once #1170 lands this seal can be
	 * removed to restore incremental peer_results persistence.
	 */
	seal(): void {
		this.sealed = true;
	}

	async finish(status: 'success' | 'failed' | 'rolled_back', error?: unknown): Promise<void> {
		if (this.finished) return;
		// Send a terminal sentinel through the emitter (if any) BEFORE we unsubscribe and
		// remove it from the registry, so any SSE tail subscribers can resolve their wait
		// even on a code path that doesn't emit an explicit `error` event.
		const emitter = activeEmitters.get(this.deploymentId);
		emitter?.emit('_recorder_finished', { status });
		this.finished = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
		activeEmitters.delete(this.deploymentId);
		// Drain the ENTIRE coalesced-flush chain before mutating + persisting the terminal
		// state. Just awaiting `this.pendingPut` once isn't enough: its `.finally` may
		// re-schedule another put (when `dirty` was set during the in-flight put), and
		// that re-scheduled put captures a pre-mutation snapshot of the record. Without
		// this loop, the re-scheduled put can complete AFTER our terminal put and
		// overwrite status=success with stale state.
		while (this.pendingPut) {
			try {
				await this.pendingPut;
			} catch {
				/* the next put surfaces the error */
			}
		}
		this.record.status = status;
		this.record.completed_at = Date.now();
		if (error) {
			const e = error as { message?: string; code?: string | number; stack?: string };
			this.record.error = {
				message: e?.message ?? String(error),
				code: e?.code,
				phase: this.record.phase,
			};
		}
		await this.put();
	}

	get row(): Record<string, any> {
		return this.record;
	}

	private async put(): Promise<void> {
		const table = (databases as any).system?.[terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME];
		if (!table) {
			// Table missing means the upgrade directive hasn't run yet (or the table got dropped).
			// We tolerate this — tracking is observability; the deploy itself must still succeed.
			return;
		}
		await table.put(this.record);
	}
}

// Default peer-wait budget for the hdb_deployment row to replicate. A deploy is a rare,
// heavyweight, user-initiated operation, and the `system`-table replication channel can be
// backlogged behind unrelated writes when several deploys land in succession, so the row can
// take well over the original 30s to arrive on a peer (harper-pro#402). 120s matches the
// blob-stream receive default and gives a loaded cluster room to converge. Override per-deploy
// via the `deployment_timeout` operation parameter.
const DEFAULT_AWAIT_ROW_TIMEOUT_MS = 120_000;

/**
 * Peer-side helper — wait for the hdb_deployment row to arrive via table replication,
 * then return it. The row is committed on origin before `replicateOperation` is
 * called, so peers normally find it immediately; this polling loop covers the case
 * where the operation arrives faster than the table-replication channel, including
 * when that channel is backlogged behind other writes.
 *
 * The payload_blob's chunks may still be in flight after the row arrives — that's
 * fine, the Blob's `stream()` / `bytes()` API blocks on incomplete writes
 * (resources/blob.ts).
 *
 * On timeout the thrown error distinguishes the two failure modes: the row never
 * replicated at all (the replication channel to this peer is stalled or broken) versus
 * the row arrived but its payload_blob has not been populated yet (the origin's
 * ingestPayload write is still propagating) — they point at different root causes.
 */
export async function awaitDeploymentRow(
	deploymentId: string,
	options: { timeoutMs?: number; pollIntervalMs?: number; initialPollIntervalMs?: number } = {}
): Promise<Record<string, any>> {
	// Coerce defensively: the deploy operation's `deployment_timeout` reaches us via the
	// operation body, and the Joi validator's coerced number is discarded by validateBySchema
	// (it returns only the error, never writes the parsed value back), so a JSON/multipart
	// client sending `"120000"` would otherwise arrive here as a string. `Date.now() + "<n>"`
	// concatenates into a far-future "deadline" that silently defeats the timeout. Anything
	// non-finite or negative falls back to the default rather than producing a NaN deadline
	// (which would never satisfy `>= deadline` and loop forever).
	const requested = Number(options.timeoutMs);
	const timeoutMs = Number.isFinite(requested) && requested >= 0 ? requested : DEFAULT_AWAIT_ROW_TIMEOUT_MS;
	const maxIntervalMs = options.pollIntervalMs ?? 100;
	// Start fast (5ms) so the common case — replication has already caught up — sees no
	// human-noticeable latency, then back off exponentially up to maxIntervalMs for the
	// rare case where the row is genuinely still replicating.
	let intervalMs = options.initialPollIntervalMs ?? 5;
	const table = (databases as any).system?.[terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME];
	if (!table) {
		throw new Error(
			`Deployment tracking is not initialized on this node (system.${terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME} missing).`
		);
	}
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	let sawRow = false;
	// Poll at least once even when timeoutMs is 0 (the caller asked for a single check, not
	// "skip the lookup entirely"), and re-test the deadline AFTER the lookup so we never burn
	// an extra idle interval once it has already passed.
	while (true) {
		try {
			const row = await table.get(deploymentId);
			if (row) {
				if (row.payload_blob != null) return row;
				// Row replicated but its payload_blob write hasn't landed yet — replication is
				// alive, just mid-flight. Remember this so the timeout message points at the
				// payload write rather than a dead channel.
				sawRow = true;
			}
		} catch (err) {
			lastError = err;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		// Cap the sleep to the remaining budget so we don't overshoot the deadline.
		await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
		intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
	}
	const cause = sawRow
		? `row '${deploymentId}' replicated but its payload_blob has not arrived`
		: `hdb_deployment row '${deploymentId}' did not replicate`;
	throw new Error(
		`Timed out after ${timeoutMs}ms waiting for the deployment payload: ${cause}` +
			(lastError ? ` (last error: ${(lastError as Error).message ?? lastError})` : '')
	);
}

function normalizePeerResult(raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== 'object') {
		// Replication layer returned a primitive — preserve as a stringified marker so the
		// audit row at least records that something came back from a peer.
		return { node: null, status: 'unknown', raw: String(raw) };
	}
	const r = raw as Record<string, unknown>;
	// Failure detail arrives in one of two shapes: `error` (a structured object/string from a
	// remote operation response) or `reason` (a stringified message from the replicator's
	// per-peer `.catch` shape: { status: 'failed', reason, node }). Prefer `error`; fall back to
	// `reason` only when the peer reported failed — otherwise the audit row records a peer
	// "failed" with no explanation and deployComponent's failure message reads "unknown error".
	const err = r.error ?? (r.status === 'failed' ? r.reason : undefined);
	const hasError =
		err != null && (typeof err === 'string' ? err.length > 0 : typeof err === 'object' || typeof err === 'number');
	return {
		node: r.node ?? r.name ?? r.hostname ?? null,
		status: hasError || r.status === 'failed' ? 'failed' : (r.status ?? 'success'),
		error: hasError
			? {
					message: typeof err === 'object' ? ((err as any).message ?? String(err)) : String(err),
					code: typeof err === 'object' ? (err as any).code : undefined,
				}
			: null,
		started_at: r.started_at ?? null,
		completed_at: r.completed_at ?? null,
	};
}

function startStatusFor(phase: string | undefined): DeploymentStatus | null {
	switch (phase) {
		case 'extract':
			return 'extracting';
		case 'install':
			return 'installing';
		case 'load':
			return 'loading';
		case 'replicate':
			return 'replicating';
		case 'restart':
			return 'restarting';
		default:
			return null;
	}
}
