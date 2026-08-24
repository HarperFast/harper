'use strict';

// DeploymentRecorder — lifecycle owner for one row in system.hdb_deployment.
//
// Creates the pending row at deploy start, persists the upload payload into the row's
// payload_blob (with sha256 + size), and writes the terminal status at the end.
// Subscribes to a ProgressEmitter so phase transitions and install lines land in
// event_log as they happen — making the deploy observable by Studio polling
// get_deployment without an attached CLI. The persisted payload_blob also serves as
// the replication source for peer staging.

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { Readable, Transform, pipeline } from 'node:stream';
import { databases } from '../resources/databases.ts';
import { transaction, contextStorage } from '../resources/transaction.ts';
import { createBlob, isSaving, deleteBlob, BLOB_UNAVAILABLE_STATUS } from '../resources/blob.ts';
import * as terms from '../utility/hdbTerms.ts';
import type { CredentialReference } from './secretOperations.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import { logger } from '../utility/logging/logger.ts';
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

// Cap for the degraded fallback used only when the hdb_deployment table is missing (so the
// payload can't stream into a row-backed blob and must be buffered in memory). The normal
// streaming path is uncapped — this bound exists solely to keep a pending-upgrade window from
// OOMing the node on a large deploy. 1 GiB comfortably covers real components.
const UNTRACKED_PAYLOAD_BUFFER_CAP_BYTES = 1024 * 1024 * 1024;

type DeploymentStatus =
	| 'pending'
	| 'extracting'
	| 'installing'
	| 'staging'
	// A terminal resting state, not a transient one: where a stage-and-stop deploy comes to rest.
	| 'staged'
	| 'loading'
	| 'replicating'
	| 'activating'
	// Retained for compatibility with deployment rows written by earlier preview builds.
	| 'reverting'
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
	// Deploy credentials in reference form (`{ registry, secret, scope? }` / `{ host, secret,
	// username? }`) — never a literal token. Peers and later activation resolve the reference from
	// hdb_secret. Null when the deploy used no credentials or a no-custody transient token.
	credentials?: CredentialReference[] | null;
	activation_spec?: Record<string, unknown> | null;
	emitter?: ProgressEmitter;
	// Open-transaction budget (ms) for the payload-ingest write, below. Mirrors the
	// `deployment_timeout` operation parameter already used for the peer-side row/blob waits
	// (DEFAULT_AWAIT_ROW_TIMEOUT_MS) so operators have one existing knob for all of a deploy's
	// size-driven timeouts, rather than a new config surface for this one.
	ingestTimeoutMs?: number;
}

/**
 * Run `write()` in a fresh transaction while preserving audit attribution. Recorder writes must
 * commit independently of a caller's transaction so an older staged row cannot overwrite them;
 * authorization is enforced by the deploy operation rather than these internal writes.
 *
 * `timeoutBudget` is sticky across RocksDB `getReadTxn()` calls, so reads inside `write()` cannot
 * silently restore the generic default. The transaction uses the larger of this budget and the
 * configured global limit.
 */
function withIsolatedTransaction<T>(write: () => Promise<T>, timeoutMs?: number): Promise<T> {
	const ambient = contextStorage.getStore();
	const context = {
		user: ambient?.user,
		originatingOperation: ambient?.originatingOperation,
		session: ambient?.session,
		signal: ambient?.signal,
	};
	return transaction(context, (txn) => {
		if (timeoutMs != null) {
			// TODO(harper#2057): only extends the RocksDB DatabaseTransaction head; on
			// HARPER_STORAGE_ENGINE=lmdb, Table.txnForContext() chains a separate LMDBTransaction
			// that this budget doesn't reach.
			txn.timeoutBudget = timeoutMs;
		}
		return write();
	});
}

export class DeploymentRecorder {
	readonly deploymentId: string;
	private readonly record: Record<string, any>;
	private finished = false;
	private unsubscribe: (() => void) | null = null;
	private pendingPut: Promise<void> | null = null;
	private dirty = false;
	private sealed = false;
	private flushSuppressed = false;
	// Set only on the degraded (no-table) ingest path, which buffers the whole upload in memory. The
	// original source is exhausted by then, so this is the ONLY replayable copy — and with no row for
	// peers to read a blob from, it is what has to travel in the replicated operation.
	private bufferedPayload?: Buffer;
	private readonly ingestTimeoutMs?: number;

	private constructor(deploymentId: string, initial: Record<string, any>, ingestTimeoutMs?: number) {
		this.deploymentId = deploymentId;
		this.record = initial;
		this.ingestTimeoutMs = ingestTimeoutMs;
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
			credentials: options.credentials ?? null,
			activation_spec: options.activation_spec ?? null,
			error: null,
		};
		const recorder = new DeploymentRecorder(deploymentId, record, options.ingestTimeoutMs);
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
		if (this.sealed || this.flushSuppressed) {
			// Accumulate state until finish() or the active ingest writes it without a competing put.
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
		this.pendingPut.catch((error) => logger.warn?.('Failed to persist deployment progress', error));
	}

	/**
	 * Drain a payload source (Buffer, base64 string, or Readable) into the row's
	 * payload_blob attribute, computing sha256 and byte count alongside. After this
	 * resolves the row has been committed with the final hash and size, and
	 * `this.row.payload_blob.stream()` yields a fresh Readable callers pass to extraction.
	 *
	 * The Readable path (the multipart file part) is fully streaming: the tarball is teed
	 * through a hash/size tap straight into the blob's file-backed storage, so a multi-GB
	 * component is bounded by disk, not memory. No payload size cap is imposed — the
	 * deployment system is explicitly designed to carry arbitrarily large components.
	 * In-memory sources (a Buffer, or the legacy base64-in-JSON/CBOR body) are already
	 * materialized by the time they reach us, so they take the simpler buffer path.
	 */
	/**
	 * A replayable copy of the ingested payload, present only when ingest buffered it in memory —
	 * which is exactly the no-table case, where there is no row for peers to read the bytes from.
	 */
	get replayablePayload(): Buffer | undefined {
		return this.bufferedPayload;
	}

	async ingestPayload(source: Readable | Buffer | string): Promise<void> {
		this.flushSuppressed = true;
		try {
			while (this.pendingPut) {
				try {
					await this.pendingPut;
				} catch {
					/* already logged; the ingest write carries the current row state */
				}
			}
			await this.ingestPayloadWithoutFlush(source);
		} finally {
			this.flushSuppressed = false;
			if (this.dirty && !this.sealed) {
				this.dirty = false;
				this.scheduleFlush();
			}
		}
	}

	private async ingestPayloadWithoutFlush(source: Readable | Buffer | string): Promise<void> {
		const hash = createHash('sha256');

		// In-memory sources: the bytes are already resident, so hashing them and creating a
		// buffer-backed blob is both simplest and no worse for memory than what the caller
		// already holds. No cap — a large base64-in-JSON body is the caller's choice.
		if (Buffer.isBuffer(source) || typeof source === 'string') {
			const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source, 'base64');
			this.bufferedPayload = buffer;
			hash.update(buffer);
			this.record.payload_blob = createBlob(buffer, { type: 'application/gzip' });
			this.record.payload_hash = hash.digest('hex');
			this.record.payload_size = buffer.length;
			// Same blob-durability gate as the streaming path below applies here too (the commit
			// waits for the buffer to land on disk), so a large base64-in-JSON/CBOR body needs the
			// same extended budget.
			await this.put(ingestTransactionTimeoutMs(this.ingestTimeoutMs));
			return;
		}

		// Streaming source. If the hdb_deployment table is missing (upgrade directive hasn't
		// run, or it was dropped) there is no row to attach the blob to, and a file-backed
		// blob would never be persisted for extraction to re-read. Fall back to buffering in
		// that degraded case so the deploy still works. Unlike the streaming path below, this
		// buffer is held in memory, so it carries a cap: without it a multi-GB deploy during the
		// upgrade window would OOM the node (or throw on Node's ~2 GB Buffer limit). We fail fast
		// with a clear error instead. The cap applies ONLY to this degraded path — once the
		// table exists, deploys stream to disk with no size limit.
		const tableMissing = !(databases as any).system?.[terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME];
		if (tableMissing) {
			const chunks: Buffer[] = [];
			let collected = 0;
			for await (const chunk of source as AsyncIterable<Buffer | string>) {
				const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
				collected += buf.length;
				if (collected > UNTRACKED_PAYLOAD_BUFFER_CAP_BYTES) {
					(source as Readable).destroy?.();
					throw new ClientError(
						`Deploy payload exceeds the ${UNTRACKED_PAYLOAD_BUFFER_CAP_BYTES}-byte limit that applies while ` +
							`deployment tracking is unavailable (the system.${terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME} ` +
							`table is missing — likely a pending upgrade). Retry once the upgrade completes, or use a ` +
							`package identifier (npm:/file:/git:) for larger components.`
					);
				}
				chunks.push(buf);
			}
			const buffer = Buffer.concat(chunks);
			this.bufferedPayload = buffer;
			hash.update(buffer);
			this.record.payload_blob = createBlob(buffer, { type: 'application/gzip' });
			this.record.payload_hash = hash.digest('hex');
			this.record.payload_size = buffer.length;
			await this.put();
			return;
		}

		// Tee the source through a hash/size tap into a file-backed blob. The blob's
		// saveBlob (driven by the put() below, via encodeBlobsWithFilePath) reads from the
		// tap's output side; we pump the source into its input side. Memory stays O(chunk).
		let byteCount = 0;
		const tap = new Transform({
			transform(chunk, _encoding, callback) {
				// Normalize to a Buffer: a string chunk would otherwise hash as utf8 and count
				// characters, not bytes — corrupting both payload_hash and payload_size.
				const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
				hash.update(buf);
				byteCount += buf.length;
				callback(null, buf);
			},
		});
		// `tapDone` resolves once every source byte has passed through the tap (so the hash
		// and byteCount are final) and rejects if the source or the downstream blob write
		// errors — a destroyed tap fails the pipeline.
		const tapDone = new Promise<void>((resolve, reject) => {
			pipeline(source, tap, (error) => (error ? reject(error) : resolve()));
		});
		const blob = createBlob(tap, { type: 'application/gzip' });
		this.record.payload_blob = blob;
		// This row's commit is gated on the blob's durable file write (resources/blob.ts,
		// startPreCommitBlobsForRecord's local-write branch) so a peer never sees a row that
		// references a not-yet-durable blob — the write transaction is legitimately held open for
		// as long as the payload takes to land on disk. The deploy system is explicitly designed
		// to carry arbitrarily large, uncapped components (see the module comment above), so that
		// duration scales with payload size, not with anything bounded. Run this one put() under
		// an extended open-time budget instead of the generic storage.maxTransactionOpenTime meant
		// for ordinary short requests (a large-but-otherwise-healthy ingest tripped that generic
		// guard on a loaded self-hosted runner — see the Large Deploy Payload Test regression).
		//
		// Persisting the row encodes the blob, which synchronously starts the file write that
		// drains the tap, so `isSaving(blob)` is set as soon as put() is *called*. Await the put,
		// the source draining (tapDone), and the file flush (saving) together: handing all three
		// to Promise.all subscribes a rejection handler to each up front, so a client that aborts
		// a large upload mid-stream (which rejects both tapDone and the blob write) fails the
		// deploy loudly here instead of leaking an unhandledRejection. This also makes hash/size
		// correctness independent of the put()/store write timing and of isSaving() being defined.
		const putDone = this.put(ingestTransactionTimeoutMs(this.ingestTimeoutMs));
		const saving = isSaving(blob) ?? Promise.resolve();
		try {
			await Promise.all([putDone, tapDone, saving]);
		} catch (error) {
			// Aborted/failed upload (e.g. the client disconnects mid-stream). The first put()
			// already persisted the row's reference to a now-partial blob; since cleanupOrphans
			// only reclaims UNreferenced blobs, leaving it would leak the file permanently. Drop
			// the reference and delete the partial file. Cleanup is best-effort — never let it
			// mask the original failure.
			this.record.payload_blob = null;
			this.record.payload_hash = null;
			this.record.payload_size = null;
			try {
				// Let the first put and the blob write fully settle before re-putting: this
				// ensures the null-reference write lands after the original reference write
				// (so it wins) and the blob's file lock is released before we unlink it.
				await Promise.allSettled([putDone, saving]);
				await this.put(ingestTransactionTimeoutMs(this.ingestTimeoutMs));
				deleteBlob(blob);
			} catch (cleanupError) {
				logger.warn?.('Failed to clean up partial deploy payload blob', cleanupError);
			}
			throw error;
		}
		// Bytes are fully hashed (tapDone) and the file is flushed with its size header
		// back-patched (saving), so the digest and blob.size below are final.
		this.record.payload_hash = hash.digest('hex');
		this.record.payload_size = blob.size ?? byteCount;
		// Persist the now-known hash + size. The blob is already saved, so this re-put does
		// not re-stream — saveBlob short-circuits on the existing fileId.
		await this.put(ingestTransactionTimeoutMs(this.ingestTimeoutMs));
	}

	/**
	 * Drop the stored payload tarball, retaining the metadata (size, hash, event_log). Used to
	 * reclaim storage for large deploys once every peer has installed from the blob and it is no
	 * longer needed. Only mutates the in-memory record — the caller drops the payload before the
	 * terminal finish() write so the null reference lands in that single put rather than a
	 * separate one. Committing the row with no blob reference unlinks the file locally (via the
	 * RecordEncoder retained-blob check) and replicates the null so peers drop their copies too.
	 *
	 * Returns the freed payload size (bytes) when a blob was present and dropped, otherwise 0.
	 */
	dropPayload(): number {
		if (this.finished || this.record.payload_blob == null) return 0;
		const freed = typeof this.record.payload_size === 'number' ? this.record.payload_size : 0;
		this.record.payload_blob = null;
		return freed;
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

	async checkpoint(status: DeploymentStatus, phase: string): Promise<void> {
		if (this.finished) return;
		while (this.pendingPut) await this.pendingPut;
		this.record.status = status;
		this.record.phase = phase;
		this.record.completed_at = null;
		await this.put();
	}

	async finish(status: 'success' | 'failed' | 'rolled_back' | 'staged' | 'activating', error?: unknown): Promise<void> {
		if (this.finished) return;
		// Keep the emitter registered until the terminal row write lands. An SSE tailer may
		// otherwise observe the sentinel, re-read the preceding staged checkpoint, and
		// incorrectly finish with a stale result.
		const emitter = activeEmitters.get(this.deploymentId);
		this.finished = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
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
		this.record.completed_at = status === 'activating' ? null : Date.now();
		if (error) {
			const e = error as { message?: string; code?: string | number; stack?: string };
			this.record.error = {
				message: e?.message ?? String(error),
				code: e?.code,
				phase: this.record.phase,
			};
		}
		try {
			await this.put();
		} finally {
			// Emit after persistence but before removing the registry entry so subscribers
			// always have a durable terminal row to re-read. The sentinel also releases
			// tailers on failure paths that did not emit an explicit error event.
			emitter?.emit('_recorder_finished', { status });
			activeEmitters.delete(this.deploymentId);
		}
	}

	get row(): Record<string, any> {
		return this.record;
	}

	private async put(timeoutMs?: number): Promise<void> {
		const table = (databases as any).system?.[terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME];
		if (!table) {
			// Table missing means the upgrade directive hasn't run yet (or the table got dropped).
			// We tolerate this — tracking is observability; the deploy itself must still succeed.
			return;
		}
		await withIsolatedTransaction(() => table.put(this.record), timeoutMs);
	}
}

/**
 * Point-read a deployment row by id, or undefined when the row (or the table) is absent.
 *
 * Distinct from `awaitDeploymentRow`, which polls for a row to arrive by replication AND to carry a
 * `payload_blob`: this is for reading a row the caller already owns locally — e.g. recovering a staged
 * deployment's `package_identifier` when it is activated later by `deployment_id`. A row whose payload
 * has been reclaimed by retention is a valid result here, which is exactly what awaitDeploymentRow
 * would refuse to return.
 */
export async function getDeploymentRow(deploymentId: string): Promise<Record<string, any> | undefined> {
	if (!deploymentId) return undefined;
	const table = (databases as any).system?.[terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME];
	if (!table) return undefined;
	return table.get(deploymentId);
}

/**
 * Best-effort status update for an existing deployment row by id, used when a later operation
 * finishes a deployment the current process didn't record with a live DeploymentRecorder — e.g.
 * `deploy_component({ deployment_id })` activating a build that an earlier stage-and-stop left in the
 * `staged` state. No-op when the row (or the table) is absent; observability only, so callers treat a
 * failure here as non-fatal.
 */
export async function markDeploymentTerminal(
	deploymentId: string,
	status: 'success' | 'failed' | 'rolled_back' | 'staged' | 'activating',
	error?: unknown
): Promise<void> {
	const table = (databases as any).system?.[terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME];
	if (!table) return;
	const row = await table.get(deploymentId);
	if (!row) return;
	// Patch (partial update) rather than mutating the row: table.get() returns a read-only record, so
	// `row.status = …` throws "Cannot assign to read only property". A patch also touches only these two
	// fields, so it can't truncate the rest of the row the way a spread-and-put might.
	const update: Record<string, unknown> = {
		status,
		completed_at: status === 'activating' ? null : Date.now(),
	};
	if (error !== undefined) {
		update.error = {
			message: error instanceof Error ? error.message : String(error),
		};
	} else {
		// Cleared, not left alone: a recovery or a successful activate retry moves a row that already
		// carries a failure, and keeping that object would report success and an error at once.
		update.error = null;
	}
	await table.patch(deploymentId, update);
}

export async function recordDeploymentPeers(deploymentId: string, results: unknown): Promise<void> {
	if (!Array.isArray(results) || results.length === 0) return;
	const table = (databases as any).system?.[terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME];
	if (!table) return;
	const row = await table.get(deploymentId);
	if (!row) return;
	const peers = Array.isArray(row.peer_results)
		? row.peer_results.map((entry: unknown) => ({ ...(entry as object) }))
		: [];
	for (const result of results) {
		const normalized = normalizePeerResult(result);
		const index = normalized.node ? peers.findIndex((entry: any) => entry.node === normalized.node) : -1;
		if (index >= 0) peers[index] = normalized;
		else peers.push(normalized);
	}
	await table.patch(deploymentId, { peer_results: peers });
}

/**
 * Claim a staged deployment for activation while the component preparation lock is held. On the
 * ORIGIN this marks the row `activating`; `persist: false` runs the same validation without the
 * write, because the row is replicated and only the origin owns it. See DESIGN.md.
 */
/**
 * Whether deployment tracking is provisioned on this node.
 *
 * `DeploymentRecorder.put()` is deliberately tolerant — a one-shot deploy still works with no
 * `hdb_deployment` table, because tracking is observability there. It is NOT observability for the
 * separated phases: `activate: false` hands the caller a deployment_id that only the row can resolve,
 * so a stage that reported success would be unactivatable. Callers of the separated phases check this
 * up front instead of failing later with a missing row.
 */
export function isDeploymentTrackingAvailable(): boolean {
	return !!(databases as any).system?.[terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME];
}

export async function claimStagedDeployment(
	deploymentId: string,
	project: string,
	options: { allowActivating?: boolean; waitForStagedMs?: number; persist?: boolean } = {}
): Promise<Record<string, any>> {
	const table = (databases as any).system?.[terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME];
	if (!table) throw new ClientError('Deployment tracking is unavailable; cannot activate a staged deployment');
	const deadline = Date.now() + coerceTimeoutMs(options.waitForStagedMs, 0);
	let row = await table.get(deploymentId);
	if (!row) throw new ClientError(`No deployment found with id '${deploymentId}'`);
	if (row.project !== project) {
		throw new ClientError(`Deployment '${deploymentId}' belongs to component '${row.project}', not '${project}'`);
	}
	while (['pending', 'staging'].includes(row.status) && Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
		row = await table.get(deploymentId);
		if (!row) throw new ClientError(`No deployment found with id '${deploymentId}'`);
		if (row.project !== project) {
			throw new ClientError(`Deployment '${deploymentId}' belongs to component '${row.project}', not '${project}'`);
		}
	}
	if (row.status === 'activating' && options.allowActivating) return row;
	if (row.status !== 'staged') {
		throw new ClientError(`Deployment '${deploymentId}' is '${row.status}', not staged and available for activation`);
	}
	if (options.persist !== false) {
		await table.patch(deploymentId, { status: 'activating', phase: 'activate', completed_at: null, error: null });
	}
	return row;
}

// Deployment statuses that are settled — a non-terminal deployment's payload_blob may still be the
// replication channel peers are installing from, so retention must never yank it mid-flight. Mirrors
// deploymentOperations.ts's guard for the explicit delete_deployment_payload operation.
const TERMINAL_STATUSES = new Set(['success', 'failed', 'rolled_back']);

async function settleStagedRows(project: string, keepCount: number, keepDeploymentId?: string): Promise<string[]> {
	const table = (databases as any).system?.[terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME];
	if (!table) return [];
	const staged: Array<Record<string, any>> = [];
	for await (const row of table.search([{ attribute: 'project', value: project }])) {
		if (row?.status === 'staged') staged.push(row);
	}
	staged.sort(
		(a, b) => (b.started_at ?? 0) - (a.started_at ?? 0) || String(a.deployment_id).localeCompare(b.deployment_id)
	);
	// Keep the request being returned, plus any row strictly NEWER than it, plus the newest of the rest
	// up to the count. Excluding the current id from the ranking instead would privilege it
	// unconditionally: a stage that waited on slow peers resumes with an older `started_at`, so with a
	// retention of 1 it would expire the newer stage that had already completed and been reported to the
	// operator, then discard its staging tree cluster-wide. `started_at` is stamped by whichever node
	// originated the deploy, so cross-node clock skew produces the same inversion. Ties count as
	// protected, not evictable: two concurrent stages of one component can both reach `staged` in the
	// same millisecond, and evicting a tied row would fail a request that is about to return its
	// deployment id to the caller. The budget subtracts the protected rows, so the retained total still
	// lands on `keepCount` except when more rows tie-or-exceed the window than fit in it — a temporary
	// overflow, which is the right way for a disk bound to fail.
	const current = keepDeploymentId ? staged.find((row) => row.deployment_id === keepDeploymentId) : undefined;
	const others = staged.filter((row) => row.deployment_id !== keepDeploymentId);
	const protectedRows = current ? others.filter((row) => (row.started_at ?? 0) >= (current.started_at ?? 0)) : [];
	const budget = Math.max(0, keepCount - (current ? 1 : 0) - protectedRows.length);
	const expired = others.filter((row) => !protectedRows.includes(row)).slice(budget);
	for (const row of expired) {
		await table.patch(row.deployment_id, {
			status: 'failed',
			completed_at: Date.now(),
			error: { message: 'Staged build expired by deployment_stagingRetention_maxCount', phase: 'staged' },
		});
	}
	return expired.map((row) => row.deployment_id);
}

export async function expireOldStagedDeployments(
	project: string,
	maxCount: number,
	keepDeploymentId?: string
): Promise<string[]> {
	const count = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 1;
	return settleStagedRows(project, count, keepDeploymentId);
}

export async function invalidateProjectStagedDeployments(project: string): Promise<string[]> {
	const table = (databases as any).system?.[terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME];
	if (!table) return [];
	const invalidated: string[] = [];
	for await (const row of table.search([{ attribute: 'project', value: project }])) {
		if (!['staged', 'activating'].includes(row?.status)) continue;
		await table.patch(row.deployment_id, {
			status: 'failed',
			completed_at: Date.now(),
			error: { message: 'Staged build invalidated because the component was dropped', phase: row.phase },
		});
		invalidated.push(row.deployment_id);
	}
	return invalidated;
}

/**
 * Count-based payload retention: keep at most `maxCount` stored payload tarballs for a project,
 * newest first, dropping the payload_blob of the rest. Rows are always retained — only the tarball
 * bytes are reclaimed, so the audit trail (metadata + event_log) stays intact and `get_deployment`
 * still reports the deployment; only `get_deployment_payload` stops being available for the pruned
 * ones (`payload_blob_present: false`).
 *
 * Complements the size-based drop (`deployment_payloadRetention_maxSize`, which reclaims a single
 * oversized payload right after its own deploy): this bounds how many payloads accumulate per project
 * over time, which is what actually caps disk. Only rows that still HOLD a payload count toward
 * `maxCount`, so the cap is literally "at most N stored payloads per project".
 *
 * Best-effort and observability-only — callers must not fail a deploy because pruning failed.
 * Returns the total bytes reclaimed.
 */
export async function pruneProjectPayloads(project: string, maxCount: number): Promise<number> {
	if (!project) return 0;
	if (!Number.isFinite(maxCount) || maxCount < 0) return 0;
	const table = (databases as any).system?.[terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME];
	if (!table) return 0;

	const withPayload: Array<Record<string, any>> = [];
	for await (const row of table.search([{ attribute: 'project', value: project }])) {
		if (row?.payload_blob != null) withPayload.push(row);
	}
	// Newest first by started_at; ties broken by deployment_id so the ordering (and therefore which
	// payloads survive) is stable across runs — same tiebreak as handleListDeployments.
	withPayload.sort(
		(a, b) => (b.started_at ?? 0) - (a.started_at ?? 0) || String(a.deployment_id).localeCompare(b.deployment_id)
	);

	let freed = 0;
	for (const row of withPayload.slice(maxCount)) {
		// An in-flight deployment still counted toward maxCount above (its payload occupies disk) but
		// must not be dropped — skip it and let a later prune reclaim it once it settles.
		if (!TERMINAL_STATUSES.has(row.status)) continue;
		const size = typeof row.payload_size === 'number' ? row.payload_size : 0;
		// Patch only the field this prune owns. Writing the whole record back would rewrite fields a
		// concurrent deploy just changed — reverting a status, dropping an error — while reclaiming a
		// tarball. The drop is not appended to `event_log` either: that would be a read-copy-write of an
		// append-only list, so a concurrent writer's entry would be lost. `payload_blob_present: false`
		// already reports the outcome on the row, and the reclaim is logged here for the audit trail.
		await table.patch(row.deployment_id, { payload_blob: null });
		logger.info?.(
			`Reclaimed ${size} bytes of deployment payload for '${project}' (${row.deployment_id}): ` +
				`beyond deployment_payloadRetention_maxCount=${maxCount}`
		);
		freed += size;
	}
	return freed;
}

// Default peer-wait budget for the hdb_deployment row to replicate. A deploy is a rare,
// heavyweight, user-initiated operation, and the `system`-table replication channel can be
// backlogged behind unrelated writes when several deploys land in succession, so the row can
// take well over the original 30s to arrive on a peer (harper-pro#402). 120s matches the
// blob-stream receive default and gives a loaded cluster room to converge. Override per-deploy
// via the `deployment_timeout` operation parameter.
export const DEFAULT_AWAIT_ROW_TIMEOUT_MS = 120_000;

// Default open-time budget for the origin's payload-ingest write transaction (ingestPayload,
// below). Distinct from DEFAULT_AWAIT_ROW_TIMEOUT_MS (that one bounds a *replication* wait;
// this one bounds *local disk I/O* for a component the deploy system explicitly supports at
// arbitrarily large, uncapped sizes — see the module comment above and the large-payload
// regression test). 10 minutes comfortably covers a multi-GB ingest even on a slow or loaded
// disk while still being a bounded safety net, not a disabled one. Overridable via the same
// `deployment_timeout` operation parameter as the peer-side waits, so operators sizing for
// even larger components (or a known-slow disk) have one knob, not two.
export const DEFAULT_INGEST_TRANSACTION_TIMEOUT_MS = 600_000;

export function coerceTimeoutMs(value: unknown, fallback: number): number {
	const requested = Number(value);
	return Number.isFinite(requested) && requested >= 0 ? requested : fallback;
}

// Floored at the default, never lowered by it: `deployment_timeout` also governs the
// peer-side row/blob wait (awaitDeploymentRow), where 0 means "poll once, don't wait" — a
// legitimate fast-fail setting for peers that must never also starve the origin's own disk
// write down to 0ms.
export function ingestTransactionTimeoutMs(deploymentTimeout: unknown): number {
	return Math.max(
		coerceTimeoutMs(deploymentTimeout, DEFAULT_INGEST_TRANSACTION_TIMEOUT_MS),
		DEFAULT_INGEST_TRANSACTION_TIMEOUT_MS
	);
}

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
	options: {
		timeoutMs?: number;
		pollIntervalMs?: number;
		initialPollIntervalMs?: number;
		requirePayload?: boolean;
	} = {}
): Promise<Record<string, any>> {
	// Coerce defensively: the deploy operation's `deployment_timeout` reaches us via the
	// operation body, and the Joi validator's coerced number is discarded by validateBySchema
	// (it returns only the error, never writes the parsed value back), so a JSON/multipart
	// client sending `"120000"` would otherwise arrive here as a string. `Date.now() + "<n>"`
	// concatenates into a far-future "deadline" that silently defeats the timeout. Anything
	// non-finite or negative falls back to the default rather than producing a NaN deadline
	// (which would never satisfy `>= deadline` and loop forever).
	const timeoutMs = coerceTimeoutMs(options.timeoutMs, DEFAULT_AWAIT_ROW_TIMEOUT_MS);
	const maxIntervalMs = options.pollIntervalMs ?? 100;
	// Start fast (5ms) so the common case — replication has already caught up — sees no
	// human-noticeable latency, then back off exponentially up to maxIntervalMs for the
	// rare case where the row is genuinely still replicating.
	let intervalMs = options.initialPollIntervalMs ?? 5;
	const requirePayload = options.requirePayload !== false;
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
				if (!requirePayload || row.payload_blob != null) return row;
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

/**
 * Peer-side helper — read a replicated deploy's payload_blob, retrying on the blob layer's
 * retryable 503 (`BlobReadError` with `statusCode === BLOB_UNAVAILABLE_STATUS`,
 * resources/blob.ts). That 503 fires when the row's blob header has replicated but content
 * bytes stop arriving for `blobReadTimeout` (20s default) — a transient, self-healing stall
 * (a parked/declined blob send on the origin, or event-loop starvation), not a real failure.
 * Each fresh `stream()` call gets its own no-progress window, so re-opening after a short
 * backoff converts the stall into a successful deploy instead of failing the peer's one-shot
 * 20s window (harper-pro incident, 2026-07-16).
 *
 * Chunks are forwarded to the caller as they arrive via an async generator wrapped in
 * `Readable.from()` — a retry never buffers the whole payload in memory (deploy payloads can
 * be arbitrarily large, see the large-payload streaming regression test), and, unlike a manual
 * `ReadableStream` `start()` loop that eagerly drains the source, `Readable.from()`'s pull
 * protocol only resumes the generator when the consumer wants more, so backpressure from a
 * slow extraction consumer propagates back to the underlying `Blob.stream()` the same as it
 * did before this wrapper existed.
 *
 * This also bounds *when* a retry is safe: once any chunk has reached the consumer, re-opening
 * from byte 0 would duplicate it, so we only retry while the current attempt has yielded
 * nothing yet — the reported failure mode (no content bytes arrive at all within the
 * no-progress window). A stall after partial content has already been forwarded fails
 * immediately, exactly as an unwrapped read would.
 *
 * Non-retryable classes — 500 corrupt/incomplete, 404 gone/ENOENT, or anything without a
 * `statusCode` — also fail immediately.
 *
 * Cancellation is checked explicitly rather than relying on the generator's own suspension
 * points: while stuck retrying (no chunk has ever been yielded), the generator never reaches a
 * `yield`, so `Readable.from()`'s normal `return()`-on-destroy cancellation — which only takes
 * effect when the generator next suspends at a `yield` — would never get a chance to run,
 * letting retries continue for the full `timeoutMs` budget after the consumer has already given
 * up (verified empirically). We route the returned `Readable` into the generator via a shared
 * cell so it can check `readable.destroyed` at each loop iteration and after each backoff sleep,
 * stopping within one backoff interval (capped at `maxBackoffMs`) of destroy() instead.
 *
 * @param streamFactory Opens a fresh read of the blob, e.g. `() => row.payload_blob.stream()`.
 *   A factory (not a single stream) so each retry is a genuinely new read with its own
 *   no-progress window.
 */
export function readPayloadBlobWithRetry(
	streamFactory: () => ReadableStream,
	options: { timeoutMs?: number; initialBackoffMs?: number; maxBackoffMs?: number } = {}
): Readable {
	const cell: { readable?: Readable } = {};
	const readable = Readable.from(readPayloadBlobChunks(streamFactory, options, cell));
	cell.readable = readable;
	return readable;
}

async function* readPayloadBlobChunks(
	streamFactory: () => ReadableStream,
	options: { timeoutMs?: number; initialBackoffMs?: number; maxBackoffMs?: number },
	cell: { readable?: Readable }
): AsyncGenerator<Buffer> {
	const timeoutMs = coerceTimeoutMs(options.timeoutMs, DEFAULT_AWAIT_ROW_TIMEOUT_MS);
	const initialBackoffMs = options.initialBackoffMs ?? 2000;
	const maxBackoffMs = options.maxBackoffMs ?? 5000;
	const deadline = Date.now() + timeoutMs;
	let backoffMs = initialBackoffMs;
	let forwardedAnyBytes = false;
	while (true) {
		if (cell.readable?.destroyed) return;
		try {
			for await (const chunk of streamFactory() as unknown as AsyncIterable<Buffer>) {
				yield chunk;
				forwardedAnyBytes = true;
			}
			return;
		} catch (error) {
			if (forwardedAnyBytes || (error as { statusCode?: number })?.statusCode !== BLOB_UNAVAILABLE_STATUS) {
				throw error;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw error;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, Math.min(backoffMs, remaining));
				timer.unref?.();
			});
			if (cell.readable?.destroyed) return;
			backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
		}
	}
}

export function normalizePeerResult(raw: unknown): Record<string, unknown> {
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
		case 'stage':
			return 'staging';
		case 'load':
			return 'loading';
		case 'replicate':
			return 'replicating';
		case 'activate':
			return 'activating';
		case 'revert':
			return 'reverting';
		case 'restart':
			return 'restarting';
		default:
			return null;
	}
}
