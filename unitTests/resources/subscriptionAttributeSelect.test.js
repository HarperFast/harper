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
	let Doc, StaticDoc, Related;
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
								{ attribute_name: 'later', read: true, insert: true, update: true },
								{ attribute_name: 'constructor', read: true, insert: false, update: false },
								{ attribute_name: 'secret', read: false, insert: false, update: false },
							],
						},
					},
				},
			},
		},
	};
	const asUser = () => ({ user, authorize: true });
	const readOnlyUser = {
		role: {
			permission: { subselect: { tables: { SelectDoc: { read: true, insert: false, update: false, delete: false } } } },
		},
	};
	const docAttributes = (later) => [
		{ name: 'id', isPrimaryKey: true },
		{ name: 'title' },
		{ name: 'secret' },
		{ name: 'shout', computed: true },
		later,
		{ name: 'relatedId' },
		{ name: 'related', relationship: { from: 'relatedId' }, definition: { tableClass: Related } },
	];

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		Related = table({
			database: 'subselect',
			table: 'SelectRelated',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		Doc = table({
			database: 'subselect',
			table: 'SelectDoc',
			audit: true,
			attributes: docAttributes({ name: 'later' }),
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
			// a write not yet delivered when the next one commits is superseded, so each is awaited
			const deliveredToBoth = (title) => waitFor(() => delivered(events, title) && delivered(superUser, title));
			await deliveredToBoth('current');
			await Doc.put(id, { title: 'put', secret: 's' });
			await deliveredToBoth('put');
			await Doc.patch(id, { title: 'patch' });
			await deliveredToBoth('patch');
			await Doc.publish(id, { title: 'message', secret: 's' });
			await deliveredToBoth('message');
			const expected = [{ id, title: 'current' }, { id, title: 'put' }, { id, title: 'patch' }, { title: 'message' }];
			for (const event of recordEvents(events))
				assert.ok(
					expected.some((value) => isDeepStrictEqual(event.value, value)),
					JSON.stringify(event.value)
				);
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
		await waitFor(() => delivered(events, 'computed'));
		await Doc.put('computed', { title: 'computed again', secret: 's' });
		await waitFor(() => delivered(events, 'computed again'));
		// the current record may arrive twice (retained-message semantics)
		const distinct = [];
		for (const { value } of recordEvents(events))
			if (!distinct.some((seen) => isDeepStrictEqual(seen, value))) distinct.push(value);
		assert.deepStrictEqual(distinct, [{ title: 'computed' }, { title: 'computed again' }]);
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

	it('an unrestricted role selecting a relationship still gets the stored record', async () => {
		await Related.put('related-1', { name: 'related' });
		await Doc.put('relationship', { title: 'stored', secret: 's', relatedId: 'related-1' });
		const events = await subscribe(
			Doc,
			{ id: 'relationship', select: ['title', 'related'] },
			{ user: readOnlyUser, authorize: true }
		);
		await waitFor(() => delivered(events, 'stored'));
		assert.strictEqual(events[0].value, Doc.primaryStore.getEntry('relationship').value);
	});

	it('a reload re-snapshot omits unreadable attributes', async () => {
		await Doc.put('reload', { title: 'reloaded', secret: 's' });
		const single = await subscribe(Doc, { id: 'reload', omitCurrent: true }, asUser());
		const collection = await subscribe(Doc, { isCollection: true, omitCurrent: true }, asUser());
		await Doc.writeReloadMarker();
		await waitFor(() => delivered(single, 'reloaded') && delivered(collection, 'reloaded'));
		assertNoSecret(single);
		assertNoSecret(collection);
	});

	it('an attribute that becomes computed while subscribed is not read through its resolver', async () => {
		await Doc.put('schema', { title: 'before', later: 'stored', secret: 's' });
		const events = await subscribe(Doc, { id: 'schema' }, asUser());
		await waitFor(() => delivered(events, 'before'));
		assert.strictEqual(events[0].value.later, 'stored');
		let laterCalls = 0;
		table({
			database: 'subselect',
			table: 'SelectDoc',
			audit: true,
			attributes: docAttributes({ name: 'later', computed: true }),
		});
		Doc.setComputedAttribute('later', () => {
			laterCalls++;
			return 'computed';
		});
		await Doc.patch('schema', { title: 'after' });
		await waitFor(() => delivered(events, 'after'));
		assert.deepStrictEqual(events.at(-1).value, { id: 'schema', title: 'after' });
		assert.strictEqual(laterCalls, 0);
	});

	it('typed random-access records are projected from every delivery source', async () => {
		const Typed = table({
			database: 'subselect',
			table: 'SelectTyped',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true, randomAccessFields: true }, { name: 'title' }, { name: 'secret' }],
		});
		const typedUser = {
			role: {
				permission: {
					subselect: {
						tables: {
							SelectTyped: {
								read: true,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [
									{ attribute_name: 'id', read: true },
									{ attribute_name: 'title', read: true },
									{ attribute_name: 'secret', read: false },
								],
							},
						},
					},
				},
			},
		};
		for (let i = 0; i < 40; i++) await Typed.put(`typed-${i}`, { title: `t${i}`, secret: 's', [`extra${i}`]: i });
		Typed.primaryStore.cache?.clear?.();
		const requests = [
			{ isCollection: true },
			{ isCollection: true, startTime: 1 },
			{ id: 'typed-0', rawEvents: true, startTime: 1 },
			{ id: 'typed-0', startTime: 1, includeSuperseded: true },
		];
		for (const request of requests) {
			const events = await subscribe(Typed, request, { user: typedUser, authorize: true });
			await waitFor(() => delivered(events, 't0'), {
				message: () => `${JSON.stringify(request)}: ${JSON.stringify(events)}`,
			});
			for (const { value } of recordEvents(events)) assert.ok(!('secret' in value), JSON.stringify(value));
		}
	});
});
