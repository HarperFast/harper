const assert = require('node:assert/strict');
const {
	PROTOCOL_VERSION_PREFERRED,
	PROTOCOL_VERSION_BACKCOMPAT,
	SUPPORTED_PROTOCOL_VERSIONS,
	SERVER_INFO,
	SERVER_CAPABILITIES,
	handleInitialize,
	handleInitialized,
} = require('#src/components/mcp/lifecycle');
const { _setSessionTableForTest, loadSession } = require('#src/components/mcp/session');

function makeFakeTable() {
	const store = new Map();
	return {
		async put(record) {
			store.set(record.id, { ...record });
		},
		async get(id) {
			const r = store.get(id);
			return r ? { ...r } : undefined;
		},
		async delete(id) {
			store.delete(id);
		},
	};
}

describe('mcp/lifecycle', () => {
	beforeEach(() => _setSessionTableForTest(makeFakeTable()));
	afterEach(() => _setSessionTableForTest(undefined));

	describe('exported constants', () => {
		it('lists the supported protocol versions', () => {
			assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], [PROTOCOL_VERSION_PREFERRED, PROTOCOL_VERSION_BACKCOMPAT]);
		});

		it('advertises tools.listChanged, resources.listChanged, prompts.listChanged, logging capabilities', () => {
			assert.equal(SERVER_CAPABILITIES.tools.listChanged, true);
			assert.equal(SERVER_CAPABILITIES.resources.listChanged, true);
			assert.equal(SERVER_CAPABILITIES.resources.subscribe, true);
			assert.equal(SERVER_CAPABILITIES.prompts.listChanged, true);
			assert.deepEqual(SERVER_CAPABILITIES.completions, {});
			assert.deepEqual(SERVER_CAPABILITIES.logging, {});
		});

		it('exposes server info with name "harper-mcp" and a version string', () => {
			assert.equal(SERVER_INFO.name, 'harper-mcp');
			assert.equal(typeof SERVER_INFO.version, 'string');
			assert.ok(SERVER_INFO.version.length > 0);
		});
	});

	describe('handleInitialize', () => {
		it('accepts the preferred protocol version and creates a session', async () => {
			const outcome = await handleInitialize({ protocolVersion: '2025-06-18' }, 'alice');
			assert.equal(outcome.ok, true);
			assert.equal(outcome.session.user, 'alice');
			assert.equal(outcome.session.protocolVersion, '2025-06-18');
			assert.equal(outcome.session.initialized, false);
			assert.equal(outcome.result.protocolVersion, '2025-06-18');
			assert.deepEqual(outcome.result.capabilities, SERVER_CAPABILITIES);
		});

		it('accepts the backcompat protocol version', async () => {
			const outcome = await handleInitialize({ protocolVersion: '2025-03-26' }, 'bob');
			assert.equal(outcome.ok, true);
			assert.equal(outcome.session.protocolVersion, '2025-03-26');
			assert.equal(outcome.result.protocolVersion, '2025-03-26');
		});

		it('negotiates an unsupported version down to the preferred one (spec: server MUST respond with a supported version)', async () => {
			const outcome = await handleInitialize({ protocolVersion: '2024-01-01' }, 'alice');
			// Spec quote: "If the server does not support the requested version,
			// the server MUST respond with a value it does support" — so we
			// downgrade to the preferred version rather than failing the call.
			assert.equal(outcome.ok, true);
			assert.equal(outcome.result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
			assert.equal(outcome.session.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
		});

		it('also negotiates down for a newer-than-supported version (e.g. 2025-11-25 from SDK 1.29)', async () => {
			const outcome = await handleInitialize({ protocolVersion: '2025-11-25' }, 'alice');
			assert.equal(outcome.ok, true);
			assert.equal(outcome.result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
		});

		it('rejects missing protocolVersion', async () => {
			const outcome = await handleInitialize({}, 'alice');
			assert.equal(outcome.ok, false);
		});

		it('rejects a non-string protocolVersion', async () => {
			const outcome = await handleInitialize({ protocolVersion: 1 }, 'alice');
			assert.equal(outcome.ok, false);
		});
	});

	describe('handleInitialized', () => {
		it('flips initialized to true and persists', async () => {
			const init = await handleInitialize({ protocolVersion: '2025-06-18' }, 'alice');
			assert.equal(init.session.initialized, false);
			const updated = await handleInitialized(init.session);
			assert.equal(updated.initialized, true);
			const reloaded = await loadSession(init.session.id);
			assert.equal(reloaded.initialized, true);
		});

		it('is idempotent — calling on already-initialized session returns it unchanged', async () => {
			const init = await handleInitialize({ protocolVersion: '2025-06-18' }, 'alice');
			const first = await handleInitialized(init.session);
			const second = await handleInitialized(first);
			assert.equal(second.initialized, true);
		});
	});
});
