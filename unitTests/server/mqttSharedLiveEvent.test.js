const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { getSession } = require('#src/server/DurableSubscriptionsSession');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const userNamed = (username) => ({ username, role: { permission: { super_user: true } } });

let sequence = 0;
function topicTable() {
	const name = `SharedLiveTopic${++sequence}`;
	const T = table({
		table: name,
		database: `shared_live_${name}`,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
	return { T, name };
}

async function sessionsOn(name, users) {
	const sessions = [];
	for (const [i, user] of users.entries()) {
		const session = await getSession({ clientId: `shared-live-${name}-${i}`, user, clean: true });
		session.messages = [];
		session.setListener((topic, message) => {
			session.messages.push(message);
			return true;
		});
		await session.addSubscription({ topic: `${name}/t0`, qos: 0, rh: 2 }, false);
		sessions.push(session);
	}
	return sessions;
}

// An MQTT session writes nothing to the events it delivers that it reads later, so its table subscriptions take one
// live event per record write, built once for every session, rather than one each.
describe('MQTT sessions sharing live events', function () {
	this.timeout(30_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
	});

	it('hands every session subscribed to a topic the same live event', async () => {
		const { T, name } = topicTable();
		Resources.resources.set(name, T, { mqtt: true });
		const sessions = await sessionsOn(name, [userNamed('shared-live-a'), userNamed('shared-live-b')]);
		const sent = sessions.map((session) => {
			const events = [];
			const subscription = session.subscriptions[0];
			const send = subscription.send;
			subscription.send = function (event) {
				events.push(event);
				return send.call(this, event);
			};
			return events;
		});
		await T.publish('t0', { n: 1 });
		await waitFor(() => sessions.every((session) => session.messages.length === 1));
		assert.strictEqual(sent[0].length, 1);
		assert.strictEqual(sent[1][0], sent[0][0], 'each session was handed an event of its own');
		for (const session of sessions) session.disconnect(true);
	});

	it('writes nothing to the event it shares, whatever topic each session takes it under', async () => {
		const { T, name } = topicTable();
		Resources.resources.set(name, T, { mqtt: true });
		const sent = [];
		const sessions = [];
		for (const [i, filter] of [`${name}/t0`, `${name}/#`].entries()) {
			const session = await getSession({
				clientId: `shared-live-topic-${name}-${i}`,
				user: userNamed(`shared-live-topic-${i}`),
				clean: true,
			});
			session.messages = [];
			session.setListener((topic, message) => {
				session.messages.push(message);
				return true;
			});
			await session.addSubscription({ topic: filter, qos: 1, rh: 2 }, true);
			const events = [];
			const subscription = session.subscriptions[0];
			const send = subscription.send;
			subscription.send = function (event) {
				events.push(event);
				return send.call(this, event);
			};
			sent.push(events);
			sessions.push(session);
		}
		await T.publish('t0', { n: 1 });
		await waitFor(() => sessions.every((session) => session.messages.length === 1));
		assert.strictEqual(sent[1][0], sent[0][0], 'the sessions were handed events of their own');
		assert.ok(!('topic' in sent[0][0]), `a session wrote its topic, ${sent[0][0].topic}, to the event it shares`);
		for (const session of sessions) session.disconnect(true);
	});

	// A resource can wrap the table's subscription and change each event for its subscriber, so only the subscription
	// the session itself consumes takes shared events, never the table subscription inside a wrapper.
	it('keeps the events of a resource that wraps the table subscription per session', async () => {
		const { T, name } = topicTable();
		class PerViewer extends T {
			static async subscribe(request, context) {
				const inner = await super.subscribe(request, context);
				const viewer = context?.user?.username;
				const events = (async function* () {
					for await (const event of inner) {
						event.value = { ...event.value, viewer };
						yield event;
					}
				})();
				events.end = () => inner.end();
				return events;
			}
		}
		Resources.resources.set(name, PerViewer, { mqtt: true });
		const viewers = ['shared-live-c', 'shared-live-d'];
		const sessions = await sessionsOn(name, viewers.map(userNamed));
		await T.publish('t0', { n: 1 });
		await waitFor(() => sessions.every((session) => session.messages.length === 1));
		for (const [i, session] of sessions.entries()) {
			assert.strictEqual(session.messages[0].viewer, viewers[i], `another session's event reached ${viewers[i]}`);
		}
		for (const session of sessions) session.disconnect(true);
	});
});
