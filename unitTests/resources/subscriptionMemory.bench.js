/**
 * Benchmark: heap retained per live `Table.subscribe()` subscription, with no transport in front of it,
 * for the shapes protocols open: a collection with no current values (MQTT `T/#`, retain handling 2), a
 * record with its current value (`T/id`), and a collection reporting progress with superseded versions
 * included (an MQTT QoS 1 durable session).
 * Run via: npm run build && npx mocha unitTests/resources/subscriptionMemory.bench.js
 * SUBSCRIPTION_MEMORY_BENCH_COUNT sets how many subscriptions each shape holds (default 5000).
 */
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { RequestTarget } = require('#src/resources/RequestTarget');

const COUNT = Number(process.env.SUBSCRIPTION_MEMORY_BENCH_COUNT ?? 5000);

const heapUsed = () => {
	global.gc();
	global.gc();
	return process.memoryUsage().heapUsed;
};

describe('Table.subscribe heap per subscription', function () {
	let T;
	const results = [];
	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			database: 'subscriptionmemorybench',
			table: 'SubscriptionMemory',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		for (let i = 0; i < 100; i++) await T.put(`r${i}`, { value: i, payload: 'x'.repeat(200) });
	});
	after(() => {
		console.log(`\nTable.subscribe heap per subscription (${COUNT} each)`);
		console.table(results);
	});

	const shapes = {
		'collection, omitCurrent': () => {
			const target = new RequestTarget('/');
			target.isCollection = true;
			target.omitCurrent = true;
			return target;
		},
		'record, with current value': (i) => new RequestTarget(`/r${i % 100}`),
		'collection, progress + superseded': () => {
			const target = new RequestTarget('/');
			target.isCollection = true;
			target.omitCurrent = true;
			target.reportProgress = true;
			target.includeSuperseded = true;
			return target;
		},
	};

	for (const [shape, makeTarget] of Object.entries(shapes)) {
		it(shape, async () => {
			const targets = Array.from({ length: COUNT }, (_, i) => makeTarget(i));
			const before = heapUsed();
			const snapshot = process.env.SUBSCRIPTION_MEMORY_BENCH_SNAPSHOT;
			if (snapshot) require('node:v8').writeHeapSnapshot(`${snapshot}-${results.length}-before.heapsnapshot`);
			const subscriptions = [];
			for (let i = 0; i < COUNT; i++) {
				const subscription = await T.subscribe(targets[i]);
				// a consumer drains the current value, as a protocol's delivery loop would
				subscription.on('data', () => {});
				subscriptions.push(subscription);
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
			const after = heapUsed();
			if (snapshot) require('node:v8').writeHeapSnapshot(`${snapshot}-${results.length}-after.heapsnapshot`);
			results.push({ shape, 'B/subscription': Math.round((after - before) / COUNT) });
			for (const subscription of subscriptions) subscription.end();
		});
	}
});
