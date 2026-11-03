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
const { subscribeFullTextTelemetry } = require('#src/resources/analytics/fullTextTelemetryRuntime');

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
		limits: {
			indexingThreads: 2,
			searchThreads: 2,
			writerMemoryBytes: 64 * 1024 * 1024,
			maxQueuedCommands: 16,
			maxQueuedBytes: 64 * 1024 * 1024,
			maxBatchBytes: 8 * 1024 * 1024,
		},
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
