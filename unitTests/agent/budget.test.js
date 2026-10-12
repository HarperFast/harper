'use strict';

const assert = require('node:assert');
const {
	summarizeSessionUsage,
	budgetViolation,
	parseBudgetCap,
	parseMaxTurns,
	callUsage,
} = require('#src/agent/budget');

const assistant = (usage) => ({ role: 'assistant', content: '', createdAt: 0, ...(usage && { usage }) });
const user = { role: 'user', content: 'hi', createdAt: 0 };
const tool = { role: 'tool', content: '{}', toolCallId: 'c1', createdAt: 0 };

describe('agent/budget', () => {
	describe('summarizeSessionUsage', () => {
		it('counts only assistant messages as calls and sums their figures', () => {
			const usage = summarizeSessionUsage([
				user,
				assistant({ promptTokens: 10, completionTokens: 2, costUsd: 0.5 }),
				tool,
				assistant({ promptTokens: 5, completionTokens: 1, costUsd: 0.25 }),
			]);
			assert.deepStrictEqual(usage, { calls: 2, promptTokens: 15, completionTokens: 3, costUsd: 0.75 });
		});

		it('reports zero totals for a session with no calls yet', () => {
			assert.deepStrictEqual(summarizeSessionUsage([user]), {
				calls: 0,
				promptTokens: 0,
				completionTokens: 0,
				costUsd: 0,
			});
		});

		it('drops a total for good once any call did not report it', () => {
			const usage = summarizeSessionUsage([
				assistant({ promptTokens: 10, completionTokens: 2 }),
				assistant({ promptTokens: 5, completionTokens: 1, costUsd: 0.25 }),
				assistant(undefined),
			]);
			assert.deepStrictEqual(usage, { calls: 3 });
		});

		it('treats a non-finite or negative figure as unreported', () => {
			assert.deepStrictEqual(
				summarizeSessionUsage([assistant({ promptTokens: Number.NaN, completionTokens: -1, costUsd: Infinity })]),
				{ calls: 1 }
			);
		});
	});

	describe('callUsage', () => {
		it('keeps only supplied fields and returns nothing for an empty report', () => {
			assert.deepStrictEqual(callUsage({ promptTokens: 3 }, undefined), { promptTokens: 3 });
			assert.deepStrictEqual(callUsage({ promptTokens: 3, completionTokens: 0 }, 0), {
				promptTokens: 3,
				completionTokens: 0,
				costUsd: 0,
			});
			assert.strictEqual(callUsage({}, undefined), undefined);
			assert.strictEqual(callUsage(undefined, undefined), undefined);
		});
	});

	describe('budgetViolation', () => {
		const measured = { calls: 1, promptTokens: 60, completionTokens: 40, costUsd: 0.5 };

		it('allows a session under every cap, and any session with no caps', () => {
			assert.strictEqual(budgetViolation(measured, { maxSessionTokens: 101, maxCostUsd: 0.51 }), undefined);
			assert.strictEqual(budgetViolation({ calls: 9 }, {}), undefined);
		});

		it('trips at the cap, not only past it', () => {
			assert.match(
				budgetViolation(measured, { maxSessionTokens: 100 }),
				/maxSessionTokens=100 reached: this session used 100 tokens/
			);
			assert.match(
				budgetViolation(measured, { maxCostUsd: 0.5 }),
				/maxCostUsd=0.5 reached: this session cost \$0\.5000/
			);
		});

		it('maxCostUsd 0 stops before the first call', () => {
			assert.match(budgetViolation(summarizeSessionUsage([]), { maxCostUsd: 0 }), /maxCostUsd=0 reached/);
		});

		it('stops a session whose capped figure is unmeasured', () => {
			assert.match(
				budgetViolation({ calls: 1, costUsd: 0.1 }, { maxSessionTokens: 1000 }),
				/maxSessionTokens=1000 cannot be enforced/
			);
			assert.match(
				budgetViolation({ calls: 1, promptTokens: 1, completionTokens: 1 }, { maxCostUsd: 5 }),
				/maxCostUsd=5 cannot be enforced: .*declare pricing/
			);
		});
	});

	describe('parseBudgetCap', () => {
		it('accepts valid caps, numeric strings from env-style config, and clears on null or absence', () => {
			assert.strictEqual(parseBudgetCap('maxSessionTokens', 500000), 500000);
			assert.strictEqual(parseBudgetCap('maxSessionTokens', '500000'), 500000);
			assert.strictEqual(parseBudgetCap('maxCostUsd', 0), 0);
			assert.strictEqual(parseBudgetCap('maxCostUsd', 2.5), 2.5);
			assert.strictEqual(parseBudgetCap('maxCostUsd', null), undefined);
			assert.strictEqual(parseBudgetCap('maxSessionTokens', undefined), undefined);
		});

		it('refuses a value that would silently uncap or mis-trip', () => {
			for (const [name, value] of [
				['maxSessionTokens', 0],
				['maxSessionTokens', 1.5],
				['maxSessionTokens', 'many'],
				['maxSessionTokens', ''],
				['maxCostUsd', -1],
				['maxCostUsd', Number.NaN],
				['maxCostUsd', Infinity],
				['maxCostUsd', true],
				['maxCostUsd', {}],
			]) {
				assert.throws(
					() => parseBudgetCap(name, value),
					(err) => err.statusCode === 400 && err.message.startsWith(`agent.${name} must be`),
					`${name}=${String(value)}`
				);
			}
		});
	});

	describe('parseMaxTurns', () => {
		it('accepts a positive integer, also as a config string', () => {
			assert.strictEqual(parseMaxTurns(50), 50);
			assert.strictEqual(parseMaxTurns('7'), 7);
		});

		it('refuses null and anything that would make every run turnless', () => {
			for (const value of [null, 0, -3, 1.5, Number.NaN, 'many', '', true]) {
				assert.throws(
					() => parseMaxTurns(value),
					(err) => err.statusCode === 400 && /agent\.maxTurns must be a positive integer/.test(err.message),
					String(value)
				);
			}
		});
	});
});
