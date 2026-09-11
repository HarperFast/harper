export interface LatencySummary {
	count: number;
	p50Milliseconds: number;
	p95Milliseconds: number;
	p99Milliseconds: number;
	maxMilliseconds: number;
}

export interface GateInput {
	searchP99Milliseconds?: number;
	eventLoopP99Milliseconds: number;
	foregroundP99Milliseconds: number;
	baselineForegroundP99Milliseconds: number;
	maxSyncMilliseconds: number;
	emptyDrainsPerPublication?: number;
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
	if (input.searchP99Milliseconds !== undefined && input.searchP99Milliseconds >= 50) {
		failures.push(`search p99 ${input.searchP99Milliseconds.toFixed(3)}ms is not below 50ms`);
	}
	if (input.eventLoopP99Milliseconds >= 20) {
		failures.push(`event-loop p99 ${input.eventLoopP99Milliseconds.toFixed(3)}ms is not below 20ms`);
	}
	const foregroundLimit = input.baselineForegroundP99Milliseconds * 1.2;
	if (input.foregroundP99Milliseconds > foregroundLimit) {
		failures.push(
			`foreground p99 ${input.foregroundP99Milliseconds.toFixed(3)}ms exceeds the ` +
				`20% regression limit ${foregroundLimit.toFixed(3)}ms`
		);
	}
	if (input.maxSyncMilliseconds > 250) {
		failures.push(`sync max ${input.maxSyncMilliseconds.toFixed(3)}ms exceeds 250ms`);
	}
	if (input.emptyDrainsPerPublication !== undefined && input.emptyDrainsPerPublication > 1) {
		failures.push(`empty drains per publication ${input.emptyDrainsPerPublication.toFixed(3)} exceeds 1`);
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
