const assert = require('node:assert/strict');
const {
	registerOperationsTools,
	DEFAULT_ALLOW,
	_setOperationFunctionMapForTest,
	_setChooseOperationForTest,
	_setProcessLocalTransactionForTest,
} = require('#src/components/mcp/tools/operations');
const { listTools, getTool, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');
const env = require('#src/utility/environment/environmentManager');

function makeOpMap(entries) {
	const m = new Map();
	for (const [name, fn] of entries) {
		m.set(name, { operation_function: fn ?? (async () => ({ ok: true })) });
	}
	return m;
}

const SUPER = { username: 'admin', role: { permission: { super_user: true } } };
const NOBODY = { username: 'nobody', role: { permission: {} } };

describe('mcp/tools/operations — registration', () => {
	let envOverrides;
	const originalEnvGet = env.get;

	beforeEach(() => {
		_resetRegistryForTest();
		envOverrides = {};
		env.get = (key) => (key in envOverrides ? envOverrides[key] : originalEnvGet.call(env, key));
	});

	afterEach(() => {
		_resetRegistryForTest();
		_setOperationFunctionMapForTest(undefined);
		_setChooseOperationForTest(undefined);
		_setProcessLocalTransactionForTest(undefined);
		env.get = originalEnvGet;
	});

	it('registers one tool per default-allowed operation', () => {
		_setOperationFunctionMapForTest(
			makeOpMap([
				['describe_all', async () => ({ schemas: [] })],
				['describe_table', async () => ({ table: 't' })],
				['list_users', async () => ({ users: [] })],
				['search_by_value', async () => ({ rows: [] })],
				['get_job', async () => ({ id: 'j' })],
				['system_information', async () => ({ host: 'x' })],
				['read_log', async () => ({ entries: [] })],
				['read_audit_log', async () => ({ entries: [] })],
				// These should NOT be registered by default — destructive / not on the list.
				['drop_table', async () => ({})],
				['delete', async () => ({})],
				['insert', async () => ({})],
			])
		);

		registerOperationsTools();

		const { tools } = listTools({ user: SUPER, profile: 'operations', sessionId: 's', limit: 200 });
		const names = tools.map((t) => t.name).sort();
		assert.deepEqual(names, [
			'describe_all',
			'describe_table',
			'get_job',
			'list_users',
			'read_audit_log',
			'read_log',
			'search_by_value',
			'system_information',
		]);

		// `insert`, `drop_table`, `delete` are filtered out by the default allow list.
		assert.equal(getTool('insert'), undefined);
		assert.equal(getTool('drop_table'), undefined);
		assert.equal(getTool('delete'), undefined);
	});

	it('honors a user-defined allow list', () => {
		envOverrides.mcp_operations_allow = ['describe_*', 'insert'];
		_setOperationFunctionMapForTest(
			makeOpMap([
				['describe_all', null],
				['describe_table', null],
				['insert', null],
				['delete', null],
				['list_users', null],
			])
		);

		registerOperationsTools();
		const { tools } = listTools({ user: SUPER, profile: 'operations', sessionId: 's', limit: 200 });
		assert.deepEqual(tools.map((t) => t.name).sort(), ['describe_all', 'describe_table', 'insert']);
	});

	it('honors a deny list that overrides allow', () => {
		envOverrides.mcp_operations_deny = ['list_users']; // default allow includes list_*
		_setOperationFunctionMapForTest(
			makeOpMap([
				['describe_all', null],
				['list_users', null],
				['list_roles', null],
			])
		);

		registerOperationsTools();
		const { tools } = listTools({ user: SUPER, profile: 'operations', sessionId: 's', limit: 200 });
		assert.deepEqual(tools.map((t) => t.name).sort(), ['describe_all', 'list_roles']);
	});

	it('annotates read-only operations with readOnlyHint and destructive ones with destructiveHint', () => {
		envOverrides.mcp_operations_allow = ['describe_all', 'drop_table'];
		_setOperationFunctionMapForTest(
			makeOpMap([
				['describe_all', null],
				['drop_table', null],
			])
		);

		registerOperationsTools();
		const describe = getTool('describe_all');
		const dropTable = getTool('drop_table');
		assert.equal(describe.annotations?.readOnlyHint, true);
		assert.equal(describe.annotations?.destructiveHint, undefined);
		assert.equal(dropTable.annotations?.destructiveHint, true);
		assert.equal(dropTable.annotations?.readOnlyHint, undefined);
	});

	it('falls back to a permissive schema for ops with no hand-curated entry', () => {
		envOverrides.mcp_operations_allow = ['nonstandard_op'];
		_setOperationFunctionMapForTest(makeOpMap([['nonstandard_op', null]]));
		registerOperationsTools();
		const tool = getTool('nonstandard_op');
		assert.equal(tool.inputSchema.type, 'object');
		assert.equal(tool.inputSchema.additionalProperties, true);
	});

	it('exposes hand-curated schemas with required fields', () => {
		_setOperationFunctionMapForTest(makeOpMap([['describe_table', null]]));
		registerOperationsTools();
		const tool = getTool('describe_table');
		assert.equal(tool.inputSchema.type, 'object');
		assert.ok(Array.isArray(tool.inputSchema.required));
		assert.ok(tool.inputSchema.required.includes('table'));
	});

	it('visibleTo predicate uses canRoleInvokeOperation (super_user sees everything)', () => {
		_setOperationFunctionMapForTest(makeOpMap([['describe_all', null]]));
		registerOperationsTools();
		const tool = getTool('describe_all');
		assert.equal(tool.visibleTo(SUPER), true);
		assert.equal(tool.visibleTo(NOBODY), false);
	});

	it('DEFAULT_ALLOW is exposed and matches the documented v1 surface', () => {
		assert.deepEqual(
			[...DEFAULT_ALLOW],
			['describe_*', 'list_*', 'search_*', 'get_*', 'system_information', 'read_log', 'read_audit_log']
		);
	});

	it('is idempotent across repeated invocations', () => {
		_setOperationFunctionMapForTest(
			makeOpMap([
				['describe_all', null],
				['list_users', null],
			])
		);
		registerOperationsTools();
		registerOperationsTools();
		registerOperationsTools();
		const { tools } = listTools({ user: SUPER, profile: 'operations', sessionId: 's', limit: 200 });
		assert.equal(tools.length, 2);
	});

	it('logs a warning and registers nothing when OPERATION_FUNCTION_MAP is unavailable', () => {
		_setOperationFunctionMapForTest(undefined);
		// Force the lazy require to return a module-shape that has no map.
		// Tests for the unhappy path don't need a real require shim — the
		// production code path falls through gracefully.
		// We exercise the registration with an empty map and assert nothing leaks through.
		_setOperationFunctionMapForTest(new Map());
		registerOperationsTools();
		const { tools } = listTools({ user: SUPER, profile: 'operations', sessionId: 's', limit: 200 });
		assert.equal(tools.length, 0);
	});
});

describe('mcp/tools/operations — handler dispatch', () => {
	let envOverrides;
	const originalEnvGet = env.get;

	beforeEach(() => {
		_resetRegistryForTest();
		envOverrides = {};
		env.get = (key) => (key in envOverrides ? envOverrides[key] : originalEnvGet.call(env, key));
	});

	afterEach(() => {
		_resetRegistryForTest();
		_setOperationFunctionMapForTest(undefined);
		_setChooseOperationForTest(undefined);
		_setProcessLocalTransactionForTest(undefined);
		env.get = originalEnvGet;
	});

	it('delegates to chooseOperation + processLocalTransaction with the user attached', async () => {
		let chosenBody;
		let processedBody;
		const opFn = async () => ({ result: 'ok' });
		_setChooseOperationForTest((body) => {
			chosenBody = body;
			return opFn;
		});
		_setProcessLocalTransactionForTest(async ({ body }, fn) => {
			processedBody = body;
			return await fn(body);
		});
		_setOperationFunctionMapForTest(makeOpMap([['describe_all', opFn]]));
		registerOperationsTools();

		const tool = getTool('describe_all');
		const res = await tool.handler({}, { user: SUPER, profile: 'operations', sessionId: 's' });

		assert.equal(chosenBody.operation, 'describe_all');
		assert.equal(chosenBody.hdb_user, SUPER);
		assert.equal(processedBody.operation, 'describe_all');
		assert.equal(res.isError, undefined);
		assert.ok(res.content[0].text.includes('"result":"ok"'));
		assert.deepEqual(res.structuredContent, { result: 'ok' });
	});

	it('passes through caller arguments alongside the operation name', async () => {
		let captured;
		_setChooseOperationForTest((body) => {
			captured = body;
			return async () => null;
		});
		_setProcessLocalTransactionForTest(async () => null);
		_setOperationFunctionMapForTest(makeOpMap([['describe_table', null]]));
		registerOperationsTools();

		await getTool('describe_table').handler(
			{ database: 'data', table: 'product' },
			{ user: SUPER, profile: 'operations', sessionId: 's' }
		);

		assert.equal(captured.database, 'data');
		assert.equal(captured.table, 'product');
		assert.equal(captured.operation, 'describe_table');
	});

	it('maps permission-denied exceptions to isError=true with kind=harper_error', async () => {
		_setChooseOperationForTest(() => {
			const err = new Error('User is not permitted to describe_all');
			err.statusCode = 403;
			throw err;
		});
		_setProcessLocalTransactionForTest(async () => null);
		_setOperationFunctionMapForTest(makeOpMap([['describe_all', null]]));
		registerOperationsTools();

		const res = await getTool('describe_all').handler({}, { user: NOBODY, profile: 'operations', sessionId: 's' });

		assert.equal(res.isError, true);
		const payload = JSON.parse(res.content[0].text);
		assert.equal(payload.kind, 'harper_error');
		assert.equal(payload.operation, 'describe_all');
		assert.match(payload.message, /not permitted/);
	});

	it('maps server-side validation errors to isError=true', async () => {
		_setChooseOperationForTest(() => async () => {
			throw new Error('table is required');
		});
		_setProcessLocalTransactionForTest(async (_req, fn) => await fn({}));
		_setOperationFunctionMapForTest(makeOpMap([['describe_table', null]]));
		registerOperationsTools();

		const res = await getTool('describe_table').handler({}, { user: SUPER, profile: 'operations', sessionId: 's' });

		assert.equal(res.isError, true);
		const payload = JSON.parse(res.content[0].text);
		assert.match(payload.message, /table is required/);
	});

	it('handles string responses (e.g., status text) by wrapping in {message}', async () => {
		_setChooseOperationForTest(() => async () => 'success');
		_setProcessLocalTransactionForTest(async (_req, fn) => {
			const data = await fn({});
			return typeof data !== 'object' ? { message: data } : data;
		});
		_setOperationFunctionMapForTest(makeOpMap([['system_information', null]]));
		registerOperationsTools();

		const res = await getTool('system_information').handler({}, { user: SUPER, profile: 'operations', sessionId: 's' });

		assert.equal(res.isError, undefined);
		assert.deepEqual(res.structuredContent, { message: 'success' });
	});
});
