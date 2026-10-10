const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { RequestTarget } = require('#src/resources/RequestTarget');

// A live subscription holds its listener's small state, not Table.subscribe()'s scope: a long-lived closure
// created inside subscribe() would retain that whole scope, the resource instance and every function declared
// there, about another kilobyte per subscription.
const COUNT = 2000;
const CEILING_BYTES = 600;

const heapUsed = () => {
	global.gc();
	global.gc();
	return process.memoryUsage().heapUsed;
};

describe('Table.subscribe retention', function () {
	this.timeout(30_000);
	let T;
	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			database: 'subscriptionretention',
			table: 'SubscriptionRetention',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		for (let i = 0; i < 10; i++) await T.put(`r${i}`, { value: i });
	});

	async function retainedPerSubscription(makeTarget) {
		const targets = Array.from({ length: COUNT }, (_, i) => makeTarget(i));
		const listener = () => {};
		const before = heapUsed();
		const subscriptions = [];
		for (const target of targets) {
			const subscription = await T.subscribe(target);
			subscription.on('data', listener);
			subscriptions.push(subscription);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
		const retained = (heapUsed() - before) / COUNT;
		for (const subscription of subscriptions) subscription.end();
		return retained;
	}

	it('keeps a live collection subscription under 600 bytes', async () => {
		const retained = await retainedPerSubscription(() => {
			const target = new RequestTarget('/');
			target.isCollection = true;
			target.omitCurrent = true;
			return target;
		});
		assert.ok(retained < CEILING_BYTES, `${Math.round(retained)} B retained per subscription`);
	});

	it('keeps a live record subscription under 600 bytes, once its current value is sent', async () => {
		const retained = await retainedPerSubscription((i) => new RequestTarget(`/r${i % 10}`));
		assert.ok(retained < CEILING_BYTES, `${Math.round(retained)} B retained per subscription`);
	});
});
