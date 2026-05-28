'use strict';

const assert = require('node:assert/strict');
const {
	createSession,
	getSession,
	listSessions,
	appendMessage,
	setStatus,
	addPendingApproval,
	resolveApproval,
	_setTableForTests,
} = require('#src/agent/session');

function makeMockTable() {
	const store = new Map();
	return {
		store,
		primaryStore: {
			async put(key, value) {
				store.set(key, structuredClone(value));
			},
			async get(key) {
				const value = store.get(key);
				return value ? structuredClone(value) : undefined;
			},
			getRange({ limit = Infinity, reverse } = {}) {
				const entries = Array.from(store.entries());
				if (reverse) entries.reverse();
				return entries.slice(0, limit).map(([key, value]) => ({ key, value: structuredClone(value) }));
			},
		},
	};
}

describe('agent/session', () => {
	let mock;

	beforeEach(() => {
		mock = makeMockTable();
		_setTableForTests(mock);
	});

	afterEach(() => {
		_setTableForTests(undefined);
	});

	it('creates a session with an initial user message', async () => {
		const session = await createSession({
			user: 'admin',
			initialMessage: { role: 'user', content: 'hello', createdAt: Date.now() },
		});
		assert.equal(session.user, 'admin');
		assert.equal(session.status, 'idle');
		assert.equal(session.messages.length, 1);
		assert.equal(session.messages[0].content, 'hello');
		assert.deepEqual(session.pendingApprovals, []);
		const reloaded = await getSession(session.session_id);
		assert.equal(reloaded.session_id, session.session_id);
	});

	it('appends messages and updates updatedAt', async () => {
		const session = await createSession({ user: 'admin' });
		const initialUpdatedAt = session.updatedAt;
		await new Promise((r) => setTimeout(r, 5));
		const updated = await appendMessage(session.session_id, {
			role: 'assistant',
			content: 'hi back',
			createdAt: Date.now(),
		});
		assert.equal(updated.messages.length, 1);
		assert.equal(updated.messages[0].role, 'assistant');
		assert.ok(updated.updatedAt >= initialUpdatedAt);
	});

	it('rejects appendMessage for an unknown session', async () => {
		await assert.rejects(
			appendMessage('nope', { role: 'user', content: 'x', createdAt: Date.now() }),
			/No agent session/
		);
	});

	it('transitions through approval lifecycle', async () => {
		const session = await createSession({ user: 'admin' });
		const approval = await addPendingApproval(session.session_id, {
			toolName: 'drop_component',
			arguments: { name: 'demo' },
			reason: 'destructive',
		});
		assert.ok(approval.id);
		assert.equal(approval.resolved, undefined);

		const afterAdd = await getSession(session.session_id);
		assert.equal(afterAdd.status, 'awaiting_approval');
		assert.equal(afterAdd.pendingApprovals.length, 1);

		const resolved = await resolveApproval(session.session_id, approval.id, true);
		assert.equal(resolved.resolved, true);
		assert.equal(resolved.approved, true);

		const afterResolve = await getSession(session.session_id);
		assert.equal(afterResolve.status, 'idle');
	});

	it('returns to idle even when an approval is denied (deny is not abort)', async () => {
		const sess = await createSession({ user: 'admin' });
		const approval = await addPendingApproval(sess.session_id, {
			toolName: 'restart',
			arguments: {},
			toolCallId: 'c1',
			reason: 'destructive',
		});
		await resolveApproval(sess.session_id, approval.id, false);
		const reloaded = await getSession(sess.session_id);
		assert.equal(reloaded.status, 'idle');
	});

	it('rejects double-resolution of an approval', async () => {
		const session = await createSession({ user: 'admin' });
		const approval = await addPendingApproval(session.session_id, {
			toolName: 'restart',
			arguments: {},
			reason: 'destructive',
		});
		await resolveApproval(session.session_id, approval.id, true);
		await assert.rejects(resolveApproval(session.session_id, approval.id, true), /already resolved/);
	});

	it('lists sessions in reverse insertion order', async () => {
		const a = await createSession({ user: 'admin' });
		const b = await createSession({ user: 'admin' });
		const sessions = await listSessions({ limit: 10 });
		const ids = sessions.map((s) => s.session_id);
		assert.ok(ids.includes(a.session_id));
		assert.ok(ids.includes(b.session_id));
		assert.equal(sessions[0].session_id, b.session_id);
	});

	it('serializes concurrent mutations on the same session (no lost updates)', async () => {
		const session = await createSession({ user: 'admin' });
		// Fire several mutations concurrently. Without per-session serialization each would read the
		// same snapshot and the last put would clobber the rest, losing messages.
		await Promise.all([
			appendMessage(session.session_id, { role: 'user', content: 'a', createdAt: Date.now() }),
			appendMessage(session.session_id, { role: 'assistant', content: 'b', createdAt: Date.now() }),
			appendMessage(session.session_id, { role: 'user', content: 'c', createdAt: Date.now() }),
		]);
		const reloaded = await getSession(session.session_id);
		assert.equal(reloaded.messages.length, 3);
		assert.deepEqual(reloaded.messages.map((m) => m.content).sort(), ['a', 'b', 'c']);
	});

	it('setStatus persists the new status and optional error', async () => {
		const session = await createSession({ user: 'admin' });
		await setStatus(session.session_id, 'error', 'boom');
		const reloaded = await getSession(session.session_id);
		assert.equal(reloaded.status, 'error');
		assert.equal(reloaded.lastError, 'boom');
	});
});
