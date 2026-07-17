'use strict';

const assert = require('node:assert');
const {
	pickNextLeader,
	promotionWaitMs,
	isHeartbeatStale,
	findMissedCronOccurrence,
	registerComponentJobs,
	unregisterComponentJobs,
	safeErrorMessage,
	stopSchedulerEngine,
	getEngineRole,
	getRegisteredJobNames,
	STALE_THRESHOLD_MS,
	PROMOTION_ESCALATION_MS,
} = require('#src/resources/scheduler/engine');
const { CronExpression } = require('#src/resources/scheduler/CronExpression');

describe('scheduler engine', () => {
	afterEach(() => {
		stopSchedulerEngine();
	});

	describe('pickNextLeader', () => {
		it('elects the alphabetically-first node', () => {
			assert.strictEqual(pickNextLeader(['node-b', 'node-a', 'node-c'].sort(), null), 'node-a');
		});

		it('skips a stale leader', () => {
			assert.strictEqual(pickNextLeader(['node-a', 'node-b', 'node-c'], 'node-a'), 'node-b');
		});

		it('falls back to the stale leader when it is the only node', () => {
			assert.strictEqual(pickNextLeader(['node-a'], 'node-a'), 'node-a');
		});

		it('returns null for an empty roster', () => {
			assert.strictEqual(pickNextLeader([], null), null);
		});
	});

	describe('promotionWaitMs', () => {
		const roster = ['node-a', 'node-b', 'node-c'];

		it('lets the preferred node promote immediately', () => {
			assert.strictEqual(promotionWaitMs(roster, 'node-a', null), 0);
		});

		it('escalates by roster position so a dead preferred node cannot deadlock the cluster', () => {
			assert.strictEqual(promotionWaitMs(roster, 'node-b', null), PROMOTION_ESCALATION_MS);
			assert.strictEqual(promotionWaitMs(roster, 'node-c', null), 2 * PROMOTION_ESCALATION_MS);
		});

		it('excludes a stale leader from the queue', () => {
			assert.strictEqual(promotionWaitMs(roster, 'node-b', 'node-a'), 0);
			assert.strictEqual(promotionWaitMs(roster, 'node-c', 'node-a'), PROMOTION_ESCALATION_MS);
		});

		it('sends the stale leader itself to the back of the queue', () => {
			assert.strictEqual(promotionWaitMs(roster, 'node-a', 'node-a'), 2 * PROMOTION_ESCALATION_MS);
		});

		it('lets a lone node (that was the stale leader) promote immediately', () => {
			// Single-node roster where that node is the stale leader: the eligible
			// queue is empty, so the full roster is the queue and it is first
			assert.strictEqual(promotionWaitMs(['node-a'], 'node-a', 'node-a'), 0);
		});
	});

	describe('isHeartbeatStale', () => {
		const now = Date.parse('2026-07-15T12:00:00Z');

		it('treats a missing or unparseable heartbeat as stale', () => {
			assert.strictEqual(isHeartbeatStale(undefined, now), true);
			assert.strictEqual(isHeartbeatStale('not a date', now), true);
		});

		it('respects the staleness threshold', () => {
			const fresh = new Date(now - STALE_THRESHOLD_MS + 1000).toISOString();
			const stale = new Date(now - STALE_THRESHOLD_MS - 1000).toISOString();
			assert.strictEqual(isHeartbeatStale(fresh, now), false);
			assert.strictEqual(isHeartbeatStale(stale, now), true);
		});
	});

	describe('findMissedCronOccurrence', () => {
		const daily2am = new CronExpression('0 2 * * *');

		it('reports the missed occurrence when the baseline predates it', () => {
			const missed = findMissedCronOccurrence(
				daily2am,
				'UTC',
				new Date('2026-07-14T02:00:00Z'), // last ran yesterday
				new Date('2026-07-15T08:00:00Z') // it is now well past 02:00
			);
			assert.strictEqual(missed.toISOString(), '2026-07-15T02:00:00.000Z');
		});

		it('returns null when the job is up to date', () => {
			const missed = findMissedCronOccurrence(
				daily2am,
				'UTC',
				new Date('2026-07-15T02:00:05Z'), // ran at (just after) the last occurrence
				new Date('2026-07-15T08:00:00Z')
			);
			assert.strictEqual(missed, null);
		});

		it('returns null when the baseline is newer than every occurrence (new job)', () => {
			const missed = findMissedCronOccurrence(
				daily2am,
				'UTC',
				new Date('2026-07-15T08:00:00Z'),
				new Date('2026-07-15T08:00:30Z')
			);
			assert.strictEqual(missed, null);
		});
	});

	describe('safeErrorMessage', () => {
		it('extracts a normal error message', () => {
			assert.strictEqual(safeErrorMessage(new Error('boom')), 'boom');
		});

		it('handles primitives and message-less values', () => {
			assert.strictEqual(safeErrorMessage('a string error'), 'a string error');
			assert.strictEqual(safeErrorMessage(42), '42');
			assert.strictEqual(safeErrorMessage(undefined), 'undefined');
		});

		it('survives objects whose message getter throws', () => {
			const hostile = {};
			Object.defineProperty(hostile, 'message', {
				get() {
					throw new Error('gotcha');
				},
			});
			assert.strictEqual(safeErrorMessage(hostile), String(hostile));
		});

		it('survives objects that cannot be stringified at all', () => {
			const unstringifiable = Object.create(null);
			Object.defineProperty(unstringifiable, 'message', {
				get() {
					throw new Error('gotcha');
				},
			});
			assert.strictEqual(safeErrorMessage(unstringifiable), 'unknown error');
		});
	});

	describe('job registration', () => {
		const noopJob = (name) => ({
			name,
			componentName: 'test-app',
			cron: new CronExpression('0 2 * * *'),
			handler: () => {},
		});

		it('starts inactive and registration alone does not change the role', () => {
			assert.strictEqual(getEngineRole(), 'inactive');
			registerComponentJobs('test-app', [noopJob('a')]);
			assert.strictEqual(getEngineRole(), 'inactive');
		});

		it('replaces a component job set on re-registration and forgets it on unregister', () => {
			registerComponentJobs('test-app', [noopJob('a'), noopJob('b')]);
			assert.deepStrictEqual(getRegisteredJobNames('test-app').sort(), ['a', 'b']);
			// Re-registration (reload/redeploy) must replace, not accumulate
			registerComponentJobs('test-app', [noopJob('b')]);
			assert.deepStrictEqual(getRegisteredJobNames('test-app'), ['b']);
			unregisterComponentJobs('test-app');
			assert.deepStrictEqual(getRegisteredJobNames('test-app'), []);
			// Unregistering an unknown component is a no-op
			unregisterComponentJobs('never-registered');
		});
	});
});
