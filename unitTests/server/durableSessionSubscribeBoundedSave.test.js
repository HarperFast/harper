const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { getSession } = require('#src/server/DurableSubscriptionsSession');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

// Every PUBACK checkpoint dirties the session, so a stream of acknowledgements keeps the save loop running. A reply
// that means "my change is saved" waits for the first save that read the session after the change, and for no later one.

// the save in flight when the request arrives, and the one that reads the session after it
const SAVES_ALLOWED = 2;
// only a bound on the test: the saves that re-dirty the session before it is left to settle
const DIRTYING_SAVES = 200;

const sessions = () => databases.system.hdb_durable_session;
const savedTopics = async (clientId) =>
	(await sessions().get(clientId)).subscriptions.map((entry) => entry.topic).sort();

describe('DurableSubscriptionsSession replies while acknowledgements keep the session saving', () => {
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
		const name = `BoundedSave${++sequence}`;
		const T = table({
			database: `bounded_save_${name}`,
			table: name,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		Resources.resources.set(name, T, { mqtt: true });
		const clientId = `bounded-save-${name}`;
		const session = await getSession({
			clientId,
			clean: false,
			user: { username: 'bounded-save-test', role: { permission: { super_user: true } } },
		});
		session.setListener(() => true);
		const first = `${name}/first`;
		const second = `${name}/second`;
		const put = sessions().put;
		const writes = [];
		try {
			await session.addSubscription({ topic: first, qos: 1, rh: 2 }, true);
			await session.writes;
			/** Holds this session's writes after their record is built, so a test decides when each one lands. */
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
			await run({ session, clientId, first, second, writes });
		} finally {
			sessions().put = put;
			for (const write of writes) write.release();
			session.disconnect(true);
			await session.writes;
			Resources.resources.delete(name);
			await sessions().delete(clientId);
		}
	}

	/** Starts a save and waits until its record is built and its write is held. */
	async function startHeldSave(session, writes) {
		const count = writes.length;
		session.dirty = true;
		session.persist();
		await waitFor(() => writes.length === count + 1);
	}

	const changes = [
		{
			name: 'SUBSCRIBE at QoS 1',
			start: (session, { second }) => session.addSubscription({ topic: second, qos: 1, rh: 2 }, true),
			topics: ({ first, second }) => [first, second].sort(),
		},
		{
			name: 'SUBSCRIBE at QoS 0',
			start: (session, { second }) => session.addSubscription({ topic: second, qos: 0, rh: 2 }, false),
			topics: ({ first, second }) => [first, second].sort(),
		},
		{
			name: 'UNSUBSCRIBE',
			start: (session, { first }) => session.removeSubscription(first),
			topics: () => [],
		},
	];

	for (const change of changes) {
		it(`${change.name} is acknowledged by the first save that includes it, not by an older one or a later one`, async () => {
			await withSession(async (context) => {
				const { session, clientId, writes } = context;
				await startHeldSave(session, writes);
				let acknowledged = false;
				change.start(session, context).then(() => (acknowledged = true));
				// the request has asked for its save: it dirties the session while the older write is held
				await waitFor(() => session.dirty);
				writes[0].release();
				await waitFor(() => writes.length === 2);
				assert.strictEqual(acknowledged, false, 'the save that began before the request does not acknowledge it');
				assert.deepStrictEqual(
					writes[1].record.subscriptions.map((entry) => entry.topic).sort(),
					change.topics(context),
					'the next save holds the change'
				);
				// the session is dirtied again while that save is written, as an acknowledgement stream does
				session.dirty = true;
				writes[1].release();
				await waitFor(() => acknowledged, { message: 'the request waits for the stream, not for its own save' });
				await waitFor(() => writes.length === 3);
				assert.ok(session.saving, 'the loop is still saving when the request is acknowledged');
				assert.deepStrictEqual(await savedTopics(clientId), change.topics(context));
			});
		});

		it(`${change.name} is answered within ${SAVES_ALLOWED} saves while every save dirties the session`, async () => {
			await withSession(
				async (context) => {
					const { session, clientId } = context;
					const saveOnce = session.saveOnce;
					let dirtied = 0;
					session.saveOnce = function () {
						if (dirtied++ < DIRTYING_SAVES) this.dirty = true;
						return saveOnce.call(this);
					};
					const before = session.savesStarted;
					await change.start(session, context);
					const saves = session.savesStarted - before;
					assert.ok(saves <= SAVES_ALLOWED, `waited for ${saves} saves`);
					assert.deepStrictEqual(await savedTopics(clientId), change.topics(context));
					dirtied = DIRTYING_SAVES;
				},
				{ hold: false }
			);
		});
	}

	it('rejects a SUBSCRIBE whose awaited save was an older write that failed, and leaves nothing unhandled', async () => {
		await withSession(async (context) => {
			const { session, second, writes } = context;
			await startHeldSave(session, writes);
			const requested = session.addSubscription({ topic: second, qos: 1, rh: 2 }, true);
			await waitFor(() => session.dirty);
			writes[0].fail(new Error('system table unavailable'));
			await assert.rejects(requested, /unavailable/);
			assert.strictEqual(session.topics.has(second), false, 'the refused subscription is rolled back');
			assert.strictEqual(session.saveWaiters.length, 0);
			await new Promise(setImmediate);
			assert.deepStrictEqual(unhandled, []);
		});
	});
});
