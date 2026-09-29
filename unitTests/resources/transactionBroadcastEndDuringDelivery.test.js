// A subscription can end while the live fan-out is still delivering the same record to the other
// subscribers of its key: its rowFilter or eventFilter throws, or its listener calls end() on itself or a
// sibling. Every subscriber still registered when the delivery reaches it must get the record, and an
// ended subscription must get nothing more, end_txn included (harper#2771).
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { addSubscription } = require('#src/resources/transactionBroadcast');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor.js');
require('#src/server/serverHelpers/serverUtilities');

const DATABASE = 'fanoutend';

describe('Ending a subscription during live delivery', () => {
	let T;
	let sequence = 0;
	const opened = [];
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});
	beforeEach(() => {
		T = table({
			database: DATABASE,
			table: `FanoutEnd${++sequence}`,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
	});
	afterEach(() => {
		for (const subscription of opened.splice(0)) subscription.end();
	});

	async function subscribe(request, onEvent) {
		const subscriber = { events: [] };
		subscriber.subscription = await T.subscribe({
			...request,
			omitCurrent: true,
			listener: (event) => {
				subscriber.events.push(event);
				onEvent?.(event);
			},
		});
		opened.push(subscriber.subscription);
		return subscriber;
	}
	const values = (subscriber) =>
		subscriber.events.filter((event) => event.type === 'put').map((event) => event.value.value);
	// The second write lands only after the first was delivered: a write committed before the delivery pass
	// supersedes the first, and superseded versions are not delivered live.
	async function writeTwice(firstDelivered, secondDelivered) {
		await T.put('A', { value: 1 });
		await waitFor(firstDelivered, { message: 'the first write should have been delivered' });
		await T.put('A', { value: 2 });
		await waitFor(secondDelivered, { message: 'the second write should have been delivered' });
	}
	const throwOnFirstWrite = (value) => {
		if (value === 1) throw new Error('filter failed');
		return true;
	};

	for (const [scopeName, scope] of [
		['record', { id: 'A' }],
		['table', {}],
	]) {
		for (const [pathName, crossThreads] of [
			['cross-thread', undefined],
			['same-thread', false],
		]) {
			const where = `(${scopeName} subscription, ${pathName} delivery)`;
			it(`a throwing rowFilter does not cost the next subscriber that write ${where}`, async () => {
				const failing = await subscribe({ ...scope, crossThreads, rowFilter: (row) => throwOnFirstWrite(row.value) });
				const sibling = await subscribe({ ...scope, crossThreads });
				await writeTwice(
					() => failing.subscription.closed,
					() => values(sibling).includes(2)
				);
				assert.deepStrictEqual(values(sibling), [1, 2]);
				assert.deepStrictEqual(values(failing), []);
			});

			it(`a listener ending its own subscription does not cost the next subscriber that write ${where}`, async () => {
				const ending = await subscribe({ ...scope, crossThreads }, () => ending.subscription.end());
				const sibling = await subscribe({ ...scope, crossThreads });
				await writeTwice(
					() => values(ending).includes(1),
					() => values(sibling).includes(2)
				);
				assert.deepStrictEqual(values(sibling), [1, 2]);
				assert.deepStrictEqual(values(ending), [1]);
			});
		}

		const where = `(${scopeName} subscription)`;
		it(`a throwing eventFilter does not cost the next subscriber that write ${where}`, async () => {
			const failing = await subscribe({ ...scope, eventFilter: (event) => throwOnFirstWrite(event.value?.value) });
			const sibling = await subscribe(scope);
			await writeTwice(
				() => failing.subscription.closed,
				() => values(sibling).includes(2)
			);
			assert.deepStrictEqual(values(sibling), [1, 2]);
		});

		it(`a listener ending an earlier sibling does not cost the subscriber after it ${where}`, async () => {
			const earlier = await subscribe(scope);
			const ending = await subscribe(scope, () => earlier.subscription.end());
			const later = await subscribe(scope);
			await writeTwice(
				() => values(ending).includes(1),
				() => values(later).includes(2)
			);
			assert.deepStrictEqual(values(later), [1, 2]);
			assert.deepStrictEqual(values(ending), [1, 2]);
			assert.deepStrictEqual(values(earlier), [1]);
		});

		it(`a listener ending itself and the next subscriber does not cost the one after ${where}`, async () => {
			let next;
			const ending = await subscribe(scope, () => {
				ending.subscription.end();
				next.subscription.end();
			});
			next = await subscribe(scope);
			const last = await subscribe(scope);
			await writeTwice(
				() => values(ending).includes(1),
				() => values(last).includes(2)
			);
			assert.deepStrictEqual(values(last), [1, 2]);
			assert.deepStrictEqual(values(next), []);
		});

		it(`a subscriber ended by a sibling earlier in the same delivery gets nothing more ${where}`, async () => {
			let target;
			const ending = await subscribe(scope, () => target.subscription.end());
			const between = await subscribe(scope);
			target = await subscribe(scope);
			await writeTwice(
				() => values(ending).includes(1),
				() => values(between).includes(2)
			);
			assert.deepStrictEqual(values(between), [1, 2]);
			assert.deepStrictEqual(values(target), []);
		});
	}
});

describe('Ending a subscription during live delivery (transaction and reload signals)', () => {
	let path = 0;
	const opened = [];
	afterEach(() => {
		for (const subscription of opened.splice(0)) subscription.end();
	});

	function makeFakeTable() {
		const auditStore = new EventEmitter();
		auditStore.env = {};
		auditStore.reusableIterable = true;
		return { primaryStore: { path: `/fake/broadcast-end-during-delivery-${++path}`, tableId: 1 }, auditStore };
	}
	function subscribeRaw(fakeTable, key, onEvent) {
		const subscriber = { events: [] };
		subscriber.subscription = addSubscription(
			fakeTable,
			key,
			(recordId, auditRecord, timestamp, beginTxn) => {
				subscriber.events.push({ id: recordId, type: auditRecord.type, beginTxn });
				onEvent?.(auditRecord);
			},
			0,
			{ crossThreads: false }
		);
		subscriber.subscription.includeDescendants = true;
		subscriber.subscription.supportsTransactions = true;
		opened.push(subscriber.subscription);
		return subscriber;
	}
	function commit(fakeTable, entries) {
		const txnLogKey = Date.now();
		fakeTable.auditStore.emit(
			'aftercommit',
			entries.map((entry) => ({ tableId: 1, version: txnLogKey, txnLogKey, ...entry }))
		);
	}

	function endOnFirstEntryOfTransaction() {
		const fakeTable = makeFakeTable();
		const ending = subscribeRaw(fakeTable, null, () => ending.subscription.end());
		const sibling = subscribeRaw(fakeTable, null);
		commit(fakeTable, [
			{ type: 'put', recordId: 'a' },
			{ type: 'put', recordId: 'b' },
		]);
		return { ending, sibling };
	}

	it('a sibling gets the whole transaction when the subscriber before it ends on its first entry', () => {
		const { sibling } = endOnFirstEntryOfTransaction();
		assert.deepStrictEqual(sibling.events, [
			{ id: 'a', type: 'put', beginTxn: true },
			{ id: 'b', type: 'put', beginTxn: undefined },
			{ id: null, type: 'end_txn', beginTxn: true },
		]);
	});

	it('a subscriber that ends mid-transaction gets no end_txn for it', () => {
		const { ending } = endOnFirstEntryOfTransaction();
		assert.deepStrictEqual(ending.events, [{ id: 'a', type: 'put', beginTxn: true }]);
	});

	it('a reload marker reaches every subscriber still registered when one ends itself and another', () => {
		const fakeTable = makeFakeTable();
		let otherKey;
		const ending = subscribeRaw(fakeTable, 'x', () => {
			ending.subscription.end();
			otherKey.subscription.end();
		});
		const sameKey = subscribeRaw(fakeTable, 'x');
		otherKey = subscribeRaw(fakeTable, 'y');
		commit(fakeTable, [{ type: 'reload' }]);
		assert.deepStrictEqual(sameKey.events, [{ id: null, type: 'reload', beginTxn: false }]);
		assert.deepStrictEqual(otherKey.events, []);
	});

	for (const [recordName, entry] of [
		['put', { type: 'put', recordId: 'k' }],
		['reload', { type: 'reload' }],
	]) {
		for (const [siblingName, withSibling] of [
			['alone on its key', false],
			['beside a live sibling', true],
		]) {
			it(`a subscriber that re-subscribes from its listener starts with the next ${recordName} (${siblingName})`, async () => {
				const fakeTable = makeFakeTable();
				subscribeRaw(fakeTable, 'j'); // another subscribed key keeps the table's map in place through the walk
				if (withSibling) subscribeRaw(fakeTable, 'k');
				const calls = [];
				const subscribeGeneration = (generation) => {
					const subscriber = subscribeRaw(fakeTable, 'k', (auditRecord) => {
						if (auditRecord.type === 'end_txn') return;
						calls.push(generation);
						if (calls.length >= 20) return; // a regression re-delivers endlessly; stop re-subscribing
						subscriber.subscription.end();
						subscribeGeneration(generation + 1);
					});
				};
				subscribeGeneration(0);
				commit(fakeTable, [entry]);
				assert.deepStrictEqual(calls, [0]);
				await new Promise((resolve) => setImmediate(resolve));
				commit(fakeTable, [entry]);
				assert.deepStrictEqual(calls, [0, 1]);
			});
		}
	}

	for (const [siblingName, withOtherKey] of [
		['alone on its table', false],
		['beside another subscribed key', true],
	]) {
		it(`a reload listener that re-subscribes on a new key starts with the next reload (${siblingName})`, async () => {
			const fakeTable = makeFakeTable();
			if (withOtherKey) subscribeRaw(fakeTable, 'j');
			const calls = [];
			const subscribeGeneration = (generation) => {
				const subscriber = subscribeRaw(fakeTable, `k${generation}`, () => {
					calls.push(generation);
					if (calls.length >= 20) return; // a regression re-delivers endlessly; stop re-subscribing
					subscriber.subscription.end();
					subscribeGeneration(generation + 1);
				});
			};
			subscribeGeneration(0);
			commit(fakeTable, [{ type: 'reload' }]);
			assert.deepStrictEqual(calls, [0]);
			await new Promise((resolve) => setImmediate(resolve));
			commit(fakeTable, [{ type: 'reload' }]);
			assert.deepStrictEqual(calls, [0, 1]);
		});
	}

	it('a reload walk visits at most the keys present at its start, a new key taking the place of one that left', () => {
		const fakeTable = makeFakeTable();
		let second, added;
		const first = subscribeRaw(fakeTable, 'a', () => {
			first.subscription.end();
			second.subscription.end();
			added = subscribeRaw(fakeTable, 'd');
		});
		second = subscribeRaw(fakeTable, 'b');
		const third = subscribeRaw(fakeTable, 'c');
		commit(fakeTable, [{ type: 'reload' }]);
		assert.deepStrictEqual(
			[first, second, third, added].map((subscriber) => subscriber.events.length),
			[1, 0, 1, 1]
		);
	});

	it('a pass nested inside a listener does not reclaim an array the outer pass is still walking', async () => {
		const fakeTable = makeFakeTable();
		let nested = false;
		let outerSibling;
		const ending = subscribeRaw(fakeTable, null, (auditRecord) => {
			if (nested || auditRecord.type !== 'put') return;
			nested = true;
			commit(fakeTable, [{ type: 'put', recordId: 'inner' }]);
		});
		outerSibling = subscribeRaw(fakeTable, null, (auditRecord) => {
			if (auditRecord.recordId === 'inner') ending.subscription.end();
		});
		commit(fakeTable, [{ type: 'put', recordId: 'outer' }]);
		await new Promise((resolve) => setImmediate(resolve));
		commit(fakeTable, [{ type: 'put', recordId: 'next' }]);
		const puts = (subscriber) => subscriber.events.filter((event) => event.type === 'put').map((event) => event.id);
		assert.deepStrictEqual(puts(ending), ['outer', 'inner']);
		assert.deepStrictEqual(puts(outerSibling), ['inner', 'outer', 'next']);
	});

	it('a listener that ends itself and then throws does not cost its sibling the record', async () => {
		const fakeTable = makeFakeTable();
		const ending = subscribeRaw(fakeTable, null, (auditRecord) => {
			if (auditRecord.type !== 'put') return;
			ending.subscription.end();
			throw new Error('listener failed');
		});
		const sibling = subscribeRaw(fakeTable, null);
		commit(fakeTable, [{ type: 'put', recordId: 'a' }]);
		await new Promise((resolve) => setImmediate(resolve));
		commit(fakeTable, [{ type: 'put', recordId: 'b' }]);
		assert.deepStrictEqual(
			sibling.events.filter((event) => event.type === 'put').map((event) => event.id),
			['a', 'b']
		);
		assert.deepStrictEqual(
			ending.events.map((event) => event.id),
			['a']
		);
	});

	it('ending a subscription twice inside delivery unlinks only that subscription', async () => {
		const fakeTable = makeFakeTable();
		const ending = subscribeRaw(fakeTable, null, () => {
			ending.subscription.end();
			ending.subscription.end();
		});
		const middle = subscribeRaw(fakeTable, null);
		const last = subscribeRaw(fakeTable, null);
		commit(fakeTable, [{ type: 'put', recordId: 'a' }]);
		await new Promise((resolve) => setImmediate(resolve));
		commit(fakeTable, [{ type: 'put', recordId: 'b' }]);
		for (const subscriber of [middle, last]) {
			assert.deepStrictEqual(
				subscriber.events.filter((event) => event.type === 'put').map((event) => event.id),
				['a', 'b']
			);
		}
	});

	it('an end_txn listener ending a later subscriber keeps end_txn from reaching it', () => {
		const fakeTable = makeFakeTable();
		let later;
		subscribeRaw(fakeTable, null, (auditRecord) => {
			if (auditRecord.type === 'end_txn') later.subscription.end();
		});
		later = subscribeRaw(fakeTable, null);
		commit(fakeTable, [{ type: 'put', recordId: 'a' }]);
		assert.deepStrictEqual(later.events, [{ id: 'a', type: 'put', beginTxn: true }]);
	});

	it('a subscriber ending in the first batch of a longer transaction gets no more of it, and its sibling all of it', async () => {
		// the cross-thread path, which yields every 256 records and carries the transaction's subscribers across the yield
		const auditStore = new EventEmitter();
		const pending = [];
		auditStore.reusableIterable = true;
		auditStore.getRange = () => ({
			[Symbol.iterator]: () => ({
				next: () => (pending.length ? { value: pending.shift(), done: false } : { value: undefined, done: true }),
			}),
		});
		const fakeTable = {
			primaryStore: { path: `/fake/broadcast-end-during-delivery-${++path}`, tableId: 1 },
			auditStore,
		};
		const subscribeCrossThread = (onEvent) => {
			const subscriber = { events: [] };
			subscriber.subscription = addSubscription(fakeTable, null, (recordId, auditRecord) => {
				subscriber.events.push(auditRecord.type === 'end_txn' ? 'end_txn' : recordId);
				onEvent?.(subscriber);
			});
			subscriber.subscription.includeDescendants = true;
			subscriber.subscription.supportsTransactions = true;
			opened.push(subscriber.subscription);
			return subscriber;
		};
		const ending = subscribeCrossThread((subscriber) => {
			if (subscriber.events.length === 100) subscriber.subscription.end();
		});
		const sibling = subscribeCrossThread();
		const txnLogKey = Date.now() + 1000;
		const recordIds = [];
		for (let i = 0; i < 300; i++) {
			recordIds.push(`r${i}`);
			pending.push({ type: 'put', tableId: 1, recordId: `r${i}`, version: txnLogKey, txnLogKey });
		}
		auditStore.emit('committed');
		await waitFor(() => sibling.events.includes('end_txn'), {
			message: 'the sibling should get the whole transaction',
		});
		assert.deepStrictEqual(sibling.events, [...recordIds, 'end_txn']);
		assert.deepStrictEqual(ending.events, recordIds.slice(0, 100));
	});
});
