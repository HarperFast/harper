require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { RequestTarget } = require('#src/resources/RequestTarget');
const analytics = require('#src/resources/analytics/write');
const { waitFor } = require('../waitFor.js');

// might want to enable an iteration with NATS being assigned as a source
describe('CRUD operations with the Resource API', () => {
	let CRUDTable, CRUDRelatedTable;
	const PUBLISHED_MESSAGE_BYTES = 2048;
	const FLUSH_RACE_BYTES = 987654;
	let publishIteration = 0;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		let relationship_attribute = {
			name: 'related',
			type: 'CRUDRelatedTable',
			relationship: { from: 'relatedId' },
			definition: {},
		};
		analytics.analyticsDelay = 50; // let's make this fast
		analytics.setAnalyticsEnabled(true);
		CRUDTable = table({
			table: 'CRUDTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'sparse', indexed: true },
				{ name: 'relatedId', indexed: true },
				{ name: 'notIndexed' },
				relationship_attribute,
				{ name: 'computed', enumerable: true, computed: true, indexed: true },
				{
					name: 'nestedData',
					properties: [
						{ name: 'id', type: 'String' },
						{ name: 'name', type: 'String' },
					],
				},
				{ name: 'createdAt', type: 'Date', assignCreatedTime: true },
				{ name: 'updatedAt', type: 'Date', assignUpdatedTime: true },
			],
		});
		CRUDTable.loadAsInstance = false;
		CRUDTable.setComputedAttribute('computed', (instance) => instance.name + ' computed');
		const children_of_self_attribute = {
			name: 'childrenOfSelf',
			relationship: { to: 'parentId' },
			elements: { type: 'CRUDRelatedTable', definition: {} },
		};
		const parent_of_self_attribute = {
			name: 'parentOfSelf',
			relationship: { from: 'parentId' },
			type: 'CRUDRelatedTable',
			definition: {},
		};
		CRUDRelatedTable = table({
			table: 'CRUDRelatedTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'Int' },
				{ name: 'aFlag', type: 'Boolean', indexed: true },
				{ name: 'name', indexed: true },
				{ name: 'parentId', indexed: true },
				{
					name: 'relatedToMany',
					relationship: { to: 'relatedId' },
					elements: { type: 'CRUDTable', definition: { tableClass: CRUDTable } },
				},
				children_of_self_attribute,
				parent_of_self_attribute,
			],
		});
		CRUDRelatedTable.loadAsInstance = false;
		relationship_attribute.definition.tableClass = CRUDRelatedTable;
		children_of_self_attribute.elements.definition.tableClass = CRUDRelatedTable;
		parent_of_self_attribute.definition.tableClass = CRUDRelatedTable;

		for (let i = 0; i < 5; i++) {
			CRUDRelatedTable.put({
				id: i,
				name: 'related name ' + i,
				aFlag: i % 3 === 0,
				parentId: i % 2,
			});
		}
		let last;
		for (let i = 0; i < 100; i++) {
			last = CRUDTable.put({
				id: 'id-' + i,
				name: i > 0 ? 'name-' + i : null,
				relatedId: i % 5,
				sparse: i % 6 === 2 ? i : null,
				notIndexed: 'not indexed ' + i,
				nestedData: i > 0 ? { id: 'nested-' + i, name: 'nested name ' + i } : null,
			});
		}
		await last;
	});
	describe('CRUD operations with no loadAsInstance', () => {
		registerTests();
	});
	describe('CRUD operations with loadAsInstance = false', () => {
		before(async function () {
			CRUDTable.loadAsInstance = false;
			CRUDRelatedTable.loadAsInstance = false;
		});
		registerTests();
	});
	describe('CRUD operations with loadAsInstance = true', () => {
		before(async function () {
			CRUDTable.loadAsInstance = true;
			CRUDRelatedTable.loadAsInstance = true;
		});
		registerTests();
	});
	// A stored record reports the MEAN of its aggregation window, which a preceding test's small
	// writes (a delete records 1 byte) can drag under the threshold when the window's unref'd flush
	// timer slips. These assertions mean "one operation recorded more than N bytes": the window's
	// largest single value, which the percentile distribution always carries because it runs to the
	// 100th percentile.
	function largestRecordedValue(metric) {
		if (!Array.isArray(metric?.distribution)) return undefined;
		let largest = -Infinity;
		for (const entry of metric.distribution) {
			const value = typeof entry === 'number' ? entry : entry?.value;
			if (typeof value === 'number' && value > largest) largest = value;
		}
		return largest === -Infinity ? undefined : largest;
	}
	it('reads the largest single write from a distribution rather than the window mean', function () {
		const diluted = { mean: 8.333333333333334, count: 3, distribution: [{ value: 1, count: 2 }, 23] };
		assert(!(diluted.mean > 20));
		assert.equal(largestRecordedValue(diluted), 23);
		assert.equal(largestRecordedValue({ distribution: [28] }), 28);
		assert.equal(largestRecordedValue({ distribution: [44, { value: 78, count: 65 }, 79] }), 79);
		assert.equal(largestRecordedValue({ distribution: [] }), undefined);
		assert.equal(largestRecordedValue({ mean: 12 }), undefined);
	});
	it('keeps an analytics sample recorded while its window is being flushed', async function () {
		const start = Date.now();
		let sentinelRecorded = false;
		analytics.addAnalyticsListener((metrics) => {
			if (sentinelRecorded || !metrics.some((entry) => entry?.metric === 'db-write' && entry?.path === 'CRUDTable'))
				return;
			sentinelRecorded = true;
			analytics.recordAction(FLUSH_RACE_BYTES, 'db-write', 'CRUDTable', null);
		});
		analytics.recordAction(64, 'db-write', 'CRUDTable', null);
		await waitForAnalyticsMetrics(['db-write'], start, FLUSH_RACE_BYTES - 1, 5000);
	});
	async function waitForAnalyticsMetrics(metricNames, start, minBytes, timeout) {
		const observed = [];
		try {
			return await waitFor(
				async () => {
					if (!databases.system?.hdb_raw_analytics) return undefined;
					const analyticsResults = await databases.system.hdb_raw_analytics.search({
						conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: start }],
					});
					const recorded = new Set();
					observed.length = 0;
					for await (let { metrics } of analyticsResults) {
						if (!Array.isArray(metrics)) continue;
						for (const entry of metrics) {
							if (entry?.path !== 'CRUDTable' || !metricNames.includes(entry.metric)) continue;
							const largest = largestRecordedValue(entry);
							observed.push(`${entry.metric} max ${largest} (count ${entry.count}, mean ${entry.mean})`);
							if (largest > minBytes) recorded.add(entry.metric);
						}
						if (metricNames.every((name) => recorded.has(name))) return true;
					}
					return undefined;
				},
				{ timeout, message: `${metricNames.join(' and ')} byte counts over ${minBytes} were recorded in analytics` }
			);
		} catch (error) {
			error.message += `; observed ${observed.length ? observed.join('; ') : 'no CRUDTable analytics records'}`;
			throw error;
		}
	}
	function registerTests() {
		it('puts', async function () {
			const start = Date.now();
			await CRUDTable.put({
				id: 'one',
				name: 'One',
				relatedId: 1,
				sparse: null,
				notIndexed: 'this data is not indexed',
				nestedData: { id: 'some-id', name: 'nested name ' },
			});
			assert.equal((await CRUDTable.get('one')).name, 'One');
			await CRUDTable.put('two', {
				name: 'Two',
				relatedId: 1,
				sparse: null,
				notIndexed: 'this data is not indexed',
				nestedData: { id: 'some-id', name: 'nested name ' },
			});
			assert.equal((await CRUDTable.get('two')).name, 'Two');
			await waitForAnalyticsMetrics(['db-write'], start, 2);
		});
		it('get is recorded in analytics', async function () {
			const start = Date.now();
			assert.equal((await CRUDTable.get('two')).name, 'Two');
			await waitForAnalyticsMetrics(['db-read'], start, 20);
		});
		it('gets', async function () {
			const context = {};
			let record = await CRUDTable.get('one', context);
			if (!CRUDTable.loadAsInstance) {
				assert(Object.isFrozen(record));
				assert(Object.isFrozen(record.nestedData));
				assert(Object.isFrozen(record.related));
			}
			const jsonCopy = JSON.parse(JSON.stringify(record));
			assert(Object.keys(jsonCopy).includes('computed')); // verify that this computed attribute was marked as enumerable
			assert.equal(record.name, 'One');
			for await (let record of CRUDTable.search([])) {
				if (!CRUDTable.loadAsInstance) {
					assert(Object.isFrozen(record));
					assert(Object.isFrozen(record.nestedData));
					assert(Object.isFrozen(record.related));
				}
			}
		});
		it('update', async function () {
			const context = {};
			await transaction(context, async () => {
				let updatable = await CRUDTable.update('one', context);
				updatable.name = 'One updated';
			});
			assert.equal((await CRUDTable.get('one')).name, 'One updated');
		});
		it('deletes', async function () {
			await CRUDTable.delete('one');
			assert.equal(await CRUDTable.get('one'), undefined);
			let target = new RequestTarget();
			target.id = 'two';
			await CRUDTable.delete(target);
			assert.equal(await CRUDTable.get('two'), undefined);
		});
		it('publishes and subscribes', async function () {
			const start = Date.now();
			const messages = [];
			const subscription = await CRUDTable.subscribe('pubsub');
			subscription.on('data', (message) => {
				messages.push(message);
			});
			// Each registerTests() run publishes a larger payload than the one before it. A record's id
			// is stamped when its window is flushed rather than when it closed, so an earlier run's
			// window can still be returned to this one; requiring more bytes than that run could have
			// written is what ties the assertion below to this run's publish.
			const payloadBytes = PUBLISHED_MESSAGE_BYTES * ++publishIteration;
			await CRUDTable.publish('pubsub', {
				id: 'pubsub',
				name: 'A published message'.padEnd(payloadBytes, '.'),
			});
			await waitFor(() => messages.length >= 1);
			assert.equal(messages.length, 1);
			await waitForAnalyticsMetrics(['db-write', 'db-message'], start, payloadBytes, 5000);
		});
		it('create with auto-id', async function () {
			let created = await CRUDTable.create({ relatedId: 1, name: 'constructed with auto-id' });
			let retrieved = await CRUDTable.get(created.id);
			assert.equal(retrieved.name, 'constructed with auto-id');
		});
		it('create via post with auto-id, check timestamps', async function () {
			let start = new Date(Date.now() - 100);
			for (let i = 0; i < 20; i++) {
				let createdId = await CRUDTable.post({ relatedId: 1, name: 'constructed via post with auto-id' });
				let retrieved = await CRUDTable.get(createdId);
				assert.equal(retrieved.name, 'constructed via post with auto-id');
				assert(
					retrieved.createdAt >= start,
					`Expected createdAt to be >= ${start.toISOString()}, got ${retrieved.createdAt.toISOString()}`
				);
				assert(
					retrieved.updatedAt >= start,
					`Expected updatedAt to be >= ${start.toISOString()}, got ${retrieved.updatedAt.toISOString()}`
				);
			}
		});
		it('create in transaction', async function () {
			let context = {};
			let created;
			await transaction(context, async () => {
				created = await CRUDTable.create({ relatedId: 1, name: 'constructed with auto-id' });
			});
			let retrieved = await CRUDTable.get(created.id);
			assert.equal(retrieved.name, 'constructed with auto-id');
		});
		it('create with known id argument', async function () {
			let created;
			await CRUDTable.delete('three');
			if (CRUDTable.loadAsInstance) created = await CRUDTable.create({ id: 'three', relatedId: 1, name: 'Three' });
			else created = await CRUDTable.create('three', { relatedId: 1, name: 'Three' });
			assert.equal(created.id, 'three');
			let retrieved = await CRUDTable.get('three');
			assert.equal(retrieved.name, 'Three');
			await assert.rejects(async () => {
				if (CRUDTable.loadAsInstance) created = await CRUDTable.create({ id: 'three', relatedId: 1, name: 'Three' });
				else created = await CRUDTable.create('three', { relatedId: 1, name: 'Three' });
			});
		});
		it('delete all and recreate', async function () {
			await CRUDTable.put({
				id: 'one',
				name: 'One',
				relatedId: 1,
				sparse: null,
			});
			await CRUDTable.put({
				id: 'two',
				name: 'Two',
				relatedId: 1,
				sparse: null,
			});
			let target = new RequestTarget('/');
			await CRUDTable.delete(target);
			await CRUDTable.put({
				id: 'one',
				name: 'One',
				relatedId: 2,
				sparse: null,
			});
			for await (let _entry of CRUDTable.search([{ attribute: 'relatedId', value: 1 }])) {
				throw new Error('should not have found any related records with relatedId = 1');
			}
		});
	}
	after(() => {
		analytics.setAnalyticsEnabled(false); // restore to normal unit test behavior
	});
});

describe('transactional argument normalization with RequestTarget', () => {
	let BaseTable, SubTable;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		BaseTable = table({
			table: 'NormTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }, { name: 'stamped' }],
		});
		// Subclass that overrides static put and calls super.put(RequestTarget, body) —
		// the form that previously misidentified (RequestTarget, data) as (data, context).
		SubTable = class extends BaseTable {
			static async put(target, data) {
				const body = await data;
				body.stamped = true;
				return super.put(target, body);
			}
		};
		Object.defineProperty(SubTable, 'name', { value: 'SubTable' });
	});

	it('super.put(RequestTarget, body) stores body data, not the RequestTarget', async function () {
		const target = new RequestTarget('/rt-test-1');
		await SubTable.put(target, { title: 'hello' });
		const record = await SubTable.get('rt-test-1');
		assert.equal(record.title, 'hello', 'body data should be stored');
		assert.equal(record.stamped, true, 'override logic should have run');
		assert.equal(record.id, 'rt-test-1', 'id should come from the RequestTarget path');
		assert.ok(!record.pathname, 'RequestTarget descriptor fields must not be stored as record data');
	});

	it('super.put(string_id, body) continues to work', async function () {
		await SubTable.put('rt-test-2', { title: 'world' });
		const record = await SubTable.get('rt-test-2');
		assert.equal(record.title, 'world');
		assert.equal(record.stamped, true);
	});
});

describe('instance post on a collection target', () => {
	let PostBase, PostSub;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		PostBase = table({
			table: 'InstancePostTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }, { name: 'stamped' }],
		});
		// Subclass that overrides instance post and delegates to super.post(record)
		PostSub = class extends PostBase {
			async post(data) {
				data.stamped = true;
				return super.post(data);
			}
		};
		Object.defineProperty(PostSub, 'name', { value: 'PostSub' });
	});

	it('super.post(record) from a bare collection target creates the record', async function () {
		const target = new RequestTarget('');
		const id = await PostSub.post(target, { title: 'created' });
		assert.ok(id != null, 'create should return the new id');
		const record = await PostSub.get(id);
		assert.strictEqual(record.title, 'created');
		assert.strictEqual(record.stamped, true, 'instance override should have run');
	});

	it('an argless RequestTarget (unconfigured, undefined id) still rejects post', async function () {
		await assert.rejects(
			async () => PostSub.post(new RequestTarget(), { title: 'nope' }),
			/does not have a post method/
		);
	});

	it('instance post on an identified resource still 405s', async function () {
		await PostSub.put('existing-1', { title: 'x' });
		await assert.rejects(
			async () => PostSub.post(new RequestTarget('/existing-1'), { title: 'y' }),
			/does not have a post method/
		);
	});
});
