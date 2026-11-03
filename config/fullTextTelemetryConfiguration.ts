import { isDeepStrictEqual } from 'node:util';
import { getSharedRootConfigWatcher, type RootConfigWatcher } from './RootConfigWatcher.ts';
import { overlayRootEnvConfig } from './harperConfigEnvVars.ts';
import { get, refreshConfigSubtree } from '../utility/environment/environmentManager.ts';
import { resolveFullTextTelemetryPolicy } from '../resources/analytics/fullTextTelemetry.ts';
import { loggerWithTag } from '../utility/logging/logger.ts';

const logger = loggerWithTag('fulltext-telemetry');
const PARAM = 'analytics_fullText';

/** Observe only telemetry settings; invalid edits retain the last valid policy. */
export function watchFullTextTelemetryConfiguration(
	apply: (value: unknown) => void,
	watcher: RootConfigWatcher = getSharedRootConfigWatcher()
): () => void {
	let stopped = false;
	let previousRoot: unknown;
	let lastPolicy: ReturnType<typeof resolveFullTextTelemetryPolicy> | undefined;
	function applyPolicy(value: unknown) {
		const policy = resolveFullTextTelemetryPolicy(value);
		if (isDeepStrictEqual(policy, lastPolicy)) return;
		apply(policy);
		lastPolicy = policy;
	}
	function report() {
		try {
			logger.warn('Could not apply full-text telemetry configuration; retaining the previous valid policy');
		} catch {}
	}
	function changed() {
		if (stopped) return;
		try {
			const root = structuredClone(overlayRootEnvConfig(watcher.config) ?? {});
			const policy = refreshConfigSubtree(PARAM, previousRoot, root, resolveFullTextTelemetryPolicy);
			applyPolicy(policy);
			previousRoot = root;
		} catch {
			report();
		}
	}
	function unavailable() {
		if (stopped) return;
		try {
			applyPolicy(refreshConfigSubtree(PARAM, previousRoot, {}, resolveFullTextTelemetryPolicy));
			previousRoot = {};
		} catch {
			report();
		}
	}
	function stop() {
		stopped = true;
		watcher.off('change', changed);
		watcher.off('unavailable', unavailable);
		watcher.off('available', changed);
		watcher.off('close', stop);
	}
	try {
		applyPolicy(get(PARAM));
	} catch {
		report();
	}
	watcher.on('change', changed);
	watcher.on('unavailable', unavailable);
	watcher.on('available', changed);
	watcher.on('close', stop);
	void watcher.ready.then(changed).catch(report);
	return stop;
}
