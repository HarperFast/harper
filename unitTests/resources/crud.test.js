require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { clearNextEncoding, setNextEncoding } = require('#src/resources/RecordEncoder');
const analytics = require('#src/resources/analytics/write');
const { waitFor } = require('../waitFor.js');

// might want to enable an iteration with NATS being assigned as a source
describe('CRUD operations with the Resource API', () => {
	let CRUDTable, CRUDRelatedTable;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		let relationship_attribute = {
			name: 'related',
			type: 'CRUDRelatedTable',
			relationship: { from: 'relatedId' },
			enumerable: true,
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
	async function waitForAnalyticsMetric(metric, start) {
		return waitFor(
			async () => {
				if (!databases.system?.hdb_raw_analytics) return undefined;
				const analyticsResults = await databases.system.hdb_raw_analytics.search({
					conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: start }],
				});
				for await (let { metrics } of analyticsResults) {
					if (!Array.isArray(metrics)) continue;
					const found = metrics.find((entry) => entry?.metric === metric && entry?.path === 'CRUDTable');
					if (found) return found;
				}
			},
			{ message: `${metric} was recorded in analytics` }
		);
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
			const analyticRecorded = await waitForAnalyticsMetric('db-write', start);
			assert(analyticRecorded.mean > 2, 'db-write bytes count were recorded in analytics');
		});
		it('get is recorded in analytics', async function () {
			const start = Date.now();
			assert.equal((await CRUDTable.get('two')).name, 'Two');
			const analyticRecorded = await waitForAnalyticsMetric('db-read', start);
			assert(analyticRecorded.mean > 20, 'db-read bytes count were recorded in analytics');
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
		it('keeps computed response fields out of durable re-encoding', async function () {
			let computedResolutions = 0;
			CRUDTable.setComputedAttribute('computed', (instance) => {
				computedResolutions++;
				return instance.name + ' computed';
			});
			try {
				await CRUDTable.put({ id: 'durable-computed', name: 'durable', relatedId: 1 });
				const record = await CRUDTable.get('durable-computed');
				const response = JSON.parse(JSON.stringify(record));
				assert.equal(response.computed, 'durable computed');
				assert(computedResolutions > 0, 'response serialization must resolve the computed field');

				computedResolutions = 0;
				const encoder = CRUDTable.primaryStore.encoder;
				const durable = encoder.decode(Buffer.from(encoder.encode(record)), { noMetadata: true });
				assert.equal(computedResolutions, 0, 'durable encoding must not resolve the computed field');
				assert(durable, 'a decoded record must survive durable re-encoding');
				assert.equal(Object.hasOwn(durable, 'computed'), false);
				assert.equal(durable.related.id, 1);

				const legacyRecord = Object.create(encoder.structPrototype);
				Object.assign(legacyRecord, { id: 'legacy-reencode', name: 'trusted', relatedId: 1 });
				Object.defineProperty(legacyRecord, 'computed', { value: 'forged', enumerable: true });
				const legacyEncoding = Buffer.from(encoder.encode(legacyRecord));
				assert.equal(legacyEncoding.includes(Buffer.from('forged')), false);
			} finally {
				CRUDTable.setComputedAttribute('computed', (instance) => instance.name + ' computed');
			}
		});
		it('keeps a no-change instance put clean in the primary store', async function () {
			if (CRUDTable.loadAsInstance !== true) this.skip();
			await CRUDTable.put({ id: 'instance-reput', name: 'instance', relatedId: 1 });
			const instance = await CRUDTable.get('instance-reput');
			await CRUDTable.put(instance);
			const persisted = CRUDTable.primaryStore.getEntry('instance-reput').value;
			assert.equal(Object.hasOwn(persisted, 'computed'), false);
			assert.equal(persisted.computed, 'instance computed');
			const entry = CRUDTable.primaryStore.getEntry('instance-reput');
			const auditRecord = CRUDTable.auditStore.getSync(
				entry.localTime ?? entry.version,
				CRUDTable.tableId,
				'instance-reput'
			);
			assert(auditRecord, 'the no-change put must produce an audit entry');
			assert.equal(Object.hasOwn(auditRecord.getValue(CRUDTable.primaryStore), 'computed'), false);
		});
		it('rejects mutation of a returned read-only computed field', async function () {
			await CRUDTable.put({ id: 'computed-read-only', name: 'read-only', relatedId: 1 });
			const record = await CRUDTable.get('computed-read-only');
			assert.throws(() => (record.computed = 'forged'), /computed.*read.?only/i);
		});
		it('discards a forged computed value from an affected-release payload', async function () {
			const encoder = CRUDTable.primaryStore.encoder;
			const encoded = Buffer.from(
				encoder.encode({ id: 'legacy-computed', name: 'trusted', computed: 'forged', relatedId: 1 })
			);
			const decoded = encoder.decode(encoded, { noMetadata: true });
			assert(decoded, 'legacy payload must materialize');
			assert.equal(Object.hasOwn(decoded, 'computed'), false);
			await CRUDTable.put(decoded);
			assert.equal((await CRUDTable.get('legacy-computed')).computed, 'trusted computed');
			const forgedMatches = await CRUDTable.search({
				conditions: [{ attribute: 'computed', comparator: 'equals', value: 'forged' }],
			}).asArray;
			const resolvedMatches = await CRUDTable.search({
				conditions: [{ attribute: 'computed', comparator: 'equals', value: 'trusted computed' }],
			}).asArray;
			assert.equal(forgedMatches.length, 0);
			assert.equal(
				resolvedMatches.some((record) => record.id === 'legacy-computed'),
				true
			);
		});
		it('returns metadata-prefixed binary decode output as bytes', function () {
			const encoder = CRUDTable.primaryStore.encoder;
			try {
				setNextEncoding(0, 0);
				const encoded = Buffer.from(encoder.encode({ id: 'binary', name: 'durable bytes' }));
				encoder.readOnlyResolverNames.add('0');
				const decoded = encoder.decode(encoded, { valueAsBuffer: true });
				const bytes = decoded.value ?? decoded;
				assert(Buffer.isBuffer(bytes));
				assert(bytes.length > 0);
			} finally {
				clearNextEncoding();
				encoder.readOnlyResolverNames.delete('0');
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
			await new Promise((resolve) => setTimeout(resolve, 100)); // let previous analytics get written
			const start = Date.now();
			const messages = [];
			const subscription = await CRUDTable.subscribe('pubsub');
			subscription.on('data', (message) => {
				messages.push(message);
			});
			await CRUDTable.publish('pubsub', {
				id: 'pubsub',
				name: 'A published message',
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(messages.length, 1);
			// Poll until analytics are flushed (fixed 100ms was too short on a loaded CI runner)
			let publishRecorded, messageRecorded;
			for (let i = 0; i < 20; i++) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				const analyticsResults = await databases.system.hdb_raw_analytics.search({
					conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: start }],
				});
				publishRecorded = undefined;
				messageRecorded = undefined;
				for await (let { metrics } of analyticsResults) {
					publishRecorded ??= metrics.find(({ metric, path }) => metric === 'db-write' && path === 'CRUDTable');
					messageRecorded ??= metrics.find(({ metric, path }) => metric === 'db-message' && path === 'CRUDTable');
					if (publishRecorded && messageRecorded) break;
				}
				if (publishRecorded && messageRecorded) break;
			}
			assert(publishRecorded, 'db-write was recorded in analytics');
			assert(publishRecorded.mean > 20, 'db-write recorded the bytes count');
			assert(messageRecorded, 'db-message was recorded in analytics');
			assert(messageRecorded.mean > 20, 'db-message recorded the bytes count');
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
