'use strict';

/**
 * Index-awareness in whereToConditions: a conjunct on an unindexed attribute
 * must be left as a residual (post-scan Filter), NOT pushed into the Resource
 * API condition tree — otherwise Table.search calls searchByIndex on the
 * unindexed attribute and throws "…is not indexed" at runtime. Regression guard
 * for mixed indexed/unindexed WHERE (e.g. `WHERE status = 'active' AND
 * createdAt < X`), which the bulk-conditional-mutation integration test
 * exercises end-to-end.
 */

const assert = require('assert');
const {
	whereToConditions,
	conditionUsesIndex,
	conditionIsPushable,
} = require('#src/sqlEngine/optimizer/whereToConditions');

const col = (name) => ({ kind: 'column', name });
const lit = (value) => ({ kind: 'literal', value });
const binop = (op, name, v) => ({ kind: 'binop', op, left: col(name), right: lit(v) });
const ATTRS = [
	{ name: 'status', indexed: true },
	{ name: 'createdAt', indexed: false },
];

describe('sqlEngine whereToConditions: index-aware residualization', () => {
	it('residualizes an unindexed conjunct and pushes only the indexed one', () => {
		const pred = { kind: 'logical', op: 'and', args: [binop('=', 'status', 'active'), binop('<', 'createdAt', 123)] };
		const { conditions, residual } = whereToConditions(pred, ATTRS);
		assert.strictEqual(conditions.length, 1);
		assert.strictEqual(conditions[0].attribute, 'status');
		assert.ok(residual, 'unindexed createdAt predicate must be residualized');
		assert.strictEqual(residual.left && residual.left.name, 'createdAt');
	});

	it('pushes nothing when every conjunct is unindexed (→ legacy fallback)', () => {
		const { conditions, residual } = whereToConditions(binop('<', 'createdAt', 123), ATTRS);
		assert.strictEqual(conditions.length, 0);
		assert.ok(residual);
	});

	it('without attributes keeps legacy behavior (push any representable condition)', () => {
		const pred = { kind: 'logical', op: 'and', args: [binop('=', 'status', 'active'), binop('<', 'createdAt', 123)] };
		const { conditions, residual } = whereToConditions(pred);
		assert.strictEqual(conditions.length, 2);
		assert.ok(!residual);
	});

	it('keeps a full-scan comparator on an INDEXED attr pushable (driven by another condition)', () => {
		// `status = 'active' AND status LIKE '%act%'` → contains on the indexed
		// `status` is pushable as a secondary filter; it must NOT be residualized.
		const pred = {
			kind: 'logical',
			op: 'and',
			args: [binop('=', 'status', 'active'), { attribute: 'status', comparator: 'contains', value: 'act' }],
		};
		// Build via a like-shaped node so leafToCondition produces the contains form.
		const likePred = {
			kind: 'logical',
			op: 'and',
			args: [
				binop('=', 'status', 'active'),
				{ kind: 'like', expr: col('status'), pattern: lit('%act%'), negated: false },
			],
		};
		const { conditions, residual } = whereToConditions(likePred, ATTRS);
		assert.strictEqual(conditions.length, 2, 'both conditions on indexed status are pushed');
		assert.ok(!residual, 'nothing residualized for all-indexed conditions');
		assert.ok(pred); // (documents the equivalent condition shape)
	});

	it('conditionUsesIndex (driver): indexed+seekable yes; unindexed or full-scan comparator no', () => {
		assert.strictEqual(conditionUsesIndex({ attribute: 'status', comparator: 'equals', value: 'x' }, ATTRS), true);
		assert.strictEqual(conditionUsesIndex({ attribute: 'createdAt', comparator: 'lt', value: 1 }, ATTRS), false);
		assert.strictEqual(conditionUsesIndex({ attribute: 'status', comparator: 'contains', value: 'x' }, ATTRS), false);
	});

	it('conditionIsPushable (search-safe): indexed yes regardless of comparator; unindexed no', () => {
		assert.strictEqual(conditionIsPushable({ attribute: 'status', comparator: 'contains', value: 'x' }, ATTRS), true);
		assert.strictEqual(conditionIsPushable({ attribute: 'createdAt', comparator: 'lt', value: 1 }, ATTRS), false);
	});
});
