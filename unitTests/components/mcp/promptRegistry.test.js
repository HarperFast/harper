const assert = require('node:assert/strict');
const {
	addPrompt,
	getPrompt,
	removePrompt,
	listPrompts,
	clearProfilePrompts,
	snapshotProfilePrompts,
	countProfilePrompts,
	completePromptArgument,
	_resetPromptRegistryForTest,
} = require('#src/components/mcp/promptRegistry');
const { decodeCursor } = require('#src/components/mcp/pagination');

function def(name, profile = 'application', extra = {}) {
	return {
		name,
		profile,
		render: () => ({ messages: [{ role: 'user', content: { type: 'text', text: `hi ${name}` } }] }),
		...extra,
	};
}

describe('mcp/promptRegistry', () => {
	beforeEach(() => _resetPromptRegistryForTest());
	afterEach(() => _resetPromptRegistryForTest());

	it('registers and retrieves a prompt', () => {
		addPrompt(def('greet'));
		assert.equal(getPrompt('greet')?.name, 'greet');
	});

	it('rejects a prompt without a render function', () => {
		assert.throws(() => addPrompt({ name: 'bad', profile: 'application' }), /render function/);
	});

	it('lists only prompts for the requested profile, sorted by name', () => {
		addPrompt(def('b'));
		addPrompt(def('a'));
		addPrompt(def('ops', 'operations'));
		const { prompts } = listPrompts('application');
		assert.deepEqual(
			prompts.map((p) => p.name),
			['a', 'b']
		);
	});

	it('exposes only public descriptor fields (no render/profile leak)', () => {
		addPrompt(
			def('rich', 'application', {
				title: 'Rich',
				description: 'a prompt',
				arguments: [{ name: 'x', required: true }],
			})
		);
		const { prompts } = listPrompts('application');
		assert.deepEqual(prompts[0], {
			name: 'rich',
			title: 'Rich',
			description: 'a prompt',
			arguments: [{ name: 'x', required: true }],
		});
	});

	it('omits the internal `values` field from argument descriptors in prompts/list', () => {
		addPrompt(
			def('withvalues', 'application', {
				arguments: [{ name: 'color', description: 'pick one', required: true, values: ['red', 'green'] }],
			})
		);
		const { prompts } = listPrompts('application');
		assert.deepEqual(prompts[0].arguments, [{ name: 'color', description: 'pick one', required: true }]);
		assert.equal(prompts[0].arguments[0].values, undefined, 'values must not leak to clients');
	});

	it('paginates with an opaque cursor', () => {
		for (const n of ['a', 'b', 'c']) addPrompt(def(n));
		const page1 = listPrompts('application', 0, 2);
		assert.deepEqual(
			page1.prompts.map((p) => p.name),
			['a', 'b']
		);
		assert.ok(page1.nextCursor);
		const page2 = listPrompts('application', decodeCursor(page1.nextCursor), 2);
		assert.deepEqual(
			page2.prompts.map((p) => p.name),
			['c']
		);
		assert.equal(page2.nextCursor, undefined);
	});

	it('removePrompt + clearProfilePrompts drop registrations', () => {
		addPrompt(def('a'));
		addPrompt(def('b'));
		addPrompt(def('ops', 'operations'));
		assert.equal(removePrompt('a'), true);
		assert.equal(countProfilePrompts('application'), 1);
		clearProfilePrompts('application');
		assert.equal(countProfilePrompts('application'), 0);
		assert.equal(countProfilePrompts('operations'), 1, 'other profile untouched');
	});

	it('snapshotProfilePrompts returns the live defs for atomic-rebuild restore', () => {
		addPrompt(def('a'));
		const snap = snapshotProfilePrompts('application');
		assert.equal(snap.length, 1);
		assert.equal(snap[0].name, 'a');
		assert.equal(typeof snap[0].render, 'function');
	});

	describe('completePromptArgument', () => {
		it('filters an argument’s author-declared values by prefix', () => {
			addPrompt(
				def('pick', 'application', {
					arguments: [{ name: 'color', values: ['red', 'green', 'blue', 'grey'] }],
				})
			);
			const all = completePromptArgument('application', 'pick', 'color', '');
			assert.deepEqual(all.values, ['blue', 'green', 'grey', 'red']);
			const gr = completePromptArgument('application', 'pick', 'color', 'gr');
			assert.deepEqual(gr.values, ['green', 'grey']);
		});

		it('returns empty for unknown prompt, wrong profile, or an argument with no values', () => {
			addPrompt(def('plain', 'application', { arguments: [{ name: 'x' }] }));
			assert.deepEqual(completePromptArgument('application', 'nope', 'color', '').values, []);
			assert.deepEqual(completePromptArgument('operations', 'plain', 'x', '').values, []);
			assert.deepEqual(completePromptArgument('application', 'plain', 'x', '').values, []);
		});
	});
});
