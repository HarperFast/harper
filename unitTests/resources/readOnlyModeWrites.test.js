require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, __setReadOnlyModeForTest } = require('#src/resources/databases');
const { IterableEventQueue } = require('#src/resources/IterableEventQueue');
const { Resource } = require('#src/resources/Resource');
const { waitFor } = require('../waitFor');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// harper#474. Runs on whichever engine HARPER_STORAGE_ENGINE selects.
describe('read-only mode rejects writes', () => {
	let ReadOnlyTable;
	let NumericTable;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		ReadOnlyTable = table({
			table: 'ReadOnlyWritesTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
		});
		await ReadOnlyTable.put('seed', { id: 'seed', name: 'seed' });
		NumericTable = table({
			table: 'ReadOnlyNumericTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'Int' },
				{ name: 'name', indexed: true },
			],
		});
	});

	afterEach(() => __setReadOnlyModeForTest(undefined));

	async function assertReadOnlyRejection(write) {
		__setReadOnlyModeForTest(true);
		await assert.rejects(
			async () => write(),
			(error) => {
				assert.strictEqual(error.statusCode, 405, `status was ${error.statusCode}: ${error.message}`);
				assert.strictEqual(error.message, 'Server is in read-only mode');
				return true;
			}
		);
	}

	for (const [method, write] of [
		['put', () => ReadOnlyTable.put('ro-put', { id: 'ro-put', name: 'x' })],
		['patch', () => ReadOnlyTable.patch('seed', { name: 'changed' })],
		['delete', () => ReadOnlyTable.delete('seed')],
		['invalidate', () => ReadOnlyTable.invalidate('seed')],
		['post', () => ReadOnlyTable.post({ id: 'ro-post', name: 'x' })],
		['publish', () => ReadOnlyTable.publish('ro-publish', { name: 'x' })],
	]) {
		it(`${method} is refused with a 405 and changes nothing`, async function () {
			await assertReadOnlyRejection(write);
			__setReadOnlyModeForTest(undefined);
			assert.ok((await ReadOnlyTable.get('ro-put')) == null);
			assert.ok((await ReadOnlyTable.get('ro-post')) == null);
			assert.strictEqual((await ReadOnlyTable.get('seed')).name, 'seed');
		});
	}

	it('refuses to allocate an id range, which is a write of its own', async function () {
		await assertReadOnlyRejection(() => NumericTable.post({ name: 'x' }));
		__setReadOnlyModeForTest(undefined);
		assert.strictEqual(NumericTable.primaryStore.getEntry(Symbol.for('id_allocation')), undefined);
	});

	it('refuses to hand out an id from a stored range without advancing the counter', async function () {
		const first = NumericTable.getNewId();
		__setReadOnlyModeForTest(true);
		// well past the 512-id threshold at which the incrementer schedules a range expansion
		for (let i = 0; i < 1000; i++) assert.throws(() => NumericTable.getNewId(), { statusCode: 405 });
		__setReadOnlyModeForTest(undefined);
		assert.strictEqual(NumericTable.getNewId(), first + 1);
	});

	it('refuses to add an attribute, which changes the catalog', async function () {
		const before = NumericTable.attributes.length;
		await assertReadOnlyRejection(() => NumericTable.addAttributes([{ name: 'extra', indexed: true }]));
		assert.strictEqual(NumericTable.attributes.length, before);
	});

	it('observes a request body that is still being parsed when the write is refused', async function () {
		const unhandled = [];
		const record = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', record);
		try {
			await assertReadOnlyRejection(() => ReadOnlyTable.put('body', Promise.reject(new Error('malformed body'))));
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepStrictEqual(unhandled, []);
		} finally {
			process.off('unhandledRejection', record);
		}
	});

	it('leaves a custom resource that does not touch storage usable', async function () {
		class Custom extends Resource {
			put() {
				return 'put handled';
			}
			post() {
				return 'post handled';
			}
		}
		__setReadOnlyModeForTest(true);
		assert.strictEqual(await Custom.put('x', { a: 1 }), 'put handled');
		assert.strictEqual(await Custom.post('x', { a: 1 }), 'post handled');
	});

	it('does not subscribe to a source whose notifications it could not apply', async function () {
		const subscribed = [];
		const source = (label) => ({
			subscribe: () => {
				subscribed.push(label);
				return new IterableEventQueue();
			},
			subscribeOnThisThread: () => true,
		});
		const Writable = table({
			table: 'ReadOnlySourceControl',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		Writable.sourcedFrom(source('writable'));
		await waitFor(() => subscribed.includes('writable'));
		const Guarded = table({
			table: 'ReadOnlySourceGuarded',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		__setReadOnlyModeForTest(true);
		Guarded.sourcedFrom(source('read-only'));
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
		assert.deepStrictEqual(subscribed, ['writable']);
	});

	it('refuses a record lock before it takes the key, which only a write could use', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		await assertReadOnlyRejection(() => ReadOnlyTable.lock('seed'));
		__setReadOnlyModeForTest(undefined);
		const held = await ReadOnlyTable.lock('seed', { timeout: 500, hold: true });
		await held.unlock();
	});

	it('still serves reads', async function () {
		__setReadOnlyModeForTest(true);
		assert.strictEqual((await ReadOnlyTable.get('seed')).name, 'seed');
	});

	it('writes normally once read-only mode is off', async function () {
		await ReadOnlyTable.put('writable', { id: 'writable', name: 'ok' });
		assert.strictEqual((await ReadOnlyTable.get('writable')).name, 'ok');
	});
});
