require('../testUtils');
const assert = require('node:assert');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { setupTestDBPath, ensureSystemTables } = require('../testUtils');
const { setRootConfigEntry, readRootConfig } = require('../rootConfigFixture');
const { waitFor } = require('../waitFor');
const { getConfigFilePath } = require('#src/config/configUtils');
const { getSharedRootConfigWatcher } = require('#src/config/RootConfigWatcher');
const { getDatabases } = require('#src/resources/databases');
const { startWorker } = require('#src/server/threads/manageThreads');
const { supportsPublishedFullTextBinding } = require('./fullTextNativePlatform');
const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
const {
	initializeFullTextTelemetry,
	fullTextTelemetryCollector,
} = require('#src/resources/analytics/fullTextTelemetryRuntime');
const analytics = require('#src/resources/analytics/write');

it('persists an actual managed-worker sample produced before main applies the same enabled policy', async function () {
	this.timeout(30_000);
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !(await supportsPublishedFullTextBinding())) this.skip();
	const directory = setupTestDBPath();
	await ensureSystemTables();
	await loadFullTextNativeBinding();
	const configPath = getConfigFilePath();
	const savedConfig = readFileSync(configPath, 'utf8');
	const wasEnabled = analytics.checkAnalyticsEnabled();
	const barrier = new Int32Array(new SharedArrayBuffer(4));
	const label = `worker-telemetry-${process.pid}`;
	const pending = new Map();
	let sequence = 0;
	let worker;
	let produced;
	let producer;
	function request(command, options = {}) {
		return new Promise((resolve, reject) => {
			const id = ++sequence;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`Telemetry worker command ${command} did not settle`));
			}, 15_000);
			pending.set(id, { resolve, reject, timer });
			try {
				worker.postMessage({ id, command, ...options });
			} catch (error) {
				clearTimeout(timer);
				pending.delete(id);
				reject(error);
			}
		});
	}
	try {
		initializeFullTextTelemetry();
		analytics.setAnalyticsEnabled(true);
		setRootConfigEntry('analytics', { ...readRootConfig().analytics, fullText: { enabled: false } });
		const watcher = getSharedRootConfigWatcher();
		await watcher.ready;
		await waitFor(
			() => watcher.config?.analytics?.fullText?.enabled === false && !fullTextTelemetryCollector.collecting,
			5000
		);
		worker = startWorker(join(__dirname, 'fixtures/fullTextTelemetryWorker.cjs'), {
			name: 'http',
			workerIndex: 1,
			autoRestart: false,
		});
		worker.on('message', (message) => {
			if (message.event === 'sample-before-main-policy') produced = message;
			const command = pending.get(message.id);
			if (!command) return;
			clearTimeout(command.timer);
			pending.delete(message.id);
			if (message.error) command.reject(Object.assign(new Error(message.error.message), message.error));
			else command.resolve(message.result);
		});
		worker.on('error', (error) => {
			for (const command of pending.values()) {
				clearTimeout(command.timer);
				command.reject(error);
			}
			pending.clear();
		});
		worker.on('exit', (code) => {
			for (const command of pending.values()) {
				clearTimeout(command.timer);
				command.reject(new Error(`Telemetry worker exited before its command settled: ${code}`));
			}
			pending.clear();
		});
		producer = request('produce', { path: join(directory, label), label, barrier: barrier.buffer });
		// Attach rejection immediately while the ordering assertion waits for the producer's first event.
		void producer.catch(() => {});
		await waitFor(() => produced, 10_000);
		assert.ok(BigInt(produced.completed) > 0n);
		assert.strictEqual(fullTextTelemetryCollector.collecting, false);
		await waitFor(() => Date.now() > produced.sampledAt);
		setRootConfigEntry('analytics', { ...readRootConfig().analytics, fullText: { enabled: true } });
		await waitFor(() => fullTextTelemetryCollector.collecting, 5000).catch((error) => {
			error.message += `; activation state ${JSON.stringify({
				file: readRootConfig().analytics?.fullText,
				watched: watcher.config?.analytics?.fullText,
				analyticsEnabled: analytics.checkAnalyticsEnabled(false),
				armed: watcher._armedForTests,
				polling: watcher._usingPollingForTests,
				reads: watcher._readCountForTests,
				listeners: watcher.listenerCount('change'),
			})}`;
			throw error;
		});
		const mainEnabledAt = Date.now();
		assert.ok(produced.sampledAt < mainEnabledAt);
		Atomics.store(barrier, 0, 1);
		Atomics.notify(barrier, 0);
		await producer;
		const findRow = () => {
			const store = getDatabases().system?.hdb_raw_analytics?.primaryStore;
			if (!store) return;
			for (const { value } of store.getRange({ start: false, end: Infinity })) {
				if (value.threadId !== worker.threadId) continue;
				const row = value.metrics.find(
					(entry) => entry.metric === 'fulltext' && entry.path === label && entry.sampledAt === produced.sampledAt
				);
				if (row) return { report: value, row };
			}
		};
		await waitFor(findRow, 5000);
		const { report, row } = findRow();
		assert.strictEqual(report.threadId, produced.threadId);
		assert.strictEqual(row.method, 'writer');
		assert.strictEqual(row.available, true);
		assert.ok(BigInt(row.native_operations_applyFrame_completed) > 0n);
		assert.ok(row.sampledAt < mainEnabledAt);
		assert.deepStrictEqual(await request('close'), { closed: true });
	} finally {
		Atomics.store(barrier, 0, 1);
		Atomics.notify(barrier, 0);
		await producer?.catch(() => {});
		try {
			if (worker) {
				try {
					if (worker.threadId !== -1) await request('close');
				} finally {
					let timer;
					try {
						await Promise.race([
							worker.terminate(),
							new Promise((_, reject) => {
								timer = setTimeout(() => reject(new Error('Telemetry worker termination did not settle')), 5000);
							}),
						]);
					} finally {
						clearTimeout(timer);
					}
				}
			}
		} finally {
			for (const command of pending.values()) clearTimeout(command.timer);
			writeFileSync(configPath, savedConfig);
			analytics.setAnalyticsEnabled(wasEnabled);
		}
	}
});
