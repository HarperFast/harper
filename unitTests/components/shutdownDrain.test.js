const assert = require('node:assert');
const {
	registerShutdownDrain,
	shutdownDrainsHaveWork,
	runShutdownDrains,
	getShutdownDrainCeilingMs,
	boundedTerminateDelay,
} = require('#src/components/shutdownDrain');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

describe('shutdownDrain', () => {
	let unregisters = [];
	const track = (drain) => {
		const off = registerShutdownDrain(drain);
		unregisters.push(off);
		return off;
	};
	afterEach(() => {
		for (const off of unregisters) off();
		unregisters = [];
	});

	describe('shutdownDrainsHaveWork', () => {
		it('is false with no registered drains', () => {
			assert.equal(shutdownDrainsHaveWork(), false);
		});
		it('reflects any registered drain reporting work', () => {
			track({ hasWork: () => false, drain: async () => {} });
			assert.equal(shutdownDrainsHaveWork(), false);
			track({ hasWork: () => true, drain: async () => {} });
			assert.equal(shutdownDrainsHaveWork(), true);
		});
		it('is isolated from a hasWork that throws (treated as no work from that drain)', () => {
			track({
				hasWork() {
					throw new Error('boom');
				},
				drain: async () => {},
			});
			assert.equal(shutdownDrainsHaveWork(), false);
		});
	});

	describe('getShutdownDrainCeilingMs', () => {
		afterEach(() => env.setProperty(CONFIG_PARAMS.REPLICATION_BLOBSENDDRAINTIMEOUT, undefined));

		it('defaults to 10 minutes when unset, null, or empty/blank', () => {
			env.setProperty(CONFIG_PARAMS.REPLICATION_BLOBSENDDRAINTIMEOUT, undefined);
			assert.equal(getShutdownDrainCeilingMs(), 600_000);
			env.setProperty(CONFIG_PARAMS.REPLICATION_BLOBSENDDRAINTIMEOUT, null);
			assert.equal(getShutdownDrainCeilingMs(), 600_000);
			env.setProperty(CONFIG_PARAMS.REPLICATION_BLOBSENDDRAINTIMEOUT, '');
			assert.equal(getShutdownDrainCeilingMs(), 600_000);
			env.setProperty(CONFIG_PARAMS.REPLICATION_BLOBSENDDRAINTIMEOUT, '   ');
			assert.equal(getShutdownDrainCeilingMs(), 600_000);
		});
		it('coerces a numeric-string config value (YAML/HARPER_CONFIG) to a number', () => {
			env.setProperty(CONFIG_PARAMS.REPLICATION_BLOBSENDDRAINTIMEOUT, '300000');
			assert.equal(getShutdownDrainCeilingMs(), 300_000);
		});
		it('accepts a real number, and an explicit 0 (disable) passes through', () => {
			env.setProperty(CONFIG_PARAMS.REPLICATION_BLOBSENDDRAINTIMEOUT, 120_000);
			assert.equal(getShutdownDrainCeilingMs(), 120_000);
			env.setProperty(CONFIG_PARAMS.REPLICATION_BLOBSENDDRAINTIMEOUT, 0);
			assert.equal(getShutdownDrainCeilingMs(), 0);
		});
		it('clamps an oversized value to the max timer to prevent setTimeout overflow', () => {
			env.setProperty(CONFIG_PARAMS.REPLICATION_BLOBSENDDRAINTIMEOUT, 3_000_000_000);
			assert.equal(getShutdownDrainCeilingMs(), 2_147_483_647);
		});
		it('falls back to the default on a non-finite or negative value', () => {
			env.setProperty(CONFIG_PARAMS.REPLICATION_BLOBSENDDRAINTIMEOUT, 'not-a-number');
			assert.equal(getShutdownDrainCeilingMs(), 600_000);
			env.setProperty(CONFIG_PARAMS.REPLICATION_BLOBSENDDRAINTIMEOUT, -5);
			assert.equal(getShutdownDrainCeilingMs(), 600_000);
		});
	});

	describe('boundedTerminateDelay', () => {
		const NOW = 1_000_000;
		const BASE = 20_000; // threadTerminationTimeout * 2
		const CEILING = 600_000;

		it('adds base headroom to a within-ceiling deadline', () => {
			// deadline 5min out → 5min remaining + base
			assert.equal(boundedTerminateDelay(NOW + 300_000, NOW, BASE, CEILING), 300_000 + BASE);
		});
		it('clamps a deadline beyond the ceiling down to the ceiling', () => {
			// rogue "1 day" deadline → clamped to ceiling + base
			assert.equal(boundedTerminateDelay(NOW + 86_400_000, NOW, BASE, CEILING), CEILING + BASE);
		});
		it('lets a shrink (now-deadline reset) pass through to just the base headroom', () => {
			assert.equal(boundedTerminateDelay(NOW, NOW, BASE, CEILING), BASE);
			assert.equal(boundedTerminateDelay(NOW - 5_000, NOW, BASE, CEILING), BASE); // past deadline floors at 0 + base
		});
		it('falls back to no extension (base only) on a non-finite deadline', () => {
			assert.equal(boundedTerminateDelay(NaN, NOW, BASE, CEILING), BASE);
			assert.equal(boundedTerminateDelay(undefined, NOW, BASE, CEILING), BASE);
		});
		it('clamps the final delay to the max timer even when ceiling + base headroom would overflow it', () => {
			// A ceiling at (or near) the max timer value plus base headroom on top would otherwise exceed
			// MAX_TIMER_MS, which Node coerces to ~1ms — firing the backstop almost immediately instead of
			// honoring the drain. The ceiling-only clamp isn't enough; the sum must be clamped too.
			const MAX_TIMER_MS = 2_147_483_647;
			assert.equal(boundedTerminateDelay(NOW + MAX_TIMER_MS, NOW, BASE, MAX_TIMER_MS), MAX_TIMER_MS);
		});
	});

	describe('runShutdownDrains', () => {
		it('resolves immediately when no drains are registered', async () => {
			await runShutdownDrains(Date.now() + 10_000);
		});

		it('awaits every registered drain', async () => {
			let a = false;
			let b = false;
			track({ hasWork: () => true, drain: async () => void (a = true) });
			track({ hasWork: () => true, drain: async () => void (b = true) });
			await runShutdownDrains(Date.now() + 10_000);
			assert.equal(a, true);
			assert.equal(b, true);
		});

		it('never rejects when a drain rejects (so the shutdown sequence continues)', async () => {
			let ran = false;
			track({
				hasWork: () => true,
				drain: async () => {
					throw new Error('drain failed');
				},
			});
			track({ hasWork: () => true, drain: async () => void (ran = true) });
			await runShutdownDrains(Date.now() + 10_000); // must resolve, not throw
			assert.equal(ran, true);
		});

		it('is bounded by the deadline when a drain ignores it', async () => {
			track({ hasWork: () => true, drain: () => new Promise(() => {}) }); // never resolves
			const start = Date.now();
			await runShutdownDrains(start + 150);
			const elapsed = Date.now() - start;
			// Lower bound has margin for timer/Date.now jitter (a setTimeout may fire a hair early); the
			// point is it waited ~the deadline rather than resolving immediately, and didn't hang.
			assert.ok(elapsed >= 120, `expected >= 120ms, got ${elapsed}`);
			assert.ok(elapsed < 2000, `expected < 2000ms, got ${elapsed}`);
		});
	});
});
