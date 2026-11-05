require('../testUtils');
const assert = require('node:assert');
const { join } = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { supportsPublishedFullTextBinding } = require('./fullTextNativePlatform');
const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
const { NativeFullTextDerivedIndexLifecycle } = require('#src/resources/indexes/nativeFullTextDerivedIndexLifecycle');
const {
	FullTextDerivedIndexBackend,
	encodeFullTextCursorPayload,
} = require('#src/resources/indexes/fullTextDerivedIndex');
const { DERIVED_INDEX_ACCEPTED } = require('#src/resources/derivedIndexRuntime');
const { FullTextTelemetryCollector } = require('#src/resources/analytics/fullTextTelemetry');
const {
	subscribeFullTextTelemetry,
	registerNativeFullTextTelemetry,
	fullTextTelemetryCollector,
} = require('#src/resources/analytics/fullTextTelemetryRuntime');

const limits = {
	indexingThreads: 2,
	searchThreads: 2,
	writerMemoryBytes: 64 * 1024 * 1024,
	maxQueuedCommands: 16,
	maxQueuedBytes: 64 * 1024 * 1024,
	maxBatchBytes: 8 * 1024 * 1024,
};

for (const demand of ['consumer', 'operator', 'default']) {
	const description =
		demand === 'default'
			? 'keeps default recording disabled after a rejected close'
			: `disables native recording after a rejected close when the last ${demand} demand was removed`;
	it(description, async function () {
		this.timeout(20_000);
		if (!(await supportsPublishedFullTextBinding())) this.skip();
		const binding = await loadFullTextNativeBinding();
		const id = `close-disabled-${demand}-${process.pid}`;
		const writer = await binding.openNativeFullTextIndex({
			path: join(setupTestDBPath(), id),
			indexId: id,
			generation: 'g1',
			fields: [{ name: 'title' }],
			analyzer: 'english@2',
			positions: true,
			limits,
		});
		let errors = 0;
		const collector = new FullTextTelemetryCollector({ onError: () => errors++ });
		const policy = { histograms: true, snapshotBytes: true, intervalMilliseconds: 1000 };
		let removeDemand = () => {};
		if (demand === 'consumer') removeDemand = collector.subscribe(() => {}, policy);
		else if (demand === 'operator') {
			collector.setOperatorPolicy({ ...policy, enabled: true });
			removeDemand = () => collector.setOperatorPolicy({ enabled: false });
		}
		const recording = () => {
			const { histogramsEnabled, snapshotBytesEnabled } = writer.telemetry().native;
			return { histogramsEnabled, snapshotBytesEnabled };
		};
		const initiallyRecording = demand !== 'default';
		try {
			collector.register(writer, id, 'writer');
			assert.deepStrictEqual(recording(), {
				histogramsEnabled: initiallyRecording,
				snapshotBytesEnabled: initiallyRecording,
			});
			await writer.applyMutationBatch({ upserts: [{ id: 'dirty', fields: { title: 'catalog widget' } }], deletes: [] });
			collector.beforeClose(writer);
			const closing = writer.close({ mode: 'require-clean' });
			removeDemand();
			assert.strictEqual(collector.collecting, false);
			assert.strictEqual(collector.scheduled, false);
			assert.deepStrictEqual(recording(), {
				histogramsEnabled: initiallyRecording,
				snapshotBytesEnabled: initiallyRecording,
			});
			await assert.rejects(closing, (error) => error.code === 'E_DIRTY_CLOSE');
			collector.closeFailed(writer);
			assert.strictEqual(writer.status().state, 'open');
			assert.strictEqual(collector.collecting, false);
			assert.strictEqual(collector.scheduled, false);
			assert.deepStrictEqual(recording(), { histogramsEnabled: false, snapshotBytesEnabled: false });
			await writer.applyMutationBatch({ upserts: [{ id: 'later', fields: { title: 'still writable' } }], deletes: [] });
			assert.strictEqual(writer.status().state, 'open');
			assert.deepStrictEqual(recording(), { histogramsEnabled: false, snapshotBytesEnabled: false });
			assert.strictEqual(errors, 0);
		} finally {
			removeDemand();
			collector.beforeClose(writer);
			try {
				await writer.close({ mode: 'rollback' });
				collector.afterClose(writer);
			} finally {
				collector.stop();
			}
		}
	});
}

it('reconciles removed recording demand through a real backend close failure', async function () {
	this.timeout(20_000);
	if (!(await supportsPublishedFullTextBinding())) this.skip();
	const binding = await loadFullTextNativeBinding();
	const id = `close-backend-disabled-${process.pid}`;
	const lifecycle = new NativeFullTextDerivedIndexLifecycle({
		storePath: join(setupTestDBPath(), id),
		storeName: 'catalog.Product.title',
		indexId: id,
		sourceGeneration: 'generation-1',
		fields: [{ name: 'title' }],
		analyzer: 'english@2',
		positions: true,
		limits,
		binding,
	});
	await lifecycle.initialize({ reclaimRetired: false });
	let writer;
	let removeConsumer = () => {};
	removeConsumer = subscribeFullTextTelemetry(
		(sample) => {
			if (sample.index === id && sample.stage === 'closing') removeConsumer();
		},
		{ histograms: true, snapshotBytes: true, intervalMilliseconds: 1000 }
	);
	const backend = new FullTextDerivedIndexBackend({
		id,
		lifecycle: {
			inspect: () => lifecycle.inspect(),
			reset: (epoch) => lifecycle.reset(epoch),
			async open() {
				writer = await lifecycle.open();
				return writer;
			},
		},
		closeTimeoutMilliseconds: 5000,
		shutdownTimeoutMilliseconds: 10_000,
	});
	backend.attach({
		isOwnerEpoch: (epoch) => epoch === 1n,
		getReadiness: () => ({ state: 'ready', ownerEpoch: 1n, rebuildAttempts: 0 }),
		publicationChanged() {},
	});
	const cursor = { format: 1, logs: { local: 1 } };
	try {
		backend.getDurableCursor();
		assert.strictEqual(
			backend.deliver({ ownerEpoch: 1n, transactions: [], records: [], through: cursor, bytes: 0 }),
			DERIVED_INDEX_ACCEPTED
		);
		backend.flush();
		await waitFor(() => backend.getDurableCursor()?.logs.local === 1, 5000);
		assert.strictEqual(writer.telemetry().native.histogramsEnabled, true);
		assert.strictEqual(writer.telemetry().native.snapshotBytesEnabled, true);
		await writer.applyMutationBatch({ upserts: [{ id: 'dirty', fields: { title: 'catalog widget' } }], deletes: [] });
		await assert.rejects(backend.shutdown(1n), /did not prove quiescence/);
		assert.strictEqual(writer.telemetry().native.operations.close.errors.E_DIRTY_CLOSE, 1n);
		assert.strictEqual(writer.status().state, 'open');
		assert.strictEqual(fullTextTelemetryCollector.collecting, false);
		assert.strictEqual(fullTextTelemetryCollector.scheduled, false);
		const { histogramsEnabled, snapshotBytesEnabled } = writer.telemetry().native;
		assert.deepStrictEqual(
			{ histogramsEnabled, snapshotBytesEnabled },
			{ histogramsEnabled: false, snapshotBytesEnabled: false }
		);
		await writer.applyMutationBatch({ upserts: [{ id: 'later', fields: { title: 'still writable' } }], deletes: [] });
		await writer.publish(encodeFullTextCursorPayload(cursor));
		await backend.shutdown(1n);
		assert.strictEqual(writer.status().state, 'closed');
	} finally {
		removeConsumer();
		if (writer && writer.status().state !== 'closed') await writer.close({ mode: 'rollback' });
		await backend.shutdown(1n);
	}
});

it('keeps observing an installed real writer after a rejected require-clean close and closes on retry', async function () {
	this.timeout(20_000);
	if (!(await supportsPublishedFullTextBinding())) this.skip();
	const binding = await loadFullTextNativeBinding();
	const id = `close-retry-${process.pid}`;
	const lifecycle = new NativeFullTextDerivedIndexLifecycle({
		storePath: join(setupTestDBPath(), id),
		storeName: 'catalog.Product.title',
		indexId: id,
		sourceGeneration: 'generation-1',
		fields: [{ name: 'title' }],
		analyzer: 'english@2',
		positions: true,
		limits,
		binding,
	});
	await lifecycle.initialize({ reclaimRetired: false });
	let writer;
	let latest;
	const removeConsumer = subscribeFullTextTelemetry(
		(sample) => {
			if (sample.index === id && sample.role === 'writer' && sample.snapshot?.available) latest = sample;
		},
		{ intervalMilliseconds: 1000 }
	);
	const backend = new FullTextDerivedIndexBackend({
		id,
		lifecycle: {
			inspect: () => lifecycle.inspect(),
			reset: (epoch) => lifecycle.reset(epoch),
			async open() {
				writer = await lifecycle.open();
				return writer;
			},
		},
		closeTimeoutMilliseconds: 5000,
		shutdownTimeoutMilliseconds: 10_000,
	});
	backend.attach({
		isOwnerEpoch: (epoch) => epoch === 1n,
		getReadiness: () => ({ state: 'ready', ownerEpoch: 1n, rebuildAttempts: 0 }),
		publicationChanged() {},
	});
	const cursor = { format: 1, logs: { local: 1 } };
	try {
		backend.getDurableCursor();
		assert.strictEqual(
			backend.deliver({
				ownerEpoch: 1n,
				transactions: [],
				records: [
					{
						tableId: 1,
						recordId: 'seed',
						logVersion: 1,
						state: { kind: 'record', version: 1, projection: { title: 'catalog widget' } },
					},
				],
				through: cursor,
				bytes: 64,
			}),
			DERIVED_INDEX_ACCEPTED
		);
		backend.flush();
		await waitFor(() => backend.getDurableCursor()?.logs.local === 1, 5000);
		await waitFor(() => latest?.snapshot.native.operations.applyFrame.completed >= 1n, 3000);
		const series = latest.series;
		// Stage real native work outside the backend so its clean-close bookkeeping cannot mask E_DIRTY_CLOSE.
		await writer.applyMutationBatch({
			upserts: [{ id: 'external', fields: { title: 'catalog widget' } }],
			deletes: [],
		});
		assert.ok(writer.status().uncommittedMutations > 0n);
		await assert.rejects(backend.shutdown(1n), /did not prove quiescence/);
		assert.strictEqual(writer.status().state, 'open');
		assert.strictEqual(writer.telemetry().native.operations.close.errors.E_DIRTY_CLOSE, 1n);
		const before = writer.telemetry().native.operations.applyFrame.completed;
		await writer.applyMutationBatch({ upserts: [{ id: 'later', fields: { title: 'catalog widget' } }], deletes: [] });
		await waitFor(() => latest?.snapshot.native.operations.applyFrame.completed > before, 3000);
		assert.strictEqual(latest.series, series);
		await writer.publish(encodeFullTextCursorPayload(cursor));
		await backend.shutdown(1n);
		assert.strictEqual(writer.status().state, 'closed');
		assert.strictEqual(latest.snapshot.native.state, 'closed');
		assert.strictEqual(latest.snapshot.native.operations.close.completed, 2n);
	} finally {
		try {
			if (writer && writer.status().state !== 'closed') await writer.close({ mode: 'rollback' });
			await backend.shutdown(1n);
		} finally {
			removeConsumer();
		}
	}
});

it('does not poll or reconfigure a real writer while backend close spans scheduled peer observations', async function () {
	this.timeout(40_000);
	if (!(await supportsPublishedFullTextBinding())) this.skip();
	const binding = await loadFullTextNativeBinding();
	const id = `close-poll-${process.pid}`;
	const lifecycle = new NativeFullTextDerivedIndexLifecycle({
		storePath: join(setupTestDBPath(), id),
		storeName: 'catalog.Product.title',
		indexId: id,
		sourceGeneration: 'generation-1',
		fields: [{ name: 'title' }],
		analyzer: 'english@2',
		positions: true,
		limits,
		binding,
	});
	await lifecycle.initialize({ reclaimRetired: false });
	let writer, witness, latest, closingAt, witnessAfterClose, shutdown, removeHistograms;
	let writerSamples = 0;
	let releaseClose;
	const gate = new Promise((resolve) => (releaseClose = resolve));
	const remove = subscribeFullTextTelemetry(
		(sample) => {
			if (sample.index === id) {
				if (sample.stage === 'closing') closingAt = performance.now();
				if (sample.snapshot?.available) {
					latest = sample.snapshot;
					writerSamples++;
				}
			} else if (
				sample.index === id + '-peer' &&
				closingAt !== undefined &&
				performance.now() - closingAt >= 1000 &&
				sample.snapshot?.native.histogramsEnabled
			)
				witnessAfterClose = sample;
		},
		{ intervalMilliseconds: 1000 }
	);
	const backend = new FullTextDerivedIndexBackend({
		id,
		lifecycle: {
			inspect: () => lifecycle.inspect(),
			reset: (epoch) => lifecycle.reset(epoch),
			async open() {
				writer = await lifecycle.open();
				return writer;
			},
		},
		closeTimeoutMilliseconds: 15_000,
		shutdownTimeoutMilliseconds: 30_000,
	});
	backend.attach({
		isOwnerEpoch: (epoch) => epoch === 1n,
		getReadiness: () => ({ state: 'ready', ownerEpoch: 1n, rebuildAttempts: 0 }),
		publicationChanged() {},
	});
	try {
		backend.getDurableCursor();
		assert.strictEqual(
			backend.deliver({
				ownerEpoch: 1n,
				transactions: [],
				records: [],
				through: { format: 1, logs: { local: 1 } },
				bytes: 0,
			}),
			DERIVED_INDEX_ACCEPTED
		);
		backend.flush();
		await waitFor(() => backend.getDurableCursor()?.logs.local === 1, 5000);
		witness = await binding.openNativeFullTextIndex({
			path: join(setupTestDBPath(), id + '-peer'),
			indexId: id + '-peer',
			generation: 'g1',
			fields: [{ name: 'title' }],
			analyzer: 'english@2',
			positions: true,
			limits,
		});
		registerNativeFullTextTelemetry(witness, id + '-peer', 'writer');
		const close = writer.close.bind(writer);
		writer.close = async (options) => {
			await gate;
			return close(options);
		};
		shutdown = backend.shutdown(1n);
		void shutdown.catch(() => {});
		await waitFor(() => closingAt !== undefined);
		const before = writerSamples;
		removeHistograms = subscribeFullTextTelemetry(() => {}, { histograms: true, intervalMilliseconds: 1000 });
		await waitFor(() => witnessAfterClose, 5000);
		assert.strictEqual(writerSamples, before, 'the scheduler must leave the closing writer unsampled');
		assert.strictEqual(writer.telemetry().native.histogramsEnabled, false);
		releaseClose();
		await shutdown;
		assert.strictEqual(writerSamples, before + 1, 'successful close must emit exactly one final observation');
		assert.strictEqual(latest.native.state, 'closed');
		assert.strictEqual(latest.native.histogramsEnabled, false);
	} finally {
		releaseClose();
		try {
			await backend.shutdown(1n);
			if (writer && writer.status().state !== 'closed') await writer.close({ mode: 'rollback' });
		} finally {
			try {
				if (witness) {
					fullTextTelemetryCollector.beforeClose(witness);
					try {
						await witness.close({ mode: 'rollback' });
						fullTextTelemetryCollector.afterClose(witness);
					} catch (error) {
						fullTextTelemetryCollector.closeFailed(witness);
						throw error;
					}
				}
			} finally {
				removeHistograms?.();
				remove();
			}
		}
	}
});
