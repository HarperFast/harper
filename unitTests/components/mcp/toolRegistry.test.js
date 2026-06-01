const assert = require('node:assert/strict');
const {
	addTool,
	removeTool,
	getTool,
	listTools,
	isSuperUser,
	hasClassLevelVerbs,
	canRoleInvokeOperation,
	_resetRegistryForTest,
} = require('#src/components/mcp/toolRegistry');

function makeTool(overrides = {}) {
	return {
		name: 'sample_tool',
		description: 'A sample tool',
		inputSchema: { type: 'object', properties: {} },
		profile: 'application',
		visibleTo: () => true,
		handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
		...overrides,
	};
}

describe('mcp/toolRegistry', () => {
	beforeEach(() => _resetRegistryForTest());
	afterEach(() => _resetRegistryForTest());

	describe('addTool / removeTool / getTool', () => {
		it('adds, fetches, and removes a tool', () => {
			addTool(makeTool({ name: 'a' }));
			assert.equal(getTool('a').name, 'a');
			assert.equal(removeTool('a'), true);
			assert.equal(getTool('a'), undefined);
		});

		it('rejects nameless tools', () => {
			assert.throws(() => addTool(makeTool({ name: '' })), /name is required/);
		});

		it('removeTool returns false when the tool was never registered', () => {
			assert.equal(removeTool('ghost'), false);
		});
	});

	describe('listTools — filtering', () => {
		it('returns only tools for the requested profile', () => {
			addTool(makeTool({ name: 'ops_tool', profile: 'operations' }));
			addTool(makeTool({ name: 'app_tool', profile: 'application' }));
			const result = listTools({ user: {}, profile: 'application', sessionId: 's1', limit: 10 });
			assert.deepEqual(
				result.tools.map((t) => t.name),
				['app_tool']
			);
		});

		it('omits tools whose visibleTo returns false', () => {
			addTool(makeTool({ name: 'public', visibleTo: () => true }));
			addTool(makeTool({ name: 'secret', visibleTo: () => false }));
			const result = listTools({ user: {}, profile: 'application', sessionId: 's', limit: 10 });
			assert.deepEqual(
				result.tools.map((t) => t.name),
				['public']
			);
		});

		it('passes the user to visibleTo predicates', () => {
			let observed;
			addTool(
				makeTool({
					name: 't',
					visibleTo: (u) => {
						observed = u;
						return true;
					},
				})
			);
			listTools({ user: { username: 'alice' }, profile: 'application', sessionId: 's', limit: 10 });
			assert.deepEqual(observed, { username: 'alice' });
		});

		it('produces deterministic order via name sort', () => {
			addTool(makeTool({ name: 'beta' }));
			addTool(makeTool({ name: 'alpha' }));
			addTool(makeTool({ name: 'gamma' }));
			const result = listTools({ user: {}, profile: 'application', sessionId: 's', limit: 10 });
			assert.deepEqual(
				result.tools.map((t) => t.name),
				['alpha', 'beta', 'gamma']
			);
		});

		it('omits handler and visibleTo from the public descriptor', () => {
			addTool(makeTool({ name: 't' }));
			const result = listTools({ user: {}, profile: 'application', sessionId: 's', limit: 10 });
			const desc = result.tools[0];
			assert.equal('handler' in desc, false);
			assert.equal('visibleTo' in desc, false);
			assert.equal('profile' in desc, false);
		});

		it('includes annotations when present', () => {
			addTool(makeTool({ name: 't', annotations: { readOnlyHint: true } }));
			const result = listTools({ user: {}, profile: 'application', sessionId: 's', limit: 10 });
			assert.deepEqual(result.tools[0].annotations, { readOnlyHint: true });
		});
	});

	describe('listTools — pagination', () => {
		beforeEach(() => {
			for (let i = 0; i < 5; i++) {
				addTool(makeTool({ name: `tool_${i.toString().padStart(2, '0')}` }));
			}
		});

		it('respects limit and returns nextCursor', () => {
			const page1 = listTools({ user: {}, profile: 'application', sessionId: 's', limit: 2 });
			assert.equal(page1.tools.length, 2);
			assert.deepEqual(
				page1.tools.map((t) => t.name),
				['tool_00', 'tool_01']
			);
			assert.ok(page1.nextCursor);
		});

		it('round-trips opaquely through nextCursor', () => {
			const page1 = listTools({ user: {}, profile: 'application', sessionId: 's', limit: 2 });
			const page2 = listTools({
				user: {},
				profile: 'application',
				sessionId: 's',
				limit: 2,
				cursor: page1.nextCursor,
			});
			assert.deepEqual(
				page2.tools.map((t) => t.name),
				['tool_02', 'tool_03']
			);
			const page3 = listTools({
				user: {},
				profile: 'application',
				sessionId: 's',
				limit: 2,
				cursor: page2.nextCursor,
			});
			assert.deepEqual(
				page3.tools.map((t) => t.name),
				['tool_04']
			);
			assert.equal(page3.nextCursor, undefined);
		});

		it('treats a bad cursor as offset=0', () => {
			const result = listTools({
				user: {},
				profile: 'application',
				sessionId: 's',
				limit: 2,
				cursor: '$$nonsense$$',
			});
			assert.equal(result.tools[0].name, 'tool_00');
		});

		it('rejects limit < 1', () => {
			assert.throws(() => listTools({ user: {}, profile: 'application', sessionId: 's', limit: 0 }));
		});

		it('recovers from mid-flow cache invalidation (addTool clears cache, paging continues from offset)', () => {
			const page1 = listTools({ user: {}, profile: 'application', sessionId: 's', limit: 2 });
			assert.deepEqual(
				page1.tools.map((t) => t.name),
				['tool_00', 'tool_01']
			);
			// Registry mutation between pages drops the cache (per addTool's
			// invalidation). Paging with the prior cursor should still work —
			// the next page recomputes the list and slices from the cursor's
			// offset. Result may be slightly different from what the original
			// list contained, which is acceptable per MCP's listChanged
			// eventual-consistency stance.
			addTool(makeTool({ name: 'tool_99' }));
			const page2 = listTools({ user: {}, profile: 'application', sessionId: 's', limit: 2, cursor: page1.nextCursor });
			assert.equal(page2.tools.length, 2);
			// Names are still drawn from the sorted list; the new tool sorts last.
			for (const t of page2.tools) assert.match(t.name, /^tool_/);
		});
	});

	describe('clearSessionCache', () => {
		const { clearSessionCache } = require('#src/components/mcp/toolRegistry');

		it('removes the cache entry for the given session', () => {
			addTool(makeTool({ name: 'a' }));
			addTool(makeTool({ name: 'b' }));
			addTool(makeTool({ name: 'c' }));
			// First call populates the cache.
			const page1 = listTools({ user: {}, profile: 'application', sessionId: 'sx', limit: 2 });
			assert.equal(page1.tools.length, 2);
			// Drop only this session's entry.
			clearSessionCache('sx');
			// Paged call with the cursor should still work — falls into the
			// recompute path because the cache is gone.
			const page2 = listTools({
				user: {},
				profile: 'application',
				sessionId: 'sx',
				limit: 2,
				cursor: page1.nextCursor,
			});
			assert.equal(page2.tools.length, 1);
		});
	});

	describe('isSuperUser', () => {
		it('true when super_user flag is set', () => {
			assert.equal(isSuperUser({ role: { permission: { super_user: true } } }), true);
		});
		it('false otherwise', () => {
			assert.equal(isSuperUser({ role: { permission: {} } }), false);
			assert.equal(isSuperUser({}), false);
			assert.equal(isSuperUser(undefined), false);
		});
	});

	describe('hasClassLevelVerbs', () => {
		// Stand in for `Resource.prototype` — a "base" with no overrides.
		const base = { get() {}, post() {}, put() {}, patch() {}, delete() {} };

		it('detects all-overridden prototype', () => {
			const sub = { get() {}, post() {}, put() {}, patch() {}, delete() {} };
			const v = hasClassLevelVerbs(sub, base);
			assert.deepEqual(v, { get: true, post: true, put: true, patch: true, delete: true });
		});

		it('returns false for verbs that are not overridden (same fn ref as base)', () => {
			const sub = Object.assign({}, base, { get() {} }); // only get overridden
			const v = hasClassLevelVerbs(sub, base);
			assert.equal(v.get, true);
			assert.equal(v.post, false);
			assert.equal(v.put, false);
			assert.equal(v.patch, false);
			assert.equal(v.delete, false);
		});

		it('treats an `update` method as making post truthy (openApi pattern)', () => {
			const sub = Object.assign({}, base, { update() {} });
			const v = hasClassLevelVerbs(sub, base);
			assert.equal(v.post, true);
		});
	});

	describe('canRoleInvokeOperation', () => {
		it('true for super_user regardless of operation', () => {
			assert.equal(canRoleInvokeOperation({ role: { permission: { super_user: true } } }, 'drop_schema'), true);
		});

		it('true for structure_user on schema-structure operations', () => {
			assert.equal(canRoleInvokeOperation({ role: { permission: { structure_user: true } } }, 'create_table'), true);
		});

		it('false for structure_user on non-structure operations', () => {
			assert.equal(canRoleInvokeOperation({ role: { permission: { structure_user: true } } }, 'add_node'), false);
		});

		it('honors a role-level operations allowlist', () => {
			assert.equal(
				canRoleInvokeOperation({ role: { permission: { operations: ['describe_all'] } } }, 'describe_all'),
				true
			);
			assert.equal(
				canRoleInvokeOperation({ role: { permission: { operations: ['describe_all'] } } }, 'drop_schema'),
				false
			);
		});

		it('false for users with no relevant role permission', () => {
			assert.equal(canRoleInvokeOperation({ role: { permission: {} } }, 'describe_all'), false);
			assert.equal(canRoleInvokeOperation({}, 'describe_all'), false);
		});
	});
});
