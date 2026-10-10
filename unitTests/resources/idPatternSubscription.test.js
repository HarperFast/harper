const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { getSession } = require('#src/server/DurableSubscriptionsSession');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
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
});
