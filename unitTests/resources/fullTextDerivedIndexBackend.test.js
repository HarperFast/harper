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
		this.publications = [];
		this.closes = [];
	}

	async apply(bytes) {
		const batch = JSON.parse(Buffer.from(bytes).toString());
		this.applied.push(batch);
		if (this.applyError) throw this.applyError;
		if (this.applyWait) await this.applyWait;
		return batch.upserts.length + batch.deletes.length;
	}

	async publish(payload) {
		this.publications.push(payload);
		if (this.publishAction) return this.publishAction(payload);
		this.committedPayload = payload;
		return 1n;
	}

	async close(options) {
		this.closes.push(options);
		if (this.closeError) throw this.closeError;
	}
}

function lifecycle(opened, replacements = []) {
	return {
		openCalls: [],
		replaceCalls: [],
		async open(epoch) {
			this.openCalls.push(epoch);
			const next = opened.shift();
			if (next instanceof Error) throw next;
			if (typeof next === 'function') return next(epoch);
			return next;
		},
		async replace(epoch) {
			this.replaceCalls.push(epoch);
			const next = replacements.shift();
			if (next instanceof Error) throw next;
			if (typeof next === 'function') return next(epoch);
			return next;
		},
	};
}

function makeBackend(lifecycleValue, options = {}) {
	let epoch = 1n;
	const backend = new FullTextDerivedIndexBackend({
		id: options.id ?? 'products-title',
		lifecycle: lifecycleValue,
		encodeMutationBatch: (batch) => {
			options.onEncode?.(batch);
			return Buffer.from(JSON.stringify(batch));
		},
		maxQueuedBatches: options.maxQueuedBatches,
		maxQueuedBytes: options.maxQueuedBytes,
		openAttempts: options.openAttempts ?? 1,
		openRetryMilliseconds: 0,
	});
	backend.attach({
		isOwnerEpoch: (candidate) => candidate === epoch,
		getReadiness: () => ({ state: 'ready', ownerEpoch: epoch, rebuildAttempts: 0 }),
	});
	return { backend, setEpoch: (value) => (epoch = value) };
}

function mutation(recordId, state, tableId = 1) {
	return {
		tableId,
		recordId,
		recordKey: writeKeyId(recordId),
		logVersion: 1,
		state,
	};
}

function batch(ownerEpoch, records, through, bytes = 32) {
	return { ownerEpoch, transactions: [], records, through, bytes };
}

describe('FullTextDerivedIndexBackend', () => {
	it('encodes deterministic bounded cursor payloads and rejects unsafe persisted values', () => {
		const payload = encodeFullTextCursorPayload({ format: 1, logs: { z: 20, a: 10 } });
		assert.strictEqual(payload, '{"format":1,"cursor":{"format":1,"logs":{"a":10,"z":20}}}');
		assert.deepStrictEqual({ ...decodeFullTextCursorPayload(payload).logs }, { a: 10, z: 20 });
		const rocksCursor = { format: 1, logs: { local: 1789099806338.477 } };
		assert.deepStrictEqual(
			{ ...decodeFullTextCursorPayload(encodeFullTextCursorPayload(rocksCursor)).logs },
			rocksCursor.logs,
			'Harper RocksDB audit positions are positive finite numbers, not necessarily integers'
		);
		assert.strictEqual(decodeFullTextCursorPayload(encodeFullTextCursorPayload(undefined)), undefined);
		assert.throws(() => decodeFullTextCursorPayload('{"format":1,"cursor":{"format":1,"logs":{"__proto__":1}}}'));
		assert.throws(() => decodeFullTextCursorPayload('{"format":1,"cursor":{"format":1,"logs":{"local":0}}}'));
		assert.throws(() => decodeFullTextCursorPayload('{"format":1,"cursor":null,"extra":true}'));
		assert.throws(() => decodeFullTextCursorPayload('x'.repeat(32), 16));
	});

	it('maps Harper canonical keys to unambiguous Fulltext document ids', () => {
		const sharedNumberKey = writeKeyId(1);
		assert.strictEqual(sharedNumberKey, writeKeyId(1n));
		const converted = toFullTextMutationBatch(
			batch(1n, [
				mutation(1, { kind: 'record', version: 1, projection: { title: 'one' } }),
				mutation('a', { kind: 'absent' }, 12),
			])
		);
		assert.strictEqual(converted.upserts[0].id, `1.${Buffer.from(sharedNumberKey, 'latin1').toString('base64url')}`);
		assert.strictEqual(converted.deletes[0], `12.${Buffer.from(writeKeyId('a'), 'latin1').toString('base64url')}`);
		assert.notStrictEqual(converted.upserts[0].id, converted.deletes[0]);
	});

	it('defers at its byte and command bounds without encoding in deliver', async () => {
		let releaseApply;
		const engine = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		engine.applyWait = new Promise((resolve) => (releaseApply = resolve));
		let encoded = 0;
		const { backend } = makeBackend(lifecycle([engine]), {
			maxQueuedBatches: 1,
			maxQueuedBytes: 64,
			onEncode: () => encoded++,
		});
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		await backend.acquire(1n);
		const first = batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20));
		assert.strictEqual(backend.deliver(first), DERIVED_INDEX_ACCEPTED);
		assert.strictEqual(encoded, 0);
		assert.strictEqual(backend.deliver(first), DERIVED_INDEX_DEFERRED);
		await waitFor(() => encoded === 1);
		releaseApply();
		await waitFor(() => changes.includes('changed'));
		assert.strictEqual(backend.deliver(first), DERIVED_INDEX_ACCEPTED);
		await backend.shutdown(1n);
	});

	it('does not wake the runtime when an ordinary drain released no deferred capacity', async () => {
		const engine = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		const { backend } = makeBackend(lifecycle([engine]));
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		await backend.acquire(1n);
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20)));
		await waitFor(() => engine.applied.length === 1);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepStrictEqual(changes, []);
		await backend.shutdown(1n);
	});

	it('does not re-arm a same-epoch engine after a failed shutdown', async () => {
		const engine = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		engine.closeError = new Error('writer still active');
		const { backend } = makeBackend(lifecycle([engine]));
		await backend.acquire(1n);
		await assert.rejects(backend.shutdown(1n), /did not prove quiescence/);
		await assert.rejects(backend.acquire(1n), /not quiescent/);
	});

	it('publishes FIFO barrier horizons even when consecutive batches repeat a cursor', async () => {
		const engine = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		const { backend } = makeBackend(lifecycle([engine]));
		await backend.acquire(1n);
		assert.strictEqual(
			backend.deliver(
				batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20))
			),
			DERIVED_INDEX_ACCEPTED
		);
		assert.strictEqual(
			backend.deliver(
				batch(1n, [mutation('b', { kind: 'record', version: 1, projection: { title: 'b' } })], cursor(20))
			),
			DERIVED_INDEX_ACCEPTED
		);
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		assert.deepStrictEqual({ ...decodeFullTextCursorPayload(engine.publications[0]).logs }, cursor(20).logs);
		assert.deepStrictEqual({ ...backend.getDurableCursor().logs }, cursor(20).logs);
		await backend.shutdown(1n);
	});

	it('fails closed before accepting a cursor that moves backward', async () => {
		const engine = new FakeEngine(encodeFullTextCursorPayload(cursor(20)));
		const { backend } = makeBackend(lifecycle([engine]));
		await backend.acquire(1n);
		assert.strictEqual(
			backend.deliver(
				batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(10))
			),
			DERIVED_INDEX_FAILED
		);
		assert.strictEqual(engine.applied.length, 0);
		await backend.shutdown(1n);
	});

	it('accepts a monotone cursor when the source log set grows', async () => {
		const engine = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		const { backend } = makeBackend(lifecycle([engine]));
		await backend.acquire(1n);
		assert.strictEqual(
			backend.deliver(
				batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], {
					format: 1,
					logs: { local: 20, peer: 5 },
				})
			),
			DERIVED_INDEX_ACCEPTED
		);
		await backend.shutdown(1n);
	});

	it('omits non-text projection fields without failing the accepted batch', () => {
		const converted = toFullTextMutationBatch(
			batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'valid', price: 42 } })], cursor(20))
		);
		assert.deepStrictEqual({ ...converted.upserts[0].fields }, { title: 'valid' });
	});

	it('keeps deliveries after a requested barrier in the next publication', async () => {
		const engine = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		const { backend } = makeBackend(lifecycle([engine]));
		await backend.acquire(1n);
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20)));
		backend.flush();
		backend.deliver(batch(1n, [mutation('b', { kind: 'record', version: 1, projection: { title: 'b' } })], cursor(30)));
		backend.flush();
		await waitFor(() => engine.publications.length === 2);
		assert.deepStrictEqual(
			engine.publications.map((payload) => ({ ...decodeFullTextCursorPayload(payload).logs })),
			[cursor(20).logs, cursor(30).logs]
		);
		await backend.shutdown(1n);
	});

	it('reopens and exposes its recovered cursor before reporting accepted work lost', async () => {
		const first = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		first.applyError = new Error('write contention');
		const reopened = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		const { backend } = makeBackend(lifecycle([first, reopened]));
		const changes = [];
		backend.onStateChange((change) => changes.push({ change, cursor: backend.getDurableCursor() }));
		await backend.acquire(1n);
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20)));
		await waitFor(() => changes.some(({ change }) => change === 'accepted-work-lost'));
		const loss = changes.find(({ change }) => change === 'accepted-work-lost');
		assert.deepStrictEqual({ ...loss.cursor.logs }, cursor(10).logs);
		assert.deepStrictEqual(first.closes, [{ mode: 'rollback' }]);
		await backend.shutdown(1n);
	});

	it('does not deliver a queued state change to a replacement listener', async () => {
		const first = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		first.applyError = new Error('write contention');
		const reopened = new FakeEngine();
		let committedPayload = encodeFullTextCursorPayload(cursor(10));
		let swapListener;
		Object.defineProperty(reopened, 'committedPayload', {
			get() {
				queueMicrotask(swapListener);
				return committedPayload;
			},
			set(value) {
				committedPayload = value;
			},
		});
		const { backend } = makeBackend(lifecycle([first, reopened]));
		const originalChanges = [];
		const replacementChanges = [];
		const unsubscribe = backend.onStateChange((change) => originalChanges.push(change));
		swapListener = () => {
			unsubscribe();
			backend.onStateChange((change) => replacementChanges.push(change));
		};
		await backend.acquire(1n);
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20)));
		await waitFor(() => backend.getDurableCursor()?.logs.local === 10 && first.closes.length === 1);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepStrictEqual(originalChanges, []);
		assert.deepStrictEqual(replacementChanges, []);
		await backend.shutdown(1n);
	});

	it('joins a recovery reopen before shutdown releases quiescence', async () => {
		let finishOpen;
		const first = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		first.applyError = new Error('write contention');
		const reopened = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		const { backend } = makeBackend(
			lifecycle([
				first,
				() =>
					new Promise((resolve) => {
						finishOpen = () => resolve(reopened);
					}),
			])
		);
		await backend.acquire(1n);
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20)));
		await waitFor(() => first.closes.length === 1 && finishOpen);
		let settled = false;
		const shuttingDown = backend.shutdown(1n).then(() => (settled = true));
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(settled, false);
		finishOpen();
		await shuttingDown;
		assert.strictEqual(reopened.closes.length, 1);
		assert.strictEqual(backend.getDurableCursor(), undefined);
	});

	it('reconciles an ambiguous publish from the reopened committed payload', async () => {
		const first = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		const reopened = new FakeEngine();
		first.publishAction = async (payload) => {
			reopened.committedPayload = payload;
			throw new Error('response lost after commit');
		};
		const { backend } = makeBackend(lifecycle([first, reopened]));
		const changes = [];
		backend.onStateChange((change) => changes.push({ change, cursor: backend.getDurableCursor() }));
		await backend.acquire(1n);
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20)));
		backend.flush();
		await waitFor(() => changes.some(({ change }) => change === 'accepted-work-lost'));
		assert.deepStrictEqual(
			{ ...changes.find(({ change }) => change === 'accepted-work-lost').cursor.logs },
			cursor(20).logs
		);
		await backend.shutdown(1n);
	});

	it('fails closed when accepted work cannot reopen a valid generation', async () => {
		const first = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		first.applyError = new Error('apply failed');
		const reopened = new FakeEngine('{bad json');
		const { backend } = makeBackend(lifecycle([first, reopened]));
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		await backend.acquire(1n);
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20)));
		await waitFor(() => changes.includes('failed'));
		assert.strictEqual(backend.deliver(batch(1n, [], cursor(20))), DERIVED_INDEX_FAILED);
		await backend.shutdown(1n);
	});

	it('retains a rejected recovery engine until shutdown proves it closed', async () => {
		const first = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		first.applyError = new Error('apply failed');
		const reopened = new FakeEngine('{bad json');
		reopened.closeError = new Error('writer still active');
		const { backend } = makeBackend(lifecycle([first, reopened]));
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		await backend.acquire(1n);
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20)));
		await waitFor(() => changes.includes('failed'));
		reopened.closeError = undefined;
		await backend.shutdown(1n);
		assert.strictEqual(reopened.closes.length, 2);
	});

	it('closes at shutdown, clears the cache, and reopens on the next owner epoch', async () => {
		const first = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		const second = new FakeEngine(encodeFullTextCursorPayload(cursor(20)));
		const context = makeBackend(lifecycle([first, second]));
		await context.backend.acquire(1n);
		context.backend.deliver(
			batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20))
		);
		await context.backend.shutdown(1n);
		assert.strictEqual(context.backend.getDurableCursor(), undefined);
		assert.deepStrictEqual(first.closes, [{ mode: 'require-clean' }]);
		context.setEpoch(2n);
		assert.deepStrictEqual({ ...(await context.backend.acquire(2n)).logs }, cursor(20).logs);
		await context.backend.shutdown(2n);
	});

	it('retains a failed native close for shutdown retry', async () => {
		const engine = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		engine.closeError = new Error('busy writer');
		const { backend } = makeBackend(lifecycle([engine]));
		await backend.acquire(1n);
		await assert.rejects(backend.shutdown(1n), /did not prove quiescence/);
		engine.closeError = undefined;
		await backend.shutdown(1n);
		assert.strictEqual(engine.closes.length, 2);
		assert.strictEqual(backend.getDurableCursor(), undefined);
	});

	it('publishes a tombstone before replacing a generation', async () => {
		const events = [];
		const first = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		const oldGeneration = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		oldGeneration.publishAction = async (payload) => {
			events.push(['tombstone', decodeFullTextCursorPayload(payload)]);
			oldGeneration.committedPayload = payload;
			return 1n;
		};
		const replacement = new FakeEngine();
		const lifecycleValue = lifecycle(
			[first, oldGeneration],
			[
				() => {
					events.push(['replace']);
					return replacement;
				},
			]
		);
		const context = makeBackend(lifecycleValue);
		await context.backend.acquire(1n);
		await context.backend.shutdown(1n);
		context.setEpoch(2n);
		await context.backend.reset(2n);
		assert.deepStrictEqual(events, [['tombstone', undefined], ['replace']]);
		assert.strictEqual(context.backend.getDurableCursor(), undefined);
		await context.backend.shutdown(2n);
	});

	it('replaces an unopenable old generation instead of making reset terminal', async () => {
		const replacement = new FakeEngine();
		const lifecycleValue = lifecycle([new Error('corrupt generation')], [replacement]);
		const { backend } = makeBackend(lifecycleValue);
		await backend.reset(1n);
		assert.deepStrictEqual(lifecycleValue.replaceCalls, [1n]);
		await backend.shutdown(1n);
	});

	it('does not replace an old generation until its writer proves quiescent', async () => {
		const oldGeneration = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		oldGeneration.closeError = new Error('writer still active');
		const replacement = new FakeEngine();
		const lifecycleValue = lifecycle([oldGeneration], [replacement]);
		const { backend } = makeBackend(lifecycleValue);

		await assert.rejects(backend.reset(1n), /could not close before replacement/);
		assert.deepStrictEqual(lifecycleValue.replaceCalls, []);
		oldGeneration.closeError = undefined;
		await backend.shutdown(1n);
	});

	it('closes a rejected replacement generation before reset returns', async () => {
		const oldGeneration = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		const replacement = new FakeEngine(encodeFullTextCursorPayload(cursor(20)));
		const { backend } = makeBackend(lifecycle([oldGeneration], [replacement]));

		await assert.rejects(backend.reset(1n), /retained a durable cursor/);
		assert.deepStrictEqual(replacement.closes, [{ mode: 'rollback' }]);
	});

	it('retains an engine that cannot close after acquisition validation fails', async () => {
		const engine = new FakeEngine('invalid');
		engine.closeError = new Error('writer still active');
		const { backend } = makeBackend(lifecycle([engine]));

		await assert.rejects(backend.acquire(1n), /acquisition could not close/);
		engine.closeError = undefined;
		await backend.shutdown(1n);
		assert.strictEqual(engine.closes.length, 2);
	});

	it('closes an engine that finishes opening after its owner epoch is revoked', async () => {
		let finishOpen;
		const engine = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		const context = makeBackend(
			lifecycle([
				() =>
					new Promise((resolve) => {
						finishOpen = () => resolve(engine);
					}),
			])
		);
		const acquiring = context.backend.acquire(1n);
		context.setEpoch(2n);
		finishOpen();
		await assert.rejects(acquiring, /epoch was revoked/);
		assert.deepStrictEqual(engine.closes, [{ mode: 'rollback' }]);
	});
});
