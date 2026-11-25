const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { Resource } = require('#src/resources/Resource');
const { IterableEventQueue } = require('#src/resources/IterableEventQueue');
const { getSession } = require('#src/server/DurableSubscriptionsSession');
const { addSubscription, routeByIdPattern } = require('#src/resources/transactionBroadcast');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor.js');
require('#src/server/serverHelpers/serverUtilities');

const user = { username: 'id-pattern-test', role: { permission: { super_user: true } } };

describe('Subscriptions routed by id pattern', () => {
	let tableCount = 0;
	const ended = [];
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
	});
	afterEach(() => {
		for (const subscription of ended.splice(0)) subscription?.end();
	});

	function createTopicTable() {
		const name = `IdPatternTopic${++tableCount}`;
		const T = table({
			database: 'idpatterns',
			table: name,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		Resources.resources.set(name, T, { mqtt: true });
		return { T, name };
	}
	// Table.subscribe sets includeDescendants on a collection subscription; addSubscription alone does not
	function collection(T, key, listener) {
		const subscription = addSubscription(T, key, listener, 0, {});
		subscription.includeDescendants = true;
		return subscription;
	}
	function patterned(T, key, listener, pattern) {
		const subscription = collection(T, key, listener);
		assert.strictEqual(routeByIdPattern(subscription, pattern), true);
		return subscription;
	}
	async function mqttSession(clientId, received, prefix = '') {
		const session = await getSession({ clientId, user, clean: true });
		session.listener = (topic) => {
			received.push(topic.slice(prefix.length));
		};
		return session;
	}

	it('moves only a subscription addSubscription returned, keyed on the pattern’s prefix, taking every descendant, unfiltered', () => {
		const { T } = createTopicTable();
		const subscription = addSubscription(T, 'site/', () => {}, 0, {});
		ended.push(subscription);
		assert.strictEqual(routeByIdPattern(subscription, 'site/+/temp'), false, 'not a collection');
		subscription.includeDescendants = true;
		subscription.onlyChildren = true;
		assert.strictEqual(routeByIdPattern(subscription, 'site/+/temp'), false, 'children only');
		subscription.onlyChildren = undefined;
		assert.strictEqual(routeByIdPattern(subscription, 'other/+/temp'), false, 'another prefix');
		assert.strictEqual(routeByIdPattern(subscription, 'site/x/temp'), false, 'no +');
		assert.strictEqual(routeByIdPattern(subscription, 'site/+/te\0mp'), false, 'U+0000');
		const wrapper = { subscriptions: subscription.subscriptions, includeDescendants: true };
		assert.strictEqual(routeByIdPattern(wrapper, 'site/+/temp'), false, 'a wrapper');
		const neighbor = addSubscription(T, 'site/', () => {}, 0, {});
		ended.push(neighbor);
		assert.strictEqual(routeByIdPattern(new Proxy(subscription, {}), 'site/+/temp'), false, 'a proxy');
		assert.deepStrictEqual([...subscription.subscriptions], [subscription, neighbor]);
		subscription.state = { allowsEvent: () => true };
		assert.strictEqual(routeByIdPattern(subscription, 'site/+/temp'), false, 'an event filter');
		subscription.state = undefined;
		assert.strictEqual(typeof subscription.subscriptions.key, 'string');
		assert.strictEqual(routeByIdPattern(subscription, 'site/+/temp'), true);
		assert.strictEqual(typeof subscription.subscriptions.key, 'symbol');
		assert.strictEqual(routeByIdPattern(subscription, 'site/+/temp'), false, 'already routed');
	});

	it('routes a record to no shape registered while it is routed, however often listeners replace them', async () => {
		const { T } = createTopicTable();
		const patterns = ['site/+/temp', 'site/+/temp/#'];
		let deliveries = 0;
		let current;
		const subscribe = (index) =>
			(current = patterned(
				T,
				'site/',
				function () {
					// without the bound, a failure would replace subscriptions for as long as the walk ran
					if (++deliveries > 50) return;
					this.end();
					subscribe(1 - index);
				},
				patterns[index]
			));
		subscribe(0);
		await T.put('site/1/temp', { name: 'one' });
		await waitFor(() => deliveries > 0);
		await new Promise((resolve) => setImmediate(resolve));
		ended.push(current);
		assert.strictEqual(deliveries, 1);
	});

	it('routes a record to no shape registered while it is routed, when a listener also ends a group not yet visited', async () => {
		const { T } = createTopicTable();
		const reached = [];
		let unvisited;
		let added;
		const first = patterned(
			T,
			'site/',
			() => {
				reached.push('site/+/temp');
				if (added) return;
				unvisited.end();
				added = patterned(T, 'site/', () => reached.push('site/+/temp/#'), 'site/+/temp/#');
			},
			'site/+/temp'
		);
		unvisited = patterned(T, null, () => reached.push('+/a/temp'), '+/a/temp');
		ended.push(first);
		await T.put('site/a/temp', { name: 'a' });
		await waitFor(() => reached.length > 0);
		await new Promise((resolve) => setImmediate(resolve));
		ended.push(added);
		assert.deepStrictEqual(reached, ['site/+/temp']);
	});

	it('starts a pattern registered during routing with the next record, when its shape is already registered', async () => {
		const { T } = createTopicTable();
		const reached = [];
		let added;
		ended.push(
			patterned(
				T,
				'site/',
				(id) => {
					reached.push(['site/+/temp', id]);
					added ??= patterned(T, 'site/', (id) => reached.push(['site/+/temp/#', id]), 'site/+/temp/#');
				},
				'site/+/temp'
			),
			patterned(T, 'site/', () => {}, 'site/+/humidity/#')
		);
		await T.put('site/x/temp', { name: 'x' });
		await T.put('site/y/temp', { name: 'y' });
		await waitFor(() => reached.some(([pattern]) => pattern === 'site/+/temp/#'));
		ended.push(added);
		assert.deepStrictEqual(reached, [
			['site/+/temp', 'site/x/temp'],
			['site/+/temp', 'site/y/temp'],
			['site/+/temp/#', 'site/y/temp'],
		]);
	});

	it('moves no subscription out of a bucket while a record is delivered from it', async () => {
		const { T } = createTopicTable();
		const reached = [];
		let added;
		let movedDuringDelivery;
		ended.push(
			collection(T, 'site/', () => {
				if (added) return;
				added = collection(T, 'site/', (id) => reached.push(id));
				movedDuringDelivery = routeByIdPattern(added, 'site/+/temp/#');
			}),
			patterned(T, 'site/', () => {}, 'site/+/humidity/#')
		);
		await T.put('site/x/temp', { name: 'x' });
		await waitFor(() => added);
		assert.strictEqual(movedDuringDelivery, false);
		assert.strictEqual(routeByIdPattern(added, 'site/+/temp/#'), true);
		ended.push(added);
		await T.put('site/y/humidity', { name: 'y' });
		await T.put('site/y/temp', { name: 'y' });
		await waitFor(() => reached.includes('site/y/temp'));
		assert.deepStrictEqual(reached, ['site/y/temp']);
	});

	it('delivers only records whose id matches the pattern', async () => {
		const { T } = createTopicTable();
		const subscribe = async (pattern, into) => {
			const subscription = await T.subscribe({
				id: 'site/',
				isCollection: true,
				omitCurrent: true,
				listener: (event) => into.push(event.id),
			});
			ended.push(subscription);
			assert.strictEqual(routeByIdPattern(subscription, pattern), true);
		};
		const received = [];
		await subscribe('site/+/temp', received);
		const prefixed = [];
		await subscribe('site/+/temp/#', prefixed);
		// a topic level is a string, so the number 7 does not match the level '7'
		const typed = [];
		await subscribe('site/+/7', typed);
		await T.publish(['site', 'g', 7], { name: 'numeric bound level' });
		await T.publish(['site', 'h', '7'], { name: 'string bound level' });
		await T.publish(['site', 'a', 'temp'], { name: 'array id' });
		await T.publish('site/b/temp', { name: 'string id' });
		await T.publish(['site', 'c', 'humidity'], { name: 'other metric' });
		await T.publish(['site', 'd', 'temp', 'x'], { name: 'deeper' });
		await T.publish(['site', 1, 'temp'], { name: 'numeric level' });
		await T.publish(['other', 'e', 'temp'], { name: 'other site' });
		await T.publish(['site', 'last', 'temp'], { name: 'last' });
		await waitFor(() => received.some((id) => id?.[1] === 'last') && prefixed.some((id) => id?.[1] === 'last'));
		const levels = (ids) => ids.map((id) => (Array.isArray(id) ? id.join('/') : id));
		assert.deepStrictEqual(levels(received), ['site/a/temp', 'site/b/temp', 'site/1/temp', 'site/last/temp']);
		assert.deepStrictEqual(levels(prefixed), [
			'site/a/temp',
			'site/b/temp',
			'site/d/temp/x',
			'site/1/temp',
			'site/last/temp',
		]);
		assert.deepStrictEqual(levels(typed), ['site/h/7']);
	});

	it('drops a pattern from the index when its last subscription ends, and routes it again when it returns', async () => {
		const { T } = createTopicTable();
		const first = patterned(T, 'site/', () => {}, 'site/+/temp');
		const tableSubscriptions = first.subscriptions.tables;
		assert.strictEqual(tableSubscriptions.idPatterns.size, 1);
		ended.push(addSubscription(T, 'other/', () => {}, 0, {}));
		first.end();
		assert.strictEqual(tableSubscriptions.idPatterns, undefined);
		const received = [];
		ended.push(patterned(T, 'site/', (id) => received.push(id), 'site/+/temp'));
		await T.put('site/z/humidity', { name: 'z' });
		await T.put('site/z/temp', { name: 'z' });
		await waitFor(() => received.length > 0);
		assert.deepStrictEqual(received, ['site/z/temp']);
	});

	it('keeps a resource that wraps its table subscription on the key walk, so the ids it rewrites still match', async () => {
		const { T, name } = createTopicTable();
		class Rewritten extends T {
			async subscribe(target) {
				const inner = await super.subscribe(target);
				const outer = new IterableEventQueue();
				outer.end = () => {
					inner.end();
					outer.close();
				};
				inner.on('data', (event) => outer.send({ ...event, id: event.id.replace(/\/raw$/, '/temp') }));
				return outer;
			}
		}
		Resources.resources.set(`Rewritten${name}`, Rewritten, { mqtt: true });
		const received = [];
		const session = await mqttSession(`id-pattern-rewritten-${tableCount}`, received, `Rewritten${name}/`);
		ended.push(await session.addSubscription({ topic: `Rewritten${name}/site/+/temp`, qos: 0 }, false));
		await T.publish('site/x/raw', { name: 'x' });
		await waitFor(() => received.length > 0);
		assert.deepStrictEqual(received, ['site/x/temp']);
	});

	it('keeps a resource that decorates its subscription’s send on the key walk, so the ids it rewrites still match', async () => {
		const { T, name } = createTopicTable();
		class Decorated extends T {
			async subscribe(target) {
				const subscription = await super.subscribe(target);
				const send = subscription.send;
				subscription.send = (event) => send.call(subscription, { ...event, id: event.id.replace(/\/raw$/, '/temp') });
				return subscription;
			}
		}
		Resources.resources.set(`Decorated${name}`, Decorated, { mqtt: true });
		const received = [];
		const session = await mqttSession(`id-pattern-decorated-${tableCount}`, received, `Decorated${name}/`);
		const subscription = await session.addSubscription({ topic: `Decorated${name}/site/+/temp`, qos: 0 }, false);
		ended.push(subscription);
		assert.strictEqual(subscription.subscriptions.key, 'site/');
		await T.publish('site/x/raw', { name: 'x' });
		await waitFor(() => received.length > 0);
		assert.deepStrictEqual(received, ['site/x/temp']);
	});

	it('moves a subscription whose send Harper wraps to track its progress', async () => {
		const { T } = createTopicTable();
		const received = [];
		const subscription = await T.subscribe({
			id: 'site/',
			isCollection: true,
			omitCurrent: true,
			reportProgress: true,
			listener: (event) => received.push(event.id),
		});
		ended.push(subscription);
		assert.strictEqual(routeByIdPattern(subscription, 'site/+/temp'), true);
		await T.publish('site/a/humidity', { name: 'a' });
		await T.publish('site/a/temp', { name: 'a' });
		await waitFor(() => received.length > 0);
		assert.deepStrictEqual(received, ['site/a/temp']);
	});

	it('moves a subscription to a resource that extends a table without overriding subscribe', async () => {
		const { T, name } = createTopicTable();
		class Readable extends T {
			get(target) {
				return super.get(target);
			}
		}
		Resources.resources.set(`Readable${name}`, Readable, { mqtt: true });
		const received = [];
		const session = await mqttSession(`id-pattern-readable-${tableCount}`, received, `Readable${name}/`);
		const subscription = await session.addSubscription({ topic: `Readable${name}/site/+/temp`, qos: 0 }, false);
		ended.push(subscription);
		assert.strictEqual(typeof subscription.subscriptions.key, 'symbol');
		await T.publish('site/x/humidity', { name: 'x' });
		await T.publish('site/x/temp', { name: 'x' });
		await waitFor(() => received.length > 0);
		assert.deepStrictEqual(received, ['site/x/temp']);
	});

	it('keeps a resource that overrides subscribe on the key walk, even when it returns the table’s subscription as is', async () => {
		const { T, name } = createTopicTable();
		class Passthrough extends T {
			subscribe(target) {
				return super.subscribe(target);
			}
		}
		Resources.resources.set(`Passthrough${name}`, Passthrough, { mqtt: true });
		const session = await mqttSession(`id-pattern-passthrough-${tableCount}`, []);
		const subscription = await session.addSubscription({ topic: `Passthrough${name}/site/+/temp`, qos: 0 }, false);
		ended.push(subscription);
		assert.strictEqual(subscription.subscriptions.key, 'site/');
	});

	it('keeps a resource that overrides subscribe with an instance field on the key walk', async () => {
		const { T, name } = createTopicTable();
		class Field extends T {
			subscribe = (target) => super.subscribe(target);
		}
		Resources.resources.set(`Field${name}`, Field, { mqtt: true });
		const session = await mqttSession(`id-pattern-field-${tableCount}`, []);
		const subscription = await session.addSubscription({ topic: `Field${name}/site/+/temp`, qos: 0 }, false);
		ended.push(subscription);
		assert.strictEqual(subscription.subscriptions.key, 'site/');
	});

	it('keeps a resource that narrows its target to a namespace of its own on the key walk', async () => {
		const { T, name } = createTopicTable();
		class Scoped extends T {
			subscribe(target) {
				target.id = this.getCurrentUser().username + '/';
				return super.subscribe(target);
			}
		}
		Resources.resources.set(`Scoped${name}`, Scoped, { mqtt: true });
		const alice = { username: 'alice', role: { permission: { super_user: true } } };
		const session = await getSession({ clientId: `id-pattern-scoped-${tableCount}`, user: alice, clean: true });
		const received = [];
		session.listener = (topic) => {
			received.push(topic.slice(topic.indexOf('/') + 1));
		};
		const subscription = await session.addSubscription({ topic: `Scoped${name}/+/temp`, qos: 0 }, false);
		ended.push(subscription);
		assert.strictEqual(subscription.subscriptions.key, 'alice/');
		// one subscription delivers in log order, so bob's record would arrive before alice's
		await T.publish('bob/temp', { name: 'bob’s' });
		await T.publish('alice/temp', { name: 'alice’s' });
		await waitFor(() => received.includes('alice/temp'));
		assert.deepStrictEqual(received, ['alice/temp']);
	});

	for (const [narrowing, narrow] of [
		['to its children', (target) => (target.onlyChildren = true)],
		['to the record itself', (target) => (target.isCollection = false)],
	]) {
		it(`keeps a resource that narrows its subscription ${narrowing} on the key walk`, async () => {
			const { T, name } = createTopicTable();
			class Narrowed extends T {
				subscribe(target) {
					narrow(target);
					return super.subscribe(target);
				}
			}
			Resources.resources.set(`Narrowed${name}`, Narrowed, { mqtt: true });
			const session = await getSession({ clientId: `id-pattern-narrowed-${tableCount}`, user, clean: true });
			session.listener = () => {};
			const subscription = await session.addSubscription({ topic: `Narrowed${name}/site/+/temp`, qos: 0 }, false);
			ended.push(subscription);
			assert.strictEqual(subscription.subscriptions.key, 'site/');
		});
	}

	it('keeps MQTT wildcard topics delivering exactly their matches', async () => {
		const { name } = createTopicTable();
		// the expectations of unitTests/apiTests/mqtt-test.mjs, through in-process sessions
		const expectations = {
			'+/33': ['sub/33'],
			'sub/+': ['sub/33'],
			'sub/+/33': ['sub/sub2/33'],
			'+/+/+': ['sub/sub2/33'],
			'+/sub2/+': ['sub/sub2/33'],
			'+/+': ['sub/33'],
			'sub/#': ['sub/33', 'sub/sub2/33'],
			'+/sub2/#': ['sub/sub2/33'],
		};
		const received = {};
		const routed = [];
		let sessionCount = 0;
		for (const filter in expectations) {
			received[filter] = [];
			const clientId = `id-pattern-${tableCount}-${++sessionCount}`;
			const session = await mqttSession(clientId, received[filter], `${name}/`);
			const subscription = await session.addSubscription({ topic: `${name}/${filter}`, qos: 0 }, false);
			ended.push(subscription);
			if (typeof subscription.subscriptions?.key === 'symbol') routed.push(filter);
		}
		// a trailing '+' and a bare '#' are delivered by the key walk
		assert.deepStrictEqual(routed, ['+/33', 'sub/+/33', '+/+/+', '+/sub2/+', '+/+', '+/sub2/#']);
		const publisher = await getSession({ clientId: `id-pattern-publisher-${tableCount}`, user, clean: true });
		for (const topic of ['44', 'sub/33', 'sub/sub2/33']) {
			await publisher.publish({ topic: `${name}/${topic}`, retain: false, qos: 0 }, { name: topic });
		}
		await waitFor(() =>
			Object.entries(expectations).every(([filter, topics]) => received[filter].length >= topics.length)
		);
		// every '#' subscription matches this one, so anything unexpected would have arrived before it
		await publisher.publish({ topic: `${name}/sub/sub2/last`, retain: false, qos: 0 }, { name: 'last' });
		await waitFor(() => received['sub/#'].includes('sub/sub2/last') && received['+/sub2/#'].includes('sub/sub2/last'));
		for (const [filter, topics] of Object.entries(expectations)) {
			assert.deepStrictEqual(
				received[filter].filter((topic) => topic !== 'sub/sub2/last'),
				topics,
				`subscription to ${filter}`
			);
		}
	});

	it('routes a record to a table-backed # topic only when it has every level before the #', async () => {
		const { T, name } = createTopicTable();
		const received = [];
		const session = await mqttSession(`id-pattern-table-levels-${tableCount}`, received, `${name}/`);
		const subscription = await session.addSubscription({ topic: `${name}/a/+/+/#`, qos: 0 }, false);
		ended.push(subscription);
		assert.strictEqual(typeof subscription.subscriptions.key, 'symbol');
		for (const id of ['a/z', 'a/z/w', ['a', 'y'], ['a', 'y', 'w'], 'a/z/w/v']) await T.put(id, { name: 'z' });
		await waitFor(() => received.includes('a/z/w/v'));
		assert.deepStrictEqual(received, ['a/z/w', 'a/y/w', 'a/z/w/v']);
	});

	it('delivers a record to a # topic only when it has every level before the #, through the filter alone', async () => {
		const name = `IdPatternLevels${++tableCount}`;
		const queue = new IterableEventQueue();
		queue.end = () => queue.close();
		class Levels extends Resource {
			static subscribe() {
				return queue;
			}
		}
		Resources.resources.set(name, Levels, { mqtt: true });
		const session = await getSession({ clientId: `id-pattern-levels-${tableCount}`, user, clean: true });
		const received = [];
		session.setListener((topic) => {
			received.push(topic.slice(name.length + 1));
			return true;
		});
		await session.addSubscription({ topic: `${name}/a/+/+/#`, qos: 0, rh: 2 }, false);
		for (const id of ['a/x', 'a/x/y', 'a/z', 'a/z/w/v']) queue.send({ id, value: { id }, type: 'put' });
		await waitFor(() => received.includes('a/z/w/v'));
		assert.deepStrictEqual(received, ['a/x/y', 'a/z/w/v']);
		session.disconnect(true);
	});
});
