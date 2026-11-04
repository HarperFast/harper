'use strict';

const assert = require('node:assert');
const { once } = require('node:events');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const YAML = require('yaml');
const { setupTestDBPath, ensureSystemTables } = require('../testUtils');
const { startWorker } = require('#src/server/threads/manageThreads');
const { getFullTextRuntimeConfiguration } = require('#src/resources/indexes/fullTextRuntimeConfiguration');
const { getConfigFilePath } = require('#src/config/configUtils');
const { supportsPublishedFullTextBinding } = require('./fullTextNativePlatform');
const { setRootConfigEntry, readRootConfig } = require('../rootConfigFixture');
const { waitFor } = require('../waitFor');
const analytics = require('#src/resources/analytics/write');
const {
	initializeFullTextTelemetry,
	fullTextTelemetryCollector,
} = require('#src/resources/analytics/fullTextTelemetryRuntime');
const { getDatabases } = require('#src/resources/databases');
const { randomUUID } = require('node:crypto');
const { jobWorkerOptions } = require('#src/server/jobs/jobRunner');
const { JOB_STATUS_ENUM, SYSTEM_TABLE_NAMES } = require('#src/utility/hdbTerms');

it('logs a failing periodic analytics window without preventing the final flush', async function () {
	this.timeout(60_000);
	await ensureSystemTables();
	const worker = startWorker(require.resolve('./fixtures/analyticsExitFlush.cjs'), {
		name: 'http',
		autoRestart: false,
		workerData: { failPeriodic: true },
	});
	const messages = [];
	worker.prependListener('message', (message) => messages.push(structuredClone(message)));
	try {
		const [code] = await once(worker, 'exit', { signal: AbortSignal.timeout(55_000) });
		assert.strictEqual(code, 0);
		assert.ok(messages.some((message) => message.type === 'periodic-error-logged'));
	} finally {
		if (worker.threadId !== -1) await worker.terminate();
	}
});

for (const mode of ['failOverlap', 'failFinal'])
	it(`preserves final-flush rejection ownership (${mode})`, async function () {
		this.timeout(60_000);
		await ensureSystemTables();
		const worker = startWorker(require.resolve('./fixtures/analyticsExitFlush.cjs'), {
			name: 'http',
			autoRestart: false,
			workerData: { [mode]: true },
		});
		const messages = [];
		worker.prependListener('message', (message) => messages.push(structuredClone(message)));
		try {
			const [code] = await once(worker, 'exit', { signal: AbortSignal.timeout(55_000) });
			assert.strictEqual(code, 0);
			assert.ok(
				messages.some(
					(message) => message.type === (mode === 'failFinal' ? 'final-error-propagated' : 'flush-completed')
				)
			);
		} finally {
			if (worker.threadId !== -1) await worker.terminate();
		}
	});

it('waits for an in-flight analytics window before delivering exactly one final window', async function () {
	this.timeout(60_000);
	await ensureSystemTables();
	const worker = startWorker(require.resolve('./fixtures/analyticsExitFlush.cjs'), {
		name: 'http',
		autoRestart: false,
	});
	const messages = [];
	worker.prependListener('message', (message) => messages.push(structuredClone(message)));
	try {
		const [code] = await once(worker, 'exit', { signal: AbortSignal.timeout(55_000) });
		assert.strictEqual(code, 0);
		assert.deepStrictEqual(messages.find((message) => message.type === 'flush-completed')?.order, [
			'ordinary-started',
			'exit-requested',
			'ordinary-delivered',
			'final-delivered',
		]);
		assert.strictEqual(messages.filter((message) => message.type === 'analytics-report').length, 2);
	} finally {
		if (worker.threadId !== -1) await worker.terminate();
	}
});

it('flushes actual job-worker analytics before cleanup acknowledgement and persists native counters', async function () {
	this.timeout(60_000);
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !(await supportsPublishedFullTextBinding())) this.skip();
	await ensureSystemTables();
	const id = randomUUID();
	const label = `job-exit-${id}`;
	const indexPath = join(setupTestDBPath(), label);
	const jobs = getDatabases().system[SYSTEM_TABLE_NAMES.JOB_TABLE_NAME];
	const savedConfig = readFileSync(getConfigFilePath(), 'utf8');
	const wasEnabled = analytics.checkAnalyticsEnabled(false);
	let worker;
	try {
		initializeFullTextTelemetry();
		analytics.setAnalyticsEnabled(true);
		setRootConfigEntry('analytics', {
			...readRootConfig().analytics,
			fullText: { enabled: true, intervalMilliseconds: 60_000 },
		});
		await waitFor(() => fullTextTelemetryCollector.collecting, 5000);
		await jobs.put({
			id,
			type: 'delete_transaction_logs_before',
			status: JOB_STATUS_ENUM.IN_PROGRESS,
			created_datetime: Date.now(),
			start_datetime: Date.now(),
			request: { operation: 'delete_transaction_logs_before', database: 'system', timestamp: 0 },
		});
		worker = startWorker(require.resolve('#src/server/jobs/jobProcess'), {
			...jobWorkerOptions(id),
			execArgv: [
				...process.execArgv.filter((argument) => argument.startsWith('--conditions=')),
				'--require',
				require.resolve('./fixtures/fullTextTelemetryJobExit.cjs'),
			],
			workerData: {
				addPorts: [],
				addThreadIds: [],
				indexPath,
				indexLabel: label,
				fullTextRuntimeConfiguration: getFullTextRuntimeConfiguration(),
			},
		});
		const messages = [];
		worker.prependListener('message', (message) => messages.push(structuredClone(message)));
		const workerId = worker.threadId;
		const [code] = await once(worker, 'exit', { signal: AbortSignal.timeout(55_000) });
		assert.strictEqual(code, 0, JSON.stringify(messages));
		assert.strictEqual((await jobs.get(id)).status, JOB_STATUS_ENUM.COMPLETE);
		const finalIndex = messages.findIndex((message) => message.type === 'job-final-analytics');
		const ackIndex = messages.findIndex((message) => message.type === 'job_cleanup_complete');
		assert.ok(finalIndex >= 0, 'real jobProcess must invoke terminal analytics');
		assert.strictEqual(messages[finalIndex].collectorStopped, true);
		assert.ok(ackIndex > finalIndex, 'terminal analytics must finish before job cleanup acknowledgement');
		const finalReportIndex = messages.findLastIndex((message) => message.type === 'analytics-report');
		assert.ok(finalReportIndex > finalIndex && finalReportIndex < ackIndex);
		const stored = [];
		for (const { value } of getDatabases().system.hdb_raw_analytics.primaryStore.getRange({
			start: false,
			end: Infinity,
		}))
			if (value.threadId === workerId) stored.push(...value.metrics);
		assert.ok(
			stored.some(
				(row) => row.path === label && row.native_state === 'closed' && row.native_operations_close_completed === '1'
			)
		);
	} finally {
		try {
			if (worker && worker.threadId !== -1) await worker.terminate();
			await jobs.delete(id);
		} finally {
			writeFileSync(getConfigFilePath(), savedConfig);
			analytics.setAnalyticsEnabled(wasEnabled);
			rmSync(indexPath, { recursive: true, force: true, maxRetries: 5 });
		}
	}
});

it('delivers final native telemetry after deferred scope close and before worker exit', async function () {
	this.timeout(60_000);
	if (!(await supportsPublishedFullTextBinding())) this.skip();
	await ensureSystemTables();
	const root = mkdtempSync(join(setupTestDBPath(), 'telemetry-shutdown-'));
	for (const directory of ['database', 'log', 'components', 'keys']) mkdirSync(join(root, directory));
	const config = YAML.parse(readFileSync(getConfigFilePath(), 'utf8'));
	config.rootPath = root;
	config.analytics = { ...config.analytics, fullText: { enabled: true, intervalMilliseconds: 60_000 } };
	writeFileSync(join(root, 'harper-config.yaml'), YAML.stringify(config));
	const label = `shutdown-${process.pid}`;
	const savedConfig = readFileSync(getConfigFilePath(), 'utf8');
	const wasEnabled = analytics.checkAnalyticsEnabled(false);
	let worker;
	try {
		initializeFullTextTelemetry();
		analytics.setAnalyticsEnabled(true);
		setRootConfigEntry('analytics', {
			...readRootConfig().analytics,
			fullText: { enabled: true, intervalMilliseconds: 60_000 },
		});
		await waitFor(() => fullTextTelemetryCollector.collecting, 5000);
		worker = startWorker(require.resolve('#src/server/threads/threadServer'), {
			autoRestart: false,
			name: 'http',
			execArgv: [
				...process.execArgv.filter((argument) => argument.startsWith('--conditions=')),
				'--require',
				require.resolve('./fixtures/fullTextTelemetryShutdown.cjs'),
			],
			env: { ...process.env, ROOTPATH: root, HARPER_SAFE_MODE: 'true' },
			workerData: {
				addPorts: [],
				addThreadIds: [],
				indexPath: join(root, 'index'),
				indexLabel: label,
				fullTextRuntimeConfiguration: getFullTextRuntimeConfiguration(),
			},
		});
		const messages = [];
		// Preserve the wire report independently of main's storage normalization.
		worker.prependListener('message', (message) => messages.push(structuredClone(message)));
		const workerId = worker.threadId;
		const exited = once(worker, 'exit', { signal: AbortSignal.timeout(55_000) });
		async function waitForMessage(type, timeout = 15_000) {
			while (!messages.some((message) => message.type === type))
				await once(worker, 'message', { signal: AbortSignal.timeout(timeout) }).catch((error) => {
					throw new Error(`Missing ${type}; received ${JSON.stringify(messages)}`, { cause: error });
				});
			return messages.find((message) => message.type === type);
		}
		assert.strictEqual((await waitForMessage('native-ready', 45_000)).pending, true);
		worker.postMessage({ type: 'shutdown', restartNumber: 2, exitDeadline: Date.now() + 15_000 });
		worker.postMessage({ type: 'release-startup' });
		const held = await waitForMessage('native-close-held');
		worker.postMessage({ type: 'release-close' });
		const [code] = await exited;
		assert.strictEqual(code, 0);
		assert.strictEqual(held.collecting, true, 'collector must outlive the deferred native owner');
		assert.strictEqual(messages.find((message) => message.type === 'native-closed')?.state, 'closed');
		const rows = messages.flatMap((message) => message.report?.metrics ?? []).filter((row) => row.path === label);
		const final = rows.find((row) => row.native_state === 'closed');
		assert.ok(final, `closed native snapshot must be delivered before worker exit: ${JSON.stringify(messages)}`);
		assert.strictEqual(final.native_operations_close_completed, '1');
		const pending = messages
			.flatMap((message) => message.report?.metrics ?? [])
			.find((row) => row.path === label + '-previous');
		assert.strictEqual(pending?.native_state, 'closed', 'shutdown must preserve an already pending closed-handle row');
		const persisted = () => {
			for (const { value } of getDatabases().system.hdb_raw_analytics.primaryStore.getRange({
				start: false,
				end: Infinity,
			})) {
				if (value.threadId !== workerId) continue;
				const row = value.metrics.find((row) => row.path === label && row.native_state === 'closed');
				if (row) return row;
			}
		};
		await waitFor(persisted, 5000);
		assert.strictEqual(persisted().native_operations_close_completed, '1');
	} finally {
		try {
			if (worker && worker.threadId !== -1) await worker.terminate();
		} finally {
			writeFileSync(getConfigFilePath(), savedConfig);
			analytics.setAnalyticsEnabled(wasEnabled);
			rmSync(root, { recursive: true, force: true, maxRetries: 5 });
		}
	}
});
