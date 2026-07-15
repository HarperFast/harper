'use strict';

const assert = require('node:assert');
const {
	pickNextLeader,
	isHeartbeatStale,
	findMissedCronOccurrence,
	registerComponentJobs,
	unregisterComponentJobs,
	stopSchedulerEngine,
	getEngineRole,
	STALE_THRESHOLD_MS,
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
			// Re-registration (reload/redeploy) must not accumulate jobs or throw
			registerComponentJobs('test-app', [noopJob('b')]);
			unregisterComponentJobs('test-app');
			// Unregistering an unknown component is a no-op
			unregisterComponentJobs('never-registered');
		});
	});
});
