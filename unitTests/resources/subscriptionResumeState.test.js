const assert = require('node:assert');
const {
	SubscriptionResumeState,
	SubscriptionResumeError,
	subscriptionResumeFingerprint,
} = require('#src/resources/subscriptionResumeState');

function tracker(overrides = {}) {
	return new SubscriptionResumeState({
		historyId: 'database/table/generation-1',
		window: 10,
		origins: ['a', 'b'],
		...overrides,
	});
}

describe('compact subscription resume state', () => {
	it('emits an initial compact fingerprint without exposing origin names', () => {
		const state = tracker({ origins: ['private-node-a', 'private-node-b'] });
		const checkpoint = state.checkpoint();
		assert.equal(checkpoint.startTime, 0);
		assert.match(checkpoint.resumeState, /^1\.[A-Za-z0-9_-]{22}$/);
		assert.equal(checkpoint.resumeState.length, 24);
		assert.equal(checkpoint.resumeState.includes('private-node'), false);
		assert.equal(state.checkpoint().resumeState, undefined);
	});

	it('omits unchanged fingerprints while active origins continue writing', () => {
		const state = tracker();
		let updates = 0;
		for (let i = 0; i < 1000; i++) {
			state.recordTransaction(i % 2 ? 'b' : 'a', 100 + i);
			const checkpoint = state.checkpoint();
			assert.equal(checkpoint.startTime, 90 + i);
			if (checkpoint.resumeState) updates++;
		}
		assert.equal(updates, 2);
	});

	it('changes state when an origin leaves the overlap, then stabilizes while it is silent', () => {
		const state = tracker();
		state.recordTransaction('a', 100);
		state.recordTransaction('b', 104);
		const active = state.checkpoint();
		state.recordTransaction('b', 110);
		assert.equal(state.checkpoint().resumeState, undefined);
		state.recordTransaction('b', 111);
		const silent = state.checkpoint();
		assert.notEqual(silent.resumeState, active.resumeState);
		assert.equal(silent.startTime, 101);
		state.recordTransaction('b', 120);
		assert.equal(state.checkpoint().resumeState, undefined);
		state.recordTransaction('a', 121);
		assert.notEqual(state.checkpoint().resumeState, silent.resumeState);
	});

	it('preserves the maximum for activity and the physical last timestamp for an idle origin', () => {
		const state = tracker();
		state.recordTransaction('a', 100);
		state.checkpoint();
		state.recordTransaction('a', 20);
		assert.deepEqual(state.checkpoint(), { startTime: 90 });
		state.recordTransaction('b', 115);
		const checkpoint = state.checkpoint();
		assert.equal(checkpoint.startTime, 105);
		assert.equal(
			checkpoint.resumeState,
			subscriptionResumeFingerprint('database/table/generation-1', 10, [
				['a', 20],
				['b', 'active'],
			])
		);
	});

	it('keeps a changed state paired with the checkpoint that first needs it', () => {
		const state = tracker();
		state.recordTransaction('a', 100);
		const initial = state.checkpoint();
		const saved = { ...initial };
		state.recordTransaction('a', 105);
		const unchanged = state.checkpoint();
		assert.equal(unchanged.resumeState, undefined);
		assert.equal(unchanged.startTime, 95);
		state.recordTransaction('b', 20);
		const changed = state.checkpoint();
		assert.equal(changed.startTime, unchanged.startTime);
		assert.notEqual(changed.resumeState, saved.resumeState);
		assert.deepEqual(initial, saved);
		assert.equal(state.checkpoint().resumeState, undefined);
	});

	it('binds history, overlap, membership, and idle timestamps with canonical origin ordering', () => {
		const shape = [
			['a', 'active'],
			['b', 20],
		];
		const expected = subscriptionResumeFingerprint('history', 10, shape);
		assert.equal(subscriptionResumeFingerprint('history', 10, [...shape].reverse()), expected);
		for (const actual of [
			subscriptionResumeFingerprint('other-history', 10, shape),
			subscriptionResumeFingerprint('history', 11, shape),
			subscriptionResumeFingerprint('history', 10, [['a', 'active']]),
			subscriptionResumeFingerprint('history', 10, [
				['c', 'active'],
				['b', 20],
			]),
			subscriptionResumeFingerprint('history', 10, [
				['a', 'active'],
				['b', 21],
			]),
			subscriptionResumeFingerprint('history', 10, [
				['a', 'active'],
				['b', null],
			]),
		])
			assert.notEqual(actual, expected);
	});

	it('takes an immutable copy of the origin membership', () => {
		const origins = ['a'];
		const state = tracker({ origins });
		origins.push('b');
		assert.throws(() => state.recordTransaction('b', 100), SubscriptionResumeError);
	});

	it('rejects unknown origins with an explicit base-copy requirement', () => {
		const state = tracker();
		assert.throws(
			() => state.recordTransaction('unknown', 100),
			(error) => {
				assert.ok(error instanceof SubscriptionResumeError);
				assert.equal(error.resyncRequired, true);
				assert.equal(typeof error.reason, 'string');
				assert.ok(error.reason.length > 0);
				return true;
			}
		);
	});

	it('rejects invalid history identities, overlaps, and timestamps', () => {
		for (const historyId of ['', null, undefined, 123]) {
			assert.throws(() => tracker({ historyId }), TypeError);
		}
		for (const window of [0, -1, NaN, Infinity, -Infinity, '10', null]) {
			assert.throws(() => tracker({ window }), TypeError);
		}
		const state = tracker();
		for (const timestamp of [0, -1, NaN, Infinity, -Infinity, 8.64e15 + 1, '100', null, undefined]) {
			assert.throws(() => state.recordTransaction('a', timestamp), TypeError);
		}
		assert.equal(state.checkpoint().startTime, 0);
	});

	it('rejects ambiguous or invalid origin membership', () => {
		for (const origins of [[], ['a', 'a'], [''], [null], [123]]) {
			assert.throws(() => tracker({ origins }), TypeError);
		}
	});

	it('accepts fractional log timestamps and clamps the initial overlap to zero', () => {
		const state = tracker();
		state.recordTransaction('a', 0.25);
		assert.equal(state.checkpoint().startTime, 0);
		state.recordTransaction('a', 100.125);
		assert.equal(state.checkpoint().startTime, 90.125);
	});

	it('never reconstructs an inclusive anchor beyond a delivered prefix in an exhaustive unordered model', () => {
		const histories = [[]];
		function append(prefix, remaining) {
			for (const timestamp of remaining) {
				const next = [...prefix, timestamp];
				histories.push(next);
				append(
					next,
					remaining.filter((value) => value !== timestamp)
				);
			}
		}
		append([], [1, 2, 3, 4]);
		let cases = 0;
		let accepted = 0;
		for (const history of histories) {
			for (let delivered = 0; delivered <= history.length; delivered++) {
				const source = history.slice(0, delivered);
				for (let high = Math.max(1, ...source); high <= 5; high++) {
					const state = tracker({ historyId: 'model', window: 1, origins: ['a', 'clock'] });
					state.recordTransaction('clock', high);
					for (const timestamp of source) state.recordTransaction('a', timestamp);
					const checkpoint = state.checkpoint();
					for (let available = 0; available <= history.length; available++) {
						cases++;
						const receiver = history.slice(0, available);
						const firstOverlap = receiver.findIndex((timestamp) => timestamp >= high - 1 && timestamp <= high);
						const beforeWindow = receiver.filter((timestamp) => timestamp < high - 1);
						const idle = beforeWindow.at(-1) ?? null;
						const fingerprint = subscriptionResumeFingerprint('model', 1, [
							['a', firstOverlap < 0 ? idle : 'active'],
							['clock', 'active'],
						]);
						if (fingerprint !== checkpoint.resumeState) continue;
						accepted++;
						const anchor = firstOverlap >= 0 ? firstOverlap : idle === null ? 0 : receiver.indexOf(idle);
						assert.ok(anchor <= delivered, JSON.stringify({ history, delivered, available, high, anchor }));
					}
				}
			}
		}
		assert.equal(cases, 3613);
		assert.equal(accepted, 1761);
	});
});
