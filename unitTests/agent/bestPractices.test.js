'use strict';

/**
 * Unit tests for the agent's Harper best-practices integration (#626).
 * Exercises the real @harperfast/skills package (a dependency), so it verifies
 * the SKILL.md overview loads and the on-demand rule tool serves rule bodies,
 * lists rules, and rejects traversal / unknown names.
 */

const assert = require('node:assert/strict');
const { loadBestPracticesOverview, buildBestPracticeTool } = require('#src/agent/bestPractices');

describe('agent/bestPractices', () => {
	it('loads the SKILL.md overview from @harperfast/skills', () => {
		const overview = loadBestPracticesOverview();
		assert.equal(typeof overview, 'string');
		assert.match(overview, /Harper Best Practices/i);
		// The overview is the index — it should reference rule names, not inline every rule body.
		assert.match(overview, /adding-tables-with-schemas/);
	});

	it('lists available rules when called with no rule', async () => {
		const tool = buildBestPracticeTool();
		assert.ok(tool, 'tool should be built when the skill package is present');
		assert.equal(tool.def.name, 'harper_best_practice');
		const { rules } = await tool.handler({});
		assert.ok(Array.isArray(rules) && rules.length > 5, 'expected several rules');
		assert.ok(rules.includes('adding-tables-with-schemas'));
	});

	it('returns a rule body for a valid rule name', async () => {
		const tool = buildBestPracticeTool();
		const res = await tool.handler({ rule: 'adding-tables-with-schemas' });
		assert.equal(res.rule, 'adding-tables-with-schemas');
		assert.equal(typeof res.content, 'string');
		assert.ok(res.content.length > 100);
	});

	it('rejects a traversal / malformed rule name', async () => {
		const tool = buildBestPracticeTool();
		for (const bad of ['../SKILL', 'a/b', 'foo.md', '..', 'Bad_Name']) {
			await assert.rejects(() => tool.handler({ rule: bad }), /Invalid rule name/, `should reject ${bad}`);
		}
	});

	it('throws a helpful error for an unknown rule', async () => {
		const tool = buildBestPracticeTool();
		await assert.rejects(() => tool.handler({ rule: 'no-such-rule' }), /No such best-practice rule/);
	});
});
