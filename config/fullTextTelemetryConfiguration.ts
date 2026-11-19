import { isDeepStrictEqual } from 'node:util';
import { getSharedRootConfigWatcher, type RootConfigWatcher } from './RootConfigWatcher.ts';
import { overlayRootEnvConfig } from './harperConfigEnvVars.ts';
import { refreshConfigSubtree } from '../utility/environment/environmentManager.ts';
import { resolveFullTextTelemetryPolicy } from '../resources/analytics/fullTextTelemetry.ts';
import { loggerWithTag } from '../utility/logging/logger.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';

const logger = loggerWithTag('fulltext-telemetry');
const PARAM = CONFIG_PARAMS.ANALYTICS_FULL_TEXT;

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
			logger.warn?.('Could not apply full-text telemetry configuration; retaining the previous valid policy');
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
	function stop() {
		stopped = true;
		watcher.off('change', changed);
		watcher.off('close', stop);
	}
	watcher.on('change', changed);
	watcher.on('close', stop);
	void watcher.ready.then(changed).catch(report);
	return stop;
}
