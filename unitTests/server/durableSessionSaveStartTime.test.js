const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { transaction } = require('#src/resources/transaction');
const { getSession } = require('#src/server/DurableSubscriptionsSession');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

describe('DurableSubscriptionsSession.saveSubscriptions', () => {
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
	});

	it('keeps QoS 0 live delivery open across a session save', async () => {
		const T = table({
			database: 'session_save_start_time',
			table: 'SaveStartTime',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		Resources.resources.set('SaveStartTime', T, { mqtt: true });
		const session = await getSession({
			clientId: 'save-start-time',
			clean: false,
			user: { username: 'save-start-time-test', role: { permission: { super_user: true } } },
		});
		const received = [];
		session.setListener((topic, message) => {
			received.push({ topic, message });
			return true;
		});
		let release;
		let late;
		try {
			await session.addSubscription({ topic: 'SaveStartTime/qos0', qos: 0, rh: 2 }, false);
			await session.addSubscription({ topic: 'SaveStartTime/qos1', qos: 1, rh: 2 }, true);
			const gates = session.subscriptions.map((subscription) => subscription.startTime);
			const held = new Promise((resolve) => (release = resolve));
			let entered = false;
			late = transaction({}, async (context) => {
				await T.put('qos0', { value: 'late' }, context);
				entered = true;
				await held;
			});
			await waitFor(() => entered);
			await session.saveSubscriptions();
			const saved = (await databases.system.hdb_durable_session.get('save-start-time')).subscriptions;
			assert.strictEqual(saved.find((entry) => entry.qos === 0).startTime, undefined);
			assert.ok(saved.find((entry) => entry.qos === 1).startTime > 0);
			assert.deepStrictEqual(
				session.subscriptions.map((subscription) => subscription.startTime),
				gates
			);
			release();
			await late;
			await waitFor(() =>
				received.some(({ topic, message }) => topic === 'SaveStartTime/qos0' && message.value === 'late')
			);
			await session.saveSubscriptions();
			assert.deepStrictEqual(
				session.subscriptions.map((subscription) => subscription.startTime),
				gates
			);
		} finally {
			release?.();
			try {
				await late;
			} finally {
				session.disconnect(true);
				await session.writes;
				Resources.resources.delete('SaveStartTime');
			}
		}
	});
});
