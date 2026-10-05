// saveSubscriptions persists a resume position for every subscription in the session. It must not write
// that position onto a live subscription's startTime, which is the broadcaster's delivery gate: doing so
// made a QoS 0 subscription drop every event at or below the save time.
require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { DurableSubscriptionsSession } = require('#src/server/DurableSubscriptionsSession');

describe('DurableSubscriptionsSession.saveSubscriptions', () => {
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('records a resume position without changing a live subscription startTime', async () => {
		const session = new DurableSubscriptionsSession('save-start-time', { role: { permission: {} } });
		const qos0 = { topic: 'live/qos0', qos: 0, startTime: 0 };
		const qos1 = { topic: 'live/qos1', qos: 1, startTime: 0 };
		session.subscriptions = [qos0, qos1];
		await session.saveSubscriptions();
		assert.equal(qos0.startTime, 0, 'the QoS 0 subscription delivery gate was moved');
		assert.equal(qos1.startTime, 0, 'the QoS 1 subscription delivery gate was moved');
		const saved = session.sessionRecord.subscriptions;
		assert.ok(
			saved.every((subscription) => subscription.startTime > 0),
			JSON.stringify(saved)
		);
		const firstPositions = saved.map((subscription) => subscription.startTime);
		await session.saveSubscriptions();
		assert.deepEqual(
			session.sessionRecord.subscriptions.map((subscription) => subscription.startTime),
			firstPositions,
			'a later save moved the resume position'
		);
	});
});
