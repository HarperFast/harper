const assert = require('node:assert/strict');
const {
	initListChanged,
	seedSessionSnapshot,
	_setItcHandlersForTest,
	_resetListChangedForTest,
} = require('#src/components/mcp/listChanged');
const { registerSession, _resetSessionRegistryForTest } = require('#src/components/mcp/sessionRegistry');
const { addTool, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');

const SUPER = { username: 'admin', role: { permission: { super_user: true } } };
const ALICE = {
	username: 'alice',
	role: { permission: { data: { tables: { product: { read: true, describe: true } } } } },
};

function makeFakeItcHandlers() {
	const userListeners = [];
	const schemaListeners = [];
	return {
		userHandler: { addListener: (fn) => userListeners.push(fn) },
		schemaHandler: { addListener: (fn) => schemaListeners.push(fn) },
		_fireUser: () => {
			for (const fn of userListeners) fn();
		},
		_fireSchema: () => {
			for (const fn of schemaListeners) fn();
		},
	};
}

async function readNextEvent(queue, timeoutMs = 100) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('timed out waiting for SSE event')), timeoutMs);
		const iter = queue[Symbol.asyncIterator]();
		Promise.resolve(iter.next()).then(({ value }) => {
			clearTimeout(t);
			resolve(value);
		}, reject);
	});
}

describe('mcp/listChanged', () => {
	let fakeItc;

	beforeEach(() => {
		_resetSessionRegistryForTest();
		_resetRegistryForTest();
		_resetListChangedForTest();
		fakeItc = makeFakeItcHandlers();
		_setItcHandlersForTest(fakeItc);
	});

	afterEach(() => {
		_resetSessionRegistryForTest();
		_resetRegistryForTest();
		_resetListChangedForTest();
		_setItcHandlersForTest(undefined);
	});

	it('subscribes to both userHandler and schemaHandler on init', () => {
		assert.equal(initListChanged(), true);
		// Second init is a no-op.
		assert.equal(initListChanged(), true);
	});

	it('emits notifications/tools/list_changed when the tool surface changes', async () => {
		initListChanged();
		const rec = registerSession('sid', 'operations', SUPER);
		seedSessionSnapshot('sid');
		assert.deepEqual(rec.lastTools, []);

		// Register a tool — this changes what the session would see.
		addTool({
			name: 'new_tool',
			description: 'x',
			inputSchema: { type: 'object' },
			profile: 'operations',
			visibleTo: () => true,
			handler: async () => ({ content: [{ type: 'text', text: '' }] }),
		});

		fakeItc._fireUser();
		const evt = await readNextEvent(rec.queue);
		assert.equal(evt.event, 'message');
		assert.equal(evt.data.method, 'notifications/tools/list_changed');
	});

	it('suppresses notifications when the visible set is unchanged', async () => {
		initListChanged();
		addTool({
			name: 'stable_tool',
			description: 'x',
			inputSchema: { type: 'object' },
			profile: 'operations',
			visibleTo: () => true,
			handler: async () => ({ content: [{ type: 'text', text: '' }] }),
		});
		const rec = registerSession('sid', 'operations', SUPER);
		seedSessionSnapshot('sid');
		assert.deepEqual(rec.lastTools, [{ name: 'stable_tool' }]);

		fakeItc._fireUser();
		// No mutation between fires — no event should arrive.
		await assert.rejects(readNextEvent(rec.queue, 50), /timed out/);
	});

	it('does not notify users whose visible set is unaffected', async () => {
		initListChanged();
		// A tool only super_user can see.
		addTool({
			name: 'admin_only',
			description: 'x',
			inputSchema: { type: 'object' },
			profile: 'operations',
			visibleTo: (u) => u?.role?.permission?.super_user === true,
			handler: async () => ({ content: [{ type: 'text', text: '' }] }),
		});
		const superRec = registerSession('s-super', 'operations', SUPER);
		const aliceRec = registerSession('s-alice', 'operations', ALICE);
		seedSessionSnapshot('s-super');
		seedSessionSnapshot('s-alice');

		// Add another admin_only tool — super sees a diff, alice does not.
		addTool({
			name: 'admin_only_two',
			description: 'x',
			inputSchema: { type: 'object' },
			profile: 'operations',
			visibleTo: (u) => u?.role?.permission?.super_user === true,
			handler: async () => ({ content: [{ type: 'text', text: '' }] }),
		});
		fakeItc._fireUser();

		const superEvt = await readNextEvent(superRec.queue);
		assert.equal(superEvt.data.method, 'notifications/tools/list_changed');
		await assert.rejects(readNextEvent(aliceRec.queue, 50), /timed out/);
	});

	it('init returns false when ITC handlers are unavailable', () => {
		_setItcHandlersForTest({}); // empty — no addListener methods
		assert.equal(initListChanged(), false);
	});

	it('schema events also fan out (application profile)', async () => {
		initListChanged();
		addTool({
			name: 'get_thing',
			description: 'x',
			inputSchema: { type: 'object' },
			profile: 'application',
			visibleTo: () => true,
			handler: async () => ({ content: [{ type: 'text', text: '' }] }),
		});
		const rec = registerSession('app-sid', 'application', SUPER);
		seedSessionSnapshot('app-sid');

		// Register a new tool — simulates the result of a schema change.
		addTool({
			name: 'search_thing',
			description: 'x',
			inputSchema: { type: 'object' },
			profile: 'application',
			visibleTo: () => true,
			handler: async () => ({ content: [{ type: 'text', text: '' }] }),
		});
		fakeItc._fireSchema();
		const evt = await readNextEvent(rec.queue);
		assert.equal(evt.data.method, 'notifications/tools/list_changed');
	});
});
