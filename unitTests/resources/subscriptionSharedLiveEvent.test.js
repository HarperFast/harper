const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { ORIGIN_ID } = require('#src/resources/subscriptionCheckpoint');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor.js');
require('#src/server/serverHelpers/serverUtilities');

const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';

// A subscription whose consumer never writes to an event (the MQTT session sets `sharesLiveEvents` on it) takes the
// live event built for the record's other such subscriptions. Every path that writes to an event it does not own
// copies it first, and only subscriptions whose event would be the same share one.
describe('Live events shared across subscriptions that take them', () => {
	let sequence = 0;
	const open = [];
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});
	afterEach(() => {
		for (const subscription of open.splice(0)) subscription.end();
	});

	const newTable = (attributes = [{ name: 'reading' }]) =>
		table({
			database: 'sharedLiveEvent',
			table: `SharedLiveEvent${++sequence}`,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, ...attributes],
		});
	/** Subscribes with a listener that records each event, marking the subscription as the MQTT session does. */
	async function subscribe(T, request = {}, { shares = true, context } = {}) {
		const events = [];
		const target = { omitCurrent: true, ...request, listener: (event) => events.push(event) };
		const subscription = context
			? await transaction(context, () => T.subscribe(target, context))
			: await T.subscribe(target);
		if (shares) subscription.sharesLiveEvents = true;
		open.push(subscription);
		return events;
	}
	const putOf = (id) => (event) => event.type === 'put' && event.id === id;

	it('hands one event object to the subscriptions that take shared events, and its own to one that does not', async () => {
		const T = newTable();
		const first = await subscribe(T);
		const own = await subscribe(T, {}, { shares: false });
		const second = await subscribe(T);
		await T.put({ id: 'a', reading: 1 });
		const isPut = putOf('a');
		await waitFor(() => [first, own, second].every((events) => events.some(isPut)));
		const shared = first.find(isPut);
		assert.strictEqual(second.find(isPut), shared, 'the sharing subscriptions each built an event');
		assert.notStrictEqual(own.find(isPut), shared, 'a subscription that does not take shared events was given one');
		assert.strictEqual(own.find(isPut).value, shared.value);
		assert.strictEqual(shared.value.reading, 1);
	});

	it("projects a role's readable attributes onto a copy, leaving the shared event whole", async () => {
		const T = newTable([{ name: 'title' }, { name: 'secret' }]);
		const attribute = (attribute_name, read) => ({ attribute_name, read, insert: false, update: false });
		const user = {
			role: {
				permission: {
					sharedLiveEvent: {
						tables: {
							[T.tableName]: {
								read: true,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [attribute('id', true), attribute('title', true), attribute('secret', false)],
							},
						},
					},
				},
			},
		};
		// the restricted subscription is notified first, so it is the one that builds the shared event
		const restricted = await subscribe(T, { id: 'doc' }, { context: { user, authorize: true } });
		const whole = await subscribe(T, { id: 'doc' }, { context: {} });
		await T.put('doc', { title: 'title', secret: 'secret' });
		const isPut = putOf('doc');
		await waitFor(() => restricted.some(isPut) && whole.some(isPut));
		assert.deepStrictEqual({ ...restricted.find(isPut).value }, { id: 'doc', title: 'title' });
		assert.strictEqual(whole.find(isPut).value.secret, 'secret', "the restricted role's projection reached the other");
	});

	it('brings a buffered event up to the current record on a copy, leaving the delivered one as it was', async () => {
		const T = newTable();
		for (let i = 0; i < 150; i++) await T.put(`r${String(i).padStart(3, '0')}`, { reading: 0 });
		const live = await subscribe(T, { isCollection: true });
		// a snapshot whose consumer does not read stops mid-scan, so the live events it is sent meanwhile wait
		const snapshot = await T.subscribe({ isCollection: true });
		open.push(snapshot);
		snapshot.sharesLiveEvents = true;
		await waitFor(() => snapshot.queue?.length > 100 && snapshot.currentDrainResolver, { timeout: 5000 });
		await T.put('r000', { reading: 1 });
		const isPut = (event) => event.id === 'r000' && event.value?.reading === 1;
		await waitFor(() => live.some(isPut));
		const delivered = live.find(isPut);
		const deliveredVersion = delivered.version;
		// a publish advances the record's version, so the buffered put is delivered at the newer one
		await T.publish('r000', { message: 'published' });
		await waitFor(() => live.some((event) => event.id === 'r000' && event.type === 'message'));
		const message = live.find((event) => event.id === 'r000' && event.type === 'message');
		const events = [];
		snapshot.on('data', (event) => events.push(event));
		await waitFor(() => events.some((event) => event.type === 'message'), { timeout: 5000 });
		const buffered = events.filter((event) => event.id === 'r000' && event.type === 'put').at(-1);
		assert.strictEqual(buffered.version, message.version, 'precondition: the buffered put was brought up to date');
		assert.strictEqual(
			delivered.version,
			deliveredVersion,
			'bringing the buffered put up to date changed the shared one'
		);
	});

	it('shares an event only between subscriptions that begin a transaction with it alike', async () => {
		const T = newTable();
		const plain = await subscribe(T);
		const transactional = await subscribe(T, { supportsTransactions: true });
		await T.put({ id: 't', reading: 1 });
		const isPut = putOf('t');
		await waitFor(() => plain.some(isPut) && transactional.some(isPut));
		assert.strictEqual(transactional.find(isPut).beginTxn, true);
		assert.strictEqual(plain.find(isPut).beginTxn, undefined);
	});

	it('tags the origin only on the events of a subscription that reports progress', async function () {
		if (!isRocksDB) return this.skip();
		const T = newTable();
		const reporting = await subscribe(T, { reportProgress: true });
		const plain = await subscribe(T);
		await T.put({ id: 'p', reading: 1 });
		const isPut = putOf('p');
		await waitFor(() => reporting.some(isPut) && plain.some(isPut));
		assert.strictEqual(reporting.find(isPut)[ORIGIN_ID], 0);
		assert.ok(!(ORIGIN_ID in plain.find(isPut)), 'a subscription that reports no progress was given an origin tag');
	});

	// QoS 0 sessions and durable QoS 1 sessions (which include superseded versions) subscribe to the same topics
	it('shares within each kind of subscription however the kinds are interleaved', async () => {
		const T = newTable();
		const kinds = [{}, { includeSuperseded: true }, {}, { includeSuperseded: true }];
		const received = [];
		for (const request of kinds) received.push(await subscribe(T, request));
		await T.put({ id: 'm', reading: 1 });
		const isPut = putOf('m');
		await waitFor(() => received.every((events) => events.some(isPut)));
		const [latest, superseded, latestAgain, supersededAgain] = received.map((events) => events.find(isPut));
		assert.notStrictEqual(superseded, latest);
		assert.strictEqual(latestAgain, latest, 'the first kind built its event again');
		assert.strictEqual(supersededAgain, superseded, 'the second kind built its event again');
	});
});
