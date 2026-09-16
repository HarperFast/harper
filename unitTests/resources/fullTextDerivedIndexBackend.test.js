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
		this.applyOptions = [];
		this.publications = [];
		this.closes = [];
	}

	async applyMutationBatch(batch, options) {
		this.applied.push(batch);
		this.applyOptions.push(options);
		this.onApply?.(batch, options);
		if (this.applyError) throw this.applyError;
		if (this.applyWait) await this.applyWait;
		if (this.applyResult) return this.applyResult(batch, options);
		return {
			processed: batch.upserts.length + batch.deletes.length,
			rejected: [],
			encodedBytes: 1,
			frames: 1,
		};
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
		return this.closeResult ?? {};
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
		const durable = backend.getDurableCursor();
		assert.deepStrictEqual({ ...durable.logs }, cursor(10).logs);
		assert.strictEqual(backend.getDurableCursor(), durable);
		assert(Object.isFrozen(durable));
		assert(Object.isFrozen(durable.logs));
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

	it('fails after exhausting the bounded writer-open retry budget', async () => {
		const source = lifecycle({ state: 'missing' }, [
			new Error('open failed'),
			new Error('open failed'),
			new Error('open failed'),
		]);
		const { backend } = makeBackend(source, { openAttempts: 3 });
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush();
		await waitFor(() => changes.includes('failed'));
		assert.strictEqual(source.openCalls, 3);
		await backend.shutdown(1n);
	});

	it('delegates one logical batch to the wrapper before publishing its cursor', async () => {
		const engine = new FakeEngine();
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]));
		backend.deliver(
			batch(
				1n,
				[mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } }), mutation('b', { kind: 'absent' })],
				cursor(20)
			)
		);
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		assert.strictEqual(engine.applied.length, 1);
		assert.deepStrictEqual(engine.applyOptions, [{ assumeDistinctIds: true, rejectedUpsert: 'delete' }]);
		assert.deepStrictEqual([engine.applied[0].upserts.length, engine.applied[0].deletes.length], [1, 1]);
		await backend.shutdown(1n);
	});

	it('publishes the wrapper count of rejected upserts as unindexable', async () => {
		const engine = new FakeEngine();
		engine.applyResult = (value) => ({
			processed: value.upserts.length,
			rejected: [{ operation: 'upsert', index: 1, code: 'E_BATCH_TOO_LARGE' }],
			encodedBytes: 16,
			frames: 2,
		});
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]));
		backend.deliver(
			batch(
				1n,
				['good', 'bad'].map((id) => mutation(id, { kind: 'record', version: 1, projection: { title: id } })),
				cursor(20)
			)
		);
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		assert.strictEqual(backend.getUnindexableRecords(), 1);
		await backend.shutdown(1n);
	});

	it('accepts a valid wrapper result with a custom prototype', async () => {
		const engine = new FakeEngine();
		engine.applyResult = (value) =>
			Object.assign(Object.create({ wrapperResult: true }), {
				processed: value.upserts.length + value.deletes.length,
				rejected: [],
				encodedBytes: 1,
				frames: 1,
			});
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]));
		backend.deliver(batch(1n, [mutation('a', { kind: 'absent' })], cursor(20)));
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		await backend.shutdown(1n);
	});

	it('fails permanently after rolling back an invalid wrapper result', async () => {
		const engine = new FakeEngine();
		engine.applyResult = () => ({ processed: 0, rejected: [], encodedBytes: 1, frames: 1 });
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]));
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })]));
		await waitFor(() => changes.includes('failed'));
		assert(!changes.includes('accepted-work-lost'));
		assert.deepStrictEqual(engine.closes, [{ mode: 'rollback' }]);
		await backend.shutdown(1n);
	});

	it('defers at queue bounds without applying in deliver', async () => {
		let releaseApply;
		let applyCalls = 0;
		const engine = new FakeEngine();
		engine.onApply = () => applyCalls++;
		engine.applyWait = new Promise((resolve) => (releaseApply = resolve));
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]), {
			maxQueuedBatches: 1,
			maxQueuedBytes: 64,
		});
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		const value = batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20));
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_ACCEPTED);
		assert.strictEqual(applyCalls, 0);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_DEFERRED);
		await waitFor(() => applyCalls === 1);
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
		engine.applyMutationBatch = async function (value, options) {
			this.applied.push(value);
			this.applyOptions.push(options);
			await (this.applied.length === 1 ? firstWait : secondWait);
			return {
				processed: value.upserts.length + value.deletes.length,
				rejected: [],
				encodedBytes: 1,
				frames: 1,
			};
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

	it('publishes cursor-only progress without applying mutations', async () => {
		const engine = new FakeEngine();
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]));
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush('age');
		await waitFor(() => engine.publications.length === 1);
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

	it('fails permanently after a repeated writer failure without durable progress', async () => {
		const first = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		const second = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		first.applyError = new Error('disk failure');
		second.applyError = new Error('disk still failing');
		const { backend } = makeBackend(
			lifecycle({ state: 'checkpointed', committedPayload: first.committedPayload }, [first, second])
		);
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.getDurableCursor();
		const value = batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20));
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_ACCEPTED);
		await waitFor(() => changes.includes('accepted-work-lost'));
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_ACCEPTED);
		await waitFor(() => changes.includes('failed'));
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_FAILED);
		assert.deepStrictEqual(first.closes, [{ mode: 'rollback' }]);
		assert.deepStrictEqual(second.closes, [{ mode: 'rollback' }]);
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

	it('releases a writer when close reports a non-fatal cleanup error', async () => {
		const engine = new FakeEngine();
		engine.closeResult = { cleanupError: new Error('native cleanup failed after release') };
		const source = lifecycle({ state: 'missing' }, [engine]);
		const { backend, setEpoch } = makeBackend(source);
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		await backend.shutdown(1n);
		setEpoch(2n);
		await backend.reset(2n);
		assert.strictEqual(source.resetCalls, 1);
		await backend.shutdown(2n);
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
		const projection = Object.assign(Object.create({ inherited: 'ignored' }), {
			title: 'shoe',
			tags: ['red', 'sale'],
			price: 12,
			mixed: ['red', 12],
		});
		const converted = toFullTextMutationBatch(
			batch(1n, [
				mutation('a', {
					kind: 'record',
					version: 1,
					projection,
				}),
			])
		);
		assert.deepStrictEqual({ ...converted.upserts[0].fields }, { title: 'shoe', tags: ['red', 'sale'] });
	});
});
