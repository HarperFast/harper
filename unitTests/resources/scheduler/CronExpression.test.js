'use strict';

const assert = require('node:assert');
const {
	CronExpression,
	InvalidCronExpressionError,
	toZonedWallTime,
	fromZonedWallTime,
	validateTimezone,
} = require('#src/resources/scheduler/CronExpression');

// All schedule assertions pass an explicit timezone so results do not depend
// on the machine the tests run on.
const UTC = 'UTC';
const NEW_YORK = 'America/New_York';

function nextIso(expression, afterIso, timezone = UTC) {
	return new CronExpression(expression).nextDate(new Date(afterIso), timezone)?.toISOString();
}

function previousIso(expression, beforeIso, timezone = UTC) {
	return new CronExpression(expression).previousDate(new Date(beforeIso), timezone)?.toISOString();
}

describe('CronExpression', () => {
	describe('parsing', () => {
		it('rejects the wrong number of fields', () => {
			assert.throws(() => new CronExpression('* * * *'), InvalidCronExpressionError);
			assert.throws(() => new CronExpression('0 0 * * * *'), InvalidCronExpressionError);
			assert.throws(() => new CronExpression(''), InvalidCronExpressionError);
		});

		it('rejects out-of-range and malformed values', () => {
			assert.throws(() => new CronExpression('60 * * * *'), InvalidCronExpressionError);
			assert.throws(() => new CronExpression('* 24 * * *'), InvalidCronExpressionError);
			assert.throws(() => new CronExpression('* * 0 * *'), InvalidCronExpressionError);
			assert.throws(() => new CronExpression('* * 32 * *'), InvalidCronExpressionError);
			assert.throws(() => new CronExpression('* * * 13 *'), InvalidCronExpressionError);
			assert.throws(() => new CronExpression('* * * * 8'), InvalidCronExpressionError);
			assert.throws(() => new CronExpression('a * * * *'), InvalidCronExpressionError);
			assert.throws(() => new CronExpression('1- * * * *'), InvalidCronExpressionError);
			assert.throws(() => new CronExpression('5-1 * * * *'), InvalidCronExpressionError);
			assert.throws(() => new CronExpression('*/0 * * * *'), InvalidCronExpressionError);
			assert.throws(() => new CronExpression('*/x * * * *'), InvalidCronExpressionError);
			assert.throws(() => new CronExpression('1//2 * * * *'), InvalidCronExpressionError);
			assert.throws(() => new CronExpression('1,,2 * * * *'), InvalidCronExpressionError);
			assert.throws(() => new CronExpression('* * * FOO *'), InvalidCronExpressionError);
		});

		it('rejects schedules that can never fire', () => {
			assert.throws(() => new CronExpression('0 0 30 2 *'), InvalidCronExpressionError);
			assert.throws(() => new CronExpression('0 0 31 4 *'), InvalidCronExpressionError);
		});

		it('accepts leap-day schedules', () => {
			assert.strictEqual(nextIso('0 0 29 2 *', '2026-07-15T00:00:00Z'), '2028-02-29T00:00:00.000Z');
		});

		it('supports macros', () => {
			assert.strictEqual(nextIso('@daily', '2026-07-15T10:30:00Z'), '2026-07-16T00:00:00.000Z');
			assert.strictEqual(nextIso('@hourly', '2026-07-15T10:30:00Z'), '2026-07-15T11:00:00.000Z');
			assert.strictEqual(nextIso('@weekly', '2026-07-15T10:30:00Z'), '2026-07-19T00:00:00.000Z');
			assert.strictEqual(nextIso('@monthly', '2026-07-15T10:30:00Z'), '2026-08-01T00:00:00.000Z');
			assert.strictEqual(nextIso('@yearly', '2026-07-15T10:30:00Z'), '2027-01-01T00:00:00.000Z');
		});
	});

	describe('nextDate', () => {
		it('handles steps', () => {
			assert.strictEqual(nextIso('*/15 * * * *', '2026-07-15T10:07:00Z'), '2026-07-15T10:15:00.000Z');
			assert.strictEqual(nextIso('*/15 * * * *', '2026-07-15T10:45:00Z'), '2026-07-15T11:00:00.000Z');
			// `5/15` = every 15 starting at 5
			assert.strictEqual(nextIso('5/15 * * * *', '2026-07-15T10:36:00Z'), '2026-07-15T10:50:00.000Z');
		});

		it('is strictly after the reference time', () => {
			assert.strictEqual(nextIso('30 10 * * *', '2026-07-15T10:30:00Z'), '2026-07-16T10:30:00.000Z');
			// A second into the matching minute still rolls to the next occurrence
			assert.strictEqual(nextIso('30 10 * * *', '2026-07-15T10:30:01Z'), '2026-07-16T10:30:00.000Z');
		});

		it('handles lists and ranges', () => {
			assert.strictEqual(nextIso('0 9-17 * * *', '2026-07-15T17:30:00Z'), '2026-07-16T09:00:00.000Z');
			assert.strictEqual(nextIso('0,30 6 * * *', '2026-07-15T06:05:00Z'), '2026-07-15T06:30:00.000Z');
		});

		it('handles month and day-of-week names', () => {
			// 2026-07-15 is a Wednesday
			assert.strictEqual(nextIso('0 12 * * MON-FRI', '2026-07-17T13:00:00Z'), '2026-07-20T12:00:00.000Z');
			assert.strictEqual(nextIso('0 0 1 JAN *', '2026-07-15T00:00:00Z'), '2027-01-01T00:00:00.000Z');
		});

		it('treats day-of-week 7 as Sunday', () => {
			assert.strictEqual(nextIso('0 0 * * 7', '2026-07-15T00:00:00Z'), nextIso('0 0 * * 0', '2026-07-15T00:00:00Z'));
			assert.strictEqual(nextIso('0 0 * * 7', '2026-07-15T00:00:00Z'), '2026-07-19T00:00:00.000Z');
		});

		it('uses OR semantics when both day fields are restricted', () => {
			// Fires on the 13th of the month AND on every Friday
			assert.strictEqual(nextIso('0 0 13 * FRI', '2026-07-15T00:00:00Z'), '2026-07-17T00:00:00.000Z');
			assert.strictEqual(nextIso('0 0 13 * FRI', '2026-08-08T00:00:00Z'), '2026-08-13T00:00:00.000Z');
		});

		it('uses AND semantics when only one day field is restricted', () => {
			assert.strictEqual(nextIso('0 0 13 * *', '2026-07-15T00:00:00Z'), '2026-08-13T00:00:00.000Z');
		});

		it('advances across month and year boundaries', () => {
			assert.strictEqual(nextIso('59 23 31 12 *', '2026-07-15T00:00:00Z'), '2026-12-31T23:59:00.000Z');
			assert.strictEqual(nextIso('0 0 1 * *', '2026-12-31T23:59:00Z'), '2027-01-01T00:00:00.000Z');
		});

		it('evaluates in the requested timezone', () => {
			// 02:00 New York (EDT, UTC-4) = 06:00 UTC
			assert.strictEqual(nextIso('0 2 * * *', '2026-07-15T00:00:00Z', NEW_YORK), '2026-07-15T06:00:00.000Z');
		});
	});

	describe('previousDate', () => {
		it('finds the most recent occurrence strictly before the reference', () => {
			assert.strictEqual(previousIso('*/15 * * * *', '2026-07-15T10:07:00Z'), '2026-07-15T10:00:00.000Z');
			assert.strictEqual(previousIso('30 10 * * *', '2026-07-15T10:30:00Z'), '2026-07-14T10:30:00.000Z');
			assert.strictEqual(previousIso('0 2 * * *', '2026-07-15T01:00:00Z'), '2026-07-14T02:00:00.000Z');
		});

		it('walks back across month boundaries', () => {
			assert.strictEqual(previousIso('0 0 31 * *', '2026-07-15T00:00:00Z'), '2026-05-31T00:00:00.000Z');
		});

		it('is the inverse of nextDate around a fixed point', () => {
			const expression = new CronExpression('*/5 * * * *');
			const reference = new Date('2026-07-15T10:02:30Z');
			const next = expression.nextDate(reference, UTC);
			const previous = expression.previousDate(next, UTC);
			assert.strictEqual(previous.toISOString(), '2026-07-15T10:00:00.000Z');
		});
	});

	describe('DST transitions (America/New_York)', () => {
		// Spring forward 2026: 2:00 AM EST -> 3:00 AM EDT on March 8
		it('fires a schedule inside the spring-forward gap at the shifted instant', () => {
			// Wall time 02:30 does not exist on 2026-03-08; the job fires at the
			// instant the probe resolves to (03:30 EDT) rather than being dropped
			assert.strictEqual(nextIso('30 2 * * *', '2026-03-08T05:00:00Z', NEW_YORK), '2026-03-08T07:30:00.000Z');
		});

		// Fall back 2026: 2:00 AM EDT -> 1:00 AM EST on November 1; wall times
		// 01:00-01:59 occur twice
		it('fires an ambiguous fall-back time once, at the first occurrence', () => {
			assert.strictEqual(nextIso('30 1 * * *', '2026-11-01T04:00:00Z', NEW_YORK), '2026-11-01T05:30:00.000Z');
		});

		it('does not double-fire when the reference is inside the repeated hour', () => {
			// 06:00 UTC = 01:00 EST, the second pass through the 1 AM hour. The
			// 01:30 wall time maps to 05:30 UTC (already past); the next real
			// firing is the following day.
			assert.strictEqual(nextIso('30 1 * * *', '2026-11-01T06:00:00Z', NEW_YORK), '2026-11-02T06:30:00.000Z');
		});
	});

	describe('timezone helpers', () => {
		it('round-trips instants through wall time', () => {
			const instant = new Date('2026-07-15T18:45:00Z');
			const wall = toZonedWallTime(instant, NEW_YORK);
			// 18:45 UTC = 14:45 EDT
			assert.strictEqual(wall.toISOString(), '2026-07-15T14:45:00.000Z');
			assert.strictEqual(fromZonedWallTime(wall, NEW_YORK).toISOString(), instant.toISOString());
		});

		it('validates timezone names', () => {
			assert.strictEqual(validateTimezone('America/Denver'), 'America/Denver');
			assert.throws(() => validateTimezone('Not/AZone'), /Unknown timezone/);
		});
	});
});
