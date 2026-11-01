import { test } from 'node:test';
import assert from 'node:assert';
import { record, target, verify, meter } from './model.mts';
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
