import assert from 'node:assert';
import { createHistogram } from 'node:perf_hooks';
export const MATCHES = 1000;
export function validateCatalogRows(rows, large = false) {
	assert(Number.isInteger(rows) && rows >= MATCHES && rows % MATCHES === 0 && rows <= (large ? 20000000 : 1000000));
}
export function diskUsageBytes(stdout, stderr = '', exitCode = 0) {
	assert(
		exitCode === 0 ||
			(exitCode === 1 &&
				stderr.trim().length > 0 &&
				stderr
					.trim()
					.split('\n')
					.every((line) => /^du: .+: No such file or directory$/.test(line))),
		`Disk usage command failed: ${stderr.trim()}`
	);
	const total = /^([0-9]+)[\t ]+[^\n]+\n?$/.exec(stdout);
	assert(total, 'Disk usage command did not report one total');
	const bytes = Number(total[1]) * 1024;
	assert(Number.isSafeInteger(bytes), 'Disk usage total exceeded the safe integer range');
	return bytes;
}
export function record(index) {
	const bucket = Math.floor(index / MATCHES);
	return {
		id: `item-${String(index).padStart(9, '0')}`,
		title: `catalog bucket${String(bucket).padStart(6, '0')}`,
		category: `bucket${String(bucket).padStart(6, '0')}`,
		rank: index % MATCHES,
	};
}
export function target(name, bucket = 0) {
	const token = `bucket${String(bucket).padStart(6, '0')}`;
	return {
		conditions: [
			{
				attribute: name === 'structured' ? 'category' : 'catalogSearch',
				comparator: name === 'structured' ? 'equals' : 'matches',
				value: token,
				...(name === 'highlights' ? { includeHighlights: true } : {}),
			},
		],
		...(name === 'relevance' || name === 'exact' ? {} : { sort: { attribute: 'rank' } }),
		select: ['id', 'title', 'category', 'rank', ...(name === 'highlights' ? ['$highlights'] : [])],
		limit: 20,
	};
}
export function verify(name, rows, range, bucket = 0) {
	assert(Array.isArray(rows));
	assert.strictEqual(rows.length, 20);
	assert.strictEqual(new Set(rows.map((r) => r.id)).size, 20);
	for (const row of rows) {
		const index = Number(row.id.slice(5));
		assert(Number.isInteger(index) && index >= bucket * MATCHES && index < (bucket + 1) * MATCHES);
		assert.deepStrictEqual({ id: row.id, title: row.title, category: row.category, rank: row.rank }, record(index));
		if (name === 'highlights') assert(row.$highlights?.title?.length > 0);
	}
	if (!['relevance', 'exact'].includes(name))
		assert.deepStrictEqual(
			rows.map((r) => r.id),
			Array.from({ length: 20 }, (_, i) => record(bucket * MATCHES + i).id)
		);
	if (name === 'exact') {
		if (range === 'items 0-19/*')
			throw Object.assign(new Error('Bounded full-text count remained unknown'), {
				code: 'QUALIFICATION_UNKNOWN_COUNT',
			});
		assert.strictEqual(range, 'items 0-19/1000');
	}
}
export function meter() {
	const histogram = createHistogram();
	let failures = 0;
	let timeouts = 0;
	let unknownCounts = 0;
	const failureLatency = createHistogram();
	return {
		add(ms) {
			histogram.record(Math.max(1, Math.round(ms * 1e6)));
		},
		fail(ms, timeout = false, unknownCount = false) {
			failures++;
			if (timeout) timeouts++;
			if (unknownCount) unknownCounts++;
			if (ms !== undefined) failureLatency.record(Math.max(1, Math.round(ms * 1e6)));
		},
		summary() {
			return {
				completed: histogram.count,
				rejections: failures,
				timeouts,
				unknownCounts,
				failureLatency: {
					count: failureLatency.count,
					p50: failureLatency.percentile(50) / 1e6,
					p95: failureLatency.percentile(95) / 1e6,
					p99: failureLatency.percentile(99) / 1e6,
					max: failureLatency.max / 1e6,
				},
				p50: histogram.percentile(50) / 1e6,
				p95: histogram.percentile(95) / 1e6,
				p99: histogram.percentile(99) / 1e6,
				max: histogram.max / 1e6,
			};
		},
	};
}

export async function runPhase(isStopped, action) {
	assert(!isStopped(), 'qualification interrupted');
	return action();
}
export function cellVerdict(reads, writes) {
	return reads.completed > 0 && reads.rejections === 0 && writes.rejections === 0 ? 'qualified' : 'unqualified';
}

export async function finalizeReport(report, cleanup, publish) {
	try {
		await cleanup();
	} catch (error) {
		report.cleanupFailure = { message: error.message };
		report.failure ??= { message: error.message };
		throw error;
	} finally {
		report.verdict =
			report.failure || report.cells.some((cell) => cell.verdict !== 'qualified') ? 'unqualified' : 'qualified';
		await publish(report);
	}
}
