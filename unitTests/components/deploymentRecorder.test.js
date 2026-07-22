'use strict';

// Unit tests for the per-peer tracking and row-await helpers in DeploymentRecorder:
//   - `recordPeers()` — normalizes the opaque replication-layer per-peer outcomes into
//     a stable `[{node, status, error?, started_at, completed_at}]` shape on the row.
//   - `awaitDeploymentRow()` — peer-side helper that polls the hdb_deployment table
//     until the row arrives via replication, then returns it.
//
// These exercise the table layer via a tiny mock attached to `databases.system` —
// the recorder's `put()` already tolerates a missing table, so we only mock when we
// need to control the `.get()` return value or assert side effects.

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	DeploymentRecorder,
	awaitDeploymentRow,
	readPayloadBlobWithRetry,
} = require('#src/components/deploymentRecorder');
const { databases } = require('#src/resources/databases');
const terms = require('#src/utility/hdbTerms');

const DEPLOYMENT_TABLE = terms.SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME;

// Lightweight mock: keeps a Map of rows, exposes get(id) and put(row).
function installMockDeploymentTable() {
	const rows = new Map();
	const mock = {
		rows,
		async get(id) {
			return rows.get(id);
		},
		async put(row) {
			rows.set(row.deployment_id, row);
		},
	};
	if (!databases.system) databases.system = {};
	const prior = databases.system[DEPLOYMENT_TABLE];
	databases.system[DEPLOYMENT_TABLE] = mock;
	return {
		mock,
		restore() {
			databases.system[DEPLOYMENT_TABLE] = prior;
		},
	};
}

describe('DeploymentRecorder.recordPeer', () => {
	let installed;
	beforeEach(() => {
		installed = installMockDeploymentTable();
	});
	afterEach(() => installed.restore());

	it('normalizes a single-peer success result', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ node: 'node-b', status: 'success', started_at: 1000, completed_at: 1500 });
		assert.deepStrictEqual(recorder.row.peer_results, [
			{ node: 'node-b', status: 'success', error: null, started_at: 1000, completed_at: 1500 },
		]);
	});

	it('maps an Error-bearing result to status="failed" with structured error', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ node: 'node-c', error: { message: 'install timed out', code: 'ETIMEDOUT' } });
		assert.deepStrictEqual(recorder.row.peer_results, [
			{
				node: 'node-c',
				status: 'failed',
				error: { message: 'install timed out', code: 'ETIMEDOUT' },
				started_at: null,
				completed_at: null,
			},
		]);
	});

	it('treats a string-shaped error as failed and preserves the message', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ node: 'node-d', error: 'connection refused' });
		assert.strictEqual(recorder.row.peer_results[0].status, 'failed');
		assert.strictEqual(recorder.row.peer_results[0].error.message, 'connection refused');
	});

	it('captures the replicator { status: "failed", reason } shape, surfacing reason as error.message', async () => {
		// This is the shape replicateOperation's per-peer .catch produces (replicator.ts):
		// the failure detail lives on `reason`, not `error`. Without picking it up the audit
		// row would record a failed peer with no explanation.
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ node: 'node-e', status: 'failed', reason: 'Error: peer connection refused' });
		assert.strictEqual(recorder.row.peer_results[0].status, 'failed');
		assert.strictEqual(recorder.row.peer_results[0].error.message, 'Error: peer connection refused');
	});

	it('marks a bare { status: "failed" } as failed with a null error', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ node: 'node-f', status: 'failed' });
		assert.strictEqual(recorder.row.peer_results[0].status, 'failed');
		assert.strictEqual(recorder.row.peer_results[0].error, null);
	});

	it('falls back to "name"/"hostname" when "node" is missing', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ name: 'node-by-name', status: 'success' });
		recorder.recordPeer({ hostname: 'node-by-hostname', status: 'success' });
		assert.strictEqual(recorder.row.peer_results[0].node, 'node-by-name');
		assert.strictEqual(recorder.row.peer_results[1].node, 'node-by-hostname');
	});

	it('preserves primitive entries as stringified raw markers', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer('node-x failed somehow');
		assert.strictEqual(recorder.row.peer_results[0].status, 'unknown');
		assert.strictEqual(recorder.row.peer_results[0].raw, 'node-x failed somehow');
	});

	it('upserts by node name on repeat calls — same peer transitions from pending to success', async () => {
		// The real-time use case: first call recorder.recordPeer({node:'n1', status:'pending'}),
		// then later recordPeer({node:'n1', status:'success'}). Only one entry should
		// exist for 'n1', and it should reflect the latest call.
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ node: 'n1', status: 'pending' });
		recorder.recordPeer({ node: 'n2', status: 'pending' });
		assert.strictEqual(recorder.row.peer_results.length, 2);
		recorder.recordPeer({ node: 'n1', status: 'success' });
		assert.strictEqual(recorder.row.peer_results.length, 2, 'no duplicate entry for n1');
		const n1 = recorder.row.peer_results.find((e) => e.node === 'n1');
		assert.strictEqual(n1.status, 'success', 'n1 upserted to latest status');
	});

	it('is a no-op when called after finish()', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		await recorder.finish('success');
		recorder.recordPeer({ node: 'node-late', status: 'success' });
		assert.deepStrictEqual(recorder.row.peer_results, []);
	});

	it('persists via scheduleFlush so the row eventually reflects peer outcomes', async () => {
		// recordPeer mutates in-memory and triggers the coalesced flush — by the time
		// finish() drains pending puts, the persisted row carries peer_results.
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ node: 'node-z', status: 'success' });
		await recorder.finish('success');
		const persisted = await installed.mock.get(recorder.deploymentId);
		assert.strictEqual(persisted.peer_results[0].node, 'node-z');
		assert.strictEqual(persisted.peer_results[0].status, 'success');
		assert.strictEqual(persisted.status, 'success');
	});
});

describe('DeploymentRecorder.recordPeers (bulk wrapper)', () => {
	let installed;
	beforeEach(() => {
		installed = installMockDeploymentTable();
	});
	afterEach(() => installed.restore());

	it('iterates the input array and upserts each entry', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeers([
			{ node: 'a', status: 'success' },
			{ node: 'b', status: 'success' },
		]);
		assert.strictEqual(recorder.row.peer_results.length, 2);
	});

	it('is idempotent when the same entries arrive via per-peer and aggregate paths', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ node: 'a', status: 'success' });
		recorder.recordPeers([{ node: 'a', status: 'success' }]);
		assert.strictEqual(recorder.row.peer_results.length, 1);
	});

	it('is a no-op for non-array inputs (defensive against odd replication shapes)', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeers(undefined);
		recorder.recordPeers(null);
		recorder.recordPeers('not an array');
		recorder.recordPeers({ node: 'object-not-array' });
		assert.deepStrictEqual(recorder.row.peer_results, []);
	});
});

describe('DeploymentRecorder.getFailedPeers', () => {
	let installed;
	beforeEach(() => {
		installed = installMockDeploymentTable();
	});
	afterEach(() => installed.restore());

	it('returns an empty array when no peers were recorded', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		assert.deepStrictEqual(recorder.getFailedPeers(), []);
	});

	it('returns an empty array when all peers succeeded', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeers([
			{ node: 'a', status: 'success' },
			{ node: 'b', status: 'success' },
		]);
		assert.deepStrictEqual(recorder.getFailedPeers(), []);
	});

	it('returns only the failed entries (status="failed")', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer({ node: 'a', status: 'success' });
		recorder.recordPeer({ node: 'b', error: { message: 'install timed out', code: 'ETIMEDOUT' } });
		recorder.recordPeer({ node: 'c', error: 'connection refused' });
		const failed = recorder.getFailedPeers();
		assert.strictEqual(failed.length, 2);
		assert.deepStrictEqual(
			failed.map((peer) => peer.node),
			['b', 'c']
		);
		assert.strictEqual(failed[0].error.message, 'install timed out');
	});

	it('does not count an uninterpretable primitive entry (status="unknown") as failed', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.recordPeer('some opaque marker');
		assert.deepStrictEqual(recorder.getFailedPeers(), []);
	});
});

describe('DeploymentRecorder.seal', () => {
	let installed;
	let putLog;
	beforeEach(() => {
		putLog = [];
		const rows = new Map();
		const mock = {
			rows,
			async get(id) {
				return rows.get(id);
			},
			async put(row) {
				putLog.push({ status: row.status, peerCount: (row.peer_results ?? []).length });
				rows.set(row.deployment_id, { ...row, peer_results: [...(row.peer_results ?? [])] });
			},
		};
		if (!databases.system) databases.system = {};
		const prior = databases.system[DEPLOYMENT_TABLE];
		databases.system[DEPLOYMENT_TABLE] = mock;
		installed = {
			mock,
			restore() {
				databases.system[DEPLOYMENT_TABLE] = prior;
			},
		};
	});
	afterEach(() => installed.restore());

	it('stops persisting intermediate updates once sealed, but finish() writes the terminal state', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		const putsAfterCreate = putLog.length;
		recorder.seal();
		recorder.recordPeer({ node: 'a', status: 'success' });
		recorder.recordPeer({ node: 'b', status: 'success' });
		assert.strictEqual(recorder.row.peer_results.length, 2, 'peer_results accumulate in memory while sealed');
		assert.strictEqual(putLog.length, putsAfterCreate, 'no puts are issued while sealed (pre-finish)');

		await recorder.finish('success');
		const terminal = putLog[putLog.length - 1];
		assert.strictEqual(terminal.status, 'success', 'finish() persists the terminal status');
		assert.strictEqual(terminal.peerCount, 2, 'finish() carries the accumulated peer_results');
		const persisted = await installed.mock.get(recorder.deploymentId);
		assert.strictEqual(persisted.status, 'success');
		assert.strictEqual(persisted.peer_results.length, 2);
	});

	it('does not affect persistence before seal: recordPeer still flushes incrementally', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		const putsAfterCreate = putLog.length;
		recorder.recordPeer({ node: 'a', status: 'success' });
		// scheduleFlush issues the put asynchronously; let it settle.
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(putLog.length > putsAfterCreate, 'an unsealed recordPeer persists incrementally');
	});
});

describe('DeploymentRecorder.dropPayload', () => {
	let installed;
	beforeEach(() => {
		installed = installMockDeploymentTable();
	});
	afterEach(() => installed.restore());

	it('nulls the payload_blob and returns the freed size, retaining size/hash metadata', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.row.payload_blob = { fake: true };
		recorder.row.payload_size = 12_345;
		recorder.row.payload_hash = 'abc123';
		const freed = recorder.dropPayload();
		assert.strictEqual(freed, 12_345);
		assert.strictEqual(recorder.row.payload_blob, null, 'blob reference is dropped');
		assert.strictEqual(recorder.row.payload_size, 12_345, 'size metadata is retained');
		assert.strictEqual(recorder.row.payload_hash, 'abc123', 'hash metadata is retained');
	});

	it('is a no-op returning 0 when there is no payload_blob', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		// create() initializes payload_blob to null.
		assert.strictEqual(recorder.dropPayload(), 0);
	});

	it('returns 0 (freed nothing) when payload_size is unknown but still drops the blob', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.row.payload_blob = { fake: true };
		recorder.row.payload_size = null;
		assert.strictEqual(recorder.dropPayload(), 0);
		assert.strictEqual(recorder.row.payload_blob, null);
	});

	it('is a no-op after finish() — leaves the blob reference untouched', async () => {
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		const blob = { fake: true };
		recorder.row.payload_blob = blob;
		recorder.row.payload_size = 999;
		await recorder.finish('success');
		assert.strictEqual(recorder.dropPayload(), 0);
		assert.strictEqual(recorder.row.payload_blob, blob, 'a finished recorder does not mutate the row');
	});

	it('folds the dropped reference into the single terminal write when sealed', async () => {
		// Mirrors the deploy flow: ingest sets the blob, seal() before replicate, dropPayload()
		// just before finish() so the null lands in finish()'s one put rather than a separate one.
		const recorder = await DeploymentRecorder.create({ project: 'p' });
		recorder.row.payload_blob = { fake: true };
		recorder.row.payload_size = 20 * 1024 * 1024;
		recorder.seal();
		const freed = recorder.dropPayload();
		assert.strictEqual(freed, 20 * 1024 * 1024);
		await recorder.finish('success');
		const persisted = await installed.mock.get(recorder.deploymentId);
		assert.strictEqual(persisted.payload_blob, null, 'terminal row has no blob reference');
		assert.strictEqual(persisted.payload_size, 20 * 1024 * 1024, 'terminal row retains the size');
		assert.strictEqual(persisted.status, 'success');
	});
});

describe('awaitDeploymentRow', () => {
	let installed;
	beforeEach(() => {
		installed = installMockDeploymentTable();
	});
	afterEach(() => installed.restore());

	it('returns the row immediately when it is already present with payload_blob', async () => {
		const row = { deployment_id: 'd1', payload_blob: { fake: true } };
		installed.mock.rows.set('d1', row);
		const result = await awaitDeploymentRow('d1');
		assert.strictEqual(result, row);
	});

	it('skips a row with no payload_blob (still in flight) and resolves once it arrives', async () => {
		const id = 'd2';
		installed.mock.rows.set(id, { deployment_id: id, payload_blob: null });
		// Schedule a delayed write of the blob so the polling loop sees it.
		setTimeout(() => {
			installed.mock.rows.set(id, { deployment_id: id, payload_blob: { fake: true } });
		}, 50);
		const result = await awaitDeploymentRow(id, { timeoutMs: 1000, pollIntervalMs: 25 });
		assert.ok(result.payload_blob);
	});

	it('rejects with a "did not replicate" timeout when the row never arrives within timeoutMs', async () => {
		await assert.rejects(
			() => awaitDeploymentRow('never-arrives', { timeoutMs: 100, pollIntervalMs: 25 }),
			/Timed out after 100ms .*hdb_deployment row 'never-arrives' did not replicate/
		);
	});

	it('rejects with a "payload_blob has not arrived" timeout when the row replicated but its blob has not', async () => {
		// Distinguish the two failure modes: the row is present (replication reached its
		// creation) but payload_blob stays null past the deadline — points at the payload
		// write, not a dead channel.
		const id = 'row-without-blob';
		installed.mock.rows.set(id, { deployment_id: id, payload_blob: null });
		await assert.rejects(
			() => awaitDeploymentRow(id, { timeoutMs: 100, pollIntervalMs: 25 }),
			/Timed out after 100ms .*row 'row-without-blob' replicated but its payload_blob has not arrived/
		);
	});

	it('throws if the deployment table is missing entirely (not yet provisioned)', async () => {
		delete databases.system[DEPLOYMENT_TABLE];
		await assert.rejects(() => awaitDeploymentRow('d3'), /Deployment tracking is not initialized on this node/);
	});

	it('coerces a numeric-string timeoutMs so the deadline is real (not string concatenation)', async () => {
		// `deployment_timeout` can reach awaitDeploymentRow as a string (validateBySchema
		// discards Joi's coerced value). Date.now() + "120" would concatenate into a
		// far-future deadline that never times out; the coercion must keep it numeric so this
		// rejects in ~120ms rather than hanging.
		const before = Date.now();
		await assert.rejects(
			() => awaitDeploymentRow('string-timeout', { timeoutMs: '120', pollIntervalMs: 25 }),
			/Timed out after 120ms/
		);
		assert.ok(Date.now() - before < 5000, 'a string timeoutMs must not balloon the deadline');
	});

	it('falls back to a real deadline when timeoutMs is non-numeric (no NaN infinite loop)', async () => {
		// Number('soon') is NaN; a NaN deadline would make `remaining <= 0` always false and
		// loop forever. The guard must fall back to the default, so polling for an
		// already-present row still resolves immediately.
		const row = { deployment_id: 'nan-timeout', payload_blob: { fake: true } };
		installed.mock.rows.set('nan-timeout', row);
		const result = await awaitDeploymentRow('nan-timeout', { timeoutMs: 'soon' });
		assert.strictEqual(result, row);
	});

	it('polls at least once when timeoutMs is 0 — returns an already-present row', async () => {
		const row = { deployment_id: 'zero-present', payload_blob: { fake: true } };
		installed.mock.rows.set('zero-present', row);
		const result = await awaitDeploymentRow('zero-present', { timeoutMs: 0 });
		assert.strictEqual(result, row, 'a 0 timeout must still perform a single lookup');
	});

	it('polls once then times out when timeoutMs is 0 and the row is absent', async () => {
		await assert.rejects(() => awaitDeploymentRow('zero-absent', { timeoutMs: 0 }), /Timed out after 0ms/);
	});
});

describe('readPayloadBlobWithRetry', () => {
	// Mirrors what resources/blob.ts's stream() rejects a ReadableStream with: an Error carrying
	// a `statusCode` (503 = BLOB_UNAVAILABLE_STATUS/retryable, 500 = corrupt/permanent).
	function statusCodeStream(statusCode, message) {
		return new ReadableStream({
			start(controller) {
				const error = new Error(message ?? `stream failed with ${statusCode}`);
				error.statusCode = statusCode;
				controller.error(error);
			},
		});
	}

	function successStream(content) {
		return new ReadableStream({
			start(controller) {
				controller.enqueue(Buffer.from(content));
				controller.close();
			},
		});
	}

	// A stream that delivers one chunk, then errors on the NEXT pull — used to prove a
	// mid-stream 503 (bytes already forwarded) is NOT retried, unlike a 503 before any chunk
	// arrives. Enqueuing and erroring within the same `start()` call doesn't model this: per
	// the streams spec, controller.error() resets the internal queue, so a chunk enqueued and
	// then errored in the same synchronous turn is discarded before a reader ever sees it.
	// Splitting across two `pull()` calls forces the first chunk to actually be read out (and
	// forwarded) before the stall.
	function partialThenErrorStream(statusCode, message) {
		let pulled = false;
		return new ReadableStream({
			pull(controller) {
				if (!pulled) {
					pulled = true;
					controller.enqueue(Buffer.from('partial-'));
					return;
				}
				const error = new Error(message ?? `stream failed with ${statusCode}`);
				error.statusCode = statusCode;
				controller.error(error);
			},
		});
	}

	async function readAll(stream) {
		const chunks = [];
		for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		return Buffer.concat(chunks);
	}

	it('retries a 503 and resolves with the content once a later attempt succeeds', async () => {
		let attempts = 0;
		const streamFactory = () => {
			attempts++;
			return attempts < 3 ? statusCodeStream(503) : successStream('tarball-bytes');
		};
		const stream = readPayloadBlobWithRetry(streamFactory, { timeoutMs: 5000, initialBackoffMs: 5, maxBackoffMs: 5 });
		const result = await readAll(stream);
		assert.strictEqual(attempts, 3, 'retried twice before the third attempt succeeded');
		assert.strictEqual(result.toString(), 'tarball-bytes');
	});

	it('rejects with the original stall error once the timeout budget is exhausted on repeated 503s', async () => {
		let attempts = 0;
		const streamFactory = () => {
			attempts++;
			return statusCodeStream(503, 'Blob read stalled: no further data is arriving');
		};
		const stream = readPayloadBlobWithRetry(streamFactory, { timeoutMs: 30, initialBackoffMs: 10, maxBackoffMs: 10 });
		await assert.rejects(() => readAll(stream), /Blob read stalled: no further data is arriving/);
		assert.ok(attempts >= 2, 'made at least one retry attempt before the budget ran out');
	});

	it('does not retry a 500 (permanent/corrupt) error — fails on the first attempt', async () => {
		let attempts = 0;
		const streamFactory = () => {
			attempts++;
			return statusCodeStream(500, 'Blob is corrupt');
		};
		const stream = readPayloadBlobWithRetry(streamFactory, { timeoutMs: 5000, initialBackoffMs: 5, maxBackoffMs: 5 });
		await assert.rejects(() => readAll(stream), /Blob is corrupt/);
		assert.strictEqual(attempts, 1, 'a non-retryable status must not be retried');
	});

	it('does not retry an error with no statusCode at all', async () => {
		let attempts = 0;
		const streamFactory = () => {
			attempts++;
			return new ReadableStream({
				start(controller) {
					controller.error(new Error('unexpected failure'));
				},
			});
		};
		const stream = readPayloadBlobWithRetry(streamFactory, { timeoutMs: 5000, initialBackoffMs: 5, maxBackoffMs: 5 });
		await assert.rejects(() => readAll(stream), /unexpected failure/);
		assert.strictEqual(attempts, 1);
	});

	it('does not retry a 503 once a chunk has already reached the consumer — avoids duplicating forwarded bytes', async () => {
		let attempts = 0;
		const streamFactory = () => {
			attempts++;
			return partialThenErrorStream(503, 'stalled mid-stream');
		};
		const stream = readPayloadBlobWithRetry(streamFactory, { timeoutMs: 5000, initialBackoffMs: 5, maxBackoffMs: 5 });
		await assert.rejects(() => readAll(stream), /stalled mid-stream/);
		assert.strictEqual(attempts, 1, 'a stall after partial content must not be retried');
	});

	it('succeeds on the first attempt without waiting when the stream is healthy', async () => {
		let attempts = 0;
		const streamFactory = () => {
			attempts++;
			return successStream('ok');
		};
		const before = Date.now();
		const stream = readPayloadBlobWithRetry(streamFactory, { timeoutMs: 5000 });
		const result = await readAll(stream);
		assert.strictEqual(attempts, 1);
		assert.strictEqual(result.toString(), 'ok');
		assert.ok(Date.now() - before < 500, 'a healthy first read must not incur backoff delay');
	});

	it('forwards chunks without buffering the whole payload — large payloads stream through', async () => {
		// Regression guard for a full-buffering design: with a multi-chunk stream, the wrapper
		// must yield each chunk as it arrives rather than collecting them all before returning
		// anything.
		const streamFactory = () =>
			new ReadableStream({
				start(controller) {
					controller.enqueue(Buffer.from('chunk-1-'));
					controller.enqueue(Buffer.from('chunk-2'));
					controller.close();
				},
			});
		const stream = readPayloadBlobWithRetry(streamFactory, { timeoutMs: 5000 });
		const iterator = stream[Symbol.asyncIterator]();
		const first = await iterator.next();
		assert.strictEqual(Buffer.from(first.value).toString(), 'chunk-1-', 'first chunk is forwarded on its own');
		const second = await iterator.next();
		assert.strictEqual(Buffer.from(second.value).toString(), 'chunk-2');
		const done = await iterator.next();
		assert.strictEqual(done.done, true);
	});

	it('is pull-based — reading one chunk does not drain a large source ahead of consumer demand', async () => {
		// Regression guard for the eager-drain bug: a `for await` loop that enqueues into a
		// Web ReadableStream without checking `desiredSize` keeps pulling from the source as
		// fast as it can, regardless of whether the consumer has read anything yet — defeating
		// the whole no-buffering design for a multi-GB payload. Readable.from()'s pull protocol
		// only resumes the generator when the consumer asks for more, so the source must not be
		// anywhere near drained after the consumer has read just one chunk.
		const TOTAL_CHUNKS = 5000;
		let innerPulls = 0;
		const streamFactory = () =>
			new ReadableStream({
				pull(controller) {
					innerPulls++;
					if (innerPulls > TOTAL_CHUNKS) {
						controller.close();
						return;
					}
					controller.enqueue(Buffer.from(`chunk-${innerPulls}`));
				},
			});
		const stream = readPayloadBlobWithRetry(streamFactory, { timeoutMs: 5000 });
		const iterator = stream[Symbol.asyncIterator]();
		const first = await iterator.next();
		assert.strictEqual(Buffer.from(first.value).toString(), 'chunk-1');
		assert.ok(
			innerPulls < TOTAL_CHUNKS / 2,
			`must not eagerly drain the source before the consumer asks for more (pulled ${innerPulls}/${TOTAL_CHUNKS} after reading just one chunk)`
		);
	});

	it('performs a single check (no retry loop) when timeoutMs is 0', async () => {
		let attempts = 0;
		const streamFactory = () => {
			attempts++;
			return statusCodeStream(503, 'stalled');
		};
		const stream = readPayloadBlobWithRetry(streamFactory, { timeoutMs: 0 });
		await assert.rejects(() => readAll(stream), /stalled/);
		assert.strictEqual(attempts, 1, 'a 0 timeout must not retry at all');
	});

	it('bounds retries after the consumer destroys the stream — does not retry toward the full timeout budget', async () => {
		let attempts = 0;
		const streamFactory = () => {
			attempts++;
			return statusCodeStream(503);
		};
		const stream = readPayloadBlobWithRetry(streamFactory, {
			timeoutMs: 10_000,
			initialBackoffMs: 20,
			maxBackoffMs: 20,
		});
		stream.resume(); // start consuming so the generator actually runs
		await new Promise((resolve) => setTimeout(resolve, 50)); // let the first attempt fail and enter backoff
		stream.destroy();
		// destroy() only takes effect at the generator's next suspension point, not
		// immediately, so some further attempts can still land in a short window — but they
		// must stabilize well before the full 10s budget, not keep retrying toward it.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const attemptsAfterGracePeriod = attempts;
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.strictEqual(
			attempts,
			attemptsAfterGracePeriod,
			'retries must stop within a bounded window after destroy(), not continue toward the full timeout budget'
		);
	});
});
