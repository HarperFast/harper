const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor.js');
require('#src/server/serverHelpers/serverUtilities');

describe('Subscription superseded versions', () => {
	let T;
	let sequence = 0;
	const subscriptions = [];
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});
	beforeEach(() => {
		T = table({
			database: 'test',
			table: `Superseded${++sequence}`,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
	});
	afterEach(() => {
		for (const subscription of subscriptions.splice(0)) subscription.end();
	});
	async function subscribe(options) {
		const events = [];
		let replayEnd = 0;
		if ((options.startTime || options.previousCount) && options.id === undefined) {
			for (const record of T.auditStore.getRange({ start: options.startTime || 1 })) {
				if (record.tableId === T.tableId) replayEnd = Math.max(replayEnd, record.txnLogKey);
			}
		}
		const subscription = await T.subscribe({ ...options, listener: (event) => events.push(event) });
		subscriptions.push(subscription);
		if (replayEnd) await waitFor(() => subscription.startTime >= replayEnd);
		return { subscription, events };
	}
	async function versions() {
		await T.put('A', { value: 2 });
		await T.patch('A', { value: 3 });
		await T.patch('A', { value: 4 });
	}

	for (const scope of [
		{ startTime: 1 },
		{ startTime: 1, id: 'A' },
		{ previousCount: 10, id: 'A' },
		...(process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? [{ previousCount: 10 }] : []),
	]) {
		it(`filters superseded relocations for ${JSON.stringify(scope)}`, async () => {
			if (scope.previousCount && scope.id === undefined) {
				const Other = table({
					database: 'test',
					table: 'RelocationReplayNoise',
					audit: true,
					attributes: [{ name: 'id', isPrimaryKey: true }],
				});
				for (let id = 0; id < 120; id++) await Other.put(id, {});
			}
			await T.put('A', { value: 2 });
			const context = {};
			await transaction(context, async () => {
				const resource = await T.getResource('A', context);
				resource._writeRelocate('A', {});
			});
			await T.put('A', { value: 4 });
			const current = await subscribe(scope);
			assert.deepStrictEqual(
				current.events.map((event) => [event.type, event.value?.value]),
				[['put', 4]]
			);
			const history = await subscribe({ ...scope, includeSuperseded: true });
			assert.deepStrictEqual(
				history.events.map((event) => event.type),
				['put', 'relocate', 'put']
			);
		});
	}

	for (const scope of [{ isCollection: true }, { id: 'A' }]) {
		for (const [options, expected] of [
			[{}, [4]],
			[{ includeSuperseded: false }, [4]],
			[{ includeSuperseded: true }, [2, 3, 4]],
			[{ rawEvents: true }, [2, 3, 4]],
			[{ rawEvents: true, includeSuperseded: false }, [4]],
		]) {
			it(`replays ${JSON.stringify(expected)} for ${JSON.stringify({ ...scope, ...options })}`, async () => {
				await versions();
				const { events } = await subscribe({ startTime: 1, ...scope, ...options });
				assert.deepStrictEqual(
					events.map((event) => event.value?.value),
					expected
				);
				if (!options.rawEvents) assert.ok(events.every((event) => event.type === 'put'));
			});
		}
		it(`preserves deletion and skips pre-delete versions for ${JSON.stringify(scope)}`, async () => {
			await versions();
			await T.delete('A');
			const { events } = await subscribe({ startTime: 1, ...scope });
			assert.deepStrictEqual(
				events.map((event) => event.type),
				['delete']
			);
			const history = await subscribe({ startTime: 1, includeSuperseded: true, ...scope });
			assert.deepStrictEqual(
				history.events.map((event) => event.type),
				['put', 'put', 'put', 'delete']
			);
		});
		it(`skips obsolete deletion after recreation for ${JSON.stringify(scope)}`, async () => {
			await T.put('A', { value: 2 });
			await T.delete('A');
			await T.put('A', { value: 4 });
			const { events } = await subscribe({ startTime: 1, ...scope });
			assert.deepStrictEqual(
				events.map((event) => [event.type, event.value?.value]),
				[['put', 4]]
			);
		});
	}

	it('keeps independent published messages during catch-up and live delivery', async () => {
		await T.publish('A', { value: 2 });
		await T.publish('A', { value: 3 });
		await T.put('A', { value: 4 });
		const { events } = await subscribe({ startTime: 1 });
		assert.deepStrictEqual(
			events.map((event) => [event.type, event.value?.value]),
			[
				['message', 2],
				['message', 3],
				['put', 4],
			]
		);
		await T.publish('A', { value: 5 });
		await waitFor(() => events.some((event) => event.type === 'message' && event.value?.value === 5));
	});

	it('advances replay across a yield with mostly superseded events, then delivers live updates', async () => {
		for (let value = 1; value <= 120; value++) await T.put('A', { value });
		await T.put('sentinel', { value: 0 });
		const { events } = await subscribe({ startTime: 1 });
		await waitFor(() => events.some((event) => event.id === 'sentinel'));
		assert.deepStrictEqual(
			events.filter((event) => event.id === 'A').map((event) => event.value.value),
			[120]
		);
		await T.put('A', { value: 121 });
		await waitFor(() => events.some((event) => event.id === 'A' && event.value?.value === 121));
		assert.deepStrictEqual(
			events.filter((event) => event.id === 'A').map((event) => event.value.value),
			[120, 121]
		);
	});

	it('skips mutations without a primary entry, including deletes superseded before eviction', async () => {
		await T.put('evicted', { value: 1 });
		await T.primaryStore.remove('evicted');
		await T.put('deleted', { value: 2 });
		await T.delete('deleted');
		await T.primaryStore.remove('deleted');
		await T.put('recreated', { value: 1 });
		await T.delete('recreated');
		await T.put('recreated', { value: 2 });
		await T.primaryStore.remove('recreated');
		assert.equal(T.primaryStore.getEntry('evicted'), undefined);
		assert.equal(T.primaryStore.getEntry('deleted'), undefined);
		const { events } = await subscribe({ startTime: 1 });
		assert.deepStrictEqual(events, []);
	});

	it('keeps published messages within single-record history', async () => {
		await T.publish('A', { value: 2 });
		await T.publish('A', { value: 3 });
		await T.put('A', { value: 4 });
		const { events } = await subscribe({ id: 'A', startTime: 1 });
		assert.deepStrictEqual(
			events.map((event) => [event.type, event.value?.value]),
			[
				['message', 2],
				['message', 3],
				['put', 4],
			]
		);
	});

	for (const scope of [{ isCollection: true }, { id: 'A' }]) {
		it(`uses the primary version after publish for ${JSON.stringify(scope)}`, async () => {
			await T.put('A', { value: 4 });
			await T.publish('A', { value: 5 });
			const { events } = await subscribe({ startTime: 1, ...scope });
			assert.deepStrictEqual(
				events.map((event) => [event.type, event.value?.value]),
				[['message', 5]]
			);
			const history = await subscribe({ startTime: 1, includeSuperseded: true, ...scope });
			assert.deepStrictEqual(
				history.events.map((event) => [event.type, event.value?.value]),
				[
					['put', 4],
					['message', 5],
				]
			);
		});
	}

	it('applies rowFilter to the historical value that is delivered', async () => {
		await versions();
		const history = await subscribe({ startTime: 1, includeSuperseded: true, rowFilter: (row) => row.value === 3 });
		assert.deepStrictEqual(
			history.events.map((event) => event.value.value),
			[3]
		);
		const current = await subscribe({ startTime: 1, rowFilter: (row) => row.value === 3 });
		assert.deepStrictEqual(current.events, []);
	});

	it('keeps invalidation typed as invalidate', async () => {
		await versions();
		await T.invalidate('A');
		for (const scope of [{ isCollection: true }, { id: 'A' }]) {
			const { events } = await subscribe({ startTime: 1, ...scope });
			assert.deepStrictEqual(
				events.map((event) => event.type),
				['invalidate']
			);
		}
	});

	it('counts only eligible versions in single-record previousCount', async () => {
		await versions();
		const latest = await subscribe({ id: 'A', previousCount: 2 });
		assert.deepStrictEqual(
			latest.events.map((event) => event.value?.value),
			[4]
		);
		const history = await subscribe({ id: 'A', previousCount: 2, includeSuperseded: true });
		assert.deepStrictEqual(
			history.events.map((event) => event.value?.value),
			[3, 4]
		);
	});

	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') {
		it('does not spend previousCount on superseded collection events', async () => {
			await T.put('B', { value: 1 });
			await versions();
			const { events } = await subscribe({ previousCount: 2 });
			assert.deepStrictEqual(
				events.map((event) => [event.id, event.value?.value]),
				[
					['B', 1],
					['A', 4],
				]
			);
		});
	}

	for (const includeSuperseded of [false, true]) {
		it(`handles delayed live audit notifications with includeSuperseded=${includeSuperseded}`, async () => {
			await versions();
			const { subscription, events } = await subscribe({ omitCurrent: true, includeSuperseded });
			for (const record of T.auditStore.getRange({ start: 1, snapshot: false })) {
				if (record.tableId === T.tableId && record.recordId === 'A') {
					subscription.listener('A', record, record.txnLogKey);
				}
			}
			assert.deepStrictEqual(
				events.map((event) => event.value?.value),
				includeSuperseded ? [2, 3, 4] : [4]
			);
			assert.ok(events.every((event) => event.type === 'put'));
		});
	}
});
