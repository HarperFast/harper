const assert = require('node:assert');
const { EventEmitter, once } = require('node:events');
const net = require('node:net');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { transaction, contextStorage } = require('#src/resources/transaction');
const { getSession, SERIALIZING } = require('#src/server/DurableSubscriptionsSession');
const { Resource } = require('#src/resources/Resource');
const { IterableEventQueue } = require('#src/resources/IterableEventQueue');
const { handleApplication } = require('#src/server/mqtt');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const mqttPacket = require('mqtt-packet');
const { generate } = mqttPacket;
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const user = { username: 'subscription-delivery-test', role: { permission: { super_user: true } } };

/** The MQTT WebSocket listener, as mqtt.ts registers it with a server. */
function mqttWebSocketListener() {
	let listener;
	const server = {
		ws: (fn) => ((listener = fn), []),
		socket: () => ({}),
		mqtt: { sessions: new Set(), events: new EventEmitter() },
	};
	handleApplication({ options: { getAll: () => ({ webSocket: {} }) }, server });
	return { listener, server };
}

/** A WebSocket that records what is sent, over a raw socket whose back-pressure a test can set. */
function fakeWebSocket() {
	const rawSocket = new EventEmitter();
	rawSocket.remoteAddress = '127.0.0.1';
	const socket = { handlers: {}, sent: [], rawSocket, _socket: rawSocket, close() {}, terminate() {} };
	socket.send = (packet) => socket.sent.push(packet);
	socket.on = (event, handler) => (socket.handlers[event] = handler);
	return socket;
}

function mqttUpgradeRequest() {
	const headers = { 'sec-websocket-protocol': 'mqtt' };
	return { headers: { asObject: headers, get: (header) => headers[header.toLowerCase()] }, user };
}

let sequence = 0;
function topicTable() {
	const name = `DeliveryTopic${++sequence}`;
	const T = table({
		table: name,
		database: `delivery_${name}`,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
	Resources.resources.set(name, T, { mqtt: true });
	return { T, name };
}

describe('MQTT subscription delivery', function () {
	this.timeout(30_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
	});

	it('yields to the event loop within a bounded number of deliveries, however many subscriptions share a backlog', async () => {
		const { T, name } = topicTable();
		const subscribers = 20;
		const records = 200;
		let delivered = 0;
		let deliveredWhenOtherWorkRan;
		const sessions = [];
		for (let i = 0; i < subscribers; i++) {
			const session = await getSession({ clientId: `pacing-${name}-${i}`, user, clean: true });
			session.setListener(() => {
				// work queued behind the first delivery must get a turn long before the backlog is gone
				if (delivered++ === 0) setImmediate(() => (deliveredWhenOtherWorkRan = delivered));
				return true;
			});
			await session.addSubscription({ topic: `${name}/#`, qos: 0, rh: 2 }, false);
			sessions.push(session);
		}
		await transaction({}, async (context) => {
			for (let i = 0; i < records; i++) await T.put(`r${i}`, { value: i }, context);
		});
		await waitFor(() => delivered === subscribers * records, 10_000);
		assert.ok(deliveredWhenOtherWorkRan !== undefined);
		// one turn's budget, plus at most one more delivery from each subscription already resumed
		assert.ok(
			deliveredWhenOtherWorkRan <= 1000 + subscribers,
			`${deliveredWhenOtherWorkRan} of ${subscribers * records} deliveries ran before the event loop turned`
		);
		for (const session of sessions) session.disconnect(true);
	});

	// A producer may reuse one id array across its events, changing its elements, so a topic is not cached by the
	// array's identity.
	it('builds each message topic from the id it carries, when a producer reuses one id array', async () => {
		const name = `ReusedIdTopic${++sequence}`;
		const queue = new IterableEventQueue();
		// as a subscription ends: the session ends what it subscribed when it disconnects
		queue.end = () => queue.close();
		class ReusedIds extends Resource {
			static subscribe() {
				return queue;
			}
		}
		Resources.resources.set(name, ReusedIds, { mqtt: true });
		const session = await getSession({ clientId: `reused-id-${name}`, user, clean: true });
		const topics = [];
		session.setListener((topic) => {
			topics.push(topic);
			return true;
		});
		await session.addSubscription({ topic: `${name}/#`, qos: 0, rh: 2 }, false);
		const id = ['a', '1'];
		queue.send({ id, value: { n: 1 }, type: 'put' });
		await waitFor(() => topics.length === 1);
		id[1] = '2';
		queue.send({ id, value: { n: 2 }, type: 'put' });
		await waitFor(() => topics.length === 2);
		assert.deepStrictEqual(topics, [`${name}/a/1`, `${name}/a/2`]);
		session.disconnect(true);
	});

	// The budget is per event turn: deliveries in an earlier turn that did not spend it leave none of it spent.
	it('starts each event turn with the whole delivery budget, whatever an earlier turn left unspent', async () => {
		const { T, name } = topicTable();
		let burst = false;
		let delivered = 0;
		let deliveredWhenOtherWorkRan;
		const sessions = [];
		for (const id of ['a', 'b', 'c', 'd']) {
			const session = await getSession({ clientId: `budget-${name}-${id}`, user, clean: true });
			session.setListener(() => {
				if (burst && ++delivered === 1) setImmediate(() => (deliveredWhenOtherWorkRan = delivered));
				return true;
			});
			await session.addSubscription({ topic: `${name}/#`, qos: 0, rh: 2 }, false);
			sessions.push(session);
		}
		// Warm-ups of 64 and then 32 deliveries, each followed by idle turns: a count kept across turns would then
		// hold enough to cross the budget before the burst's last round of visits (the budget is checked between
		// visits). The count is shared with every earlier test file, and a leftover count that happens to make one
		// warm-up yield just before the burst does not do so for the other.
		for (const warmUpRecords of [16, 8]) {
			await transaction({}, async (context) => {
				for (let i = 0; i < warmUpRecords; i++) await T.put(`warm${i}`, { value: i }, context);
			});
			for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
			burst = true;
			delivered = 0;
			deliveredWhenOtherWorkRan = undefined;
			// 996 deliveries in one turn (249 records, one notify batch), under a fresh budget of 1,000 but over
			// one that kept the earlier turn's count: they all go out before work queued behind the first
			await transaction({}, async (context) => {
				for (let i = 0; i < 249; i++) await T.put(`r${i}`, { value: i }, context);
			});
			await waitFor(() => deliveredWhenOtherWorkRan !== undefined && delivered === 996);
			burst = false;
			assert.strictEqual(deliveredWhenOtherWorkRan, 996, 'the turn yielded on an earlier turn’s count');
		}
		for (const session of sessions) session.disconnect(true);
	});

	// A QoS 2 message's PUBREL waits on the save its PUBREC starts, and PUBRECs are read only between turns, so a turn
	// sends about 16 QoS 2 messages rather than a budget's worth: their PUBRECs then come back, and save, in small
	// groups rather than one burst. QoS 0 messages still go out a whole batch at a time.
	it('lets other work run after about 16 QoS 2 deliveries, where QoS 0 deliveries go out in one turn', async () => {
		const deliveredBeforeOtherWork = async (qos) => {
			const { T, name } = topicTable();
			let burst = false;
			let warmed = 0;
			let delivered = 0;
			let deliveredWhenOtherWorkRan;
			const sessions = [];
			for (const id of ['a', 'b', 'c', 'd']) {
				const session = await getSession({ clientId: `weight-${name}-${qos}-${id}`, user, clean: true });
				session.setListener(() => {
					if (!burst) warmed++;
					else if (++delivered === 1) setImmediate(() => (deliveredWhenOtherWorkRan = delivered));
					return true;
				});
				await session.addSubscription({ topic: `${name}/#`, qos, rh: 2 }, false);
				sessions.push(session);
			}
			await T.put('warm', { value: -1 });
			await waitFor(() => warmed === sessions.length);
			// a fresh budget for the burst
			for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
			burst = true;
			// 80 deliveries in one notify batch, well under a budget of 1,000 plain deliveries
			await transaction({}, async (context) => {
				for (let i = 0; i < 20; i++) await T.put(`r${i}`, { value: i }, context);
			});
			// LMDB live delivery can drop some records of a many-record transaction (on main too), so the count is of
			// what arrived before other work ran, not of the whole batch
			await waitFor(() => deliveredWhenOtherWorkRan !== undefined);
			for (const session of sessions) session.disconnect(true);
			return deliveredWhenOtherWorkRan;
		};
		const qos0 = await deliveredBeforeOtherWork(0);
		assert.ok(qos0 > 16, `${qos0} QoS 0 deliveries before other work ran`);
		const qos2 = await deliveredBeforeOtherWork(2);
		assert.ok(qos2 <= 16, `${qos2} QoS 2 deliveries before other work ran`);
	});

	// Socket reads land in the poll phase, and an immediate queued there runs in the same loop iteration's check phase:
	// were a budget spent in the poll phase to end its turn there, a second batch would go out before the poll phase
	// read the first batch's PUBRECs. Messages queued from a socket read start the burst; the probe is a byte already
	// waiting on a socket nothing reads from until the first delivery, so the next poll is the first to read it.
	it('reads sockets after about 16 QoS 2 deliveries of a burst that starts in the poll phase', async () => {
		const name = `PollPhaseBurst${++sequence}`;
		const queues = [];
		class PollPhase extends Resource {
			static subscribe() {
				const queue = new IterableEventQueue();
				queue.end = () => queue.close();
				queues.push(queue);
				return queue;
			}
		}
		Resources.resources.set(name, PollPhase, { mqtt: true });
		// an accepted socket reads nothing until resumed
		const server = net.createServer({ pauseOnConnect: true });
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		const accepted = [];
		server.on('connection', (socket) => accepted.push(socket));
		const trigger = net.connect(server.address().port, '127.0.0.1');
		const probe = net.connect(server.address().port, '127.0.0.1');
		await Promise.all([once(trigger, 'connect'), once(probe, 'connect')]);
		await waitFor(() => accepted.length === 2);
		const [triggered, probed] = accepted;
		triggered.resume();
		await new Promise((resolve) => probe.write('x', resolve));
		// time for loopback to hand the byte to the accepted socket
		await new Promise((resolve) => setTimeout(resolve, 20));
		let delivered = 0;
		let deliveredWhenRead;
		probed.once('data', () => (deliveredWhenRead = delivered));
		const sessions = [];
		for (const id of ['a', 'b', 'c', 'd']) {
			const session = await getSession({ clientId: `poll-${name}-${id}`, user, clean: true });
			session.setListener(() => {
				if (++delivered === 1) probed.resume();
				return true;
			});
			await session.addSubscription({ topic: `${name}/#`, qos: 2, rh: 2 }, false);
			sessions.push(session);
		}
		triggered.once('data', () => {
			for (let i = 0; i < 20; i++)
				for (const queue of queues) queue.send({ id: `r${i}`, value: { n: i }, type: 'put' });
		});
		try {
			trigger.write('go');
			await waitFor(() => deliveredWhenRead !== undefined);
			assert.ok(deliveredWhenRead <= 16, `${deliveredWhenRead} QoS 2 deliveries before the socket was read`);
		} finally {
			for (const session of sessions) session.disconnect(true);
			trigger.destroy();
			probe.destroy();
			for (const socket of accepted) socket.destroy();
			server.close();
		}
	});

	// A send that waits on its socket is issued at once and settles later, so it counts against the budget when issued:
	// otherwise every waiting session could issue one more send in a turn than the budget allows.
	it('counts a send that waits on its socket when it is issued', async () => {
		const { T, name } = topicTable();
		let burst = false;
		let warmed = 0;
		let issued = 0;
		let issuedWhenOtherWorkRan;
		const sessions = [];
		for (let i = 0; i < 20; i++) {
			const session = await getSession({ clientId: `issued-${name}-${i}`, user, clean: true });
			session.setListener(() => {
				if (!burst) {
					warmed++;
					return true;
				}
				if (++issued === 1) setImmediate(() => (issuedWhenOtherWorkRan = issued));
				// back-pressure: the send settles on a later turn
				return new Promise((resolve) => setImmediate(() => resolve(true)));
			});
			await session.addSubscription({ topic: `${name}/#`, qos: 2, rh: 2 }, false);
			sessions.push(session);
		}
		try {
			await T.put('warm', { value: -1 });
			await waitFor(() => warmed === sessions.length);
			for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
			burst = true;
			await T.put('r0', { value: 0 });
			await waitFor(() => issuedWhenOtherWorkRan !== undefined);
			assert.ok(issuedWhenOtherWorkRan <= 16, `${issuedWhenOtherWorkRan} QoS 2 sends issued before other work ran`);
		} finally {
			for (const session of sessions) session.disconnect(true);
		}
	});

	// The budget is the thread's, so a subscription's batch stops once the ones sent from before it have spent it.
	it('sends about 16 QoS 2 messages in a turn when the first subscription sent most of them', async () => {
		const { T, name } = topicTable();
		let burst = false;
		let warmed = 0;
		let delivered = 0;
		let deliveredWhenOtherWorkRan;
		const listener = () => {
			if (!burst) warmed++;
			else if (++delivered === 1) setImmediate(() => (deliveredWhenOtherWorkRan = delivered));
			return true;
		};
		const sessions = [];
		// the first subscription's records are written first, so its delivery is the first one drained
		for (const [id, level] of [
			['first', 'a'],
			['second', 'b'],
		]) {
			const session = await getSession({ clientId: `unequal-${name}-${id}`, user, clean: true });
			session.setListener(listener);
			await session.addSubscription({ topic: `${name}/${level}/#`, qos: 2, rh: 2 }, false);
			sessions.push(session);
		}
		try {
			await T.put('a/warm', { value: -1 });
			await T.put('b/warm', { value: -1 });
			await waitFor(() => warmed === sessions.length);
			for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
			burst = true;
			// 15 messages for the first subscription, under the budget, then 20 for the second
			await transaction({}, async (context) => {
				for (let i = 0; i < 15; i++) await T.put(`a/${i}`, { value: i }, context);
				for (let i = 0; i < 20; i++) await T.put(`b/${i}`, { value: i }, context);
			});
			await waitFor(() => deliveredWhenOtherWorkRan !== undefined);
			assert.ok(deliveredWhenOtherWorkRan <= 16, `${deliveredWhenOtherWorkRan} QoS 2 deliveries before other work ran`);
		} finally {
			for (const session of sessions) session.disconnect(true);
		}
	});

	// A computed attribute's resolver can read the async context (getContext()) while a message is
	// serialized, so a message must go out in its subscriber's context, not in the context of whichever
	// request wrote the record and so set off the notification.
	it('sends each message in the async context its subscription was opened in, whatever context wrote it', async () => {
		const { T, name } = topicTable();
		const seen = [];
		const session = await getSession({ clientId: `context-${name}`, user, clean: true });
		session.setListener(() => {
			seen.push(contextStorage.getStore()?.topic);
			return true;
		});
		await session.addSubscription({ topic: `${name}/#`, qos: 0, rh: 2 }, false);
		await contextStorage.run({ topic: 'the writer’s context' }, () => T.put('r1', { value: 1 }));
		await waitFor(() => seen.length === 1);
		assert.deepStrictEqual(seen, [`${name}/#`]);
		session.disconnect(true);
	});

	it('fails a subscription that closes with an error while its delivery waits on the socket', async () => {
		const { T, name } = topicTable();
		const session = await getSession({ clientId: `closed-parked-${name}`, user, clean: true });
		const closedWith = [];
		session.closeConnection = (error) => closedWith.push(error);
		// the first send never drains, so the delivery stays parked and reads nothing more from its queue
		session.setListener(() => new Promise(() => {}));
		const subscription = await session.addSubscription({ topic: `${name}/#`, qos: 0, rh: 2 }, false);
		await T.put('r1', { value: 1 });
		await waitFor(() => session.parked !== null);
		const error = new Error('the subscription ended with an error');
		subscription.close(error);
		assert.deepStrictEqual(closedWith, [error], 'the connection is closed with it, without waiting on the socket');
	});

	// A subscription waiting on the session's acknowledgement backlog must not keep the session's other
	// subscriptions from their turn: they take turns, as each subscription's own loop did.
	it('gives every subscription of a session a turn while the session waits on acknowledgements', async () => {
		const busy = topicTable();
		const rare = topicTable();
		const session = await getSession({ clientId: `turns-${busy.name}`, user, clean: true });
		const received = [];
		// never acknowledges, so the session's unacknowledged deliveries pass the high-water mark and stay there
		session.setListener((topic) => {
			received.push(topic);
			return true;
		});
		// QoS 2 with acknowledgements, which a clean session tracks until they arrive
		await session.addSubscription({ topic: `${busy.name}/#`, qos: 2, rh: 2 }, true);
		await session.addSubscription({ topic: `${rare.name}/#`, qos: 2, rh: 2 }, true);
		await transaction({}, async (context) => {
			for (let i = 0; i < 300; i++) await busy.T.put(`b${i}`, { value: i }, context);
		});
		await waitFor(() => received.length > 110, { message: 'the backlog reached' });
		await rare.T.put('command', { value: 1 });
		// draining the busy queue first would take its 190 remaining waits, about 18 s
		await waitFor(() => received.includes(`${rare.name}/command`), {
			timeout: 2000,
			message: 'the rare subscription got its turn',
		});
		session.disconnect(true);
	});

	// Only socket back-pressure holds the whole session: a message waiting on its serialization holds only its own
	// subscription, so the session's others keep sending.
	it('lets the session send on its other subscriptions while one message waits on its serialization', async () => {
		const slow = topicTable();
		const other = topicTable();
		const session = await getSession({ clientId: `serializing-${slow.name}`, user, clean: true });
		const sent = [];
		let serialize;
		session.setListener((topic) => {
			if (topic.startsWith(`${slow.name}/`) && !serialize) {
				const serialized = new Promise((resolve) => (serialize = resolve)).then(() => sent.push(topic));
				serialized[SERIALIZING] = true;
				return serialized;
			}
			sent.push(topic);
			return true;
		});
		await session.addSubscription({ topic: `${slow.name}/#`, qos: 0, rh: 2 }, false);
		await session.addSubscription({ topic: `${other.name}/#`, qos: 0, rh: 2 }, false);
		await slow.T.put('first', { value: 1 });
		await waitFor(() => serialize !== undefined);
		await slow.T.put('second', { value: 2 });
		await other.T.put('meanwhile', { value: 3 });
		await waitFor(() => sent.includes(`${other.name}/meanwhile`), { message: 'the other subscription sent' });
		assert.deepStrictEqual(sent, [`${other.name}/meanwhile`], 'the waiting subscription sent nothing out of order');
		serialize();
		await waitFor(() => sent.length === 3);
		assert.deepStrictEqual(sent.slice(1), [`${slow.name}/first`, `${slow.name}/second`]);
		session.disconnect(true);
	});

	// Every received packet re-arms the keepalive timer, so a client sending within 1.5 keepalive intervals stays
	// connected, and one that goes quiet is closed after that long.
	it('keeps a connection alive while packets arrive, and closes it once they stop', async () => {
		const session = await getSession({ clientId: `keepalive-${++sequence}`, user, clean: true, keepalive: 0.1 });
		const destroyed = [];
		session.socket = { destroy: (error) => destroyed.push(error) };
		for (let i = 0; i < 20; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			session.receivedPacket();
		}
		assert.deepStrictEqual(destroyed, [], 'closed while packets were arriving every 20 ms of a 150 ms allowance');
		// a longer keepalive takes effect on the next packet
		session.keepalive = 1;
		session.receivedPacket();
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.deepStrictEqual(destroyed, [], 'closed on the earlier, shorter keepalive');
		session.keepalive = 0.1;
		session.receivedPacket();
		await waitFor(() => destroyed.length === 1, { timeout: 2000, message: 'closed once packets stopped' });
		assert.match(destroyed[0].message, /Keepalive timeout/);
		session.disconnect(true);
	});

	// A pull that throws fails its subscription, as a loop over the queue would be rejected; retried, a pull that
	// throws every time would hold the thread forever.
	it('fails a subscription whose queue throws reading its next message', async () => {
		const name = `ThrowingQueue${++sequence}`;
		const error = new Error('the next message could not be read');
		class ThrowingQueue extends IterableEventQueue {
			reads = 0;
			getNextMessage() {
				// only the first read throws, so code that retries it carries on, rather than hanging the thread
				if (this.reads++ === 0) throw error;
				return super.getNextMessage();
			}
		}
		const queue = new ThrowingQueue();
		queue.end = () => queue.close();
		class Throwing extends Resource {
			static subscribe() {
				return queue;
			}
		}
		Resources.resources.set(name, Throwing, { mqtt: true });
		const session = await getSession({ clientId: `throwing-${name}`, user, clean: true });
		const closedWith = [];
		session.closeConnection = (failure) => closedWith.push(failure);
		session.setListener(() => true);
		await session.addSubscription({ topic: `${name}/#`, qos: 0, rh: 2 }, false);
		// it reads its messages its own way, so it is iterated, not pulled
		assert.strictEqual(queue.consumer, null);
		queue.send({ id: 'a', value: { n: 1 }, type: 'put' });
		await waitFor(() => closedWith.length > 0);
		assert.deepStrictEqual(closedWith, [error]);
	});

	it('fails the subscription the drain throws over, and drains the others', async () => {
		const { T, name } = topicTable();
		const failing = await getSession({ clientId: `drain-throws-${name}`, user, clean: true });
		const closedWith = [];
		failing.closeConnection = (failure) => closedWith.push(failure);
		failing.setListener(() => true);
		await failing.addSubscription({ topic: `${name}/r1`, qos: 0, rh: 2 }, false);
		const other = await getSession({ clientId: `drain-other-${name}`, user, clean: true });
		const received = [];
		other.setListener((topic, message) => (received.push(message.n), true));
		await other.addSubscription({ topic: `${name}/r1`, qos: 0, rh: 2 }, false);
		// outside the send itself, where the drain catches it
		const error = new Error('the transport could not hold its sends');
		failing.holdSends = () => {
			throw error;
		};
		failing.releaseSends = () => {};
		await transaction({}, async (context) => {
			for (let n = 0; n < 3; n++) await T.publish('r1', { n }, context);
		});
		await waitFor(() => closedWith.length > 0 && received.length === 3);
		assert.deepStrictEqual(closedWith, [error]);
		assert.deepStrictEqual(received, [0, 1, 2]);
	});

	it('fails a pulled subscription when taking a message from it throws', async () => {
		const { T, name } = topicTable();
		const session = await getSession({ clientId: `pull-throws-${name}`, user, clean: true });
		const closedWith = [];
		session.closeConnection = (failure) => closedWith.push(failure);
		session.setListener(() => true);
		await session.addSubscription({ topic: `${name}/#`, qos: 0, rh: 2 }, false);
		const error = new Error('the message could not be taken');
		session.consumed = () => {
			throw error;
		};
		await T.put('r1', { value: 1 });
		await waitFor(() => closedWith.length > 0);
		assert.deepStrictEqual(closedWith, [error]);
	});

	it('delivers to a mid-level single-level wildcard only the records whose levels match it', async () => {
		const { T, name } = topicTable();
		const delivered = [];
		const session = await getSession({ clientId: `wildcard-${name}`, user, clean: true });
		session.setListener((topic) => {
			delivered.push(topic);
			return true;
		});
		await session.addSubscription({ topic: `${name}/site/+/temp`, qos: 0, rh: 2 }, false);
		await T.put('site/a/temp', { value: 1 });
		await T.put('site/b/humidity', { value: 2 });
		await T.put('site/c/temp/extra', { value: 3 });
		await T.put('site/d/temp', { value: 4 });
		await waitFor(() => delivered.includes(`${name}/site/d/temp`));
		assert.deepStrictEqual(delivered, [`${name}/site/a/temp`, `${name}/site/d/temp`]);
		session.disconnect(true);
	});

	for (const protocolVersion of [4, 5]) {
		it(`sends each QoS 1 subscriber of a message its own packet identifier around the shared payload (MQTT v${protocolVersion})`, async () => {
			const { listener, server } = mqttWebSocketListener();
			const socket = fakeWebSocket();
			listener(socket, mqttUpgradeRequest(), Promise.resolve({ status: 200 }), () => {});
			socket.handlers.message(
				generate({
					cmd: 'connect',
					protocolId: 'MQTT',
					protocolVersion,
					clientId: `qos1-${protocolVersion}`,
					clean: true,
				})
			);
			await waitFor(() => server.mqtt.sessions.size === 1);
			const [session] = server.mqtt.sessions;
			const message = { value: 'shared', reading: [1, 2, 3] };
			// the first send encodes, the second stores the template, the rest copy it
			for (const messageId of [11, 12, 13, 14]) session.listener('Topic/a', message, messageId, { qos: 1 }, 7);
			const parser = mqttPacket.parser({ protocolVersion });
			const publishes = [];
			parser.on('packet', (packet) => packet.cmd === 'publish' && publishes.push(packet));
			for (const sent of socket.sent) parser.parse(sent);
			assert.deepStrictEqual(
				publishes.map(({ messageId, qos, topic }) => ({ messageId, qos, topic })),
				[11, 12, 13, 14].map((messageId) => ({ messageId, qos: 1, topic: 'Topic/a' }))
			);
			for (const publish of publishes) assert.deepStrictEqual(JSON.parse(publish.payload), message);
			socket.handlers.close?.();
		});
	}

	/** A connected MQTT session over a fake WebSocket, with every `acknowledged` event's packet collected. */
	async function connectedClient(clientId, protocolVersion = 4) {
		const { listener, server } = mqttWebSocketListener();
		const socket = fakeWebSocket();
		const acknowledged = [];
		server.mqtt.events.on('acknowledged', (session, packet) => acknowledged.push(packet));
		listener(socket, mqttUpgradeRequest(), Promise.resolve({ status: 200 }), () => {});
		socket.handlers.message(
			generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion, clientId, clean: true }, { protocolVersion })
		);
		await waitFor(() => server.mqtt.sessions.size === 1);
		return { socket, acknowledged };
	}

	for (const protocolVersion of [4, 5]) {
		it(`reads a run of acknowledgements without the general parser, into the packets the parser emits for them (MQTT v${protocolVersion})`, async () => {
			const { socket, acknowledged } = await connectedClient(`acknowledgement-run-${protocolVersion}`, protocolVersion);
			const acknowledgements = Buffer.concat([
				generate({ cmd: 'puback', messageId: 5 }),
				generate({ cmd: 'pubrec', messageId: 6 }),
				generate({ cmd: 'pubrel', messageId: 7 }),
				generate({ cmd: 'pubcomp', messageId: 300 }),
			]);
			assert.strictEqual(acknowledgements.length, 16, 'four 4-byte acknowledgements');
			const parsed = [];
			const parser = mqttPacket.parser({ protocolVersion });
			parser.on('packet', (packet) => parsed.push({ ...packet }));
			parser.parse(acknowledgements);
			const sentBefore = socket.sent.length;
			socket.handlers.message(acknowledgements);
			await waitFor(() => acknowledged.length === 2);
			// PUBACK and PUBCOMP complete a delivery; PUBREC is answered with a PUBREL, and PUBREL with a PUBCOMP
			assert.deepStrictEqual(
				acknowledged.map((packet) => ({ ...packet })),
				[parsed[0], parsed[3]]
			);
			await waitFor(() => socket.sent.length >= sentBefore + 2);
			// neither identifier is in flight on this session, which v5 reports with a reason code
			assert.deepStrictEqual(
				socket.sent.slice(sentBefore).map((packet) => Buffer.from(packet)),
				[
					generate({ cmd: 'pubrel', messageId: 6, reasonCode: 0x92 }, { protocolVersion }),
					generate({ cmd: 'pubcomp', messageId: 7, reasonCode: 0x92 }, { protocolVersion }),
				]
			);
			socket.handlers.close?.();
		});
	}

	it('parses data that continues a partial packet with the general parser, though it looks like PUBACKs', async () => {
		const { socket, acknowledged } = await connectedClient('puback-lookalike');
		// a PINGREQ answered proves the parser read the PUBLISH whole, its payload included
		const publish = generate({ cmd: 'publish', topic: 'NoSuchTopic/a', payload: Buffer.from([0x40, 2, 0, 9]), qos: 0 });
		socket.handlers.message(publish.subarray(0, publish.length - 4));
		socket.handlers.message(publish.subarray(publish.length - 4));
		socket.handlers.message(generate({ cmd: 'pingreq' }));
		await waitFor(() => socket.sent.some((packet) => packet[0] >> 4 === 13), { message: 'PINGRESP' });
		assert.deepStrictEqual(acknowledged, [], 'the PUBLISH payload is not read as a PUBACK');
		socket.handlers.close?.();
	});

	it('parses the body of a packet whose fixed header came alone with the general parser, though it looks like PUBACKs', async () => {
		const { socket, acknowledged } = await connectedClient('puback-split-header');
		// a v5 PUBACK with a reason code and empty properties, its body shaped like a 4-byte PUBACK
		const puback = generate({ cmd: 'puback', messageId: 0x4002, reasonCode: 0x10 }, { protocolVersion: 5 });
		assert.deepStrictEqual([...puback], [0x40, 4, 0x40, 2, 0x10, 0]);
		socket.handlers.message(puback.subarray(0, 2));
		socket.handlers.message(puback.subarray(2));
		socket.handlers.message(generate({ cmd: 'pingreq' }));
		await waitFor(() => socket.sent.some((packet) => packet[0] >> 4 === 13), { message: 'PINGRESP' });
		assert.deepStrictEqual(
			acknowledged.map(({ messageId }) => messageId),
			[0x4002]
		);
		socket.handlers.close?.();
	});

	it('returns from the MQTT delivery listener without a promise unless the socket is backed up', async () => {
		const { listener, server } = mqttWebSocketListener();
		const socket = fakeWebSocket();
		const { rawSocket, sent } = socket;
		listener(socket, mqttUpgradeRequest(), Promise.resolve({ status: 200 }), () => {});
		socket.handlers.message(
			generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clientId: 'sync-listener', clean: true })
		);
		await waitFor(() => server.mqtt.sessions.size === 1);
		const [session] = server.mqtt.sessions;
		const deliver = (value) => session.listener('Topic/a', { value }, 1, { qos: 0 }, value);

		assert.strictEqual(deliver(1), true);
		rawSocket.writableNeedDrain = true;
		const backedUp = deliver(2);
		assert.strictEqual(typeof backedUp?.then, 'function', 'a backed-up socket is waited on');
		rawSocket.writableNeedDrain = false;
		rawSocket.emit('drain');
		await backedUp;
		assert.strictEqual(sent.filter((packet) => packet[0] >> 4 === 3).length, 2);
		socket.handlers.close?.();
	});
});
