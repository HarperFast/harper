'use strict';

/**
 * Unit tests for the agent's registry-tool composition (#626).
 *
 * Registers fake Operations-profile tools directly via the registry's `addTool`
 * (same technique as `unitTests/components/mcp/toolRegistry.test.js`), then
 * verifies `composeRegistryTools` filters by RBAC visibility, adapts the tool
 * shape, wires the destructive gate, and unwraps / re-throws the handler result.
 * `composeToolset` is checked for the operator-wins-on-collision merge rule and the reserved
 * `http_fetch` name.
 *
 * No server boot and no real operations runtime — the registry is populated
 * with stubs, so this stays a fast, credit-free unit test.
 */

const assert = require('node:assert/strict');
const { addTool, setProfileToolProvider, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');
const { composeRegistryTools, _resetRegistryToolsForTests } = require('#src/agent/registryTools');
const { composeToolset } = require('#src/agent/toolset');
const { buildHttpFetchTool } = require('#src/agent/tools/httpFetchTool');

const SUPER_USER = { username: 'agent', role: { permission: { super_user: true } } };
const RESTRICTED = { username: 'ro', role: { permission: { super_user: false } } };

function opTool(overrides = {}) {
	return {
		name: 'describe_all',
		description: 'Describe everything',
		inputSchema: { type: 'object', properties: {} },
		profile: 'operations',
		visibleTo: () => true,
		handler: async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } }),
		...overrides,
	};
}

const scheduleDeps = { onFollowup: async () => {} };

// composeRegistryTools takes (listingUser, resolveIdentity). Most tests use the same user for both.
const identity = (user) => async () => user;

describe('agent/registryTools composeRegistryTools', () => {
	beforeEach(() => {
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
	});
	afterEach(() => {
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
	});

	it('adapts a registry ToolDef to the agent AgentTool shape', () => {
		addTool(opTool({ name: 'search', description: 'Search', inputSchema: { type: 'object', properties: { q: {} } } }));
		const [tool] = composeRegistryTools(SUPER_USER, identity(SUPER_USER));
		assert.equal(tool.def.name, 'search');
		assert.equal(tool.def.description, 'Search');
		// inputSchema → parameters
		assert.deepEqual(tool.def.parameters, { type: 'object', properties: { q: {} } });
	});

	it('only includes tools whose visibleTo(user) is true', () => {
		addTool(opTool({ name: 'visible_op', visibleTo: () => true }));
		addTool(opTool({ name: 'hidden_op', visibleTo: (user) => user?.role?.permission?.super_user === true }));
		const names = composeRegistryTools(RESTRICTED, identity(RESTRICTED)).map((t) => t.def.name);
		assert.deepEqual(names, ['visible_op']);
	});

	it('only drains the operations profile, not other profiles', () => {
		addTool(opTool({ name: 'ops_op', profile: 'operations' }));
		addTool(opTool({ name: 'app_op', profile: 'application' }));
		const names = composeRegistryTools(SUPER_USER, identity(SUPER_USER)).map((t) => t.def.name);
		assert.deepEqual(names, ['ops_op']);
	});

	// Regression: the real Operations profile registers via a *lazy provider*
	// (setProfileToolProvider), not static addTool. Draining it with the
	// static-only snapshot returned nothing, so the agent had zero operation
	// tools. composeRegistryTools must see provider-supplied tools.
	it('drains operations tools registered via a lazy provider, not just static addTool', () => {
		setProfileToolProvider('operations', {
			list: () => [opTool({ name: 'restart_service' }), opTool({ name: 'sql' })],
			get: (name) => (name === 'restart_service' || name === 'sql' ? opTool({ name }) : undefined),
		});
		const names = composeRegistryTools(SUPER_USER, identity(SUPER_USER))
			.map((t) => t.def.name)
			.sort();
		assert.deepEqual(names, ['restart_service', 'sql']);
	});

	it('merges provider and static operations tools, static winning on a name collision', () => {
		setProfileToolProvider('operations', {
			list: () => [opTool({ name: 'sql', description: 'from provider' })],
			get: (name) => (name === 'sql' ? opTool({ name, description: 'from provider' }) : undefined),
		});
		addTool(opTool({ name: 'sql', description: 'from static' }));
		const byName = new Map(composeRegistryTools(SUPER_USER, identity(SUPER_USER)).map((t) => [t.def.name, t]));
		assert.equal(byName.size, 1);
		assert.equal(byName.get('sql').def.description, 'from static');
	});

	it('marks a tool destructive when annotations.destructiveHint is set', () => {
		addTool(opTool({ name: 'restart', annotations: { destructiveHint: true } }));
		addTool(opTool({ name: 'describe_all', annotations: { readOnlyHint: true } }));
		const byName = new Map(composeRegistryTools(SUPER_USER, identity(SUPER_USER)).map((t) => [t.def.name, t]));
		assert.equal(byName.get('restart').destructive, true);
		assert.equal(byName.get('describe_all').destructive, false);
	});

	it("handler unwraps structuredContent and passes the agent's user as hdb_user", async () => {
		let seenUser;
		addTool(
			opTool({
				name: 'search',
				handler: async (args, context) => {
					seenUser = context.user;
					return { content: [{ type: 'text', text: 'x' }], structuredContent: { rows: [1, 2] } };
				},
			})
		);
		const [tool] = composeRegistryTools(SUPER_USER, identity(SUPER_USER));
		const result = await tool.handler({ table: 't' }, { sessionId: 's1' });
		assert.deepEqual(result, { rows: [1, 2] });
		assert.equal(seenUser, SUPER_USER); // enforcement identity is the configured agent user
	});

	it('handler falls back to joined text when there is no structuredContent', async () => {
		addTool(
			opTool({
				name: 'search',
				handler: async () => ({
					content: [
						{ type: 'text', text: 'line one' },
						{ type: 'text', text: 'line two' },
					],
				}),
			})
		);
		const [tool] = composeRegistryTools(SUPER_USER, identity(SUPER_USER));
		assert.equal(await tool.handler({}, { sessionId: 's1' }), 'line one\nline two');
	});

	it('handler throws on an isError result so the loop records a recoverable failure', async () => {
		addTool(
			opTool({
				name: 'search',
				handler: async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }),
			})
		);
		const [tool] = composeRegistryTools(SUPER_USER, identity(SUPER_USER));
		await assert.rejects(() => tool.handler({}, { sessionId: 's1' }), /boom/);
	});

	it('resolves the enforcement identity fresh on each call (live role change is honored)', async () => {
		const seen = [];
		addTool(
			opTool({
				name: 'search',
				handler: async (args, context) => {
					seen.push(context.user);
					return { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } };
				},
			})
		);
		// resolveIdentity returns a different user object each call — the second reflects a role change.
		let call = 0;
		const resolveIdentity = async () => (call++ === 0 ? SUPER_USER : RESTRICTED);
		const [tool] = composeRegistryTools(SUPER_USER, resolveIdentity);
		await tool.handler({}, { sessionId: 's1' });
		await tool.handler({}, { sessionId: 's1' });
		assert.equal(seen[0], SUPER_USER);
		assert.equal(seen[1], RESTRICTED); // not the cached startup identity
	});

	it('handler propagates a fail-closed resolveIdentity rejection (never runs with a stale identity)', async () => {
		let handlerRan = false;
		addTool(
			opTool({
				name: 'search',
				handler: async () => {
					handlerRan = true;
					return { content: [{ type: 'text', text: 'ok' }] };
				},
			})
		);
		const resolveIdentity = async () => {
			throw new Error("agent.user 'ghost' could not be resolved to a permissioned user; failing closed");
		};
		const [tool] = composeRegistryTools(SUPER_USER, resolveIdentity);
		await assert.rejects(() => tool.handler({}, { sessionId: 's1' }), /failing closed/);
		assert.equal(handlerRan, false); // the operation never dispatched
	});
});

describe('agent/toolset composeToolset — registry merge', () => {
	beforeEach(() => {
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
	});
	afterEach(() => {
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
	});

	function registryTool(name, destructive = false) {
		return {
			def: { name, description: name, parameters: { type: 'object' } },
			destructive,
			_fromRegistry: true, // marker so we can tell it apart from an operator tool of the same name
			handler: async () => 'registry',
		};
	}

	it('includes registry tools alongside operator-only tools', () => {
		const { tools } = composeToolset({ ...scheduleDeps, registryTools: [registryTool('search')] });
		assert.ok(tools.some((t) => t.def.name === 'search'));
		// operator-only tools are still present
		assert.ok(tools.some((t) => t.def.name === 'read_file'));
	});

	it('operator-only tools win on a name collision (registry tool is dropped)', () => {
		const { tools } = composeToolset({ ...scheduleDeps, registryTools: [registryTool('read_file')] });
		const readFile = tools.filter((t) => t.def.name === 'read_file');
		assert.equal(readFile.length, 1, 'no duplicate read_file');
		assert.notEqual(readFile[0]._fromRegistry, true, 'operator read_file survives, not the registry one');
	});

	it('composes no http_fetch when the policy built none, even if a registry or extra tool claims the name', () => {
		const { tools } = composeToolset({
			...scheduleDeps,
			registryTools: [registryTool('http_fetch')],
			extraTools: [registryTool('http_fetch')],
		});
		assert.ok(!tools.some((t) => t.def.name === 'http_fetch'));
	});

	it('composes the policy-built http_fetch over a same-named registry tool', () => {
		const httpFetchTool = buildHttpFetchTool({ allow: ['localhost'] });
		const { tools } = composeToolset({ ...scheduleDeps, httpFetchTool, registryTools: [registryTool('http_fetch')] });
		const fetchTools = tools.filter((t) => t.def.name === 'http_fetch');
		assert.equal(fetchTools.length, 1);
		assert.equal(fetchTools[0], httpFetchTool);
	});

	it('filters destructive registry tools when allowDestructive is false', () => {
		const { tools } = composeToolset({
			...scheduleDeps,
			allowDestructive: false,
			registryTools: [registryTool('restart', true), registryTool('search', false)],
		});
		const names = tools.map((t) => t.def.name);
		assert.ok(!names.includes('restart'));
		assert.ok(names.includes('search'));
	});
});

describe('agent/registryTools read_log masking (harper#3097)', () => {
	const {
		registerOperationsTools,
		_setOperationFunctionMapForTest,
		_setChooseOperationForTest,
		_setProcessLocalTransactionForTest,
	} = require('#src/components/mcp/tools/operations');
	const PEM = '-----BEGIN PRIVATE KEY-----\nMIIfake\n-----END PRIVATE KEY-----';
	let operations;
	let dispatched;

	// The real operations profile and its result wrapping, with only the operation functions stubbed.
	beforeEach(() => {
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
		dispatched = 0;
		operations = new Map([
			['read_log', async () => []],
			['search_by_value', async () => [{ id: 1, apiKey: 'sk-row' }]],
		]);
		_setOperationFunctionMapForTest(
			new Map(
				[...operations.keys()].map((name) => [name, { operation_function: (body) => operations.get(name)(body) }])
			)
		);
		_setChooseOperationForTest((body) => (request) => operations.get(body.operation)(request));
		_setProcessLocalTransactionForTest(async (request, operation) => {
			dispatched++;
			return operation(request.body);
		});
		registerOperationsTools();
	});
	afterEach(() => {
		_setOperationFunctionMapForTest(undefined);
		_setChooseOperationForTest(undefined);
		_setProcessLocalTransactionForTest(undefined);
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
	});

	const tool = (name) => composeRegistryTools(SUPER_USER, identity(SUPER_USER)).find((t) => t.def.name === name);

	it('masks credentials in every text field of every entry and keeps ordinary text', async () => {
		operations.set('read_log', async () => [
			{
				timestamp: '2026-10-20T00:00:00.000Z',
				thread: 'http/1',
				level: 'error',
				tags: ['custom', 'apiKey=sk-tag'],
				message: 'request failed {"apiKey":"sk-message"} body="{\\"token\\":\\"sk-nested\\"}" for user bob',
				node: 'node-a',
			},
		]);
		assert.deepEqual(await tool('read_log').handler({ limit: 5 }, { sessionId: 's1' }), {
			results: [
				{
					timestamp: '2026-10-20T00:00:00.000Z',
					thread: 'http/1',
					level: 'error',
					tags: ['custom', 'apiKey=******'],
					message: 'request failed {"apiKey":"**********"} body="{\\"token\\":\\"*********\\"}" for user bob',
					node: 'node-a',
				},
			],
		});
	});

	it('refuses an entry that holds a PEM private key and keeps the others', async () => {
		operations.set('read_log', async () => [
			{ timestamp: 't1', level: 'info', tags: [], message: `loaded ${PEM}` },
			{ timestamp: 't2', level: 'info', tags: [], message: 'started' },
		]);
		const { results } = await tool('read_log').handler({}, { sessionId: 's1' });
		assert.deepEqual(results, [
			{ timestamp: 't1', message: 'Refused: this log entry holds a PEM private key' },
			{ timestamp: 't2', level: 'info', tags: [], message: 'started' },
		]);
	});

	it('masks a quoted credential that an entry continues on a line of its own', async () => {
		operations.set('read_log', async () => [{ timestamp: 't1', message: 'request {"apiKey":"sk-a\nsk-b"}' }]);
		const { results } = await tool('read_log').handler({}, { sessionId: 's1' });
		assert.deepEqual(results, [{ timestamp: 't1', message: 'request {"apiKey":"****\n****"}' }]);
	});

	it('refuses a filter before dispatch, since it matches unmasked text', async () => {
		await assert.rejects(tool('read_log').handler({ filter: 'sk-' }, { sessionId: 's1' }), /filter is not available/);
		assert.equal(dispatched, 0);
	});

	it('masks a failed read_log error and withholds one holding a PEM private key', async () => {
		operations.set('read_log', async () => {
			throw new Error('cannot read apiKey: sk-error');
		});
		await assert.rejects(tool('read_log').handler({}, { sessionId: 's1' }), (err) => {
			assert.match(err.message, /cannot read apiKey: \*{8}/);
			assert.doesNotMatch(err.message, /sk-error/);
			return true;
		});
		operations.set('read_log', async () => {
			throw new Error(`cannot parse ${PEM}`);
		});
		await assert.rejects(tool('read_log').handler({}, { sessionId: 's1' }), /PEM private key, so it is withheld/);
	});

	it('withholds a result it cannot mask, without echoing it', async () => {
		for (const unexpected of [
			{ text: 'apiKey: sk-shape' },
			[{ message: { apiKey: 'sk-shape' } }],
			'apiKey: sk-shape',
		]) {
			operations.set('read_log', async () => unexpected);
			await assert.rejects(tool('read_log').handler({}, { sessionId: 's1' }), (err) => {
				assert.match(err.message, /cannot mask, so it is withheld/);
				assert.doesNotMatch(err.message, /sk-shape/);
				return true;
			});
		}
	});

	it('leaves other operations unchanged', async () => {
		assert.deepEqual(await tool('search_by_value').handler({}, { sessionId: 's1' }), {
			results: [{ id: 1, apiKey: 'sk-row' }],
		});
	});
});
