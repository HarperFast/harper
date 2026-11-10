const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { Resource } = require('#src/resources/Resource');
const { IterableEventQueue } = require('#src/resources/IterableEventQueue');
const { getSession } = require('#src/server/DurableSubscriptionsSession');
const { addSubscription } = require('#src/resources/transactionBroadcast');
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
		for (const subscription of ended.splice(0)) subscription.end();
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

	// A listener that ends its pattern subscription and registers one of another shape matching the same record
	// appends a shape to the index while the record is routed; the walk visits no more shapes than it started with.
	it('routes a record to no more shapes than were registered before it, however often listeners replace them', async () => {
		const { T } = createTopicTable();
		const patterns = [
			{ levels: ['site', null, 'temp'], prefix: false },
			{ levels: ['site', null, 'temp'], prefix: true },
		];
		let deliveries = 0;
		let current;
		const subscribe = (index) =>
			(current = addSubscription(
				T,
				'site/',
				function () {
					// bounds the walk the cap would otherwise leave running
					if (++deliveries > 50) return;
					this.end();
					subscribe(1 - index);
				},
				0,
				{ idPattern: patterns[index], isCollection: true }
			));
		subscribe(0);
		await T.put('site/1/temp', { name: 'one' });
		await waitFor(() => deliveries > 0);
		await new Promise((resolve) => setImmediate(resolve));
		ended.push(current);
		assert.strictEqual(deliveries, 1, 'the record reached the subscriptions its own delivery registered');
	});

	it('routes a record to no shape registered while it is routed, when a listener also ends a shape not yet visited', async () => {
		const { T } = createTopicTable();
		const reached = [];
		let unvisited;
		let added;
		// registered first, so the walk visits this shape before the next one
		const first = addSubscription(
			T,
			'site/',
			function () {
				reached.push('site/+/temp');
				if (added) return;
				unvisited.end();
				added = addSubscription(T, 'site/', () => reached.push('site/+/temp/#'), 0, {
					idPattern: { levels: ['site', null, 'temp'], prefix: true },
					isCollection: true,
				});
			},
			0,
			{ idPattern: { levels: ['site', null, 'temp'], prefix: false }, isCollection: true }
		);
		unvisited = addSubscription(T, null, () => reached.push('+/a/temp'), 0, {
			idPattern: { levels: [null, 'a', 'temp'], prefix: false },
			isCollection: true,
		});
		ended.push(first);
		await T.put('site/a/temp', { name: 'a' });
		await waitFor(() => reached.length > 0);
		await new Promise((resolve) => setImmediate(resolve));
		ended.push(added);
		assert.deepStrictEqual(reached, ['site/+/temp'], 'a shape registered during routing received the record');
	});

	it('delivers only records whose id matches the pattern', async () => {
		const { T } = createTopicTable();
		const received = [];
		ended.push(
			await T.subscribe({
				id: 'site/',
				isCollection: true,
				omitCurrent: true,
				idPattern: { levels: ['site', null, 'temp'], prefix: false },
				listener: (event) => received.push(event.id),
			})
		);
		const prefixed = [];
		ended.push(
			await T.subscribe({
				id: 'site/',
				isCollection: true,
				omitCurrent: true,
				idPattern: { levels: ['site', null, 'temp'], prefix: true },
				listener: (event) => prefixed.push(event.id),
			})
		);
		// a topic level is a string, so the number 7 does not match the level '7'
		const typed = [];
		ended.push(
			await T.subscribe({
				id: 'site/',
				isCollection: true,
				omitCurrent: true,
				idPattern: { levels: ['site', null, '7'], prefix: false },
				listener: (event) => typed.push(event.id),
			})
		);
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

	it('routes by pattern only while the subscription keeps the pattern’s fixed levels as its id', async () => {
		const { T, name } = createTopicTable();
		// a resource that scopes each user to its own namespace, after the topic was authorized
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
		ended.push(await session.addSubscription({ topic: `Scoped${name}/+/temp`, qos: 0 }, false));
		await T.publish('bob/temp', { name: 'bob’s' });
		await T.publish('alice/temp', { name: 'alice’s' });
		await waitFor(() => received.includes('alice/temp'));
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepStrictEqual(received, ['alice/temp']);
	});

	for (const [narrowing, narrow] of [
		['to its children', (target) => (target.onlyChildren = true)],
		['to the record itself', (target) => (target.isCollection = false)],
	]) {
		it(`routes by pattern only while the subscription takes every descendant, not one narrowed ${narrowing}`, async () => {
			const { T, name } = createTopicTable();
			class Narrowed extends T {
				subscribe(target) {
					narrow(target);
					return super.subscribe(target);
				}
			}
			Resources.resources.set(`Narrowed${name}`, Narrowed, { mqtt: true });
			const sessions = [];
			const received = { narrowed: [], whole: [] };
			for (const [kind, topic] of [
				['narrowed', `Narrowed${name}/site/+/temp`],
				['whole', `${name}/site/+/temp`],
			]) {
				const session = await getSession({ clientId: `id-pattern-${kind}-${tableCount}`, user, clean: true });
				session.listener = (topic) => received[kind].push(topic);
				ended.push(await session.addSubscription({ topic, qos: 0 }, false));
				sessions.push(session);
			}
			await T.publish('site/x/temp', { name: 'x' });
			await waitFor(() => received.whole.length === 1);
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.deepStrictEqual(received.narrowed, [], 'the narrowed subscription takes nothing the pattern matches');
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
		let sessionCount = 0;
		for (const filter in expectations) {
			const session = await getSession({ clientId: `id-pattern-${tableCount}-${++sessionCount}`, user, clean: true });
			received[filter] = [];
			session.listener = (topic) => {
				received[filter].push(topic.slice(name.length + 1));
			};
			const subscription = await session.addSubscription({ topic: `${name}/${filter}`, qos: 0 }, false);
			ended.push(subscription);
		}
		const publisher = await getSession({ clientId: `id-pattern-publisher-${tableCount}`, user, clean: true });
		for (const topic of ['44', 'sub/33', 'sub/sub2/33']) {
			await publisher.publish({ topic: `${name}/${topic}`, retain: false, qos: 0 }, { name: topic });
		}
		await waitFor(() =>
			Object.entries(expectations).every(([filter, topics]) => received[filter].length >= topics.length)
		);
		// a final message every '#' subscription matches, so anything unexpected would have arrived before it
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

	// A '+' needs a level, before a '#' too, as routing by pattern requires: under a/+/+/#, a record a/x has too few
	// levels. A resource that sends its own events reaches the topic filter alone, as a catch-up does.
	it('delivers a record to a # topic only when it has every level before the #', async () => {
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
		await waitFor(() => received.includes('a/z/w/v'), { message: 'the last record with every level' });
		assert.deepStrictEqual(received, ['a/x/y', 'a/z/w/v']);
		session.disconnect(true);
	});
});
