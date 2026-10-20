const assert = require('node:assert');
const { isDeepStrictEqual } = require('node:util');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor.js');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Attribute read permissions on subscription deliveries', () => {
	let Doc, StaticDoc;
	let resolverCalls = 0;
	const subscriptions = [];
	const EVENT_FIELDS = new Set(['id', 'localTime', 'value', 'version', 'type', 'size', 'beginTxn', 'fromScan']);
	const user = {
		role: {
			permission: {
				subselect: {
					tables: {
						SelectDoc: {
							read: true,
							insert: true,
							update: true,
							delete: false,
							attribute_permissions: [
								{ attribute_name: 'id', read: true, insert: true, update: true },
								{ attribute_name: 'title', read: true, insert: true, update: true },
								{ attribute_name: 'shout', read: true, insert: false, update: false },
								{ attribute_name: 'secret', read: false, insert: false, update: false },
							],
						},
					},
				},
			},
		},
	};
	const asUser = () => ({ user, authorize: true });

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		Doc = table({
			database: 'subselect',
			table: 'SelectDoc',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'title' },
				{ name: 'secret' },
				{ name: 'shout', computed: true },
			],
		});
		Doc.setComputedAttribute('shout', (record) => {
			resolverCalls++;
			return record.title?.toUpperCase();
		});
		StaticDoc = class extends Doc {
			static loadAsInstance = false;
		};
	});
	afterEach(() => {
		for (const subscription of subscriptions.splice(0)) subscription.end();
	});

	// the way MQTT subscribes: a context is only recognized once it carries a transaction
	async function subscribe(Table, request, context = {}) {
		const events = [];
		const target = { ...request, listener: (event) => events.push(event) };
		subscriptions.push(await transaction(context, () => Table.subscribe(target, context)));
		return events;
	}
	const recordEvents = (events) => events.filter((event) => event.value != null);
	function assertNoSecret(events) {
		assert.ok(recordEvents(events).length > 0, 'something was delivered');
		for (const event of recordEvents(events)) {
			assert.ok(!('secret' in event.value), JSON.stringify(event.value));
			assert.ok('title' in event.value, JSON.stringify(event.value));
			for (const field of Object.keys(event)) assert.ok(EVENT_FIELDS.has(field), `event field ${field}`);
		}
	}
	const delivered = (events, title) => events.some((event) => event.value?.title === title);

	for (const [mode, getTable] of [
		['loadAsInstance', () => Doc],
		['loadAsInstance = false', () => StaticDoc],
	]) {
		it(`a single-record subscription omits unreadable attributes from every event (${mode})`, async () => {
			const Table = getTable();
			const id = `one-${mode}`;
			await Doc.put(id, { title: 'current', secret: 's' });
			const events = await subscribe(Table, { id }, asUser());
			const superUser = await subscribe(Table, { id });
			await waitFor(() => delivered(events, 'current'));
			await Doc.put(id, { title: 'put', secret: 's' });
			await Doc.patch(id, { title: 'patch' });
			await Doc.publish(id, { title: 'message', secret: 's' });
			await waitFor(() => delivered(events, 'message') && delivered(superUser, 'message'));
			// a put superseded before delivery is coalesced into the patch
			const expected = [{ id, title: 'current' }, { id, title: 'put' }, { id, title: 'patch' }, { title: 'message' }];
			for (const event of recordEvents(events))
				assert.ok(
					expected.some((value) => isDeepStrictEqual(event.value, value)),
					JSON.stringify(event.value)
				);
			assert.ok(delivered(events, 'patch'));
			assertNoSecret(events);
			assert.ok(recordEvents(superUser).every((event) => event.value.secret === 's'));
		});
	}

	it('history replayed from a start time omits unreadable attributes and audit fields', async () => {
		await Doc.put('history', { title: 'first', secret: 's' });
		await Doc.put('history', { title: 'second', secret: 's' });
		const events = await subscribe(Doc, { id: 'history', startTime: 1, includeSuperseded: true }, asUser());
		await waitFor(() => delivered(events, 'second'));
		assert.ok(delivered(events, 'first'));
		assertNoSecret(events);
	});

	it('a collection scan, start-time replay and previous count omit unreadable attributes', async () => {
		await Doc.put('collection', { title: 'collected', secret: 's' });
		const requests = [{ isCollection: true }, { isCollection: true, startTime: 1 }];
		// collection previousCount history is LMDB-only, as in subscriptionReplay.test.js
		if (isLMDB) requests.push({ isCollection: true, previousCount: 3 });
		for (const request of requests) {
			const events = await subscribe(Doc, request, asUser());
			await waitFor(() => delivered(events, 'collected'), {
				message: () => `${JSON.stringify(request)}: ${JSON.stringify(events)}`,
			});
			assertNoSecret(events);
		}
	});

	it('a raw patch event keeps an attribute the patch removes', async () => {
		await Doc.put('raw', { title: 'raw', secret: 's' });
		const events = await subscribe(Doc, { id: 'raw', rawEvents: true, omitCurrent: true }, asUser());
		await Doc.patch('raw', { title: undefined, secret: 'changed' });
		await waitFor(() => events.some((event) => event.type === 'patch'));
		const patch = events.find((event) => event.type === 'patch').value;
		assert.ok(Object.hasOwn(patch, 'title'), JSON.stringify(patch));
		assert.strictEqual(patch.title, undefined);
		assert.ok(!('secret' in patch));
	});

	it('a select naming a computed attribute does not run its resolver', async () => {
		await Doc.put('computed', { title: 'computed', secret: 's' });
		const callsBefore = resolverCalls;
		const events = await subscribe(Doc, { id: 'computed', select: ['title', 'shout', 'secret'] }, asUser());
		await Doc.put('computed', { title: 'computed again', secret: 's' });
		await waitFor(() => delivered(events, 'computed again'));
		assert.deepStrictEqual(
			recordEvents(events).map((event) => event.value),
			[{ title: 'computed' }, { title: 'computed again' }]
		);
		assert.strictEqual(resolverCalls, callsBefore);
	});

	it('opaque message payloads pass through', async () => {
		const events = await subscribe(Doc, { id: 'opaque', omitCurrent: true }, asUser());
		await Doc.publish('opaque', Buffer.from('bytes'));
		await Doc.publish('opaque', 'text');
		await waitFor(() => events.length >= 2);
		assert.ok(Buffer.from('bytes').equals(events[0].value));
		assert.strictEqual(events[1].value, 'text');
	});

	it('an unrestricted subscription delivers the stored record and ignores its own select', async () => {
		await Doc.put('unrestricted', { title: 'stored', secret: 's' });
		const events = await subscribe(Doc, { id: 'unrestricted', select: ['title'] });
		await waitFor(() => delivered(events, 'stored'));
		assert.strictEqual(events[0].value, Doc.primaryStore.getEntry('unrestricted').value);
		assert.strictEqual(events[0].value.secret, 's');
	});
});
