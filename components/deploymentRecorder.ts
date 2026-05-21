'use strict';

// DeploymentRecorder — lifecycle owner for one row in system.hdb_deployment.
//
// Creates the pending row at deploy start, persists the upload payload into the row's
// payload_blob (with sha256 + size), and writes the terminal status at the end.
// Slice B (#641): subscribes to a ProgressEmitter so phase transitions and install lines
// land in event_log as they happen — making the deploy observable by Studio polling
// get_deployment without an attached CLI. Slice C will add rollback sourcing from the blob.

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
// Slice B emits a handful of phase events plus aggregated install summaries; 200 entries
// comfortably covers a real deploy with headroom. When we exceed the cap, drop the middle
// rather than the front — the lifecycle spine (prepare → load → replicate → success) is
// the most valuable context for debugging, and naive front-truncation loses it under a
// chatty `npm install`.
const EVENT_LOG_MAX = 200;
const EVENT_LOG_HEAD_KEEP = 20;

// In-memory registry of live emitters, keyed by deployment_id. Populated for the lifetime
// of an in-progress deploy on the origin node; get_deployment SSE looks here to tail live
// events after replaying event_log. Per-node, not replicated — peers don't see another
// node's in-progress emitters. Slice B1 scope; cross-node tailing is a later concern.
const activeEmitters = new Map<string, ProgressEmitter>();

export function getActiveEmitter(deploymentId: string): ProgressEmitter | undefined {
	return activeEmitters.get(deploymentId);
}

// Slice A buffers the entire payload in memory before computing the hash and persisting.
// This cap prevents an OOM on accidentally-huge uploads while Slice B is in flight. Slice B
// replaces the buffer with a streaming hash + Blob-source pattern that lifts this limit
// back to whatever the replication path supports.
const SLICE_A_PAYLOAD_LIMIT_BYTES = 200 * 1024 * 1024;

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
	 * Slice A buffers the payload in memory so the hash/size are known synchronously before
	 * we commit and so the blob's `saveBlob` lifecycle doesn't race with our digest() call.
	 * Slice B will swap this for a true streaming path once we also gain the ProgressEmitter
	 * subscriber that benefits from chunk-level progress events.
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
				if (collected > SLICE_A_PAYLOAD_LIMIT_BYTES) {
					(source as Readable).destroy?.();
					throw new ClientError(
						`Deploy payload exceeds Slice A's interim ${SLICE_A_PAYLOAD_LIMIT_BYTES} byte cap. ` +
							`Use a package identifier (npm:/file:/git:) or wait for Slice B's streaming path.`
					);
				}
				chunks.push(buf);
			}
			buffer = Buffer.concat(chunks);
		}
		if (buffer.length > SLICE_A_PAYLOAD_LIMIT_BYTES) {
			throw new ClientError(
				`Deploy payload (${buffer.length} bytes) exceeds Slice A's interim ${SLICE_A_PAYLOAD_LIMIT_BYTES} byte cap. ` +
					`Use a package identifier (npm:/file:/git:) or wait for Slice B's streaming path.`
			);
		}
		hash.update(buffer);
		byteCount = buffer.length;
		this.record.payload_blob = createBlob(buffer, { type: 'application/gzip' });
		this.record.payload_hash = hash.digest('hex');
		this.record.payload_size = byteCount;
		// Touch the unused private fields so the type system stays happy in Slice B when we
		// reintroduce the streaming variant that uses them.
		this.hash = hash;
		this.byteCount = byteCount;
		await this.put();
	}

	async transitionPhase(phase: string, status?: DeploymentStatus): Promise<void> {
		this.record.phase = phase;
		if (status) this.record.status = status;
		await this.put();
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
		// Wait for any in-flight coalesced put before mutating + persisting the terminal state.
		if (this.pendingPut) {
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
