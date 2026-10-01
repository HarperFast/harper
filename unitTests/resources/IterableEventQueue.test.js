const assert = require('node:assert');
const { IterableEventQueue } = require('#src/resources/IterableEventQueue');

describe('IterableEventQueue', () => {
	it('buffers sends with no consumer, then drains them when a data listener attaches', () => {
		const q = new IterableEventQueue();
		q.send({ n: 1 });
		q.send({ n: 2 });
		const seen = [];
		q.on('data', (e) => seen.push(e));
		assert.equal(q.hasDataListeners, true);
		assert.deepEqual(seen, [{ n: 1 }, { n: 2 }], 'buffered events drained on attach');
		q.send({ n: 3 });
		assert.deepEqual(seen, [{ n: 1 }, { n: 2 }, { n: 3 }], 'subsequent sends emit live');
	});

	it('clears hasDataListeners when the last data listener is removed (not sticky)', () => {
		const q = new IterableEventQueue();
		const listener = () => {};
		q.on('data', listener);
		assert.equal(q.hasDataListeners, true);
		q.off('data', listener);
		assert.equal(q.hasDataListeners, false, 'recomputed false after the last data listener is removed');
		// With no live listener, a send buffers again instead of emitting into the void.
		q.send({ n: 9 });
		const seen = [];
		q.on('data', (e) => seen.push(e));
		assert.deepEqual(seen, [{ n: 9 }], 're-attaching drains the re-buffered event');
	});

	it('keeps hasDataListeners true while at least one data listener remains', () => {
		const q = new IterableEventQueue();
		const a = () => {};
		const b = () => {};
		q.on('data', a);
		q.on('data', b);
		q.removeListener('data', a);
		assert.equal(q.hasDataListeners, true, 'listener b still attached');
		q.removeListener('data', b);
		assert.equal(q.hasDataListeners, false, 'no data listeners left');
	});

	it('removing a non-data listener does not disturb hasDataListeners', () => {
		const q = new IterableEventQueue();
		const data = () => {};
		const close = () => {};
		q.on('data', data);
		q.on('close', close);
		q.off('close', close);
		assert.equal(q.hasDataListeners, true, "removing a 'close' listener leaves data state intact");
	});

	it('waitForDrain resolves when the on(data) attach loop empties the queue without emitting drained', async () => {
		const q = new IterableEventQueue();
		q.send({ n: 1 });
		const drained = q.waitForDrain();
		q.on('data', () => {}); // attach loop drains the buffered queue synchronously, no 'drained' emit
		const result = await Promise.race([drained, new Promise((r) => setTimeout(() => r('hung'), 1000))]);
		assert.equal(result, true, 'waiter must observe the queue emptying through the attach path');
		assert.equal(q.listenerCount('drained'), 0, 'poll-path settle must remove the drained listener');
	});

	it('close is terminal, discards buffered events, and completes pending iteration', async () => {
		const q = new IterableEventQueue();
		q.send({ stale: true });
		q.close();
		assert.equal(q.closed, true);
		assert.equal(q.send({ late: true }), false, 'no event can be queued after close');
		assert.deepEqual(await q[Symbol.asyncIterator]().next(), { value: undefined, done: true });

		const waiting = new IterableEventQueue();
		const next = waiting[Symbol.asyncIterator]().next();
		waiting.close();
		assert.deepEqual(await next, { value: undefined, done: true }, 'a waiting consumer is released');
	});

	it('close can deliver one terminal error before completing iteration', async () => {
		const q = new IterableEventQueue();
		const error = new Error('policy failed');
		q.close(error);
		const iterator = q[Symbol.asyncIterator]();
		assert.deepEqual(await iterator.next(), { value: error, done: false });
		assert.deepEqual(await iterator.next(), { value: undefined, done: true });
	});

	describe('close with a final message whose listeners misbehave', () => {
		const settled = (promise) =>
			Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('still pending'), 1000))]);
		function watchCloses(q) {
			const counter = { closes: 0 };
			q.on('close', () => counter.closes++);
			return counter;
		}

		it('hands a waiting iterator the final message before completing it', async () => {
			const q = new IterableEventQueue();
			const iterator = q[Symbol.asyncIterator]();
			const waiting = iterator.next();
			const error = new Error('policy failed');
			q.close(error);
			assert.deepEqual(await settled(waiting), { value: error, done: false });
			assert.deepEqual(await settled(iterator.next()), { value: undefined, done: true });
		});

		it('finishes closing when a data listener throws on it, then rethrows that error', async () => {
			const q = new IterableEventQueue();
			const counter = watchCloses(q);
			const listenerError = new Error('listener failed');
			q.on('data', () => {
				throw listenerError;
			});
			assert.throws(
				() => q.close(new Error('policy failed')),
				(error) => error === listenerError
			);
			assert.equal(q.closed, true, 'the queue stayed open');
			assert.equal(counter.closes, 1);
			assert.equal(q.send({ late: true }), false, 'an event was accepted after close');
			assert.deepEqual(await settled(q[Symbol.asyncIterator]().next()), { value: undefined, done: true });
			q.close();
			assert.equal(counter.closes, 1, 'a second close emitted close again');
		});

		it('completes an iteration a data listener starts before it throws', async () => {
			const q = new IterableEventQueue();
			let started;
			q.on('data', () => {
				started = q[Symbol.asyncIterator]().next();
				throw new Error('listener failed');
			});
			assert.throws(() => q.close(new Error('policy failed')));
			assert.deepEqual(await settled(started), { value: undefined, done: true });
		});

		it('emits close once when a data listener closes the queue while handling it', () => {
			const q = new IterableEventQueue();
			const counter = watchCloses(q);
			q.on('data', () => q.close());
			q.close(new Error('policy failed'));
			assert.equal(q.closed, true);
			assert.equal(counter.closes, 1, 'close was emitted more than once');
		});

		it('emits close once when a data listener closes the queue and then throws', () => {
			const q = new IterableEventQueue();
			const counter = watchCloses(q);
			const listenerError = new Error('listener failed');
			q.on('data', () => {
				q.close();
				throw listenerError;
			});
			assert.throws(
				() => q.close(new Error('policy failed')),
				(error) => error === listenerError
			);
			assert.equal(q.closed, true);
			assert.equal(counter.closes, 1, 'close was emitted more than once');
		});

		it("surfaces a close listener's error over a data listener's when both throw", () => {
			const q = new IterableEventQueue();
			const closeError = new Error('close listener failed');
			q.on('data', () => {
				throw new Error('data listener failed');
			});
			q.on('close', () => {
				throw closeError;
			});
			assert.throws(
				() => q.close(new Error('policy failed')),
				(error) => error === closeError
			);
			assert.equal(q.closed, true);
		});
	});
});
