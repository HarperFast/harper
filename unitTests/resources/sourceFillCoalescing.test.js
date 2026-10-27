require('../testUtils');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { Readable } = require('node:stream');
const { setupTestDBPath } = require('../testUtils');
const { table, __setReadOnlyModeForTest } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor.js');

describe('Concurrent source misses on one key', function () {
	this.timeout(10000);
	let CoalescingTable;
	let sourceCalls = 0;
	let respond;
	let bursts = [];
	let tryLock;
	const burstFor = (id) => bursts.find((burst) => Object.is(burst.id, id));
	function holdFirstCall(id, waiters) {
		let release;
		const allParked = new Promise((resolve) => (release = resolve));
		bursts = bursts.filter((burst) => !Object.is(burst.id, id));
		const burst = {
			id,
			parked: 0,
			started: false,
			allParked: Promise.race([
				allParked,
				delay(5000).then(() => {
					throw new Error(`only ${burst.parked} of ${waiters} reads parked on the record lock`);
				}),
			]),
			park() {
				if (++this.parked >= waiters) release();
			},
		};
		bursts.push(burst);
	}
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		CoalescingTable = table({
			table: 'SourceFillCoalescingTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		CoalescingTable.sourcedFrom({
			get(id, context) {
				const attempt = ++sourceCalls;
				const burst = burstFor(id);
				let held = delay(10);
				if (burst && !burst.started) {
					burst.started = true;
					held = burst.allParked;
				}
				return held.then(() => respond(id, attempt, context));
			},
		});
		const { primaryStore } = CoalescingTable;
		tryLock = primaryStore.tryLock;
		primaryStore.tryLock = function (key, onUnlocked) {
			const acquired = tryLock.call(this, key, onUnlocked);
			if (!acquired) burstFor(key)?.park();
			return acquired;
		};
	});
	after(function () {
		CoalescingTable.primaryStore.tryLock = tryLock;
	});
	beforeEach(() => {
		sourceCalls = 0;
		bursts = [];
	});
	const concurrentGets = (Table, id, context) => {
		holdFirstCall(id, 19);
		return Promise.allSettled(Array.from({ length: 20 }, () => Table.get(id, context && { ...context })));
	};
	const outcomes = (results, read = (value) => value) =>
		results.map(({ status, value, reason }) => (status === 'fulfilled' ? read(value) : reason.message));
	const settle = (id) => waitFor(() => !CoalescingTable.primaryStore.hasLock(id));

	it('share one source call when the source reports the record missing', async function () {
		respond = () => undefined;
		assert.deepStrictEqual(
			outcomes(await concurrentGets(CoalescingTable, 'missing'), (record) => record ?? null),
			Array(20).fill(null)
		);
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

	it('fill the cache for a caching waiter behind a noCacheStore leader', async function () {
		respond = (id) => ({ id, name: 'mixed ' + id });
		holdFirstCall('mixed', 1);
		const [uncached, cached] = await Promise.all([
			CoalescingTable.get('mixed', { noCacheStore: true }),
			CoalescingTable.get('mixed'),
		]);
		assert.deepEqual([uncached?.name, cached?.name], ['mixed mixed', 'mixed mixed']);
		assert.equal(sourceCalls, 2);
		await settle('mixed');
		assert.equal((await CoalescingTable.get('mixed')).name, 'mixed mixed');
		assert.equal(sourceCalls, 2);
	});

	it('do not share a response the source opted out of the cache', async function () {
		respond = (id, attempt, context) => {
			context.noCacheStore = true;
			return { id, name: 'private ' + attempt };
		};
		const results = outcomes(await concurrentGets(CoalescingTable, 'private'), (record) => record?.name);
		assert.equal(sourceCalls, 20);
		assert.equal(new Set(results).size, 20);
	});

	it('do not share a response the source opted out of the cache on a read-only node', async function () {
		respond = (id, attempt, context) => {
			context.noCacheStore = true;
			return { id, name: 'private ' + attempt };
		};
		__setReadOnlyModeForTest(true);
		try {
			const results = outcomes(await concurrentGets(CoalescingTable, 'private-read-only'), (record) => record?.name);
			assert.equal(sourceCalls, 20);
			assert.equal(new Set(results).size, 20);
		} finally {
			__setReadOnlyModeForTest(undefined);
		}
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

	it('do not share a fill that failed after the source answered', async function () {
		respond = (id, attempt) => {
			const record = { id, name: 'attempt ' + attempt };
			// a non-extensible record cannot take the record prototype, so the first fill rejects
			return attempt === 1 ? Object.preventExtensions(record) : record;
		};
		const results = outcomes(await concurrentGets(CoalescingTable, 'non-extensible'), (record) => record?.name);
		assert.equal(sourceCalls, 2);
		assert.equal(results.filter((outcome) => outcome === 'attempt 1').length, 0);
		assert.equal(results.filter((outcome) => outcome === 'attempt 2').length, 19);
	});

	it('do not share a record whose headers a response would merge into in place', async function () {
		respond = (id, attempt) => ({
			id,
			name: 'enveloped ' + attempt,
			headers: new Headers({ 'x-origin': String(attempt) }),
		});
		const results = outcomes(
			await concurrentGets(CoalescingTable, 'enveloped', { noCacheStore: true }),
			(record) => record?.name
		);
		assert.equal(sourceCalls, 20);
		assert.equal(new Set(results).size, 20);
	});

	it('do not share a record carrying a one-shot stream body', async function () {
		respond = (id, attempt) => ({ id, name: 'streamed ' + attempt, headers: {}, body: new ReadableStream() });
		const results = outcomes(
			await concurrentGets(CoalescingTable, 'streamed', { noCacheStore: true }),
			(record) => record?.name
		);
		assert.equal(sourceCalls, 20);
		assert.equal(new Set(results).size, 20);
	});

	it('do not share a record whose data is a one-shot passthrough stream', async function () {
		respond = (id, attempt) =>
			attempt % 2
				? { id, name: 'piped ' + attempt, contentType: 'text/plain', data: Readable.from(['x']) }
				: {
						id,
						name: 'piped ' + attempt,
						headers: {},
						data: { contentType: 'text/plain', data: Readable.from(['x']) },
					};
		const results = outcomes(
			await concurrentGets(CoalescingTable, 'piped', { noCacheStore: true }),
			(record) => record?.name
		);
		assert.equal(sourceCalls, 20);
		assert.equal(new Set(results).size, 20);
	});

	it('do not share a record holding a one-shot iterator', async function () {
		respond = (id, attempt) =>
			attempt % 2
				? { id, name: 'iterated ' + attempt, headers: {}, data: (async function* () {})() }
				: { id, name: 'iterated ' + attempt, items: { rows: [(async function* () {})()] } };
		const results = outcomes(
			await concurrentGets(CoalescingTable, 'iterated', { noCacheStore: true }),
			(record) => record?.name
		);
		assert.equal(sourceCalls, 20);
		assert.equal(new Set(results).size, 20);
	});

	it('do not share a record whose hazard sits behind a symbol, a hidden key, a hole, a getter or a dead proxy', async function () {
		const shapes = [
			(attempt) => ({ name: 'symbol ' + attempt, data: { [Symbol.asyncIterator]: () => (async function* () {})() } }),
			(attempt) =>
				Object.defineProperty({ name: 'hidden ' + attempt }, 'body', {
					value: new ReadableStream(),
					enumerable: false,
				}),
			(attempt) => ({ name: 'sparse ' + attempt, rows: Object.assign([], { 1_700_000_000: 1 }) }),
			(attempt) => Object.defineProperty({ name: 'getter ' + attempt }, 'late', { get: () => ({}), enumerable: true }),
			(attempt) => ({
				name: 'iterable ' + attempt,
				rows: Object.assign([1], { [Symbol.iterator]: () => [][Symbol.iterator]() }),
			}),
			(attempt) => {
				const { proxy, revoke } = Proxy.revocable([], {});
				revoke();
				return { name: 'revoked ' + attempt, rows: proxy };
			},
		];
		respond = (id, attempt) => Object.assign(shapes[attempt % shapes.length](attempt), { id });
		const results = outcomes(
			await concurrentGets(CoalescingTable, 'hazards', { noCacheStore: true }),
			(record) => record?.name
		);
		assert.equal(sourceCalls, 20);
		assert.equal(new Set(results).size, 20);
	});

	it('share a record of nested plain data, arrays, dates and bytes', async function () {
		respond = (id) => ({
			id,
			name: 'plain ' + id,
			nested: { list: [1, 'a', null, { when: new Date(0) }], bytes: Buffer.from('x') },
			headers: { a: '1' },
			body: 'text',
		});
		const results = outcomes(
			await concurrentGets(CoalescingTable, 'plain', { noCacheStore: true }),
			(record) => record?.name
		);
		assert.equal(sourceCalls, 1);
		assert.deepEqual(results, Array(20).fill('plain plain'));
	});

	it('do not share a record too large to scan within the budget', async function () {
		respond = (id, attempt) => ({
			id,
			name: 'large ' + attempt,
			rows: Array.from({ length: 10_001 }, (_, index) => index),
		});
		const results = outcomes(
			await concurrentGets(CoalescingTable, 'large', { noCacheStore: true }),
			(record) => record?.name
		);
		assert.equal(sourceCalls, 20);
		assert.equal(new Set(results).size, 20);
	});

	it('do not share a record a response could not copy', async function () {
		respond = (id, attempt) => Object.assign(Object.create(null), { id, name: 'bare ' + attempt, headers: { a: '1' } });
		const results = outcomes(
			await concurrentGets(CoalescingTable, 'bare', { noCacheStore: true }),
			(record) => record?.name
		);
		assert.equal(sourceCalls, 20);
		assert.equal(new Set(results).size, 20);
	});

	it('refetch for a caching waiter when a no-store leader finds an expired record absent', async function () {
		let originHasRecord = true;
		respond = (id) => (originHasRecord ? { id, name: 'stale ' + id } : undefined);
		assert.equal((await CoalescingTable.get('stale-absent')).name, 'stale stale-absent');
		await settle('stale-absent');
		await CoalescingTable.invalidate('stale-absent');
		originHasRecord = false;
		sourceCalls = 0;
		holdFirstCall('stale-absent', 1);
		const [uncached, cached] = await Promise.all([
			CoalescingTable.get('stale-absent', { noCacheStore: true }),
			CoalescingTable.get('stale-absent'),
		]);
		assert.deepEqual([uncached ?? null, cached ?? null], [null, null]);
		assert.equal(sourceCalls, 2);
		await settle('stale-absent');
		assert.equal(CoalescingTable.primaryStore.getEntry('stale-absent')?.value, undefined);
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
