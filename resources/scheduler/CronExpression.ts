import { ClientError } from '../../utility/errors/hdbError.ts';

/**
 * Thrown when a cron expression cannot be parsed, or a schedule can never fire
 * (e.g. `0 0 30 2 *` — February 30th).
 */
export class InvalidCronExpressionError extends ClientError {
	constructor(message: string) {
		super(message, 400);
		this.name = 'InvalidCronExpressionError';
	}
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAY_OF_WEEK_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const MACROS: Record<string, string> = {
	'@yearly': '0 0 1 1 *',
	'@annually': '0 0 1 1 *',
	'@monthly': '0 0 1 * *',
	'@weekly': '0 0 * * 0',
	'@daily': '0 0 * * *',
	'@midnight': '0 0 * * *',
	'@hourly': '0 * * * *',
};

// How far ahead/behind nextDate/prevDate will search before concluding the
// schedule can never fire. Four years covers any leap-day schedule.
const MAX_SEARCH_YEARS = 4;

interface FieldSpec {
	min: number;
	max: number;
	names?: string[];
	// Offset applied to named values (month names are 1-based: JAN = 1)
	nameOffset?: number;
}

const MINUTE_FIELD: FieldSpec = { min: 0, max: 59 };
const HOUR_FIELD: FieldSpec = { min: 0, max: 23 };
const DAY_OF_MONTH_FIELD: FieldSpec = { min: 1, max: 31 };
const MONTH_FIELD: FieldSpec = { min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 };
const DAY_OF_WEEK_FIELD: FieldSpec = { min: 0, max: 7, names: DAY_OF_WEEK_NAMES, nameOffset: 0 };

/**
 * Parse one cron field (e.g. `1,15,30-45`, `MON-FRI`, or a step like `0-59/15`)
 * into a boolean lookup keyed by value. Supports `*`, single values, ranges,
 * steps, lists, and the standard month/day names.
 */
function parseField(fieldValue: string, spec: FieldSpec, fieldName: string, expression: string): boolean[] {
	const allowed: boolean[] = new Array(spec.max + 1).fill(false);
	const fail = (reason: string): never => {
		throw new InvalidCronExpressionError(
			`Invalid ${fieldName} field "${fieldValue}" in cron expression "${expression}": ${reason}`
		);
	};
	const parseValue = (raw: string): number => {
		if (spec.names) {
			const nameIndex = spec.names.indexOf(raw.toUpperCase());
			if (nameIndex >= 0) return nameIndex + (spec.nameOffset ?? 0);
		}
		if (!/^\d+$/.test(raw)) fail(`"${raw}" is not a number${spec.names ? ' or recognized name' : ''}`);
		const value = Number(raw);
		if (value < spec.min || value > spec.max) fail(`${value} is outside the allowed range ${spec.min}-${spec.max}`);
		return value;
	};

	for (const part of fieldValue.split(',')) {
		if (part === '') fail('empty list entry');
		const [base, stepText, extra] = part.split('/');
		if (extra !== undefined) fail('multiple "/" step separators');
		let step = 1;
		if (stepText !== undefined) {
			if (!/^\d+$/.test(stepText) || Number(stepText) < 1) fail(`step "${stepText}" must be a positive integer`);
			step = Number(stepText);
		}
		let rangeStart: number;
		let rangeEnd: number;
		if (base === '*') {
			rangeStart = spec.min;
			rangeEnd = spec.max;
		} else if (base.includes('-')) {
			const [startText, endText, extraRange] = base.split('-');
			if (extraRange !== undefined || startText === '' || endText === '') fail('malformed range');
			rangeStart = parseValue(startText);
			rangeEnd = parseValue(endText);
			if (rangeStart > rangeEnd) fail(`range start ${rangeStart} is greater than range end ${rangeEnd}`);
		} else {
			rangeStart = parseValue(base);
			// `5/15` means "every 15 starting at 5"; a bare `5` means just 5
			rangeEnd = stepText !== undefined ? spec.max : rangeStart;
		}
		for (let value = rangeStart; value <= rangeEnd; value += step) {
			allowed[value] = true;
		}
	}
	return allowed;
}

// Cache one formatter per timezone: Intl.DateTimeFormat construction is
// expensive relative to formatting, and the same few zones recur.
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function getZoneFormatter(timezone: string): Intl.DateTimeFormat {
	let formatter = zoneFormatters.get(timezone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
		});
		zoneFormatters.set(timezone, formatter);
	}
	return formatter;
}

/**
 * Validate an IANA timezone name. Returns the normalized name, or throws.
 */
export function validateTimezone(timezone: string): string {
	try {
		getZoneFormatter(timezone);
		return timezone;
	} catch (error) {
		zoneFormatters.delete(timezone);
		throw new ClientError(`Unknown timezone "${timezone}": ${error.message}`, 400);
	}
}

let systemTimezone: string | undefined;

export function getSystemTimezone(): string {
	systemTimezone ??= Intl.DateTimeFormat().resolvedOptions().timeZone;
	return systemTimezone;
}

/**
 * Shift a real instant so its UTC fields carry the wall-clock time in the given
 * timezone. The evaluator works entirely on these "zoned wall time" Dates
 * (reading getUTC* fields), keeping the schedule math independent of the
 * system timezone.
 */
export function toZonedWallTime(date: Date, timezone: string): Date {
	const parts: Record<string, string> = {};
	for (const part of getZoneFormatter(timezone).formatToParts(date)) {
		parts[part.type] = part.value;
	}
	return new Date(
		Date.UTC(
			Number(parts.year),
			Number(parts.month) - 1,
			Number(parts.day),
			// hourCycle h23 should prevent "24", but guard anyway — some ICU
			// versions have produced it for midnight
			Number(parts.hour === '24' ? '0' : parts.hour),
			Number(parts.minute),
			Number(parts.second)
		)
	);
}

/**
 * Inverse of toZonedWallTime: given a Date whose UTC fields represent
 * wall-clock time in `timezone`, return the real instant. During DST
 * transitions a wall time may be ambiguous (fall-back) or nonexistent
 * (spring-forward); this resolves to the instant the current offset probe
 * lands on, and callers guard against the result crossing their reference
 * point (see nextDate/prevDate).
 */
export function fromZonedWallTime(wallTime: Date, timezone: string): Date {
	const asUtc = wallTime.getTime();
	const probe = toZonedWallTime(new Date(asUtc), timezone);
	const offset = probe.getTime() - asUtc;
	return new Date(asUtc - offset);
}

const MINUTE_MS = 60_000;

/**
 * A parsed five-field POSIX cron expression (minute, hour, day-of-month,
 * month, day-of-week) supporting `*`, lists, ranges, steps, month/day names,
 * and the common `@daily`-style macros. Follows the standard rule that when
 * both day-of-month and day-of-week are restricted, a date matches if EITHER
 * matches.
 */
export class CronExpression {
	expression: string;
	#minutes: boolean[];
	#hours: boolean[];
	#daysOfMonth: boolean[];
	#months: boolean[];
	#daysOfWeek: boolean[];
	#dayOfMonthRestricted: boolean;
	#dayOfWeekRestricted: boolean;

	constructor(expression: string) {
		this.expression = expression;
		const normalized = (MACROS[expression.trim().toLowerCase()] ?? expression).trim();
		const fields = normalized.split(/\s+/);
		if (fields.length !== 5) {
			throw new InvalidCronExpressionError(
				`Cron expression "${expression}" has ${fields.length} fields; expected 5 (minute hour day-of-month month day-of-week)`
			);
		}
		this.#minutes = parseField(fields[0], MINUTE_FIELD, 'minute', expression);
		this.#hours = parseField(fields[1], HOUR_FIELD, 'hour', expression);
		this.#daysOfMonth = parseField(fields[2], DAY_OF_MONTH_FIELD, 'day-of-month', expression);
		this.#months = parseField(fields[3], MONTH_FIELD, 'month', expression);
		this.#daysOfWeek = parseField(fields[4], DAY_OF_WEEK_FIELD, 'day-of-week', expression);
		// 7 is an alias for Sunday
		if (this.#daysOfWeek[7]) this.#daysOfWeek[0] = true;
		this.#dayOfMonthRestricted = fields[2] !== '*';
		this.#dayOfWeekRestricted = fields[4] !== '*';
		// Surface never-firing schedules (e.g. February 30th) at parse time
		// rather than as a silently idle job
		if (this.nextWallTime(new Date()) === null) {
			throw new InvalidCronExpressionError(`Cron expression "${expression}" can never fire`);
		}
	}

	#dayMatches(wallTime: Date): boolean {
		const dayOfMonthMatch = this.#daysOfMonth[wallTime.getUTCDate()];
		const dayOfWeekMatch = this.#daysOfWeek[wallTime.getUTCDay()];
		if (this.#dayOfMonthRestricted && this.#dayOfWeekRestricted) return dayOfMonthMatch || dayOfWeekMatch;
		if (this.#dayOfMonthRestricted) return dayOfMonthMatch;
		if (this.#dayOfWeekRestricted) return dayOfWeekMatch;
		return true;
	}

	/**
	 * The next matching wall-clock time strictly after `afterWallTime` (both as
	 * "zoned wall time" Dates — see toZonedWallTime). Returns null if no match
	 * exists within the search horizon.
	 */
	nextWallTime(afterWallTime: Date): Date | null {
		// Truncate to the minute, then step forward
		let candidate = new Date(Math.floor(afterWallTime.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
		const horizon = afterWallTime.getTime() + MAX_SEARCH_YEARS * 366 * 24 * 60 * MINUTE_MS;
		while (candidate.getTime() <= horizon) {
			if (!this.#months[candidate.getUTCMonth() + 1]) {
				// First minute of the next month
				candidate = new Date(Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, 1));
				continue;
			}
			if (!this.#dayMatches(candidate)) {
				candidate = new Date(Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), candidate.getUTCDate() + 1));
				continue;
			}
			if (!this.#hours[candidate.getUTCHours()]) {
				candidate = new Date(
					Date.UTC(
						candidate.getUTCFullYear(),
						candidate.getUTCMonth(),
						candidate.getUTCDate(),
						candidate.getUTCHours() + 1
					)
				);
				continue;
			}
			if (!this.#minutes[candidate.getUTCMinutes()]) {
				candidate = new Date(candidate.getTime() + MINUTE_MS);
				continue;
			}
			return candidate;
		}
		return null;
	}

	/**
	 * The latest matching wall-clock time strictly before `beforeWallTime`
	 * (zoned wall time in, zoned wall time out). Returns null if no match
	 * exists within the search horizon.
	 */
	previousWallTime(beforeWallTime: Date): Date | null {
		let candidate = new Date(Math.ceil(beforeWallTime.getTime() / MINUTE_MS) * MINUTE_MS - MINUTE_MS);
		const horizon = beforeWallTime.getTime() - MAX_SEARCH_YEARS * 366 * 24 * 60 * MINUTE_MS;
		while (candidate.getTime() >= horizon) {
			if (!this.#months[candidate.getUTCMonth() + 1]) {
				// Last minute of the previous month
				candidate = new Date(Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), 1) - MINUTE_MS);
				continue;
			}
			if (!this.#dayMatches(candidate)) {
				// Last minute of the previous day
				candidate = new Date(
					Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), candidate.getUTCDate()) - MINUTE_MS
				);
				continue;
			}
			if (!this.#hours[candidate.getUTCHours()]) {
				// Last minute of the previous hour
				candidate = new Date(
					Date.UTC(
						candidate.getUTCFullYear(),
						candidate.getUTCMonth(),
						candidate.getUTCDate(),
						candidate.getUTCHours()
					) - MINUTE_MS
				);
				continue;
			}
			if (!this.#minutes[candidate.getUTCMinutes()]) {
				candidate = new Date(candidate.getTime() - MINUTE_MS);
				continue;
			}
			return candidate;
		}
		return null;
	}

	/**
	 * The next real instant strictly after `after` at which this expression
	 * fires in the given timezone (defaults to the system timezone). Returns
	 * null for schedules with no future occurrence in the search horizon.
	 */
	nextDate(after: Date, timezone: string = getSystemTimezone()): Date | null {
		let wall = toZonedWallTime(after, timezone);
		// A DST fall-back overlap can map the computed wall time to an instant
		// at or before `after`; advance until we cross it (the overlap is at
		// most an hour or two, so this converges in a couple of iterations)
		for (let attempts = 0; attempts < 5; attempts++) {
			const nextWall = this.nextWallTime(wall);
			if (nextWall === null) return null;
			const instant = fromZonedWallTime(nextWall, timezone);
			if (instant.getTime() > after.getTime()) return instant;
			wall = nextWall;
		}
		return null;
	}

	/**
	 * The most recent real instant strictly before `before` at which this
	 * expression fired in the given timezone (defaults to the system timezone).
	 */
	previousDate(before: Date, timezone: string = getSystemTimezone()): Date | null {
		let wall = toZonedWallTime(before, timezone);
		for (let attempts = 0; attempts < 5; attempts++) {
			const previousWall = this.previousWallTime(wall);
			if (previousWall === null) return null;
			const instant = fromZonedWallTime(previousWall, timezone);
			if (instant.getTime() < before.getTime()) return instant;
			wall = previousWall;
		}
		return null;
	}
}
