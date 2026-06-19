const assert = require('node:assert/strict');
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
});
