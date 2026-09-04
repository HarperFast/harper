const assert = require('node:assert');
const {
	createSession,
	loadSession,
	saveSession,
	deleteSession,
	touchSession,
	_setSessionTableForTest,
} = require('#src/components/mcp/session');
const { makeFakeSessionTable } = require('./fakeSessionTable');

describe('mcp/session', () => {
	let fake;
	beforeEach(() => {
		fake = makeFakeSessionTable();
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
			assert.notStrictEqual(a.id, b.id);
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
			await saveSession(created.id, { initialized: true });
			const reloaded = await loadSession(created.id);
			assert.equal(reloaded.initialized, true);
		});
	});

	describe('deleteSession', () => {
		it('makes subsequent loads return null', async () => {
			const created = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
			await deleteSession(created.id);
			assert.equal(await loadSession(created.id), null);
			assert.equal(fake.store.has(created.id), false);
		});

		it('cannot be reversed by a stale save from an in-flight request', async () => {
			const created = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
			await deleteSession(created.id);
			await saveSession(created.id, { lastActivity: created.lastActivity + 1 });
			assert.equal(await loadSession(created.id), null);
		});

		it('does not create an incomplete row after deletion', async () => {
			const created = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
			await deleteSession(created.id);
			await saveSession(created.id, { lastActivity: created.lastActivity + 1 });
			assert.equal(await loadSession(created.id), null);
			assert.equal(fake.store.has(created.id), false);
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
