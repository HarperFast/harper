require('../testUtils');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setupTestDBPath } = require('../testUtils');
const { writeKeyId } = require('#src/resources/DatabaseTransaction');
const {
	FullTextDerivedIndexBackend,
	HARPER_FULLTEXT_MAX_CURSOR_PAYLOAD_BYTES,
	decodeFullTextCursorPayload,
	encodeFullTextCursorPayload,
	toFullTextMutationBatch,
} = require('#src/resources/indexes/fullTextDerivedIndex');
const { DERIVED_INDEX_ACCEPTED, DERIVED_INDEX_DEFERRED } = require('#src/resources/derivedIndexRuntime');
const { waitFor } = require('../waitFor');

const cursor = (timestamp) => ({ format: 1, logs: { local: timestamp } });
const cursorForLogs = (entries) => ({ format: 1, logs: Object.fromEntries(entries) });

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
			if (this.resetWait) await this.resetWait;
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
		maxApplySliceRecords: options.maxApplySliceRecords,
		openAttempts: options.openAttempts ?? 1,
		openRetryMilliseconds: options.openRetryMilliseconds ?? 0,
		maxOpenRetryMilliseconds: options.maxOpenRetryMilliseconds,
		closeTimeoutMilliseconds: options.closeTimeoutMilliseconds,
		shutdownTimeoutMilliseconds: options.shutdownTimeoutMilliseconds,
		maxCursorPayloadBytes: options.maxCursorPayloadBytes,
	});
	backend.attach({
		isOwnerEpoch: (candidate) => candidate === epoch,
		getReadiness: () => ({ state: 'ready', ownerEpoch: epoch, rebuildAttempts: 0 }),
	});
	return { backend, setEpoch: (value) => (epoch = value) };
}

function mutation(recordId, state, tableId = 1) {
	return { tableId, recordId, logVersion: 1, state };
}

function batch(ownerEpoch, records, through, bytes = 32) {
	return { ownerEpoch, transactions: [], records, through, bytes };
}

function nativeError(code, message) {
	return Object.assign(new Error(message), { code });
}

async function runRestartChild(directory, phase) {
	assert(process.env.ROOTPATH, 'the restart child requires mocha.init.js to pin ROOTPATH');
	const child = spawn(process.execPath, [path.join(__dirname, 'fullTextDerivedIndex-restart.js'), directory, phase], {
		stdio: ['ignore', 'ignore', 'pipe'],
		env: { ...process.env, ROOTPATH: process.env.ROOTPATH },
	});
	let stderr = '';
	child.stderr.on('data', (chunk) => (stderr += chunk));
	const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
	try {
		return await new Promise((resolve, reject) => {
			child.once('error', reject);
			child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
		});
	} finally {
		clearTimeout(timer);
	}
}

describe('FullTextDerivedIndexBackend', () => {
	it('keeps the whole handoff bound larger than the native close bound', () => {
		assert.throws(
			() => makeBackend(lifecycle(), { closeTimeoutMilliseconds: 10, shutdownTimeoutMilliseconds: 19 }),
			/shutdownTimeoutMilliseconds must be at least twice closeTimeoutMilliseconds/
		);
	});

	it('rejects a publication limit above the cursor inspection bound', () => {
		assert.throws(
			() =>
				makeBackend(lifecycle(), {
					maxCursorPayloadBytes: HARPER_FULLTEXT_MAX_CURSOR_PAYLOAD_BYTES + 1,
				}),
			/maxCursorPayloadBytes must not exceed 65536/
		);
	});

	it('encodes bounded deterministic cursor payloads', () => {
		const payload = encodeFullTextCursorPayload({ format: 1, logs: { z: 20, prototype: 15, a: 10 } });
		assert.strictEqual(payload, '{"format":1,"cursor":{"format":1,"logs":{"a":10,"prototype":15,"z":20}}}');
		assert.deepStrictEqual({ ...decodeFullTextCursorPayload(payload).logs }, { a: 10, prototype: 15, z: 20 });
		assert.strictEqual(decodeFullTextCursorPayload(encodeFullTextCursorPayload(undefined)), undefined);
		assert.throws(() => decodeFullTextCursorPayload('{"format":1,"cursor":{"format":1,"logs":{"local":0}}}'));
		assert.throws(() => decodeFullTextCursorPayload('x'.repeat(32), 16));
		const specialCursor = cursorForLogs([
			['constructor', 15],
			['__proto__', 10],
		]);
		const specialPayload = encodeFullTextCursorPayload(specialCursor);
		assert.strictEqual(specialPayload, '{"format":1,"cursor":{"format":1,"logs":{"__proto__":10,"constructor":15}}}');
		const specialLogs = decodeFullTextCursorPayload(specialPayload).logs;
		assert.strictEqual(Object.hasOwn(specialLogs, '__proto__'), true);
		assert.strictEqual(specialLogs.__proto__, 10);
		assert.strictEqual(specialLogs.constructor, 15);
	});

	it('round-trips cursor coverage and preserves it across ordinary publication', async () => {
		const covered = {
			format: 1,
			logs: { local: 10 },
			coverage: { local: { sequence: 3, offset: 4 }, empty: null },
		};
		const engine = new FakeEngine(encodeFullTextCursorPayload(covered));
		const { backend } = makeBackend(
			lifecycle({ state: 'checkpointed', committedPayload: engine.committedPayload }, [engine])
		);
		assert.deepStrictEqual({ ...backend.getDurableCursor().coverage }, covered.coverage);
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		assert.deepStrictEqual({ ...decodeFullTextCursorPayload(engine.publications[0]).coverage }, covered.coverage);
		await backend.shutdown(1n);
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

	it('omits Harper-internal symbol identities from replay and rebuild batches', () => {
		const converted = toFullTextMutationBatch(
			batch(1n, [
				mutation(Symbol.for('internal'), { kind: 'record', version: 1, projection: { title: 'internal' } }),
				mutation('visible', { kind: 'record', version: 1, projection: { title: 'visible' } }),
			])
		);
		assert.deepStrictEqual(converted.deletes, []);
		assert.deepStrictEqual(
			converted.upserts.map(({ fields }) => ({ ...fields })),
			[{ title: 'visible' }]
		);
	});

	it('omits nullish record identities before storage-key encoding', () => {
		const converted = toFullTextMutationBatch(
			batch(1n, [
				mutation(null, { kind: 'record', version: 1, projection: { title: 'null' } }),
				mutation(undefined, { kind: 'record', version: 1, projection: { title: 'undefined' } }),
				mutation('visible', { kind: 'record', version: 1, projection: { title: 'visible' } }),
			])
		);
		assert.strictEqual(converted.upserts.length, 1);
		assert.strictEqual(converted.upserts[0].fields.title, 'visible');
	});

	it('does not submit a native mutation for a Harper-internal identity', async () => {
		const engine = new FakeEngine();
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]));
		backend.deliver(
			batch(
				1n,
				[mutation(Symbol.for('internal'), { kind: 'record', version: 1, projection: { title: 'internal' } })],
				cursor(20)
			)
		);
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		assert.strictEqual(engine.applied.length, 0);
		await backend.shutdown(1n);
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

	it('retries acquisition inspection when the first native inspection cannot complete', () => {
		const source = lifecycle();
		source.inspect = function () {
			this.inspectCalls++;
			if (this.inspectCalls === 1) throw new Error('temporary read failure');
			return this.inspection;
		};
		const { backend } = makeBackend(source);
		assert.throws(
			() => backend.getDurableCursor(),
			(error) => error.name === 'FullTextDerivedIndexError' && /temporary read failure/.test(error.cause?.message)
		);
		assert.strictEqual(backend.getDurableCursor(), undefined);
		assert.strictEqual(source.inspectCalls, 2);
	});

	it('does not trust a cached checkpoint when acquisition inspection is unavailable', async () => {
		const source = lifecycle({ state: 'checkpointed', committedPayload: encodeFullTextCursorPayload(cursor(10)) });
		const { backend, setEpoch } = makeBackend(source);
		backend.getDurableCursor();
		await backend.shutdown(1n);
		setEpoch(2n);
		source.inspect = function () {
			this.inspectCalls++;
			throw new Error('temporary read failure');
		};
		assert.throws(() => backend.getDurableCursor(), /state could not be inspected/);
		assert.strictEqual(source.inspectCalls, 2);
		await backend.shutdown(2n);
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

	it('retries every non-terminal writer-open code and an unknown future code', async () => {
		for (const code of [
			undefined,
			'E_FUTURE_TRANSIENT',
			'E_BATCH_ACTIVE',
			'E_BATCH_INCOMPLETE',
			'E_BATCH_TOO_LARGE',
			'E_CHECKPOINT_REQUIRED',
			'E_CLOSE_FAILED',
			'E_CLOSED',
			'E_DIRTY_CLOSE',
			'E_DUPLICATE_OPEN',
			'E_INVALID_ARGUMENT',
			'E_LOCK_BUSY',
			'E_NATIVE_ABI_MISMATCH',
			'E_NATIVE_ADDON_NOT_FOUND',
			'E_NATIVE_CAPABILITY_MISMATCH',
			'E_NATIVE_FAILURE',
			'E_NATIVE_PANIC',
			'E_POISONED',
			'E_QUEUE_FULL',
			'E_QUIESCENCE_FAILED',
			'E_STORAGE',
		]) {
			const engine = new FakeEngine();
			const error = code ? nativeError(code, 'retryable') : new Error('unclassified');
			const source = lifecycle({ state: 'missing' }, [error, engine]);
			const { backend } = makeBackend(source, { openAttempts: 1 });
			const changes = [];
			backend.onStateChange((change) => changes.push(change));
			backend.deliver(batch(1n, [], cursor(20)));
			backend.flush();
			await waitFor(() => engine.publications.length === 1);
			assert.strictEqual(source.openCalls, 2, code);
			assert.strictEqual(changes.includes('failed'), false, code);
			await backend.shutdown(1n);
		}
	});

	it('fails immediately for terminal writer-open codes', async () => {
		for (const code of [
			'E_IDENTITY_MISMATCH',
			'E_INCOMPLETE_CREATE',
			'E_INDEX_CORRUPT',
			'E_INDEX_FORMAT_INCOMPATIBLE',
			'E_SCHEMA_MISMATCH',
		]) {
			const source = lifecycle({ state: 'missing' }, [nativeError(code, 'terminal')]);
			const { backend } = makeBackend(source, { openAttempts: 3 });
			const changes = [];
			backend.onStateChange((change) => changes.push(change));
			backend.deliver(batch(1n, [], cursor(20)));
			backend.flush();
			await waitFor(() => changes.includes('failed'));
			assert.strictEqual(source.openCalls, 1, code);
			await backend.shutdown(1n);
		}
	});

	it('retries native writer lock contention without failing or rebuilding', async () => {
		const engine = new FakeEngine();
		const source = lifecycle({ state: 'missing' }, [nativeError('E_LOCK_BUSY', 'busy'), engine]);
		const { backend } = makeBackend(source, { openAttempts: 1, openRetryMilliseconds: 5 });
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		assert.strictEqual(source.openCalls, 2);
		assert.strictEqual(changes.includes('failed'), false);
		await backend.shutdown(1n);
	});

	it('backs off persistent native writer lock contention', async () => {
		const engine = new FakeEngine();
		const attempts = [];
		const source = lifecycle({ state: 'missing' });
		source.open = async function () {
			this.openCalls++;
			attempts.push(Date.now());
			if (this.openCalls <= 4) throw nativeError('E_LOCK_BUSY', 'busy');
			return engine;
		};
		const { backend } = makeBackend(source, {
			openAttempts: 1,
			openRetryMilliseconds: 5,
			maxOpenRetryMilliseconds: 20,
		});
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		assert(attempts[2] - attempts[1] >= 8, 'the second retry should wait about 10 ms');
		assert(attempts[3] - attempts[2] >= 16, 'later retries should reach the 20 ms ceiling');
		await backend.shutdown(1n);
	});

	it('cancels a deferred lock retry during shutdown', async () => {
		const source = lifecycle({ state: 'missing' });
		source.open = async function () {
			this.openCalls++;
			throw nativeError('E_LOCK_BUSY', 'busy');
		};
		const { backend } = makeBackend(source, { openAttempts: 1, openRetryMilliseconds: 60_000 });
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush();
		await waitFor(() => source.openCalls === 1);
		await backend.shutdown(1n);
		assert.strictEqual(source.openCalls, 2);
		assert.strictEqual(changes.includes('failed'), false);
	});

	it('settles shutdown after an in-flight writer open rejects', async () => {
		let releaseOpen;
		const source = lifecycle({ state: 'missing' });
		source.open = async function () {
			this.openCalls++;
			await new Promise((resolve) => (releaseOpen = resolve));
			throw nativeError('E_LOCK_BUSY', 'busy');
		};
		const { backend, setEpoch } = makeBackend(source, {
			openAttempts: 1,
			closeTimeoutMilliseconds: 10,
			shutdownTimeoutMilliseconds: 20,
		});
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush();
		await waitFor(() => typeof releaseOpen === 'function');
		const stopping = backend.shutdown(1n);
		releaseOpen();
		try {
			await stopping;
		} finally {
			setEpoch(2n);
		}
		const openCalls = source.openCalls;
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.strictEqual(source.openCalls, openCalls, 'shutdown must stop retrying the writer open');
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

	it('yields large runtime batches through bounded native apply slices', async () => {
		const engine = new FakeEngine();
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]), { maxApplySliceRecords: 2 });
		backend.deliver(
			batch(
				1n,
				['a', 'b', 'c', 'd', 'e'].map((id) => mutation(id, { kind: 'record', version: 1, projection: { title: id } })),
				cursor(20)
			)
		);
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		assert.deepStrictEqual(
			engine.applied.map((applied) => applied.upserts.length + applied.deletes.length),
			[2, 2, 1]
		);
		await backend.shutdown(1n);
	});

	it('drains every bounded slice before completing shutdown', async () => {
		const engine = new FakeEngine();
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]), { maxApplySliceRecords: 2 });
		backend.deliver(
			batch(
				1n,
				['a', 'b', 'c', 'd', 'e'].map((id) => mutation(id, { kind: 'record', version: 1, projection: { title: id } })),
				cursor(20)
			)
		);

		await backend.shutdown(1n);
		assert.deepStrictEqual(
			engine.applied.map((applied) => applied.upserts.length + applied.deletes.length),
			[2, 2, 1]
		);
		assert.strictEqual(engine.publications.length, 1);
		assert.deepStrictEqual(engine.closes, [{ mode: 'require-clean' }]);
	});

	it('publishes the wrapper count of rejected upserts as unindexable', async () => {
		const engine = new FakeEngine();
		engine.applyResult = (value) => ({
			processed: value.upserts.length,
			rejected: [{ operation: 'upsert', index: 1, code: 'E_BATCH_TOO_LARGE' }],
			encodedBytes: 16,
			frames: 2,
		});
		const source = lifecycle({ state: 'missing' }, [engine]);
		const { backend, setEpoch } = makeBackend(source);
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
		setEpoch(2n);
		await backend.reset(2n);
		assert.strictEqual(backend.getUnindexableRecords(), 0);
		await backend.shutdown(2n);
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

	it('retains only one unknown-size rebuild batch at a time', async () => {
		let releaseApply;
		const engine = new FakeEngine();
		engine.applyWait = new Promise((resolve) => (releaseApply = resolve));
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]), {
			maxQueuedBatches: 4,
			maxQueuedBytes: 4 * 1024,
		});
		const value = batch(
			1n,
			['a', 'b'].map((id) => mutation(id, { kind: 'record', version: 1, projection: { title: id } })),
			undefined,
			0
		);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_ACCEPTED);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_DEFERRED);
		await waitFor(() => engine.applied.length === 1);
		releaseApply();
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
		const prototypeCursor = cursorForLogs([
			['constructor', 20],
			['__proto__', 21],
		]);
		backend.deliver(batch(1n, [], prototypeCursor));
		backend.flush('age');
		await waitFor(() => engine.publications.length === 1);
		assert.strictEqual(engine.applied.length, 0);
		assert.deepStrictEqual({ ...backend.getDurableCursor().logs }, { ...prototypeCursor.logs });
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

	it('adopts newer on-disk coverage even when log positions are unchanged', async () => {
		const inspected = { ...cursor(10), coverage: { local: { sequence: 1, offset: 2 } } };
		const actual = { ...cursor(10), coverage: { local: { sequence: 3, offset: 4 } } };
		const first = new FakeEngine(encodeFullTextCursorPayload(actual));
		const second = new FakeEngine(encodeFullTextCursorPayload(actual));
		const { backend } = makeBackend(
			lifecycle({ state: 'checkpointed', committedPayload: encodeFullTextCursorPayload(inspected) }, [first, second])
		);
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush();
		await waitFor(() => changes.includes('accepted-work-lost'));
		assert.deepStrictEqual({ ...backend.getDurableCursor().coverage }, actual.coverage);

		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush();
		await waitFor(() => second.publications.length === 1);
		assert.deepStrictEqual({ ...decodeFullTextCursorPayload(second.publications[0]).coverage }, actual.coverage);
		await backend.shutdown(1n);
	});

	it('treats adopted durable progress as recovery between writer failures', async () => {
		const first = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		first.applyError = new Error('first writer failure');
		const advanced = new FakeEngine(encodeFullTextCursorPayload(cursor(15)));
		const third = new FakeEngine(encodeFullTextCursorPayload(cursor(15)));
		third.applyError = new Error('later writer failure');
		const { backend } = makeBackend(
			lifecycle({ state: 'checkpointed', committedPayload: first.committedPayload }, [first, advanced, third]),
			{ openRetryMilliseconds: 50, maxOpenRetryMilliseconds: 50 }
		);
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.getDurableCursor();
		const value = batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20));
		backend.deliver(value);
		await waitFor(() => changes.filter((change) => change === 'accepted-work-lost').length === 1);
		await waitFor(() => changes.filter((change) => change === 'changed').length === 1);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_ACCEPTED);
		await waitFor(() => changes.filter((change) => change === 'accepted-work-lost').length === 2);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_ACCEPTED);
		await waitFor(() => changes.filter((change) => change === 'accepted-work-lost').length === 3);
		assert.strictEqual(changes.includes('failed'), false);
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

	it('backs off repeated writer failures without condemning a valid generation', async () => {
		const first = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		const second = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		const third = new FakeEngine(encodeFullTextCursorPayload(cursor(10)));
		first.applyError = new Error('disk failure');
		second.applyError = new Error('disk still failing');
		const { backend } = makeBackend(
			lifecycle({ state: 'checkpointed', committedPayload: first.committedPayload }, [first, second, third]),
			{ openRetryMilliseconds: 50, maxOpenRetryMilliseconds: 50 }
		);
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.getDurableCursor();
		const value = batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20));
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_ACCEPTED);
		await waitFor(() => changes.filter((change) => change === 'accepted-work-lost').length === 1);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_DEFERRED);
		await waitFor(() => changes.filter((change) => change === 'changed').length === 1);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_ACCEPTED);
		await waitFor(() => changes.filter((change) => change === 'accepted-work-lost').length === 2);
		assert.strictEqual(changes.includes('failed'), false);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_DEFERRED);
		await waitFor(() => changes.filter((change) => change === 'changed').length === 2);
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_ACCEPTED);
		backend.flush();
		await waitFor(() => third.publications.length === 1);
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
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine, engine]), {
			openRetryMilliseconds: 50,
			maxOpenRetryMilliseconds: 50,
		});
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
		assert.strictEqual(backend.deliver(value), DERIVED_INDEX_DEFERRED);
		await waitFor(() => changes.includes('changed'));
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

	it('bounds native close and reuses the in-flight close during a shutdown retry', async () => {
		const engine = new FakeEngine();
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]), {
			closeTimeoutMilliseconds: 10,
		});
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush();
		await waitFor(() => engine.publications.length === 1);
		let releaseClose;
		engine.closeWait = new Promise((resolve) => (releaseClose = resolve));
		await assert.rejects(backend.shutdown(1n), /did not prove quiescence/);
		assert.strictEqual(engine.closes.length, 1);
		const retry = backend.shutdown(1n);
		releaseClose();
		await retry;
		assert.strictEqual(engine.closes.length, 1);
	});

	it('bounds the whole shutdown while a native apply remains unsettled', async () => {
		let releaseApply;
		const engine = new FakeEngine();
		engine.applyWait = new Promise((resolve) => (releaseApply = resolve));
		const { backend } = makeBackend(lifecycle({ state: 'missing' }, [engine]), {
			closeTimeoutMilliseconds: 10,
		});
		backend.deliver(batch(1n, [mutation('a', { kind: 'record', version: 1, projection: { title: 'a' } })], cursor(20)));
		await waitFor(() => engine.applied.length === 1);
		await assert.rejects(backend.shutdown(1n), /did not prove quiescence/);
		assert.strictEqual(engine.closes.length, 0);
		const retry = backend.shutdown(1n);
		releaseApply();
		await retry;
		assert.strictEqual(engine.closes.length, 1);
	});

	it('bounds the whole shutdown while native writer open remains unsettled', async () => {
		let finishOpen;
		const engine = new FakeEngine();
		const source = lifecycle({ state: 'missing' }, [
			() => new Promise((resolve) => (finishOpen = () => resolve(engine))),
		]);
		const { backend } = makeBackend(source, { closeTimeoutMilliseconds: 10 });
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush();
		await waitFor(() => typeof finishOpen === 'function');
		await assert.rejects(backend.shutdown(1n), /did not prove quiescence/);
		assert.strictEqual(engine.closes.length, 0);
		const retry = backend.shutdown(1n);
		finishOpen();
		await retry;
		assert.strictEqual(engine.closes.length, 1);
	});

	it('reuses a successful native close that settled after the shutdown timeout', async () => {
		const first = new FakeEngine();
		const second = new FakeEngine(encodeFullTextCursorPayload(cursor(20)));
		const source = lifecycle({ state: 'missing' }, [first, second]);
		const { backend, setEpoch } = makeBackend(source, { closeTimeoutMilliseconds: 10 });
		backend.deliver(batch(1n, [], cursor(20)));
		backend.flush();
		await waitFor(() => first.publications.length === 1);
		let releaseClose;
		first.closeWait = new Promise((resolve) => (releaseClose = resolve));
		await assert.rejects(backend.shutdown(1n), /did not prove quiescence/);
		releaseClose();
		await new Promise((resolve) => setImmediate(resolve));
		await backend.shutdown(1n);
		assert.strictEqual(first.closes.length, 1);
		setEpoch(2n);
		assert.strictEqual(backend.deliver(batch(2n, [], cursor(30))), DERIVED_INDEX_ACCEPTED);
		backend.flush();
		await waitFor(() => second.publications.length === 1);
		await backend.shutdown(2n);
	});

	it('parks without condemning when a cursor payload cannot fit the native checkpoint', async () => {
		const engine = new FakeEngine();
		const source = lifecycle({ state: 'missing' }, [engine]);
		const { backend, setEpoch } = makeBackend(source, { maxCursorPayloadBytes: 48 });
		const changes = [];
		backend.onStateChange((change) => changes.push(change));
		backend.deliver(
			batch(
				1n,
				[],
				cursorForLogs([
					['a', 10],
					['b', 20],
					['c', 30],
				])
			)
		);
		backend.flush();
		await waitFor(() => changes.includes('accepted-work-lost'));
		assert.strictEqual(engine.publications.length, 0);
		assert.deepStrictEqual(engine.closes, [{ mode: 'rollback' }]);
		assert.strictEqual(backend.deliver(batch(1n, [], cursor(40))), DERIVED_INDEX_DEFERRED);
		await backend.shutdown(1n);
		setEpoch(2n);
		await assert.rejects(backend.reset(2n), /configuration must change/);
		assert.strictEqual(source.resetCalls, 0);
	});

	it('reuses a valid checkpoint after the publication limit is lowered', () => {
		const durable = cursorForLogs([
			['a', 10],
			['b', 20],
			['c', 30],
		]);
		const payload = encodeFullTextCursorPayload(durable);
		assert(Buffer.byteLength(payload) > 48);
		const { backend } = makeBackend(lifecycle({ state: 'checkpointed', committedPayload: payload }), {
			maxCursorPayloadBytes: 48,
		});
		assert.deepStrictEqual({ ...backend.getDurableCursor().logs }, durable.logs);
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

	it('bounds a native reset and keeps shutdown attached to the same operation', async () => {
		let finishReset;
		const source = lifecycle();
		source.resetWait = new Promise((resolve) => (finishReset = resolve));
		const { backend } = makeBackend(source, {
			closeTimeoutMilliseconds: 10,
			shutdownTimeoutMilliseconds: 20,
		});

		await assert.rejects(backend.reset(1n), /native reset did not settle/);
		assert.strictEqual(source.resetCalls, 1);
		await assert.rejects(backend.shutdown(1n), /reset did not prove quiescence/);
		finishReset();
		await backend.shutdown(1n);
		assert.strictEqual(source.resetCalls, 1);
	});

	it('refreshes its durable cursor after an ownership cycle without delivery', async () => {
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
		assert.strictEqual(source.inspectCalls, 1);
	});

	it('clears its cached cursor before a native reset that fails', async () => {
		const source = lifecycle({ state: 'checkpointed', committedPayload: encodeFullTextCursorPayload(cursor(10)) });
		const { backend, setEpoch } = makeBackend(source);
		assert.deepStrictEqual({ ...backend.getDurableCursor().logs }, cursor(10).logs);
		await backend.shutdown(1n);
		setEpoch(2n);
		source.resetError = new Error('reset outcome is unknown');
		await assert.rejects(backend.reset(2n), /reset outcome is unknown/);
		assert.strictEqual(backend.getDurableCursor(), undefined);
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

	it('leaves array field validation to the wrapper', () => {
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
		assert.deepStrictEqual(
			{ ...converted.upserts[0].fields },
			{ title: 'shoe', tags: ['red', 'sale'], mixed: ['red', 12] }
		);
	});

	it('deletes the prior document when a projector omits the current record', () => {
		const converted = toFullTextMutationBatch(
			batch(1n, [mutation('a', { kind: 'record', version: 2, projection: undefined })])
		);
		assert.deepStrictEqual(converted.upserts, []);
		assert.strictEqual(converted.deletes.length, 1);
	});

	it('deletes the prior document when the projection has no text values', () => {
		const converted = toFullTextMutationBatch(
			batch(1n, [mutation('a', { kind: 'record', version: 2, projection: { title: 42 } })])
		);
		assert.deepStrictEqual(converted.upserts, []);
		assert.strictEqual(converted.deletes.length, 1);
	});

	it('reuses a published native cursor and replays later work after a process crash', async () => {
		const directory = path.join(setupTestDBPath(), 'fulltext-derived-index-restart');
		fs.rmSync(directory, { recursive: true, force: true });
		try {
			const crashed = await runRestartChild(directory, 'seed');
			assert.strictEqual(
				crashed.signal,
				'SIGKILL',
				`the seed process should crash after publishing its cursor (exit ${crashed.code}): ${crashed.stderr}`
			);
			const resumed = await runRestartChild(directory, 'resume');
			assert.strictEqual(resumed.code, 0, `the restarted process should replay successfully: ${resumed.stderr}`);
			const state = JSON.parse(fs.readFileSync(path.join(directory, 'native-state.json'), 'utf8'));
			assert.strictEqual(decodeFullTextCursorPayload(state.committedPayload).logs.local, 20);
			assert.deepStrictEqual(
				Object.values(state.documents)
					.map((document) => document.fields.title)
					.sort(),
				['a', 'b']
			);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
