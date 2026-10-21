require('../testUtils');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor.js');

describe('Concurrent source misses on one key', function () {
	this.timeout(10000);
	let CoalescingTable;
	let sourceCalls = 0;
	let respond;
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		CoalescingTable = table({
			table: 'SourceFillCoalescingTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		CoalescingTable.sourcedFrom({
			get(id) {
				const attempt = ++sourceCalls;
				return delay(10).then(() => respond(id, attempt));
			},
		});
	});
	beforeEach(() => {
		sourceCalls = 0;
	});
	const concurrentGets = (Table, id, context) =>
		Promise.allSettled(Array.from({ length: 20 }, () => Table.get(id, context && { ...context })));
	const outcomes = (results, read = (value) => value) =>
		results.map(({ status, value, reason }) => (status === 'fulfilled' ? read(value) : reason.message));
	const settle = (id) => waitFor(() => !CoalescingTable.primaryStore.hasLock(id));

	it('share one source call when the source reports the record missing', async function () {
		respond = () => undefined;
		assert.deepEqual(outcomes(await concurrentGets(CoalescingTable, 'missing')), Array(20).fill(undefined));
		assert.equal(sourceCalls, 1);
	});

	it('do not cache an absent record for the next burst', async function () {
		respond = () => undefined;
		await concurrentGets(CoalescingTable, 'missing-twice');
		await settle('missing-twice');
		await concurrentGets(CoalescingTable, 'missing-twice');
		assert.equal(sourceCalls, 2);
	});

	it('share one source call under noCacheStore and store nothing', async function () {
		respond = (id) => ({ id, name: 'uncached ' + id });
		const results = await concurrentGets(CoalescingTable, 'uncached', { noCacheStore: true });
		assert.deepEqual(
			outcomes(results, (record) => record?.name),
			Array(20).fill('uncached uncached')
		);
		assert.equal(sourceCalls, 1);
		await settle('uncached');
		assert.equal(CoalescingTable.primaryStore.getEntry('uncached'), undefined);
	});

	it('share one source call and cache the record when the source returns one', async function () {
		respond = (id) => ({ id, name: 'cached ' + id });
		const results = await concurrentGets(CoalescingTable, 'cached');
		assert.deepEqual(
			outcomes(results, (record) => record?.name),
			Array(20).fill('cached cached')
		);
		assert.equal(sourceCalls, 1);
		await settle('cached');
		assert.equal((await CoalescingTable.get('cached')).name, 'cached cached');
		assert.equal(sourceCalls, 1);
	});

	it('do not share a failed source call', async function () {
		respond = (id, attempt) => {
			if (attempt === 1) throw new Error('first fill fails');
			return { id, name: 'retried ' + id };
		};
		const results = outcomes(await concurrentGets(CoalescingTable, 'retried'), (record) => record?.name);
		assert.equal(sourceCalls, 2);
		assert.equal(results.filter((outcome) => outcome?.startsWith('first fill fails')).length, 1);
		assert.equal(results.filter((outcome) => outcome === 'retried retried').length, 19);
	});

	it('share the retry, not the failure, when a failed call is followed by an absent record', async function () {
		respond = (id, attempt) => {
			if (attempt === 1) throw new Error('first fill fails');
		};
		const results = outcomes(await concurrentGets(CoalescingTable, 'retried-missing'));
		assert.equal(sourceCalls, 2);
		assert.equal(results.filter((outcome) => outcome?.startsWith('first fill fails')).length, 1);
		assert.equal(results.filter((outcome) => outcome == null).length, 19);
	});

	it('keep 0 and -0 apart', async function () {
		respond = (id) => ({ id, name: Object.is(id, -0) ? 'negative zero' : 'zero' });
		const [zero, negativeZero] = await Promise.all([
			concurrentGets(CoalescingTable, 0, { noCacheStore: true }),
			concurrentGets(CoalescingTable, -0, { noCacheStore: true }),
		]);
		assert.deepEqual(
			outcomes(zero, (record) => record?.name),
			Array(20).fill('zero')
		);
		assert.deepEqual(
			outcomes(negativeZero, (record) => record?.name),
			Array(20).fill('negative zero')
		);
		assert.equal(sourceCalls, 2);
	});
});
