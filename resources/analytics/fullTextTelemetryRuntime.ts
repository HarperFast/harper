import { createHash } from 'node:crypto';
import { onStartup } from '../../utility/lifecycle.ts';
import { registerShutdownDrain } from '../../components/shutdownDrain.ts';
import { loggerWithTag } from '../../utility/logging/logger.ts';
import { watchFullTextTelemetryConfiguration } from '../../config/fullTextTelemetryConfiguration.ts';
import { addAnalyticsListener, requestAnalyticsFlush, checkAnalyticsEnabled } from './write.ts';
import {
	FullTextTelemetryCollector,
	resolveFullTextTelemetryPolicy,
	type FullTextTelemetryHandle,
	type FullTextTelemetrySample,
	type FullTextTelemetryPolicy,
} from './fullTextTelemetry.ts';

const logger = loggerWithTag('fulltext-analytics');
let operatorPolicy = resolveFullTextTelemetryPolicy(undefined);
let started = false;
let stopWatching: (() => void) | undefined;
let removeListener: (() => void) | undefined;
let persistenceActive = false;
let nextWarningAt = 0;

export const fullTextTelemetryCollector = new FullTextTelemetryCollector({
	onPending: () => {
		if (operatorPolicy.enabled && checkAnalyticsEnabled(false)) requestAnalyticsFlush();
	},
	onError: () => {
		if (Date.now() < nextWarningAt) return;
		nextWarningAt = Date.now() + 60_000;
		logger.warn?.('A full-text telemetry observation or consumer failed');
	},
});

export function setFullTextAnalyticsEnabled(enabled: boolean): void {
	const next = operatorPolicy.enabled && enabled;
	persistenceActive = next;
	fullTextTelemetryCollector.setOperatorPolicy({ ...operatorPolicy, enabled: next });
}

export function acceptsFullTextTelemetryRow(row: Record<string, unknown>): boolean {
	return (
		persistenceActive &&
		checkAnalyticsEnabled(false) &&
		typeof row.sampledAt === 'number' &&
		Number.isFinite(row.sampledAt)
	);
}

export function initializeFullTextTelemetry(): void {
	if (started) return;
	started = true;
	removeListener = addAnalyticsListener((metrics) => {
		if (!persistenceActive || !checkAnalyticsEnabled(false)) return;
		const rows = fullTextTelemetryCollector.takeRows();
		metrics.push(...rows);
	});
	stopWatching = watchFullTextTelemetryConfiguration((value) => {
		const next = resolveFullTextTelemetryPolicy(value);
		operatorPolicy = next;
		setFullTextAnalyticsEnabled(checkAnalyticsEnabled(false));
	});
}

export function subscribeFullTextTelemetry(
	callback: (sample: FullTextTelemetrySample) => void | PromiseLike<void>,
	options?: Omit<Partial<FullTextTelemetryPolicy>, 'enabled'>
): () => void {
	initializeFullTextTelemetry();
	return fullTextTelemetryCollector.subscribe(callback, options);
}

export function registerNativeFullTextTelemetry(handle: unknown, index: string, role: 'writer' | 'reader'): void {
	try {
		initializeFullTextTelemetry();
		const native = handle as FullTextTelemetryHandle;
		if (typeof native?.telemetry !== 'function' || typeof native.configureTelemetry !== 'function') return;
		const label = Buffer.byteLength(index) <= 256 ? index : `index:${createHash('sha256').update(index).digest('hex')}`;
		fullTextTelemetryCollector.register(native, label, role);
	} catch {
		logger.warn?.('Could not register a full-text telemetry handle');
	}
}

onStartup(initializeFullTextTelemetry);
registerShutdownDrain({
	hasWork: () => false,
	drain: async () => {
		stopWatching?.();
		removeListener?.();
		fullTextTelemetryCollector.stop();
	},
});
