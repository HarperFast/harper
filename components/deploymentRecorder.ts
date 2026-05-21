'use strict';

// DeploymentRecorder — Slice A scope.
//
// Owns the lifecycle of one row in system.hdb_deployment: creates the pending row at deploy
// start, streams the upload payload into the row's payload_blob (computing sha256 + size
// alongside), and writes the terminal status at the end. Slice B will extend this with
// ProgressEmitter subscription and event_log writes; Slice C will add rollback sourcing
// from the blob.

import { randomUUID } from 'node:crypto';
import { createHash, Hash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { databases } from '../resources/databases.ts';
import { createBlob } from '../resources/blob.ts';
import * as terms from '../utility/hdbTerms.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import { hostname } from 'node:os';

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
}

export class DeploymentRecorder {
	readonly deploymentId: string;
	private readonly record: Record<string, any>;
	private hash: Hash | null = null;
	private byteCount = 0;
	private finished = false;

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
		return recorder;
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
		this.finished = true;
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
