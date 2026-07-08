const assert = require('node:assert');
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
// listTools now takes a decoded offset; the transport decodes the opaque
// cursor (and rejects invalid ones with -32602). Tests decode nextCursor here
// to page, mirroring what the transport does on the wire.
const { decodeCursor } = require('#src/components/mcp/pagination');

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
				offset: decodeCursor(page1.nextCursor),
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
				offset: decodeCursor(page2.nextCursor),
			});
			assert.deepEqual(
				page3.tools.map((t) => t.name),
				['tool_04']
			);
			assert.equal(page3.nextCursor, undefined);
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
			const page2 = listTools({
				user: {},
				profile: 'application',
				sessionId: 's',
				limit: 2,
				offset: decodeCursor(page1.nextCursor),
			});
			assert.equal(page2.tools.length, 2);
			// Names are still drawn from the sorted list; the new tool sorts last.
			for (const t of page2.tools) assert.match(t.name, /^tool_/);
		});
	});

	describe('setProfileToolProvider (dynamic per-profile tools)', () => {
		const { setProfileToolProvider } = require('#src/components/mcp/toolRegistry');

		function provider(defs) {
			const byName = new Map(defs.map((d) => [d.name, d]));
			return { list: () => defs, get: (name) => byName.get(name) };
		}

		it('lists provider tools merged with statically-registered tools', () => {
			addTool(makeTool({ name: 'static_op', profile: 'operations' }));
			setProfileToolProvider('operations', provider([makeTool({ name: 'dynamic_op', profile: 'operations' })]));
			const result = listTools({ user: {}, profile: 'operations', sessionId: 's', limit: 10 });
			assert.deepEqual(
				result.tools.map((t) => t.name),
				['dynamic_op', 'static_op']
			);
		});

		it('reflects a provider whose set changes between calls (lazy walk)', () => {
			let defs = [makeTool({ name: 'op_a', profile: 'operations' })];
			setProfileToolProvider('operations', {
				list: () => defs,
				get: (name) => defs.find((d) => d.name === name),
			});
			assert.deepEqual(
				listTools({ user: {}, profile: 'operations', sessionId: 's', limit: 10 }).tools.map((t) => t.name),
				['op_a']
			);
			defs = [...defs, makeTool({ name: 'op_b', profile: 'operations' })];
			assert.deepEqual(
				listTools({ user: {}, profile: 'operations', sessionId: 's', limit: 10 }).tools.map((t) => t.name),
				['op_a', 'op_b']
			);
		});

		it('a statically-registered tool overrides a provider tool of the same name', () => {
			addTool(makeTool({ name: 'dup', profile: 'operations', description: 'static wins' }));
			setProfileToolProvider(
				'operations',
				provider([makeTool({ name: 'dup', profile: 'operations', description: 'provider loses' })])
			);
			const result = listTools({ user: {}, profile: 'operations', sessionId: 's', limit: 10 });
			assert.equal(result.tools.length, 1);
			assert.equal(result.tools[0].description, 'static wins');
			assert.equal(getTool('dup').description, 'static wins');
		});

		it('getTool falls back to the provider when the registry misses', () => {
			setProfileToolProvider('operations', provider([makeTool({ name: 'prov_only', profile: 'operations' })]));
			assert.equal(getTool('prov_only').name, 'prov_only');
			assert.equal(getTool('nonexistent'), undefined);
		});

		it('getTool(name, profile) is profile-scoped so a cross-profile static tool cannot shadow a provider tool', () => {
			// A static application tool and a dynamic operations tool share a name.
			// The operations client must still resolve ITS tool (not the app one).
			addTool(makeTool({ name: 'shared', profile: 'application', description: 'app tool' }));
			setProfileToolProvider(
				'operations',
				provider([makeTool({ name: 'shared', profile: 'operations', description: 'op tool' })])
			);

			const opTool = getTool('shared', 'operations');
			assert.equal(opTool.profile, 'operations');
			assert.equal(opTool.description, 'op tool');

			const appTool = getTool('shared', 'application');
			assert.equal(appTool.profile, 'application');
			assert.equal(appTool.description, 'app tool');
		});

		it('within a profile, a static tool still wins over a same-name provider tool under getTool(name, profile)', () => {
			addTool(makeTool({ name: 'dup', profile: 'operations', description: 'static wins' }));
			setProfileToolProvider(
				'operations',
				provider([makeTool({ name: 'dup', profile: 'operations', description: 'provider loses' })])
			);
			assert.equal(getTool('dup', 'operations').description, 'static wins');
		});

		it('removing the provider drops its tools', () => {
			setProfileToolProvider('operations', provider([makeTool({ name: 'gone', profile: 'operations' })]));
			assert.equal(getTool('gone').name, 'gone');
			setProfileToolProvider('operations', undefined);
			assert.equal(getTool('gone'), undefined);
			assert.equal(listTools({ user: {}, profile: 'operations', sessionId: 's', limit: 10 }).tools.length, 0);
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
				offset: decodeCursor(page1.nextCursor),
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
