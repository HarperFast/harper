'use strict';

const assert = require('node:assert');
const {
	createSession,
	getSession,
	listSessions,
	AGENT_SESSION_ATTRIBUTES,
	appendMessage,
	setStatus,
	addPendingApproval,
	resolveApproval,
	_setTableForTests,
} = require('#src/agent/session');

function deepFreeze(o) {
	if (o && typeof o === 'object') {
		for (const v of Object.values(o)) deepFreeze(v);
		Object.freeze(o);
	}
	return o;
}

function makeMockTable() {
	const store = new Map();
	// Return FROZEN records like the real store, so an in-place mutation (a mutator missing the
	// requireSession clone) throws instead of silently passing, as it did in production.
	const read = (value) => (value ? deepFreeze(structuredClone(value)) : undefined);
	return {
		store,
		// Resource-level put — the versioned write path session.ts writes through. Keys by the record's PK.
		async put(record) {
			store.set(record.session_id, structuredClone(record));
		},
		search({ conditions = [], sort, limit = Infinity } = {}) {
			let rows = Array.from(store.values());
			for (const condition of conditions) {
				if (condition.comparator === 'greater_than') {
					rows = rows.filter((row) => row[condition.attribute] > condition.value);
				}
			}
			if (sort) {
				rows.sort((a, b) => ((a[sort.attribute] ?? 0) - (b[sort.attribute] ?? 0)) * (sort.descending ? -1 : 1));
			}
			return (async function* () {
				for (const row of rows.slice(0, limit)) yield read(row);
			})();
		},
		primaryStore: {
			async put(key, value) {
				store.set(key, structuredClone(value));
			},
			async get(key) {
				return read(store.get(key));
			},
			// Key-ordered, like the real primary store; insertion order would make a reverse scan
			// look time-ordered.
			getRange({ limit = Infinity, reverse } = {}) {
				const entries = Array.from(store.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
				if (reverse) entries.reverse();
				return entries.slice(0, limit).map(([key, value]) => ({ key, value: read(value) }));
			},
		},
	};
}

describe('agent/session table definition', () => {
	// listSessions sorts on `updatedAt` with no conditions, which Table.search only serves from an
	// index — without one it throws 404. The mock in the suite below sorts in memory whatever it is
	// asked to, so it cannot notice the attribute losing `indexed`; this asserts the declaration
	// the query depends on.
	it('declares updatedAt as indexed, which listSessions sorts on', () => {
		const updatedAt = AGENT_SESSION_ATTRIBUTES.find((attribute) => attribute.name === 'updatedAt');
		assert.ok(updatedAt, 'updatedAt attribute is declared');
		assert.strictEqual(updatedAt.indexed, true);
	});
});

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

	// Ids descend while activity time ascends, so a key-ordered scan and a time-ordered one cannot
	// agree by luck.
	async function seedSessionsOldestFirst(count) {
		const created = [];
		for (let i = 0; i < count; i++) {
			const session = await createSession({ user: 'admin', sessionId: `id-${count - 1 - i}` });
			// Explicit activity times: consecutive createSession calls land in the same millisecond,
			// and tied timestamps would leave these assertions resting on clock granularity.
			mock.store.get(session.session_id).updatedAt = 1000 + i;
			created.push(session.session_id);
		}
		return created;
	}

	it('lists sessions most-recently-updated first, not in primary-key order', async () => {
		const oldestFirst = await seedSessionsOldestFirst(4);
		const sessions = await listSessions({ limit: 10 });
		assert.deepStrictEqual(
			sessions.map((s) => s.session_id),
			[...oldestFirst].reverse()
		);
	});

	it('limit keeps the most recent sessions rather than an arbitrary subset', async () => {
		const oldestFirst = await seedSessionsOldestFirst(5);
		const sessions = await listSessions({ limit: 2 });
		assert.deepStrictEqual(
			sessions.map((s) => s.session_id),
			[oldestFirst[4], oldestFirst[3]]
		);
	});

	it('reflects later activity in the order, so a revived old session sorts first', async () => {
		const oldestFirst = await seedSessionsOldestFirst(3);
		await appendMessage(oldestFirst[1], { role: 'user', content: 'revived', createdAt: Date.now() });
		const sessions = await listSessions({ limit: 10 });
		assert.strictEqual(sessions[0].session_id, oldestFirst[1]);
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
