const assert = require('node:assert');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { stringify } = require('yaml');
const { RootConfigWatcher } = require('#src/config/RootConfigWatcher');
const { watchFullTextTelemetryConfiguration } = require('#src/config/fullTextTelemetryConfiguration');
const { resolveFullTextTelemetryPolicy } = require('#src/resources/analytics/fullTextTelemetry');
const env = require('#src/utility/environment/environmentManager');
const { updateConfigObject } = require('#src/config/configUtils');
const { configValidator } = require('#src/validation/configValidator');
const { readRootConfig } = require('../rootConfigFixture');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');

const PARAM = 'analytics_fullText';
const root = (fullText) => ({ analytics: { fullText } });

describe('Live full-text telemetry configuration', function () {
	this.timeout(20_000);
	let directory, file, watcher, stop, saved, savedOverrides, savedEnv;
	beforeEach(() => {
		directory = saved = savedOverrides = savedEnv = undefined;
		saved = { value: structuredClone(env.get(PARAM)) };
		savedOverrides = Object.entries(env.getConfigOverrides() ?? {}).filter(
			([key]) => key === PARAM || key.startsWith(PARAM + '_')
		);
		savedEnv = Object.fromEntries(
			['HARPER_CONFIG', 'HARPER_DEFAULT_CONFIG', 'HARPER_SET_CONFIG'].map((key) => [key, process.env[key]])
		);
		for (const key of Object.keys(savedEnv)) delete process.env[key];
		directory = mkdtempSync(join(setupTestDBPath(), 'telemetry-config-'));
		file = join(directory, 'config.yaml');
	});
	afterEach(() => {
		stop?.();
		watcher?.close();
		stop = watcher = undefined;
		for (const [key, value] of Object.entries(savedEnv ?? {})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (savedOverrides) {
			env.refreshConfigSubtree(PARAM, root({ enabled: Symbol('previous') }), {}, resolveFullTextTelemetryPolicy);
		}
		if (saved) updateConfigObject(PARAM, saved.value);
		for (const [name, value] of savedOverrides ?? []) env.setProperty(name, value);
		if (directory) rmSync(directory, { recursive: true, force: true });
	});
	function observe(value, samples) {
		writeFileSync(file, stringify(root(value)));
		watcher = new RootConfigWatcher(file);
		stop = watchFullTextTelemetryConfiguration((policy) => samples.push(policy), watcher);
	}
	async function removeConfigAfterObservedRead() {
		await watcher.ready;
		const reads = watcher._readCountForTests;
		rmSync(file);
		watcher.handleChange();
		assert.ok(
			watcher._readCountForTests > reads,
			'the watcher must finish a real ENOENT read before checking retention'
		);
	}
	it('initializes from the ready nested file policy without an eager aggregate/default application', async () => {
		writeFileSync(file, stringify(root({ enabled: true, histograms: true })));
		watcher = new RootConfigWatcher(file);
		await watcher.ready;
		const samples = [];
		stop = watchFullTextTelemetryConfiguration((policy) => samples.push(policy), watcher);
		assert.deepStrictEqual(samples, []);
		await waitFor(() => samples.length === 1);
		assert.strictEqual(samples[0].enabled, true);
		assert.strictEqual(samples[0].histograms, true);
	});
	it('rejects unknown telemetry keys consistently at boot and live application', () => {
		for (const value of [
			{ enable: true },
			{ enabled: true, histogram: true },
			{ intervalMilliseconds: 1000, extra: 1 },
		]) {
			const config = { ...readRootConfig(), analytics: { fullText: value } };
			assert.match(configValidator(config, true).error?.message, /analytics\.fullText/);
			assert.throws(() => resolveFullTextTelemetryPolicy(value), /Unknown analytics\.fullText option/);
		}
	});
	it('rejects quoted telemetry values consistently at validation and live application', () => {
		for (const value of [
			{ enabled: 'true' },
			{ histograms: 'false' },
			{ snapshotBytes: 'true' },
			{ intervalMilliseconds: '1000' },
		]) {
			const config = { ...readRootConfig(), analytics: { fullText: value } };
			assert.match(configValidator(config, true).error?.message, /analytics\.fullText/);
			assert.throws(() => resolveFullTextTelemetryPolicy(value));
		}
		assert.strictEqual(
			configValidator(
				{ ...readRootConfig(), analytics: { fullText: { enabled: true, intervalMilliseconds: 1000 } } },
				true
			).error,
			undefined
		);
	});
	it('enables, retains a valid policy after an invalid edit, disables and unsubscribes', async () => {
		const samples = [];
		observe({ enabled: true, intervalMilliseconds: 1000 }, samples);
		await waitFor(() => samples.at(-1)?.enabled === true);
		const valid = samples.at(-1);
		const unchangedCount = samples.length;
		writeFileSync(file, stringify({ ...root({ enabled: true, intervalMilliseconds: 1000 }), unrelated: 1 }));
		await waitFor(() => watcher.config?.unrelated === 1);
		assert.strictEqual(samples.length, unchangedCount, 'unrelated config changes must not reset collection cadence');
		writeFileSync(file, stringify(root({ enabled: 'invalid' })));
		await waitFor(() => watcher.config?.analytics.fullText.enabled === 'invalid');
		assert.deepStrictEqual(samples.at(-1), valid);
		writeFileSync(file, stringify(root({ enabled: false })));
		await waitFor(() => samples.at(-1)?.enabled === false);
		stop();
		const count = samples.length;
		writeFileSync(file, stringify(root({ enabled: true })));
		await waitFor(() => watcher.config?.analytics.fullText.enabled === true);
		assert.strictEqual(samples.length, count);
	});
	it('retains the last valid policy and overrides through deletion and identical recreation', async () => {
		const samples = [];
		env.setProperty(PARAM + '_histograms', true);
		observe({ enabled: true }, samples);
		await waitFor(() => samples.at(-1)?.enabled === true);
		const count = samples.length;
		await removeConfigAfterObservedRead();
		assert.strictEqual(samples.at(-1).enabled, true);
		assert.strictEqual(samples.length, count);
		assert.strictEqual(env.getConfigOverrides()[PARAM + '_histograms'], true);
		const reads = watcher._readCountForTests;
		writeFileSync(file, stringify(root({ enabled: true })));
		await waitFor(() => watcher._readCountForTests > reads);
		assert.strictEqual(samples.length, count);
		writeFileSync(file, stringify(root({ enabled: false, histograms: false })));
		await waitFor(() => samples.at(-1)?.enabled === false);
		assert.strictEqual(env.getConfigOverrides()?.[PARAM + '_histograms'], undefined);
	});
	it('applies a recreated changed file once and ignores invalid revival policy', async () => {
		const samples = [];
		observe({ enabled: true }, samples);
		await waitFor(() => samples.at(-1)?.enabled === true);
		await removeConfigAfterObservedRead();
		assert.strictEqual(samples.at(-1).enabled, true);
		const retainedCount = samples.length;
		writeFileSync(file, stringify(root({ enabled: 'invalid' })));
		await waitFor(() => watcher.config?.analytics.fullText.enabled === 'invalid');
		assert.strictEqual(samples.length, retainedCount);
		writeFileSync(file, stringify(root({ enabled: true, intervalMilliseconds: 2000 })));
		await waitFor(() => samples.at(-1)?.intervalMilliseconds === 2000);
		assert.strictEqual(samples.length, retainedCount + 1);
		assert.strictEqual(samples.at(-1).intervalMilliseconds, 2000);
	});
	it('honors reasserted environment policy over edits to the file', async () => {
		process.env.HARPER_SET_CONFIG = JSON.stringify(root({ enabled: true, intervalMilliseconds: 2000 }));
		const samples = [];
		observe({ enabled: false }, samples);
		await watcher.ready;
		await waitFor(() => samples.at(-1)?.enabled === true);
		writeFileSync(file, stringify(root({ enabled: false, intervalMilliseconds: 3000 })));
		await waitFor(() => watcher.config?.analytics.fullText.intervalMilliseconds === 3000);
		assert.strictEqual(samples.at(-1).intervalMilliseconds, 2000);
		await removeConfigAfterObservedRead();
		assert.strictEqual(samples.at(-1).enabled, true);
		assert.strictEqual(samples.at(-1).intervalMilliseconds, 2000);
	});
	for (const override of [
		[PARAM, { enabled: true, intervalMilliseconds: 2000 }],
		[PARAM + '_enabled', true],
	])
		it(`preserves unchanged ${override[0]} override and retires it after its own file edit`, () => {
			const before = root({ enabled: false, intervalMilliseconds: 1000 });
			env.setProperty(...override);
			assert.strictEqual(
				env.refreshConfigSubtree(PARAM, undefined, before, resolveFullTextTelemetryPolicy).enabled,
				true
			);
			const unrelated = { ...before, unrelated: 1 };
			assert.strictEqual(
				env.refreshConfigSubtree(PARAM, before, unrelated, resolveFullTextTelemetryPolicy).enabled,
				true
			);
			assert.throws(() =>
				env.refreshConfigSubtree(PARAM, before, root({ enabled: 'invalid' }), resolveFullTextTelemetryPolicy)
			);
			assert.deepStrictEqual(env.getConfigOverrides()[override[0]], override[1]);
			assert.strictEqual(
				env.refreshConfigSubtree(PARAM, before, { analytics: {} }, resolveFullTextTelemetryPolicy).enabled,
				false
			);
			assert.strictEqual(env.getConfigOverrides()?.[override[0]], undefined);
		});
});
