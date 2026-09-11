export interface LatencySummary {
	count: number;
	p50Milliseconds: number;
	p95Milliseconds: number;
	p99Milliseconds: number;
	maxMilliseconds: number;
}

export interface GateInput {
	searchP99Milliseconds?: number;
	searchSampleCount?: number;
	eventLoopP99Milliseconds: number;
	eventLoopSampleCount: number;
	foregroundP99Milliseconds: number;
	foregroundSampleCount: number;
	foregroundWindowMilliseconds: number;
	baselineForegroundP99Milliseconds: number;
	indexingElapsedMilliseconds?: number;
	maxSyncMilliseconds?: number;
	syncSampleCount?: number;
	synchronousCommittedEvents?: number;
}

export interface GateResult {
	passed: boolean;
	failures: string[];
}

export function summarizeLatencies(values: number[]): LatencySummary {
	const sorted = [...values].sort((left, right) => left - right);
	return {
		count: sorted.length,
		p50Milliseconds: percentile(sorted, 0.5),
		p95Milliseconds: percentile(sorted, 0.95),
		p99Milliseconds: percentile(sorted, 0.99),
		maxMilliseconds: sorted.at(-1) ?? 0,
	};
}

export function evaluateGates(input: GateInput): GateResult {
	const failures: string[] = [];
	if (input.searchP99Milliseconds !== undefined) {
		if ((input.searchSampleCount ?? 0) < 100) {
			failures.push(`concurrent search has ${input.searchSampleCount ?? 0} samples; at least 100 are required`);
		} else if (input.searchP99Milliseconds >= 50) {
			failures.push(`search p99 ${input.searchP99Milliseconds.toFixed(3)}ms is not below 50ms`);
		}
	}
	if (input.eventLoopSampleCount < 500) {
		failures.push(`event-loop delay has ${input.eventLoopSampleCount} samples; at least 500 are required`);
	} else if (input.eventLoopP99Milliseconds >= 20) {
		failures.push(`event-loop p99 ${input.eventLoopP99Milliseconds.toFixed(3)}ms is not below 20ms`);
	}
	if (input.foregroundSampleCount < 1_000) {
		failures.push(`foreground writes have ${input.foregroundSampleCount} samples; at least 1000 are required`);
	} else if (
		input.indexingElapsedMilliseconds !== undefined &&
		input.indexingElapsedMilliseconds > input.foregroundWindowMilliseconds
	) {
		failures.push(
			`indexing took ${input.indexingElapsedMilliseconds.toFixed(0)}ms and outlasted the ` +
				`${input.foregroundWindowMilliseconds.toFixed(0)}ms foreground window`
		);
	} else if (input.foregroundP99Milliseconds > input.baselineForegroundP99Milliseconds * 1.2) {
		const foregroundLimit = input.baselineForegroundP99Milliseconds * 1.2;
		failures.push(
			`foreground p99 ${input.foregroundP99Milliseconds.toFixed(3)}ms exceeds the ` +
				`20% regression limit ${foregroundLimit.toFixed(3)}ms`
		);
	}
	if (input.maxSyncMilliseconds !== undefined) {
		if ((input.syncSampleCount ?? 0) === 0) {
			failures.push('host storage reported no sync callbacks');
		} else if (input.maxSyncMilliseconds > 250) {
			failures.push(`sync max ${input.maxSyncMilliseconds.toFixed(3)}ms exceeds 250ms`);
		}
	}
	if ((input.synchronousCommittedEvents ?? 0) !== 0) {
		failures.push(`${input.synchronousCommittedEvents} committed events re-entered host storage writes`);
	}
	return { passed: failures.length === 0, failures };
}

export function parsePositiveIntegerList(value: string, name: string): number[] {
	const values = value.split(',').map(Number);
	if (values.length === 0 || values.some((entry) => !Number.isSafeInteger(entry) || entry <= 0)) {
		throw new Error(`${name} must be a comma-separated list of positive integers`);
	}
	return [...new Set(values)];
}

function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
