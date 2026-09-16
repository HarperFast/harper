require('../testUtils');
const assert = require('node:assert');
const { writeKeyId } = require('#src/resources/DatabaseTransaction');
const {
	FullTextDerivedIndexBackend,
	decodeFullTextCursorPayload,
	encodeFullTextCursorPayload,
	toFullTextMutationBatch,
} = require('#src/resources/FullTextDerivedIndexBackend');
const {
	DERIVED_INDEX_ACCEPTED,
	DERIVED_INDEX_DEFERRED,
	DERIVED_INDEX_FAILED,
} = require('#src/resources/derivedIndexRuntime');
const { waitFor } = require('../waitFor');

const cursor = (timestamp) => ({ format: 1, logs: { local: timestamp } });

class FakeEngine {
	constructor(committedPayload) {
		this.committedPayload = committedPayload;
		this.applied = [];
		this.encoded = [];
		this.encodingOptions = [];
		this.publications = [];
		this.closes = [];
	}

	encodeMutationBatches(batch, options) {
		this.encoded.push(batch);
		this.encodingOptions.push(options);
		this.onEncode?.(batch, options);
		if (this.encodeError) throw this.encodeError;
		if (this.encodeResult) return this.encodeResult(batch);
		return {
			batches: [
				{
					bytes: Buffer.from(JSON.stringify(batch)),
					mutationCount: batch.upserts.length + batch.deletes.length,
				},
			],
			rejected: [],
			consumedUpserts: batch.upserts.length,
			consumedDeletes: batch.deletes.length,
		};
	}

	async apply(bytes) {
		const batch = JSON.parse(Buffer.from(bytes).toString());
		this.applied.push(batch);
		if (this.applyError) throw this.applyError;
		if (this.applyWait) await this.applyWait;
		return this.appliedCount ?? batch.upserts.length + batch.deletes.length;
	}

	async publish(payload) {
		this.publications.push(payload);
		if (this.publishError) throw this.publishError;
		this.committedPayload = payload;
		return 1n;
	}

	async close(options) {
		this.closes.push(options);
		if (this.closeWait) await this.closeWait;
		if (this.closeError) throw this.closeError;
	}
}

function lifecycle(inspection = { state: 'missing' }, opens = []) {
	return {
		inspection,
		inspectCalls: 0,
		openCalls: 0,
		resetCalls: 0,
		inspect() {
			this.inspectCalls++;
			return this.inspection;
		},
		async open() {
			this.openCalls++;
			const next = opens.shift();
			if (next instanceof Error) throw next;
			if (typeof next === 'function') return next();
			return next;
		},
		async reset() {
			this.resetCalls++;
			if (this.resetError) throw this.resetError;
		},
	};
}

function makeBackend(lifecycleValue, options = {}) {
	let epoch = 1n;
	const backend = new FullTextDerivedIndexBackend({
		id: 'products-title',
		lifecycle: lifecycleValue,
		maxQueuedBatches: options.maxQueuedBatches,
		maxQueuedBytes: options.maxQueuedBytes,
		openAttempts: options.openAttempts ?? 1,
		openRetryMilliseconds: options.openRetryMilliseconds ?? 0,
		cursorOnlyPublishAfterFlushes: options.cursorOnlyPublishAfterFlushes,
		maxCursorOnlyPublishDelayMilliseconds: options.maxCursorOnlyPublishDelayMilliseconds,
		now: options.now,
	});
	backend.attach({
		isOwnerEpoch: (candidate) => candidate === epoch,
		getReadiness: () => ({ state: 'ready', ownerEpoch: epoch, rebuildAttempts: 0 }),
	});
	return { backend, setEpoch: (value) => (epoch = value) };
}

function mutation(recordId, state, tableId = 1) {
	return { tableId, recordId, recordKey: writeKeyId(recordId), logVersion: 1, state };
}

function batch(ownerEpoch, records, through, bytes = 32) {
	return { ownerEpoch, transactions: [], records, through, bytes };
}

describe('FullTextDerivedIndexBackend', () => {
	it('encodes bounded deterministic cursor payloads', () => {
		const payload = encodeFullTextCursorPayload({ format: 1, logs: { z: 20, a: 10 } });
		assert.strictEqual(payload, '{"format":1,"cursor":{"format":1,"logs":{"a":10,"z":20}}}');
		assert.deepStrictEqual({ ...decodeFullTextCursorPayload(payload).logs }, { a: 10, z: 20 });
		assert.strictEqual(decodeFullTextCursorPayload(encodeFullTextCursorPayload(undefined)), undefined);
		assert.throws(() => decodeFullTextCursorPayload('{"format":1,"cursor":{"format":1,"logs":{"local":0}}}'));
		assert.throws(() => decodeFullTextCursorPayload('x'.repeat(32), 16));
	});

	it('maps canonical Harper keys to unambiguous document ids', () => {
		const converted = toFullTextMutationBatch(
			batch(1n, [
				mutation(1, { kind: 'record', version: 1, projection: { title: 'one' } }),
				mutation('a', { kind: 'absent' }, 12),
			])
		);
		assert.strictEqual(converted.upserts[0].id, `1.${Buffer.from(writeKeyId(1), 'latin1').toString('base64url')}`);
		assert.strictEqual(converted.deletes[0], `12.${Buffer.from(writeKeyId('a'), 'latin1').toString('base64url')}`);
		assert.notStrictEqual(converted.upserts[0].id, converted.deletes[0]);
	});

	it('inspects the durable cursor without opening a writer', () => {
		const source = lifecycle({ state: 'checkpointed', committedPayload: encodeFullTextCursorPayload(cursor(10)) });
		const { backend } = makeBackend(source);
		assert.deepStrictEqual({ ...backend.getDurableCursor().logs }, cursor(10).logs);
		assert.deepStrictEqual({ ...backend.getDurableCursor().logs }, cursor(10).logs);
		assert.strictEqual(source.inspectCalls, 1);
		assert.strictEqual(source.openCalls, 0);
	});

	it('returns no cursor for missing, incompatible, or malformed native state', () => {
		for (const inspection of [
			{ state: 'missing' },
			{ state: 'incompatible', code: 'E_SCHEMA_MISMATCH' },
			{ state: 'checkpointed', committedPayload: 'not-json' },
		]) {
			const { backend } = makeBackend(lifecycle(inspection));
			assert.strictEqual(backend.getDurableCursor(), undefined);
		}
	});

	it('retries inspection after a transient read failure', () => {
		const source = lifecycle();
		const inspect = source.inspect;
		source.inspect = function () {
			if (this.inspectCalls++ === 0) throw new Error('temporary read failure');
			this.inspectCalls--;
			return inspect.call(this);
		};
		const { backend } = makeBackend(source);
		assert.throws(
			() => backend.getDurableCursor(),
			(error) => error.name === 'DerivedIndexBackendRetryError' && /temporary read failure/.test(error.cause?.message)
		);
		assert.strictEqual(backend.getDurableCursor(), undefined);
		assert.strictEqual(source.inspectCalls, 2);
	});

	it('opens the writer lazily on its first accepted delivery', async () => {
		const engine = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		const source = lifecycle({ state: 'checkpointed', committedPayload: engine.committedPayload }, [engine]);
		const { backend } = makeBackend(source);
		backend.getDurableCursor();
		assert.strictEqual(source.openCalls, 0);
		assert.strictEqual(
			backend.deliver(
				batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20))
			),
			DERIVED_INDEX_ACCEPTED
		);
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		assert.strictEqual(source.openCalls, 1);
		assert.deepStrictEqual({ ...backend.getDurableCursor().logs }, cursor(20).logs);
		await backend.shutdown(1n);
	});

	it('applies every exact wrapper partition before publishing one cursor', async () => {
		const engine = new FakeEngine();
		engine.encodeResult = (value) => ({
			batches: value.upserts.map((upsert) => ({
				bytes: Buffer.from(JSON.stringify({ upserts: [upsert], deletes: [] })),
				mutationCount: 1,
			})),
			rejected: [],
			consumedUpserts: value.upserts.length,
			consumedDeletes: value.deletes.length,
		});
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]), { maxQueuedBytes: 128 });
		backend.deliver(
			batch(
				1n,
				['a', 'b', 'c'].map((id) => mutation(id, { kind: 'record', version: 1, projection: { title: id } })),
				cursor(20)
			)
		);
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		assert.strictEqual(engine.applied.length, 3);
		assert.strictEqual(engine.applied.flatMap((value) => value.upserts).length, 3);
		assert.deepStrictEqual(engine.encodingOptions, [{ maxTotalBytes: 128, allowPartial: true }]);
		await backend.shutdown(1n);
	});

	it('continues consumed mutation prefixes behind one publication barrier', async () => {
		const engine = new FakeEngine();
		engine.encodeResult = (value) => {
			const prefix =
				value.upserts.length > 0
					? { upserts: value.upserts.slice(0, 1), deletes: [] }
					: { upserts: [], deletes: value.deletes.slice(0, 1) };
			return {
				batches: [{ bytes: Buffer.from(JSON.stringify(prefix)), mutationCount: 1 }],
				rejected: [],
				consumedUpserts: prefix.upserts.length,
				consumedDeletes: prefix.deletes.length,
			};
		};
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]), { maxQueuedBytes: 128 });
		backend.deliver(
			batch(
				1n,
				[
					mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } }),
					mutation('b', { kind: 'absent' }),
					mutation('c', { kind: 'absent' }),
				],
				cursor(20)
			)
		);
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		assert.strictEqual(engine.encoded.length, 3);
		assert.deepStrictEqual(
			engine.applied.map((value) => [value.upserts.length, value.deletes.length]),
			[
				[1, 0],
				[0, 1],
				[0, 1],
			]
		);
		await backend.shutdown(1n);
	});

	it('rolls back staged prefixes when a later prefix cannot be encoded', async () => {
		const engine = new FakeEngine();
		let encodes = 0;
		engine.encodeResult = (value) => {
			if (++encodes === 2) throw new Error('later prefix failed');
			const prefix = { upserts: value.upserts.slice(0, 1), deletes: [] };
			return {
				batches: [{ bytes: Buffer.from(JSON.stringify(prefix)), mutationCount: 1 }],
				rejected: [],
				consumedUpserts: 1,
				consumedDeletes: 0,
			};
		};
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]));
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.deliver(
			batch(
				1n,
				['a', 'b'].map((id) => mutation(id, { kind: 'record', version: 1, projection: { title: id } })),
				cursor(20)
			)
		);
		backend.flush();
		await waitFor(() => changes.includes('failed'));
		assert.strictEqual(engine.applied.length, 1);
		assert.deepStrictEqual(engine.closes, [{ mode: 'rollback' }]);
		assert(!changes.includes('accepted-work-lost'));
		await backend.shutdown(1n);
	});

	it('rolls back every staged frame when a later frame fails', async () => {
		const engine = new FakeEngine();
		engine.encodeResult = (value) => ({
			batches: value.upserts.map((upsert) => ({
				bytes: Buffer.from(JSON.stringify({ upserts: [upsert], deletes: [] })),
				mutationCount: 1,
			})),
			rejected: [],
			consumedUpserts: value.upserts.length,
			consumedDeletes: value.deletes.length,
		});
		engine.apply = async function (bytes) {
			const value = JSON.parse(Buffer.from(bytes).toString());
			this.applied.push(value);
			if (this.applied.length === 2) throw new Error('second frame failed');
			return 1;
		};
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]));
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.deliver(
			batch(
				1n,
				['a', 'b'].map((id) => mutation(id, { kind: 'record', version: 1, projection: { title: id } })),
				cursor(20)
			)
		);
		backend.flush();
		await waitFor(() => changes.includes('accepted-work-lost'));
		assert.strictEqual(engine.applied.length, 2);
		assert.strictEqual(engine.publications.length, 0);
		assert.deepStrictEqual(engine.closes, [{ mode: 'rollback' }]);
		await backend.shutdown(1n);
	});

	it('fails permanently after rolling back an applied-count contract violation', async () => {
		const engine = new FakeEngine();
		engine.appliedCount = 0;
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]));
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20)));
		backend.flush();
		await waitFor(() => changes.includes('failed'));
		assert(!changes.includes('accepted-work-lost'));
		assert.strictEqual(engine.publications.length, 0);
		assert.deepStrictEqual(engine.closes, [{ mode: 'rollback' }]);
		await backend.shutdown(1n);
	});

	it('replaces only wrapper-rejected upserts with removals', async () => {
		const engine = new FakeEngine();
		engine.encodeResult = (value) => {
			const rejectedIndex = value.upserts.findIndex((upsert) => upsert.fields.title === 'too large');
			if (rejectedIndex !== -1)
				return {
					batches: [
						{
							bytes: Buffer.from(
								JSON.stringify({
									upserts: value.upserts.filter((_, index) => index !== rejectedIndex),
									deletes: value.deletes,
								})
							),
							mutationCount: value.upserts.length + value.deletes.length - 1,
						},
					],
					rejected: [{ operation: 'upsert', index: rejectedIndex, code: 'E_BATCH_TOO_LARGE' }],
					consumedUpserts: value.upserts.length,
					consumedDeletes: value.deletes.length,
				};
			return {
				batches: [
					{
						bytes: Buffer.from(JSON.stringify(value)),
						mutationCount: value.upserts.length + value.deletes.length,
					},
				],
				rejected: [],
				consumedUpserts: value.upserts.length,
				consumedDeletes: value.deletes.length,
			};
		};
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]));
		backend.deliver(
			batch(
				1n,
				[
					mutation('good', { kind: 'record', version: 1, projection: { title: 'good' } }),
					mutation('bad', { kind: 'record', version: 1, projection: { title: 'too large' } }),
				],
				cursor(20)
			)
		);
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		assert.strictEqual(engine.applied.length, 2);
		assert.strictEqual(engine.applied[0].upserts.length, 1);
		assert.strictEqual(engine.applied[1].deletes.length, 1);
		assert.strictEqual(engine.applied[1].deletes[0], engine.encoded[0].upserts[1].id);
		assert.strictEqual(backend.getUnindexableRecords(), 1);
		await backend.shutdown(1n);
	});

	it('fails permanently on invalid wrapper rejection metadata', async () => {
		const engine = new FakeEngine();
		engine.encodeResult = () => ({
			batches: [],
			rejected: [{ operation: 'delete', index: 0, code: 'E_INVALID_ARGUMENT' }],
			consumedUpserts: 0,
			consumedDeletes: 1,
		});
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]));
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.deliver(batch(1n, [mutation('a', { kind: 'absent' })], cursor(20)));
		backend.flush();
		await waitFor(() => changes.includes('failed'));
		assert(!changes.includes('accepted-work-lost'));
		await backend.shutdown(1n);
	});

	it('continues rejected-upsert removals that exceed one encoded prefix', async () => {
		const engine = new FakeEngine();
		engine.encodeResult = (value) => {
			if (value.upserts.length > 0)
				return {
					batches: [],
					rejected: value.upserts.map((_, index) => ({
						operation: 'upsert',
						index,
						code: 'E_BATCH_TOO_LARGE',
					})),
					consumedUpserts: value.upserts.length,
					consumedDeletes: 0,
				};
			const prefix = { upserts: [], deletes: value.deletes.slice(0, 1) };
			return {
				batches: [{ bytes: Buffer.from(JSON.stringify(prefix)), mutationCount: 1 }],
				rejected: [],
				consumedUpserts: 0,
				consumedDeletes: 1,
			};
		};
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]));
		backend.deliver(
			batch(
				1n,
				['a', 'b', 'c'].map((id) => mutation(id, { kind: 'record', version: 1, projection: { title: 'too large' } })),
				cursor(20)
			)
		);
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		assert.strictEqual(engine.applied.length, 3);
		assert.strictEqual(backend.getUnindexableRecords(), 3);
		await backend.shutdown(1n);
	});

	it('defers at queue bounds without encoding in deliver', async () => {
		let releaseApply;
		let encoded = 0;
		const engine = new FakeEngine();
		engine.onEncode = () => encoded++;
		engine.applyWait = new Promise((resolve) => (releaseApply = resolve));
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]), {
			maxQueuedBatches: 1,
			maxQueuedBytes: 64,
		});
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		const value = batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20));
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_ACCEPTED);
		assert.strictEqual(encoded, 0);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_DEFERRED);
		await waitFor(() => encoded === 1);
		releaseApply();
		await waitFor(() => changes.includes('changed'));
		await backend.shutdown(1n);
	});

	it('accepts one oversized byte estimate as a soft queue cap', async () => {
		let releaseApply;
		const engine = new FakeEngine();
		engine.applyWait = new Promise((resolve) => (releaseApply = resolve));
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]), { maxQueuedBytes: 64 });
		const value = batch(
			1n,
			[mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })],
			cursor(20),
			128
		);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_ACCEPTED);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_DEFERRED);
		await waitFor(() => engine.applied.length === 1);
		releaseApply();
		await backend.shutdown(1n);
	});

	it('wakes deferred delivery when the first queued batch releases capacity', async () => {
		let releaseFirst;
		let releaseSecond;
		const firstWait = new Promise((resolve) => (releaseFirst = resolve));
		const secondWait = new Promise((resolve) => (releaseSecond = resolve));
		const engine = new FakeEngine();
		engine.apply = async function (bytes) {
			const value = JSON.parse(Buffer.from(bytes).toString());
			this.applied.push(value);
			await (this.applied.length === 1 ? firstWait : secondWait);
			return value.upserts.length + value.deletes.length;
		};
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]), {
			maxQueuedBatches: 2,
		});
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		const value = batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })]);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_ACCEPTED);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_ACCEPTED);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_DEFERRED);
		await waitFor(() => engine.applied.length === 1);
		releaseFirst();
		await waitFor(() => engine.applied.length === 2);
		await waitFor(() => changes.includes('changed'));
		releaseSecond();
		await backend.shutdown(1n);
	});

	it('publishes cursor-only progress without encoding mutations', async () => {
		const engine = new FakeEngine();
		let encoded = 0;
		engine.onEncode = () => encoded++;
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]));
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush('age');
		await waitFor(() => engine.publications.length === 1);
		assert.strictEqual(encoded, 0);
		assert.strictEqual(engine.applied.length, 0);
		assert.deepStrictEqual({ ...backend.getDurableCursor().logs }, cursor(20).logs);
		await backend.shutdown(1n);
	});

	it('does not open a writer for cursor-only work until a barrier arrives', async () => {
		const engine = new FakeEngine();
		const source = lifecycle({ state: 'missing' }, [engine]);
		const { backend } = makeBackend(source, { maxQueuedBatches: 1 });
		assert.strictEqual(backend.deliver(batch(1n, [], cursor(20), 0)), DERIVED_INDEX_ACCEPTED);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(source.openCalls, 0);
		assert.strictEqual(backend.deliver(batch(1n, [], cursor(21), 0)), DERIVED_INDEX_ACCEPTED);
		backend.flush('age');
		await waitFor(() => engine.publications.length === 1);
		assert.strictEqual(source.openCalls, 1);
		await backend.shutdown(1n);
	});

	it('reconciles a changed on-disk cursor before applying queued work', async () => {
		const inspected = cursor(10);
		const actual = cursor(15);
		const engine = new FakeEngine(encodeFullTextCursorPayload(actual));
		const { backend } = makeBackend(
			lifecycle({ state: 'checkpointed', committedPayload: encodeFullTextCursorPayload(inspected) }, [engine])
		);
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.getDurableCursor();
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20)));
		await waitFor(() => changes.includes('accepted-work-lost'));
		assert.strictEqual(engine.applied.length, 0);
		assert.deepStrictEqual(engine.closes, [{ mode: 'rollback' }]);
		assert.deepStrictEqual({ ...backend.getDurableCursor().logs }, actual.logs);
		await backend.shutdown(1n);
	});

	it('rolls back once and reports accepted work loss after apply failure', async () => {
		const engine = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		engine.applyError = new Error('disk failure');
		const { backend } = makeBackend(
			lifecycle({ state: 'checkpointed', committedPayload: engine.committedPayload }, [engine])
		);
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.getDurableCursor();
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20)));
		await waitFor(() => changes.includes('accepted-work-lost'));
		assert.deepStrictEqual(engine.closes, [{ mode: 'rollback' }]);
		assert.deepStrictEqual({ ...backend.getDurableCursor().logs }, cursor(10).logs);
		await backend.shutdown(1n);
	});

	it('does not publish a discarded cursor during immediate shutdown after publication failure', async () => {
		const first = new FakeEngine();
		first.publishError = new Error('publish failed');
		const second = new FakeEngine();
		const source = lifecycle({ state: 'missing' }, [first, second]);
		const { backend } = makeBackend(source);
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20)));
		backend.flush();
		await waitFor(() => changes.includes('accepted-work-lost'));
		await backend.shutdown(1n);
		assert.strictEqual(source.openCalls, 1);
		assert.strictEqual(second.publications.length, 0);
		assert.strictEqual(backend.getDurableCursor(), undefined);
	});

	it('defers delivery while a failed apply is closing its writer', async () => {
		let releaseClose;
		const engine = new FakeEngine();
		engine.applyError = new Error('apply failed');
		engine.closeWait = new Promise((resolve) => (releaseClose = resolve));
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine, engine]));
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		const value = batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })]);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_ACCEPTED);
		await waitFor(() => engine.closes.length === 1);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_DEFERRED);
		engine.applyError = undefined;
		releaseClose();
		await waitFor(() => changes.includes('accepted-work-lost'));
		engine.closeWait = undefined;
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_ACCEPTED);
		await backend.shutdown(1n);
	});

	it('retains a writer whose recovery close fails until shutdown proves quiescence', async () => {
		const engine = new FakeEngine();
		engine.applyError = new Error('apply failed');
		engine.closeError = new Error('writer still active');
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]));
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20)));
		await waitFor(() => changes.includes('failed'));
		await assert.rejects(backend.shutdown(1n), /did not prove quiescence/);
		assert.strictEqual(engine.closes.length, 2);
		engine.closeError = undefined;
		await backend.shutdown(1n);
		assert.strictEqual(engine.closes.length, 3);
	});

	it('holds shutdown when a lifecycle-owned invalid handle is not quiescent', async () => {
		const source = lifecycle({ state: 'missing' }, [new Error('invalid native handle')]);
		let quiesceError = new Error('writer still active');
		source.quiesce = async () => {
			if (quiesceError) throw quiesceError;
		};
		const { backend } = makeBackend(source);
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush();
		await waitFor(() => changes.includes('failed'));
		await assert.rejects(backend.shutdown(1n), /did not prove quiescence/);
		quiesceError = undefined;
		await backend.shutdown(1n);
	});

	it('does not reinstall a writer closed while its epoch was revoked', async () => {
		let releaseClose;
		const engine = new FakeEngine();
		engine.applyError = new Error('apply failed');
		engine.closeWait = new Promise((resolve) => (releaseClose = resolve));
		const { backend, setEpoch } = makeBackend(lifecycle({ state: 'missing' }, [engine]));
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })]));
		await waitFor(() => engine.closes.length === 1);
		setEpoch(2n);
		releaseClose();
		await waitFor(() => changes.includes('failed'));
		await backend.shutdown(1n);
		assert.strictEqual(engine.closes.length, 1);
	});

	it('retains a mismatched lazy writer when rollback close fails', async () => {
		const engine = new FakeEngine(encodeFullTextCursorPayload(cursor(15)));
		engine.closeError = new Error('writer still active');
		const { backend } = makeBackend(
			lifecycle({ state: 'checkpointed', committedPayload: encodeFullTextCursorPayload(cursor(10)) }, [engine])
		);
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.getDurableCursor();
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush();
		await waitFor(() => changes.includes('failed'));
		await assert.rejects(backend.shutdown(1n), /did not prove quiescence/);
		assert.strictEqual(engine.closes.length, 2);
		engine.closeError = undefined;
		await backend.shutdown(1n);
	});

	it('fails permanently when encoding cannot represent an accepted batch', async () => {
		const engine = new FakeEngine();
		engine.encodeError = Object.assign(new Error('too large'), { code: 'E_BATCH_TOO_LARGE' });
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]));
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20)));
		await waitFor(() => changes.includes('failed'));
		assert.strictEqual(backend.deliver(batch(1n, [], cursor(30))), DERIVED_INDEX_FAILED);
		await backend.shutdown(1n);
	});

	it('resets native state only after quiescence and opens no writer', async () => {
		const source = lifecycle({ state: 'missing' });
		const { backend, setEpoch } = makeBackend(source);
		assert.strictEqual(backend.getDurableCursor(), undefined);
		setEpoch(2n);
		await backend.reset(2n);
		assert.strictEqual(source.resetCalls, 1);
		assert.strictEqual(source.openCalls, 0);
		assert.strictEqual(backend.getDurableCursor(), undefined);
		await backend.shutdown(2n);
	});

	it('invalidates inspect-only state when ownership changes', async () => {
		const source = lifecycle({ state: 'missing' });
		const { backend, setEpoch } = makeBackend(source);
		assert.strictEqual(backend.getDurableCursor(), undefined);
		await backend.shutdown(1n);
		setEpoch(2n);
		source.inspection = { state: 'checkpointed', committedPayload: encodeFullTextCursorPayload(cursor(20)) };
		assert.deepStrictEqual({ ...backend.getDurableCursor().logs }, cursor(20).logs);
		assert.strictEqual(source.inspectCalls, 2);
		await backend.shutdown(2n);
	});

	it('rejects reset while an accepted batch is scheduled to drain', async () => {
		const engine = new FakeEngine();
		const source = lifecycle({ state: 'missing' }, [engine]);
		const { backend } = makeBackend(source);
		backend.deliver(batch(1n, [], cursor(20)));
		await assert.rejects(backend.reset(1n), /not quiescent/);
		assert.strictEqual(source.resetCalls, 0);
		await backend.shutdown(1n);
	});

	it('closes cleanly at handoff, preserves its cursor, and lazily opens for the successor', async () => {
		const first = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		const second = new FakeEngine(encodeFullTextCursorPayload(cursor(20)));
		const source = lifecycle({ state: 'checkpointed', committedPayload: first.committedPayload }, [first, second]);
		const { backend, setEpoch } = makeBackend(source);
		backend.getDurableCursor();
		backend.deliver(batch(1n, [], cursor(20)));
		await backend.shutdown(1n);
		assert.deepStrictEqual(first.closes, [{ mode: 'require-clean' }]);
		source.inspection = { state: 'checkpointed', committedPayload: encodeFullTextCursorPayload(cursor(20)) };
		assert.deepStrictEqual({ ...backend.getDurableCursor().logs }, cursor(20).logs);
		assert.strictEqual(source.inspectCalls, 2);
		setEpoch(2n);
		assert.strictEqual(backend.deliver(batch(2n, [], cursor(30))), DERIVED_INDEX_ACCEPTED);
		backend.flush();
		await waitFor(() => second.publications.length === 1);
		assert.strictEqual(source.openCalls, 2);
		await backend.shutdown(2n);
	});

	it('keeps reset state cursorless when the owner epoch is revoked after reset', async () => {
		const source = lifecycle({ state: 'checkpointed', committedPayload: encodeFullTextCursorPayload(cursor(10)) });
		const { backend, setEpoch } = makeBackend(source);
		assert.deepStrictEqual({ ...backend.getDurableCursor().logs }, cursor(10).logs);
		setEpoch(2n);
		source.reset = async function () {
			this.resetCalls++;
			this.inspection = { state: 'missing' };
			setEpoch(3n);
		};
		await assert.rejects(backend.reset(2n), /owner epoch was revoked/);
		assert.strictEqual(backend.getDurableCursor(), undefined);
		assert.strictEqual(source.inspectCalls, 2);
	});

	it('rejects reset while shutdown is still closing the writer', async () => {
		let releaseClose;
		const engine = new FakeEngine();
		const source = lifecycle({ state: 'missing' }, [engine]);
		const { backend, setEpoch } = makeBackend(source);
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		engine.closeWait = new Promise((resolve) => (releaseClose = resolve));
		const shuttingDown = backend.shutdown(1n);
		await waitFor(() => engine.closes.length === 1);
		await assert.rejects(backend.reset(2n), /not quiescent/);
		releaseClose();
		await shuttingDown;
		setEpoch(2n);
		await backend.reset(2n);
		assert.strictEqual(source.resetCalls, 1);
		await backend.shutdown(2n);
	});

	it('closes a writer that finishes opening after its epoch is revoked', async () => {
		let finishOpen;
		const engine = new FakeEngine();
		const source = lifecycle({ state: 'missing' }, [
			() => new Promise((resolve) => (finishOpen = () => resolve(engine))),
		]);
		const { backend, setEpoch } = makeBackend(source);
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush();
		await waitFor(() => typeof finishOpen === 'function');
		setEpoch(2n);
		finishOpen();
		await waitFor(() => engine.closes.length === 1);
		assert.deepStrictEqual(engine.closes, [{ mode: 'rollback' }]);
		assert(changes.includes('failed'));
	});

	it('omits non-text projection values', () => {
		const converted = toFullTextMutationBatch(
			batch(1n, [
				mutation('a', {
					kind: 'record',
					version: 1,
					projection: { title: 'shoe', tags: ['red', 'sale'], price: 12, mixed: ['red', 12] },
				}),
			])
		);
		assert.deepStrictEqual({ ...converted.upserts[0].fields }, { title: 'shoe', tags: ['red', 'sale'] });
	});
});
