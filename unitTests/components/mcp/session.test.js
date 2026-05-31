const assert = require('node:assert/strict');
const {
	createSession,
	loadSession,
	saveSession,
	deleteSession,
	touchSession,
	_setSessionTableForTest,
} = require('#src/components/mcp/session');

function makeFakeTable() {
	const store = new Map();
	return {
		store,
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

describe('mcp/session', () => {
	let fake;
	beforeEach(() => {
		fake = makeFakeTable();
		_setSessionTableForTest(fake);
	});
	afterEach(() => {
		_setSessionTableForTest(undefined);
	});

	describe('createSession', () => {
		it('generates a UUID id, persists, and returns the record', async () => {
			const record = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
			assert.match(record.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			assert.equal(record.user, 'alice');
			assert.equal(record.protocolVersion, '2025-06-18');
			assert.equal(record.initialized, false);
			assert.equal(typeof record.createdAt, 'number');
			assert.equal(record.lastActivity, record.createdAt);
			assert.deepEqual(fake.store.get(record.id), record);
		});

		it('generates distinct ids', async () => {
			const a = await createSession({ user: 'u', protocolVersion: '2025-06-18' });
			const b = await createSession({ user: 'u', protocolVersion: '2025-06-18' });
			assert.notEqual(a.id, b.id);
		});
	});

	describe('loadSession', () => {
		it('returns the record when present', async () => {
			const created = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
			const loaded = await loadSession(created.id);
			assert.deepEqual(loaded, created);
		});

		it('returns null when the id is unknown', async () => {
			const loaded = await loadSession('not-a-session');
			assert.equal(loaded, null);
		});
	});

	describe('saveSession', () => {
		it('persists changes', async () => {
			const created = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
			await saveSession({ ...created, initialized: true });
			const reloaded = await loadSession(created.id);
			assert.equal(reloaded.initialized, true);
		});
	});

	describe('deleteSession', () => {
		it('removes the record and subsequent loads return null', async () => {
			const created = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
			await deleteSession(created.id);
			assert.equal(await loadSession(created.id), null);
		});
	});

	describe('touchSession', () => {
		it('updates lastActivity and returns the new record', async () => {
			const created = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
			// Force a measurable delta even on fast clocks.
			await new Promise((r) => setTimeout(r, 5));
			const touched = await touchSession(created);
			assert.ok(touched.lastActivity > created.lastActivity);
			const reloaded = await loadSession(created.id);
			assert.equal(reloaded.lastActivity, touched.lastActivity);
		});

		it('preserves other fields', async () => {
			const created = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
			const initialized = { ...created, initialized: true };
			const touched = await touchSession(initialized);
			assert.equal(touched.initialized, true);
			assert.equal(touched.user, 'alice');
			assert.equal(touched.protocolVersion, '2025-06-18');
		});
	});
});
