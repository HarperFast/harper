import { createHash } from 'node:crypto';
import { onStartup } from '../../utility/lifecycle.ts';
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

function reportFailure() {
	if (Date.now() < nextWarningAt) return;
	nextWarningAt = Date.now() + 60_000;
	try {
		logger.warn?.('Could not configure, collect or deliver full-text telemetry');
	} catch {}
}

export const fullTextTelemetryCollector = new FullTextTelemetryCollector({
	onPending: () => {
		if (operatorPolicy.enabled && checkAnalyticsEnabled(false)) requestAnalyticsFlush();
	},
	onError: reportFailure,
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
	const listener = addAnalyticsListener((metrics, final = false) => {
		if (final) {
			try {
				stopWatching?.();
				if (fullTextTelemetryCollector.collecting || fullTextTelemetryCollector.hasPendingRows) {
					const rows = fullTextTelemetryCollector.collectFinalRows();
					if (persistenceActive && checkAnalyticsEnabled(false)) metrics.push(...rows);
				}
			} finally {
				removeListener?.();
				fullTextTelemetryCollector.stop();
			}
			return;
		}
		if (!persistenceActive || !checkAnalyticsEnabled(false) || !fullTextTelemetryCollector.hasPendingRows) return;
		const rows = fullTextTelemetryCollector.takeRows();
		metrics.push(...rows);
	});
	try {
		stopWatching = watchFullTextTelemetryConfiguration((value) => {
			operatorPolicy = resolveFullTextTelemetryPolicy(value);
			setFullTextAnalyticsEnabled(checkAnalyticsEnabled(false));
		});
		removeListener = listener;
		started = true;
	} catch {
		listener();
		reportFailure();
	}
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
		reportFailure();
	}
}

onStartup(initializeFullTextTelemetry);
