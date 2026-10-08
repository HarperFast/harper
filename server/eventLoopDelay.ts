import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

export const EVENT_LOOP_DELAY_RESOLUTION_MS = 20;
const NANOSECONDS_PER_MILLISECOND = 1e6;

export interface EventLoopDelay {
	mean: number;
	maxDelay: number;
	count: number;
}

type DelayHistogram = Pick<IntervalHistogram, 'count' | 'mean' | 'max'>;

let histogram: IntervalHistogram | undefined;
let resolutionMs = EVENT_LOOP_DELAY_RESOLUTION_MS;

/**
 * Samples this thread's event loop with a native timer at `resolution` ms; the histogram records
 * the interval between firings, so an idle loop reads the resolution itself.
 */
export function startEventLoopDelayMonitor(resolution = EVENT_LOOP_DELAY_RESOLUTION_MS): boolean {
	if (histogram) return true;
	if (typeof monitorEventLoopDelay !== 'function') return false;
	try {
		const started = monitorEventLoopDelay({ resolution });
		started.enable();
		histogram = started;
	} catch {
		return false;
	}
	resolutionMs = resolution;
	return true;
}

export function stopEventLoopDelayMonitor(): void {
	histogram?.disable();
	histogram = undefined;
}

/** The delay accumulated since the previous read, in milliseconds; resets the histogram. */
export function readEventLoopDelay(): EventLoopDelay | undefined {
	if (!histogram) return undefined;
	const delay = eventLoopDelayFromHistogram(histogram, resolutionMs);
	histogram.reset();
	return delay;
}

export function eventLoopDelayFromHistogram(sample: DelayHistogram, resolution: number): EventLoopDelay | undefined {
	const count = sample.count;
	if (!(count > 0)) return undefined;
	return {
		mean: Math.max(0, sample.mean / NANOSECONDS_PER_MILLISECOND - resolution),
		maxDelay: Math.max(0, sample.max / NANOSECONDS_PER_MILLISECOND - resolution),
		count,
	};
}
