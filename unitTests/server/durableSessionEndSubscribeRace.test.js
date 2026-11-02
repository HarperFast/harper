const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { getSession } = require('#src/server/DurableSubscriptionsSession');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const sessions = () => databases.system.hdb_durable_session;
const savedTopics = async (clientId) =>
	(await sessions().get(clientId)).subscriptions.map((entry) => entry.topic).sort();

describe('DurableSubscriptionsSession SUBSCRIBE/UNSUBSCRIBE racing with session end under in-flight saves', () => {
	let sequence = 0;
	let unhandled;
	const onUnhandled = (reason) => unhandled.push(reason);

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
		process.on('unhandledRejection', onUnhandled);
	});
	after(() => process.off('unhandledRejection', onUnhandled));
	beforeEach(() => (unhandled = []));

	async function withSession(run, { hold = true } = {}) {
		const name = `SessionEndRace${++sequence}`;
		const T = table({
			database: `session_end_race_${name}`,
			table: name,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		Resources.resources.set(name, T, { mqtt: true });
		const clientId = `session-end-race-${name}`;
		const session = await getSession({
			clientId,
			clean: false,
			user: { username: 'session-end-race-test', role: { permission: { super_user: true } } },
		});
		session.setListener(() => true);
		const first = `${name}/first`;
		const second = `${name}/second`;
		const put = sessions().put;
		const writes = [];
		try {
			await session.addSubscription({ topic: first, qos: 1, rh: 2 }, true);
			await session.writes;
			if (hold)
				sessions().put = function (record, options) {
					if (record.id !== clientId) return put.call(this, record, options);
					return new Promise((resolve, reject) => {
						let released = false;
						writes.push({
							record,
							fail: (error) => reject(error),
							release() {
								if (released) return;
								released = true;
								put.call(sessions(), record, options).then(resolve, reject);
							},
						});
					});
				};
			await run({ session, clientId, first, second, writes, T });
		} finally {
			sessions().put = put;
			for (const write of writes) write.release();
			session.disconnect(true);
			await session.writes;
			Resources.resources.delete(name);
			await sessions().delete(clientId);
		}
	}

	async function startHeldSave(session, writes) {
		const count = writes.length;
		session.dirty = true;
		session.persist();
		await waitFor(() => writes.length === count + 1);
	}

	it('SUBSCRIBE on a live session with an in-flight save settles on the next save and persists accurately', async () => {
		await withSession(async ({ session, clientId, first, second, writes }) => {
			await startHeldSave(session, writes);
			const subscribing = session.addSubscription({ topic: second, qos: 1, rh: 2 }, true);
			await waitFor(() => session.dirty);
			writes[0].release();
			await waitFor(() => writes.length === 2);
			writes[1].release();
			await subscribing;
			await session.writes;
			assert.deepStrictEqual(await savedTopics(clientId), [first, second].sort());
			assert.deepStrictEqual(unhandled, []);
		});
	});

	it('re-SUBSCRIBE on an existing durable topic that races with disconnect() while a save is in flight does not delete the pre-existing subscription from hdb_durable_session', async () => {
		await withSession(async ({ session, clientId, first, writes }) => {
			assert.deepStrictEqual(await savedTopics(clientId), [first]);
			await startHeldSave(session, writes);
			// Another checkpoint dirtied the session while save #1 is in flight, so disconnect() schedules a final save #2.
			session.dirty = true;

			const resubscribing = session.addSubscription({ topic: first, qos: 2, rh: 2 }, true);
			session.disconnect(true);

			await assert.rejects(resubscribing, { name: 'SessionEndedError', statusCode: 409 });

			writes[0].release();
			await waitFor(() => writes.length === 2);
			writes[1].release();
			await session.writes;

			assert.deepStrictEqual(
				await savedTopics(clientId),
				[first],
				'pre-existing durable subscription must remain persisted when a late re-SUBSCRIBE is refused by session end'
			);
			assert.deepStrictEqual(unhandled, []);
		});

		await withSession(async ({ session, clientId, first, writes, T }) => {
			assert.deepStrictEqual(await savedTopics(clientId), [first]);
			await startHeldSave(session, writes);
			session.dirty = true;

			const subscribe = T.subscribe;
			T.subscribe = function (...args) {
				T.subscribe = subscribe;
				session.disconnect(true);
				return subscribe.apply(this, args);
			};

			const resubscribing = session.addSubscription({ topic: first, qos: 2, rh: 2 }, true);
			await assert.rejects(resubscribing, { name: 'SessionEndedError', statusCode: 409 });

			writes[0].release();
			await waitFor(() => writes.length === 2);
			writes[1].release();
			await session.writes;

			assert.deepStrictEqual(
				await savedTopics(clientId),
				[first],
				'pre-existing durable subscription must remain persisted when a mid-flight re-SUBSCRIBE is refused by session end'
			);
			assert.deepStrictEqual(unhandled, []);
		});

		await withSession(async ({ session, clientId, first, writes }) => {
			assert.deepStrictEqual(await savedTopics(clientId), [first]);
			await startHeldSave(session, writes);
			session.dirty = true;

			let ended = 0;
			const subscribed = session.subscribed.bind(session);
			session.subscribed = function (sub) {
				const end = sub.end.bind(sub);
				sub.end = () => {
					ended++;
					return end();
				};
				subscribed(sub);
				session.disconnect(true);
			};

			const resubscribing = session.addSubscription({ topic: first, qos: 2, rh: 2 }, true);
			await assert.rejects(resubscribing, { name: 'SessionEndedError', statusCode: 409 });

			writes[0].release();
			await waitFor(() => writes.length === 2);
			writes[1].release();
			await session.writes;

			assert.ok(ended > 0, 'started subscription must be ended when the session disconnects during subscribe');
			assert.strictEqual(session.subscriptions.length, 0);
			assert.deepStrictEqual(await savedTopics(clientId), [first]);
			assert.deepStrictEqual(unhandled, []);
		});
	});

	it('UNSUBSCRIBE reaching a session already ended by disconnect() while a save is in flight does not delete the subscription from hdb_durable_session when it rejects with SessionEndedError', async () => {
		await withSession(async ({ session, clientId, first, writes }) => {
			assert.deepStrictEqual(await savedTopics(clientId), [first]);
			await startHeldSave(session, writes);
			// Another checkpoint dirtied the session while save #1 is in flight, so disconnect() schedules a final save #2.
			session.dirty = true;

			session.disconnect(true);
			const unsubscribing = session.removeSubscription(first);

			await assert.rejects(unsubscribing, { name: 'SessionEndedError', statusCode: 409 });

			writes[0].release();
			await waitFor(() => writes.length === 2);
			writes[1].release();
			await session.writes;

			assert.deepStrictEqual(
				await savedTopics(clientId),
				[first],
				'durable subscription must remain persisted when UNSUBSCRIBE is refused with SessionEndedError'
			);
			assert.deepStrictEqual(unhandled, []);
		});
	});
});
