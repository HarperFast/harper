import { test } from 'node:test';
import assert from 'node:assert';
import {
	record,
	target,
	verify,
	meter,
	runPhase,
	cellVerdict,
	finalizeReport,
	validateCatalogRows,
	diskUsageBytes,
} from './model.mts';
test('deterministic catalog keeps exactly 1000 rows per token and excludes writer', () => {
	assert.strictEqual(record(0).category, record(999).category);
	assert.notStrictEqual(record(999).category, record(1000).category);
	assert.strictEqual(target('structured').conditions[0].attribute, 'category');
	assert.strictEqual(target('highlights').conditions[0].includeHighlights, true);
	const rows = Array.from({ length: 20 }, (_, i) => record(i));
	verify('sort', rows, null);
	verify('exact', rows, 'items 0-19/1000');
	assert.throws(() => verify('sort', rows.slice().reverse(), null));
	assert.throws(() => verify('exact', rows, 'items 0-19/999'));
	assert.throws(() => verify('relevance', [...rows.slice(0, 19), record(1000)], null));
	assert.throws(() => verify('highlights', rows, null));
});
test('histogram retains bounded latency distribution and explicit rejection count', () => {
	const m = meter();
	for (let i = 1; i <= 100; i++) m.add(i);
	m.fail(12, true);
	const s = m.summary();
	assert.strictEqual(s.completed, 100);
	assert.strictEqual(s.rejections, 1);
	assert.strictEqual(s.timeouts, 1);
	assert.strictEqual(s.failureLatency.count, 1);
	assert(s.failureLatency.p95 >= 12 && s.failureLatency.p95 < 13);
	assert(s.p95 >= 94 && s.p95 < 96);
});

test('stop after successful readiness prevents restart and later catalogs while finally cleanup runs', async () => {
	let stopped = false;
	const reached = [];
	await assert.rejects(async () => {
		try {
			await runPhase(
				() => stopped,
				async () => {
					reached.push('ready');
					stopped = true;
				}
			);
			await runPhase(
				() => stopped,
				async () => reached.push('restart')
			);
			await runPhase(
				() => stopped,
				async () => reached.push('next-catalog')
			);
		} finally {
			reached.push('cleanup');
		}
	}, /interrupted/);
	assert.deepStrictEqual(reached, ['ready', 'cleanup']);
	await assert.rejects(
		() =>
			runPhase(
				() => stopped,
				() => reached.push('next-catalog')
			),
		/interrupted/
	);
});
test('cell verdict rejects read/write errors and empty successful sample populations', () => {
	assert.strictEqual(cellVerdict({ completed: 1, rejections: 0 }, { rejections: 0 }), 'qualified');
	for (const [reads, writes] of [
		[{ completed: 1, rejections: 1 }, { rejections: 0 }],
		[{ completed: 1, rejections: 0 }, { rejections: 1 }],
		[{ completed: 0, rejections: 0 }, { rejections: 0 }],
	])
		assert.strictEqual(cellVerdict(reads, writes), 'unqualified');
});

test('cleanup failure still publishes unqualified evidence and preserves the primary failure', async () => {
	const report = { cells: [], failure: { message: 'primary' } };
	let published;
	await assert.rejects(
		() =>
			finalizeReport(
				report,
				async () => {
					throw new Error('cleanup');
				},
				async (value) => {
					published = structuredClone(value);
				}
			),
		/cleanup/
	);
	assert.strictEqual(published.verdict, 'unqualified');
	assert.strictEqual(published.failure.message, 'primary');
	assert.strictEqual(published.cleanupFailure.message, 'cleanup');
});

test('known exact counts pass, unknown totals remain distinct degraded evidence and wrong data stays fatal', () => {
	const rows = Array.from({ length: 20 }, (_, i) => record(i));
	verify('exact', rows, 'items 0-19/1000');
	assert.throws(
		() => verify('exact', rows, 'items 0-19/*'),
		(error) => error.code === 'QUALIFICATION_UNKNOWN_COUNT'
	);
	assert.throws(
		() => verify('exact', rows, 'items 0-19/999'),
		(error) => error.code === 'ERR_ASSERTION'
	);
	assert.throws(
		() => verify('exact', [...rows.slice(0, 19), record(1000)], 'items 0-19/*'),
		(error) => error.code === 'ERR_ASSERTION'
	);
	const m = meter();
	m.add(1);
	m.fail(1001, false, true);
	const summary = m.summary();
	assert.strictEqual(summary.unknownCounts, 1);
	assert.strictEqual(summary.rejections, 1);
	assert.strictEqual(summary.failureLatency.count, 1);
	assert.strictEqual(cellVerdict(summary, { rejections: 0 }), 'unqualified');
});

test('large catalog requires explicit opt-in and preserves integral 1000-match buckets and a finite ceiling', () => {
	validateCatalogRows(1000);
	validateCatalogRows(1000000);
	validateCatalogRows(10000000, true);
	validateCatalogRows(20000000, true);
	for (const rows of [1000001, 10000000, 0, -1000, NaN, Infinity, 1000.5])
		assert.throws(() => validateCatalogRows(rows));
	for (const rows of [20001000, 20000001, 999, NaN, Infinity]) assert.throws(() => validateCatalogRows(rows, true));
});

test('disk guard accepts only valid totals with vanished paths and rejects other measurement failures', () => {
	const total = '2419556\t<fixture-root>\n';
	const vanished = "du: cannot access '<fixture-root>/index.fulltext/.tmpFTBtft': No such file or directory\n";
	assert.strictEqual(diskUsageBytes(total), 2419556 * 1024);
	assert.strictEqual(diskUsageBytes(total, vanished, 1), 2419556 * 1024);
	assert.strictEqual(
		diskUsageBytes('4\tfixture root\n', 'du: fixture root/gone: No such file or directory\n', 1),
		4096
	);
	assert.strictEqual(diskUsageBytes(total, vanished + vanished, 1), 2419556 * 1024);
	for (const [stdout, stderr, code] of [
		['', vanished, 1],
		[total, '', 1],
		[total, vanished, 2],
		[total, 'du: fixture: Permission denied\n', 1],
		[total, vanished + 'du: fixture: Input/output error\n', 1],
		[total, vanished + 'another diagnostic\n', 1],
		['unknown\tfixture\n', '', 0],
		['-1\tfixture\n', '', 0],
		['1\tfixture\n2\tother\n', '', 0],
		['9007199254740992\tfixture\n', '', 0],
	])
		assert.throws(() => diskUsageBytes(stdout, stderr, code));
});
