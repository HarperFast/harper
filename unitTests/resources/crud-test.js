require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { parseQuery } = require('../../resources/search');
const { table } = require('../../resources/databases');
const { transaction } = require('../../resources/transaction');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const { RequestTarget } = require('../../resources/RequestTarget');
const analytics = require('../../resources/analytics/write');
const { analyticsDelay } = require('../../resources/analytics/write');

// might want to enable an iteration with NATS being assigned as a source
describe('CRUD operations with the Resource API', () => {
	let CRUDTable, CRUDRelatedTable;
	let long_str = 'testing' + Math.random();
	let defaultAnalyticsDelay = analytics.analyticsDelay;
	for (let i = 0; i < 10; i++) {
		long_str += 'testing';
	}
	before(async function () {
		getMockLMDBPath();
		setMainIsWorker(true);
		let relationship_attribute = {
			name: 'related',
			type: 'CRUDRelatedTable',
			relationship: { from: 'relatedId' },
			definition: {},
		};
		analytics.analyticsDelay = 50; // let's make this fast
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
				{ name: 'computed', computed: true, indexed: true },
				{
					name: 'nestedData',
					properties: [
						{ name: 'id', type: 'String' },
						{ name: 'name', type: 'String' },
					],
				},
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
			await new Promise((resolve) => setTimeout(resolve, 100));
			const analyticsResults = await databases.system.hdb_raw_analytics.search({
				conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: start }],
			});
			let analyticRecorded;
			for await (let { metrics } of analyticsResults) {
				analyticRecorded = metrics.find(({ metric, path }) => metric === 'db-write' && path === 'CRUDTable');
				if (analyticRecorded) break;
			}
			assert(analyticRecorded, 'db-write was recorded in analytics');
			assert(analyticRecorded.mean > 20, 'db-write bytes count were recorded in analytics');
		});
		it('get is recorded in analytics', async function () {
			const start = Date.now();
			assert.equal((await CRUDTable.get('two')).name, 'Two');
			await new Promise((resolve) => setTimeout(resolve, 100));
			const analyticsResults = await databases.system.hdb_raw_analytics.search({
				conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: start }],
			});
			let analyticRecorded;
			for await (let { metrics } of analyticsResults) {
				analyticRecorded = metrics.find(({ metric, path }) => metric === 'db-read' && path === 'CRUDTable');
				if (analyticRecorded) break;
			}
			assert(analyticRecorded, 'db-read was recorded in analytics');
			assert(analyticRecorded.mean > 20, 'db-read bytes count were recorded in analytics');
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
			await CRUDTable.publish('pubsub', {
				id: 'pubsub',
				name: 'A published message',
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(messages.length, 1);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const analyticsResults = await databases.system.hdb_raw_analytics.search({
				conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: start }],
			});
			let publishRecorded, messageRecorded;
			for await (let { metrics } of analyticsResults) {
				publishRecorded = metrics.find(({ metric, path }) => metric === 'db-write' && path === 'CRUDTable');
				messageRecorded = metrics.find(({ metric, path }) => metric === 'db-message' && path === 'CRUDTable');
				if (publishRecorded) break;
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
		it('create with instance', async function () {
			let context = {};
			let created;
			await transaction(context, () => {
				let crud = CRUDTable.getResource(null, context);
				created = crud.create({ relatedId: 1, name: 'constructed with auto-id' });
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
	}
	after(() => {
		analytics.analyticsDelay = defaultAnalyticsDelay;
	});
});
