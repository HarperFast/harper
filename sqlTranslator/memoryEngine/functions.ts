/**
 * The scalar function and named-aggregate library of the legacy SQL engine. It reproduces AlaSQL 4.22's observable
 * results, quirks included, because legacy SQL users depend on them: `UPPER(NULL)` is `'NULL'`, `LEN(5)` is
 * undefined, `NULLIF` compares with `==`, a call to an unknown function fails only when a row reaches it, and so on.
 * Line references (`alasql.fs.js:N`) point into AlaSQL 4.22.0's `dist/alasql.fs.js`, the reference these semantics
 * were differentially tested against.
 *
 * Nothing here evaluates text as JavaScript. AlaSQL's `__ala__` (the whole AlaSQL instance, so `__ala__('…')` ran
 * arbitrary AlaSQL, JavaScript blocks included) and `OBJECT_ID` (a lookup in AlaSQL's own database registry) are
 * not provided, so a call to either fails like a call to any unknown function.
 */
import { randomUUID } from 'node:crypto';
import * as alasqlExtension from '../../utility/functions/sql/alaSQLExtension.ts';
import dateFunctions from '../../utility/functions/date/dateFunctions.js';
import * as geo from '../../utility/functions/geo.ts';

export { legacyLike } from '../legacyLike.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The engine's row context; opaque here, only passed through to argument evaluators. */
interface EvalContext {
	[key: string]: any;
}

/** A compiled expression, evaluated against the engine's row context. */
export type Evaluator = (ctx: EvalContext) => any;

/**
 * A named aggregate (AlaSQL's `alasql.aggr`), called once per row and once to finish:
 *
 * ```
 * AGGREGATES[funcid](...argValues, accumulator, stage, ...extra)
 * ```
 *
 * - stage 1, the group's first row (alasql.fs.js:10132-10143): `accumulator` is `undefined`; the result becomes it.
 * - stage 2, each later row (alasql.fs.js:10412-10426): the result replaces the accumulator.
 * - stage 3, after the last row (alasql.fs.js:7505-7528): every argument value is `undefined`, there are no extras,
 *   and the result is the aggregate's value.
 *
 * `argValues` is one value per call argument (`MEDIAN(x)` one, `F(x, y)` two), so with more than one argument
 * everything after it shifts right and the function sees an argument value where it expects the accumulator; that
 * is how AlaSQL called them, and these functions keep the positional parameters that make it observable. `extra`
 * is passed at stages 1 and 2 only, and only for GROUP_CONCAT: `separator` (`undefined` when no SEPARATOR clause)
 * and `orderDirection` (the first ORDER BY item's `direction`, else `undefined`), alasql.fs.js:9969-9980.
 */
type AggregateFunction = (...args: any[]) => any;

const UNDEFINED: Evaluator = () => undefined;

function argument(args: Evaluator[], index: number): Evaluator {
	return args[index] ?? UNDEFINED;
}

function evaluateAll(args: Evaluator[], ctx: EvalContext): any[] {
	const values = new Array(args.length);
	for (let i = 0; i < args.length; i++) values[i] = args[i](ctx);
	return values;
}

function nullPrototype<T>(entries: Record<string, T>): Record<string, T> {
	return Object.assign(Object.create(null), entries);
}

// #section: utilities AlaSQL's generated code calls

/** `n2u` (alasql.fs.js:3787): a NaN result becomes `undefined`. AlaSQL wraps each projected column in it. */
export function nanToUndefined(value: any): any {
	// eslint-disable-next-line no-self-compare
	return value === value ? value : undefined;
}

/** `und` (alasql.fs.js:3804): `undefined` stays `undefined` (null does not), anything else goes through `then`. */
export function undefinedOrValue(value: any, then: (value: any) => any): any {
	return value === undefined ? undefined : then(value);
}

/** `utils.setOwn` (alasql.fs.js:4741): assigns a key, making a `__proto__` key an own property. */
export function setOwn(target: any, key: string, value: any): void {
	if (key === '__proto__') {
		Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
	} else {
		target[key] = value;
	}
}

/** `utils.cloneDeep` (alasql.fs.js:4632). */
export function cloneDeep(obj: any): any {
	if (obj === null || typeof obj !== 'object') return obj;
	if (obj instanceof Date) return new Date(obj);
	if (obj instanceof String) return obj.toString();
	if (obj instanceof Number) return +obj;
	// An own `constructor` came from the data, so it is never called.
	const ctor = Object.hasOwn(obj, 'constructor') ? Object : obj.constructor;
	const clone = typeof ctor === 'function' ? new ctor() : {};
	for (const key in obj) {
		if (Object.hasOwn(obj, key)) setOwn(clone, key, cloneDeep(obj[key]));
	}
	return clone;
}

/** `utils.deepEqual` (alasql.fs.js:4668), the `==` and `!==` operators. Walks inherited enumerable keys too. */
export function deepEqual(x: any, y: any): boolean {
	if (x === y) return true;
	if (typeof x === 'object' && x !== null && typeof y === 'object' && y !== null) {
		if (Object.keys(x).length !== Object.keys(y).length) return false;
		for (const key in x) {
			if (!deepEqual(x[key], y[key])) return false;
		}
		return true;
	}
	return false;
}

/** `utils.extend` (alasql.fs.js:4723), also the EXTEND function: copies `b`'s own keys onto `a`, which it mutates. */
export function extend(a: any, b: any): any {
	a = a || {};
	for (const key in b) {
		if (Object.hasOwn(b, key)) setOwn(a, key, b[key]);
	}
	return a;
}

/** `utils.getValueOf` (alasql.fs.js:4776): unwraps `String` and `Number` objects. */
export function getValueOf(value: any): any {
	return typeof value === 'object' && (value instanceof String || value instanceof Number) ? value.valueOf() : value;
}

/** AlaSQL's `Recordset` (alasql.fs.js:6094): a `SELECT RECORDSET` result, its params assigned onto it. */
export class Recordset {
	[key: string]: any;
	data: any[];
	columns: any[];
	constructor(params?: { data?: any[]; columns?: any[]; [key: string]: any }) {
		Object.assign(this, params);
	}
}

/**
 * `utils.flatArray` (alasql.fs.js:4785): for a `Recordset`, each row's value of the first column, unwrapped by
 * `getValueOf`; for an array, each row's value of the first row's first key.
 */
export function flatArray(rows: any): any[] {
	if (!rows || rows.length === 0) return [];
	if (typeof rows === 'object' && rows instanceof Recordset) {
		const columnid = rows.columns[0].columnid;
		return rows.data.map((row: any) => getValueOf(row[columnid]));
	}
	const key = Object.keys(rows[0])[0];
	if (key === undefined) return [];
	return rows.map((row: any) => row[key]);
}

/**
 * `utils.glob` (alasql.fs.js:4951), the GLOB operator. The pattern becomes a regular expression that is then
 * upper-cased whole, escapes included (`\d` turns into `\D`), and an invalid one throws.
 */
export function glob(value: any, pattern: any): boolean {
	let source = '^';
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === '[' && i < pattern.length - 1 && pattern[i + 1] === '^') {
			source += '[^';
			i++;
		} else if (char === '[' || char === ']') source += char;
		else if (char === '*') source += '.*';
		else if (char === '?') source += '.';
		else if ('/.*+?|(){}'.indexOf(char) > -1) source += '\\' + char;
		else source += char;
	}
	source += '$';
	return ('' + (value || '')).toUpperCase().search(RegExp(source.toUpperCase())) > -1;
}

/**
 * `stdfn.REGEXP_LIKE` (alasql.fs.js:13332): the REGEXP operator (`REGEXP_LIKE(left, right)`) and the function.
 * MySQL's `[[:<:]]`/`[[:>:]]` word boundaries become `\b`; `flags` goes to `RegExp` as is.
 */
export function regexpLike(value: any, pattern: any, flags?: any): boolean {
	const source = pattern.replace(/\[\[:<:\]\]/g, '\\b').replace(/\[\[:>:\]\]/g, '\\b');
	return (value || '').search(RegExp(source, flags)) > -1;
}

// #section: dates

const DATE_WITH_DOTS = /^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}/;

/** `newDate` (alasql.fs.js:15111): `yyyy.mm.dd hh:mm:ss` reads as `yyyy-mm-dd hh:mm:ss`; anything else as `new Date`. */
function newDate(d: any): Date {
	if (typeof d === 'string' && DATE_WITH_DOTS.test(d)) d = d.replace('.', '-').replace('.', '-');
	return new Date(d);
}

function pad2(n: number): string {
	return ('0' + n).substr(-2);
}

function pad3(n: number): string {
	return ('00' + n).substr(-3);
}

/** AlaSQL runs with `options.dateAsString` on, so NOW() and CURDATE() return local-time text. */
function localDateText(d: Date): string {
	return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

const PERIODS: Record<string, number> = nullPrototype({
	year: 1000 * 3600 * 24 * 365,
	quarter: (1000 * 3600 * 24 * 365) / 4,
	month: 1000 * 3600 * 24 * 30,
	week: 1000 * 3600 * 24 * 7,
	day: 1000 * 3600 * 24,
	dayofyear: 1000 * 3600 * 24,
	weekday: 1000 * 3600 * 24,
	hour: 1000 * 3600,
	minute: 1000 * 60,
	second: 1000,
	millisecond: 1,
	microsecond: 0.001,
});

const PERIOD_ABBREVIATIONS: Record<string, string> = nullPrototype({
	yy: 'year',
	yyyy: 'year',
	qq: 'quarter',
	q: 'quarter',
	mm: 'month',
	m: 'month',
	dy: 'dayofyear',
	y: 'dayofyear',
	dd: 'day',
	d: 'day',
	wk: 'week',
	ww: 'week',
	dw: 'weekday',
	w: 'weekday',
	hh: 'hour',
	mi: 'minute',
	n: 'minute',
	ss: 'second',
	s: 'second',
	ms: 'millisecond',
	mcs: 'microsecond',
});

function datePart(period: any): string {
	period = period.toLowerCase();
	return PERIOD_ABBREVIATIONS[period] ?? period;
}

function periodLength(period: string): number {
	const length = PERIODS[period];
	if (length === undefined) throw new Error('Unknown date part: ' + period);
	return length;
}

// #section: CAST and CONVERT

interface ConvertArgs {
	dbtypeid?: any;
	dbsize?: any;
	dbprecision?: any;
	style?: any;
}

function dateParts(date: Date) {
	const year = date.getFullYear() - 1900; // Date#getYear()
	return {
		fullYear: date.getFullYear(),
		day: date.toString().substr(4, 3),
		date: pad2(date.getDate()),
		month: pad2(date.getMonth() + 1),
		year: pad2(year),
		hours: pad2(date.getHours()),
		minutes: pad2(date.getMinutes()),
		seconds: pad2(date.getSeconds()),
		milliseconds: pad3(date.getMilliseconds()),
	};
}

function styledDate(style: any, s: ReturnType<typeof dateParts>): string {
	switch (style) {
		case 1:
			return s.month + '/' + s.date + '/' + s.year;
		case 2:
			return s.year + '.' + s.month + '.' + s.date;
		case 3:
			return s.date + '/' + s.month + '/' + s.year;
		case 4:
			return s.date + '.' + s.month + '.' + s.year;
		case 5:
			return s.date + '-' + s.month + '-' + s.year;
		case 6:
			return s.date + ' ' + s.day.toLowerCase() + ' ' + s.year;
		case 7:
			return s.day + ' ' + s.date + ',' + s.year;
		case 8:
		case 108:
			return s.hours + ':' + s.minutes + ':' + s.seconds;
		case 10:
			return s.month + '-' + s.date + '-' + s.year;
		case 11:
			return s.year + '/' + s.month + '/' + s.date;
		case 12:
			return s.year + s.month + s.date;
		case 101:
			return s.month + '/' + s.date + '/' + s.fullYear;
		case 102:
			return s.fullYear + '.' + s.month + '.' + s.date;
		case 103:
			return s.date + '/' + s.month + '/' + s.fullYear;
		case 104:
			return s.date + '.' + s.month + '.' + s.fullYear;
		case 105:
			return s.date + '-' + s.month + '-' + s.fullYear;
		case 106:
			return s.date + ' ' + s.day.toLowerCase() + ' ' + s.fullYear;
		case 107:
			return s.day + ' ' + s.date + ',' + s.fullYear;
		case 110:
			return s.month + '-' + s.date + '-' + s.fullYear;
		case 111:
			return s.fullYear + '/' + s.month + '/' + s.date;
		case 112:
			return s.fullYear + s.month + s.date;
		default:
			throw new Error('The CONVERT style ' + style + ' is not realized yet.');
	}
}

/** `stdfn.CONVERT` (alasql.fs.js:13951), CAST and CONVERT. `args.dbtypeid` keeps its case; the switch upper-cases it. */
function convert(value: any, args: ConvertArgs): any {
	let val = value;
	const type = args.dbtypeid?.toUpperCase();
	let parts: ReturnType<typeof dateParts>;
	if (args.style || args.dbtypeid == 'Date' || type === 'DATE' || type === 'DATETIME' || type === 'DATETIME2') {
		const date = /\d{8}/.test(val)
			? new Date(+val.substr(0, 4), +val.substr(4, 2) - 1, +val.substr(6, 2))
			: newDate(val);
		parts = dateParts(date);
	}
	if (args.style) val = styledDate(args.style, parts);
	switch (type) {
		case 'DATE':
			return `${parts.year}.${parts.month}.${parts.date}`;
		case 'DATETIME':
		case 'DATETIME2':
			return `${parts.fullYear}.${parts.month}.${parts.date} ${parts.hours}:${parts.minutes}:${parts.seconds}.${parts.milliseconds}`;
		case 'MONEY': {
			const m = +val;
			return (m | 0) + ((m * 100) % 100) / 100;
		}
		case 'BOOLEAN':
			return !!val;
		case 'INT':
		case 'INTEGER':
		case 'SMALLINT':
		case 'BIGINT':
		case 'SERIAL':
		case 'SMALLSERIAL':
		case 'BIGSERIAL':
			return val | 0;
		case 'STRING':
		case 'VARCHAR':
		case 'NVARCHAR':
		case 'CHARACTER VARIABLE':
			return args.dbsize ? String(val).substr(0, args.dbsize) : String(val);
		case 'CHAR':
		case 'CHARACTER':
		case 'NCHAR':
			return (val + ' '.repeat(args.dbsize)).substr(0, args.dbsize);
		case 'NUMBER':
		case 'FLOAT':
		case 'DECIMAL':
		case 'NUMERIC': {
			let m = +val;
			if (args.dbsize !== undefined) m = parseFloat(m.toPrecision(args.dbsize));
			if (args.dbprecision !== undefined) m = parseFloat(m.toFixed(args.dbprecision));
			return m;
		}
		case 'JSON':
			if (typeof val === 'object') return val;
			try {
				return JSON.parse(val);
			} catch {
				throw new Error('Cannot convert string to JSON');
			}
		default:
			return val;
	}
}

/**
 * A value AlaSQL wrote into the generated code as JavaScript source (`yy.Convert#toJS`, alasql.fs.js:13910): a
 * NUMBER token's text reads as a sloppy-mode literal, so `010` is octal.
 */
function sourceValue(value: any): any {
	if (typeof value !== 'string') return value;
	if (/^0[0-7]+$/.test(value)) return parseInt(value, 8);
	return Number(value);
}

/**
 * Compiles a `Convert` node (CAST, CONVERT, `::`) as `yy.Convert#toJS` did (alasql.fs.js:13910). A `MAX` size was
 * written into the generated code as the bare identifier `MAX`, so such a cast throws a ReferenceError at run time,
 * after evaluating its operand.
 */
export function compileConvert(
	node: { dbtypeid: any; dbsize?: any; dbprecision?: any; style?: any },
	expression: Evaluator
): Evaluator {
	if (node.dbsize === 'MAX' || node.dbprecision === 'MAX') {
		return (ctx) => {
			expression(ctx);
			throw new ReferenceError('MAX is not defined');
		};
	}
	const args: ConvertArgs = {
		dbtypeid: `${node.dbtypeid}`,
		dbsize: sourceValue(node.dbsize),
		dbprecision: sourceValue(node.dbprecision),
		style: sourceValue(node.style),
	};
	return (ctx) => convert(expression(ctx), args);
}

// #section: inlined functions (alasql.stdlib)

/**
 * AlaSQL compiled these to inline code (alasql.fs.js:13256-13398), each from the JavaScript source of its
 * arguments: a missing argument was the text `undefined`, an argument the template does not use is never
 * evaluated, and `und(s, …)` returns `undefined` only for `undefined`, so most string functions throw on NULL.
 * An argument the template repeats (IFNULL's, NULLIF's) is evaluated once here, which nothing can observe.
 */
type InlineBuilder = (args: Evaluator[]) => Evaluator;

function stringMethod(apply: (y: any) => any): InlineBuilder {
	return (args) => {
		const a = argument(args, 0);
		return (ctx) => {
			const y = a(ctx);
			return y === undefined ? undefined : apply(y);
		};
	};
}

function mathFunction(fn: (...values: number[]) => number): InlineBuilder {
	return (args) => {
		const a = argument(args, 0);
		return (ctx) => fn(a(ctx));
	};
}

function greatest(args: Evaluator[]): Evaluator {
	return (ctx) => evaluateAll(args, ctx).reduce((a, b) => (a > b ? a : b));
}

function least(args: Evaluator[]): Evaluator {
	return (ctx) => evaluateAll(args, ctx).reduce((a, b) => (a < b ? a : b));
}

function substring(args: Evaluator[]): Evaluator {
	if (args.length !== 2 && args.length !== 3) return UNDEFINED;
	const [a, b, c] = args;
	return (ctx) => {
		const y = a(ctx);
		if (y === undefined) return undefined;
		const substr = y.substr; // looked up before the arguments are evaluated, as `y.substr(b-1)` did
		const start = b(ctx) - 1;
		if (!c) return substr.call(y, start);
		const length = c(ctx);
		return substr.call(y, start, length);
	};
}

function nullIf(args: Evaluator[]): Evaluator {
	const a = argument(args, 0);
	const b = argument(args, 1);
	return (ctx) => {
		const value = a(ctx);
		// eslint-disable-next-line eqeqeq
		return value == b(ctx) ? undefined : value;
	};
}

function returnOne(): Evaluator {
	return () => 1;
}

const INLINE: Record<string, InlineBuilder> = nullPrototype<InlineBuilder>({
	ABS: mathFunction(Math.abs),
	CLONEDEEP: (args) => {
		const a = argument(args, 0);
		return (ctx) => cloneDeep(a(ctx));
	},
	EXP: (args) => {
		const a = argument(args, 0);
		return (ctx) => Math.pow(Math.E, a(ctx));
	},
	IIF: (args) => {
		if (args.length !== 3) throw new Error('Number of arguments of IFF is not equals to 3');
		const [a, b, c] = args;
		return (ctx) => (a(ctx) ? b(ctx) : c(ctx));
	},
	IFNULL: (args) => {
		const a = argument(args, 0);
		const b = argument(args, 1);
		return (ctx) => {
			const value = a(ctx);
			return value === undefined || value === null ? b(ctx) : value;
		};
	},
	INSTR: (args) => {
		const a = argument(args, 0);
		const b = argument(args, 1);
		return (ctx) => {
			const s = a(ctx);
			const indexOf = s.indexOf; // throws on null before the needle is evaluated, as `(s).indexOf(p)` did
			const needle = b(ctx);
			return indexOf.call(s, needle) + 1;
		};
	},
	LEN: stringMethod((y) => y.length),
	LENGTH: stringMethod((y) => y.length),
	LOWER: stringMethod((y) => String(y).toLowerCase()),
	LCASE: stringMethod((y) => String(y).toLowerCase()),
	LTRIM: stringMethod((y) => y.replace(/^[ ]+/, '')),
	RTRIM: stringMethod((y) => y.replace(/[ ]+$/, '')),
	MAX: greatest,
	GREATEST: greatest,
	MIN: least,
	LEAST: least,
	SUBSTRING: substring,
	SUBSTR: substring,
	MID: substring,
	// Both are NULLIF, `undefined` when the arguments are loosely equal.
	ISNULL: nullIf,
	NULLIF: nullIf,
	POWER: (args) => {
		const a = argument(args, 0);
		const b = argument(args, 1);
		return (ctx) => Math.pow(a(ctx), b(ctx));
	},
	RANDOM: (args) => {
		if (args.length === 0) return () => Math.random();
		const r = args[0];
		return (ctx) => (Math.random() * r(ctx)) | 0;
	},
	CEIL: mathFunction(Math.ceil),
	CEILING: mathFunction(Math.ceil),
	FLOOR: mathFunction(Math.floor),
	// The SELECT compiler numbers these columns afterwards; as expressions they are 1.
	ROWNUM: returnOne,
	ROW_NUMBER: returnOne,
	GROUP_ROW_NUMBER: returnOne,
	SQRT: mathFunction(Math.sqrt),
	TRIM: stringMethod((y) => y.trim()),
	UPPER: stringMethod((y) => String(y).toUpperCase()),
	UCASE: stringMethod((y) => String(y).toUpperCase()),
});

// #section: called functions (alasql.stdfn)

/*
 * Each is a plain `function` like AlaSQL's, so `NEW CONCAT(…)` constructs an empty object as it did there, and one
 * that was not constructible there (CHAR, a bound native) is not here either.
 */

function DATEDIFF(period: any, d1: any, d2: any) {
	const interval = newDate(d2).getTime() - newDate(d1).getTime();
	return (interval / periodLength(datePart(period))) | 0;
}

function NOW() {
	const d = new Date();
	return (
		localDateText(d) +
		' ' +
		pad2(d.getHours()) +
		':' +
		pad2(d.getMinutes()) +
		':' +
		pad2(d.getSeconds()) +
		'.' +
		pad3(d.getMilliseconds())
	);
}

function CURDATE() {
	const date = new Date();
	date.setHours(0, 0, 0, 0);
	return localDateText(date);
}

function DATE_ADD(d: any, interval: any) {
	return new Date(newDate(d).getTime() + interval);
}

function DATE_SUB(d: any, interval: any) {
	return new Date(newDate(d).getTime() - interval);
}

function DAYOFWEEK(d: any) {
	return newDate(d).getDay();
}

function DAYOFMONTH(d: any) {
	return newDate(d).getDate();
}

function UUID() {
	return randomUUID();
}

const CALLED: Record<string, (...args: any[]) => any> = nullPrototype<(...args: any[]) => any>({
	CONCAT: function CONCAT(...args: any[]) {
		return args.join('');
	},
	REGEXP_LIKE: function REGEXP_LIKE(value: any, pattern: any, flags: any) {
		return regexpLike(value, pattern, flags);
	},
	ROUND: function ROUND(...args: any[]) {
		let s = args[0];
		if (s == null || (typeof s === 'string' && s.trim() === '')) return undefined;
		s = Number(s);
		if (isNaN(s)) return undefined;
		if (args.length < 2) return Math.round(s);
		const scale = Math.pow(10, args[1]);
		return Math.round(s * scale) / scale;
	},
	// The separator is taken after NULLs are dropped, so a NULL separator makes the first value the separator.
	CONCAT_WS: function CONCAT_WS(...args: any[]) {
		const values = args.filter((x) => x !== null && x !== undefined);
		return values.slice(1).join(values[0] || '');
	},
	REPLACE: function REPLACE(target: any, pattern: any, replacement: any) {
		const text = String(target ?? '');
		if (pattern === '') return text;
		return text.split(String(pattern ?? '')).join(String(replacement ?? ''));
	},
	GEN_RANDOM_UUID: UUID,
	UUID,
	NEWID: UUID,
	CONVERT: function CONVERT(value: any, args: any) {
		return convert(value, args);
	},
	EXTEND: extend,
	CHAR: String.fromCharCode.bind(String),
	ASCII: function ASCII(a: any) {
		return a.charCodeAt(0);
	},
	// The first argument that is not NULL, undefined or a NaN number.
	COALESCE: function COALESCE(...args: any[]) {
		for (const value of args) {
			if (value === null || value === undefined) continue;
			if (typeof value === 'number' && isNaN(value)) continue;
			return value;
		}
		return undefined;
	},
	USER: function USER() {
		return 'alasql';
	},
	DATE: function DATE(d: any) {
		if (!isNaN(d) && d.length === 8) return new Date(+d.substr(0, 4), +d.substr(4, 2) - 1, +d.substr(6, 2));
		return newDate(d);
	},
	NOW,
	GETDATE: NOW,
	CURRENT_TIMESTAMP: NOW,
	CURRENT_DATE: CURDATE,
	CURDATE,
	SECOND: function SECOND(d: any) {
		return newDate(d).getSeconds();
	},
	MINUTE: function MINUTE(d: any) {
		return newDate(d).getMinutes();
	},
	HOUR: function HOUR(d: any) {
		return newDate(d).getHours();
	},
	WEEKDAY: DAYOFWEEK,
	DAYOFWEEK,
	DAYOFMONTH,
	DAY: DAYOFMONTH,
	MONTH: function MONTH(d: any) {
		return newDate(d).getMonth() + 1;
	},
	YEAR: function YEAR(d: any) {
		return newDate(d).getFullYear();
	},
	DATEDIFF,
	DATEADD: function DATEADD(period: any, interval: any, d: any) {
		let nd = newDate(d);
		const part = datePart(period);
		switch (part) {
			case 'year':
				nd.setFullYear(nd.getFullYear() + interval);
				break;
			case 'quarter':
				nd.setMonth(nd.getMonth() + interval * 3);
				break;
			case 'month':
				nd.setMonth(nd.getMonth() + interval);
				break;
			default:
				nd = new Date(nd.getTime() + interval * periodLength(part));
		}
		return nd;
	},
	// No abbreviations here, unlike DATEADD and DATEDIFF; an unknown unit gives NaN.
	INTERVAL: function INTERVAL(interval: any, period: any) {
		return interval * PERIODS[period.toLowerCase()];
	},
	ADDDATE: DATE_ADD,
	DATE_ADD,
	SUBDATE: DATE_SUB,
	DATE_SUB,
});

// #section: functions registered by exact name (alasql.fn)

function TIMESTAMPDIFF(unit: any, date1: any, date2: any) {
	return DATEDIFF(unit, date1, date2);
}

/** Harper's date, geo and JSON functions, by exact, case-sensitive name. */
const REGISTERED: Record<string, (...args: any[]) => any> = nullPrototype<(...args: any[]) => any>({
	Date: Date as any,
	Number: Number as any,
	String: String as any,
	Boolean: Boolean as any,
	TIMESTAMPDIFF,
	DISTINCT_ARRAY: alasqlExtension.distinct_array,
	distinct_array: alasqlExtension.distinct_array,
	SEARCH_JSON: alasqlExtension.searchJSON,
	search_json: alasqlExtension.searchJSON,
	CURRENT_DATE: dateFunctions.current_date,
	current_date: dateFunctions.current_date,
	CURRENT_TIME: dateFunctions.current_time,
	current_time: dateFunctions.current_time,
	EXTRACT: dateFunctions.extract,
	extract: dateFunctions.extract,
	DATE: dateFunctions.date,
	date: dateFunctions.date,
	DATE_FORMAT: dateFunctions.date_format,
	date_format: dateFunctions.date_format,
	DATE_ADD: dateFunctions.date_add,
	date_add: dateFunctions.date_add,
	DATE_SUB: dateFunctions.date_sub,
	date_sub: dateFunctions.date_sub,
	DATE_DIFF: dateFunctions.date_diff,
	date_diff: dateFunctions.date_diff,
	DATEDIFF: dateFunctions.date_diff,
	datediff: dateFunctions.date_diff,
	NOW: dateFunctions.now,
	now: dateFunctions.now,
	OFFSET_UTC: dateFunctions.offset_utc,
	offset_utc: dateFunctions.offset_utc,
	GET_SERVER_TIME: dateFunctions.get_server_time,
	get_server_time: dateFunctions.get_server_time,
	GETDATE: dateFunctions.now,
	getdate: dateFunctions.now,
	CURRENT_TIMESTAMP: dateFunctions.now,
	current_timestamp: dateFunctions.now,
});

for (const [name, fn] of Object.entries({
	Area: geo.geoArea,
	Circle: geo.geoCircle,
	Contains: geo.geoContains,
	Convert: geo.geoConvert,
	Crosses: geo.geoCrosses,
	Difference: geo.geoDifference,
	Distance: geo.geoDistance,
	Equal: geo.geoEqual,
	Length: geo.geoLength,
	Near: geo.geoNear,
})) {
	REGISTERED[`geo${name}`] = REGISTERED[`GEO${name.toUpperCase()}`] = REGISTERED[`geo${name.toLowerCase()}`] = fn;
}

// #section: compiling a call

function compileCall(fn: any, thisArg: any, args: Evaluator[], newid: boolean): Evaluator {
	if (newid) return (ctx) => new fn(...evaluateAll(args, ctx));
	switch (args.length) {
		case 0:
			return () => fn.call(thisArg);
		case 1: {
			const [a] = args;
			return (ctx) => fn.call(thisArg, a(ctx));
		}
		case 2: {
			const [a, b] = args;
			return (ctx) => fn.call(thisArg, a(ctx), b(ctx));
		}
		case 3: {
			const [a, b, c] = args;
			return (ctx) => fn.call(thisArg, a(ctx), b(ctx), c(ctx));
		}
		default:
			return (ctx) => fn.apply(thisArg, evaluateAll(args, ctx));
	}
}

/**
 * Whether `compileFunctionCall` inlines this call (branch 1 below). AlaSQL compiled an inlined call's arguments
 * without the column-to-source map (`arg.toJS(context, tableid)`, no `defcols`), unlike the other two branches, so
 * an unqualified column in its arguments resolves differently in a join.
 */
export function isInlineFunction(funcid: string): boolean {
	return !REGISTERED[funcid] && !!INLINE[funcid.toUpperCase()];
}

/**
 * Compiles a `FuncValue` call with AlaSQL's three-way dispatch (`yy.FuncValue#toJS`, alasql.fs.js:13199):
 * 1. not registered under the exact name, and an inlined function under the upper-cased name: the inline form
 *    (IIF with other than three arguments throws here, at compile time);
 * 2. not registered under the exact name, and a called function under the upper-cased name: that function;
 * 3. otherwise the function registered under the exact name. An unknown name evaluates its arguments and then
 *    throws a TypeError, at run time, so a query that never evaluates the call (no rows) succeeds.
 *
 * `newid` (`NEW f(…)`) constructs with `new` in cases 2 and 3 and is ignored in case 1, as in AlaSQL.
 */
export function compileFunctionCall(funcid: string, args: Evaluator[], newid?: boolean): Evaluator {
	const registered = REGISTERED[funcid];
	if (!registered) {
		const name = funcid.toUpperCase();
		const inline = INLINE[name];
		if (inline) return inline(args);
		const called = CALLED[name];
		if (called) return compileCall(called, CALLED, args, !!newid);
		return (ctx) => {
			evaluateAll(args, ctx);
			throw new TypeError(`${funcid} is not a ${newid ? 'constructor' : 'function'}`);
		};
	}
	// AlaSQL called these as methods of `alasql.fn`, where SEARCH_JSON found the AlaSQL instance as `this.__ala__`
	// and cached its compiled expressions on `__ala__.res`; each call site gets that cache to itself.
	return compileCall(registered, { __ala__: {} }, args, !!newid);
}

// #section: named aggregates (alasql.aggr)

/**
 * AlaSQL replaced each of its built-in aggregates with a wrapper that returns `undefined` at stage 3 when the
 * accumulator is `undefined` (alasql.fs.js:13686-13693). Harper's aggregates (MAD, MEAN, MODE, PROD, MEDIAN) were
 * registered after that, unwrapped, so they finish an empty group with their own `null`.
 */
function wrapBuiltin(fn: AggregateFunction): AggregateFunction {
	return function (...args: any[]) {
		if (args[2] === 3 && args[1] === undefined) return undefined;
		return fn(...args);
	};
}

/** GROUP_CONCAT (alasql.fs.js:13412): collects non-NULL values, then sorts (if ordered) and joins them. */
function groupConcat(v: any, s: any, stage: any, separator?: any, orderDirection?: any): any {
	if (separator === undefined) separator = ',';
	if (stage === 1) return { values: v === null || v === undefined ? [] : [v], separator, orderDirection };
	if (stage === 2) {
		if (v === null || v === undefined) return s;
		if (s === null || s === undefined) return { values: [v], separator, orderDirection };
		if (typeof s === 'string') s = { values: s.split(','), separator: ',', orderDirection: undefined };
		s.values.push(v);
		return s;
	}
	if (s === null || s === undefined) return undefined;
	if (typeof s === 'string') return s;
	let values = s.values;
	if (values.length === 0) return undefined;
	if (s.orderDirection) {
		const ascending = s.orderDirection === 'ASC';
		values = values.slice().sort((a: any, b: any) => {
			if (a === b) return 0;
			if (a === null || a === undefined) return 1;
			if (b === null || b === undefined) return -1;
			if (typeof a === 'string' && typeof b === 'string') return ascending ? a.localeCompare(b) : b.localeCompare(a);
			if (ascending) return a < b ? -1 : 1;
			return b < a ? -1 : 1;
		});
	}
	return values.join(s.separator);
}

/** QUART (alasql.fs.js:13566): the `nth` quartile (first by default) of the non-NULL values, by position. */
function quart(v: any, s: any, stage: any, nth?: any): any {
	if (stage === 2) {
		if (v !== null) s.push(v);
		return s;
	}
	if (stage === 1) return v === null ? [] : [v];
	if (!s.length) return s;
	nth = nth || 1;
	const sorted = s.sort((a: any, b: any) => {
		if (a === b) return 0;
		return a > b ? 1 : -1;
	});
	const p = (nth * (sorted.length + 1)) / 4;
	if (Number.isInteger(p)) return sorted[p - 1];
	return sorted[Math.floor(p)];
}

/** VAR (alasql.fs.js:13613): sample variance; skips NULL but not `undefined`. 0 for fewer than two values. */
function variance(v: any, s: any, stage: any): any {
	if (stage === 1) return v === null ? { sum: 0, sumSq: 0, count: 0 } : { sum: v, sumSq: v * v, count: 1 };
	if (stage === 2) {
		if (v !== null) {
			s.sum += v;
			s.sumSq += v * v;
			s.count++;
		}
		return s;
	}
	if (s.count > 1) return (s.sumSq - (s.sum * s.sum) / s.count) / (s.count - 1);
	return 0;
}

/** VARP (alasql.fs.js:13653): population variance; counts every value, NULL included. */
function populationVariance(value: any, accumulator: any, stage: any): any {
	if (stage === 1) return { count: 1, sum: value, sumSq: value * value };
	if (stage === 2) {
		accumulator.count++;
		accumulator.sum += value;
		accumulator.sumSq += value * value;
		return accumulator;
	}
	if (accumulator.count > 0) {
		const mean = accumulator.sum / accumulator.count;
		return accumulator.sumSq / accumulator.count - mean * mean;
	}
	return 0;
}

const quartWrapped = wrapBuiltin(quart);
const varWrapped = wrapBuiltin(variance);
const varpWrapped = wrapBuiltin(populationVariance);
const groupConcatWrapped = wrapBuiltin(groupConcat);

// The derived aggregates call the wrapped base, as AlaSQL's looked theirs up in `alasql.aggr` at call time.
const standardDeviation = wrapBuiltin((v: any, s: any, stage: any) =>
	stage === 1 || stage === 2 ? varWrapped(v, s, stage) : Math.sqrt(varWrapped(v, s, stage))
);
const populationStandardDeviation = wrapBuiltin((v: any, s: any, stage: any) =>
	// eslint-disable-next-line eqeqeq
	stage == 1 || stage == 2 ? varpWrapped(v, s, stage) : Math.sqrt(varpWrapped(v, s, stage))
);

/** Named aggregates by exact, case-sensitive name: AlaSQL's built-ins plus Harper's MAD, MEAN, MODE, PROD and MEDIAN. */
export const AGGREGATES: Record<string, AggregateFunction> = Object.freeze(
	nullPrototype<AggregateFunction>({
		GROUP_CONCAT: groupConcatWrapped,
		group_concat: groupConcatWrapped,
		QUART: quartWrapped,
		QUART2: wrapBuiltin((v: any, s: any, stage: any) => quartWrapped(v, s, stage, 2)),
		QUART3: wrapBuiltin((v: any, s: any, stage: any) => quartWrapped(v, s, stage, 3)),
		VAR: varWrapped,
		STDEV: standardDeviation,
		VARP: varpWrapped,
		STDEVP: populationStandardDeviation,
		STDDEV: populationStandardDeviation,
		STD: populationStandardDeviation,
		MEDIAN: alasqlExtension.median,
		median: alasqlExtension.median,
		MODE: alasqlExtension.mode,
		mode: alasqlExtension.mode,
		MAD: alasqlExtension.mad,
		mad: alasqlExtension.mad,
		MEAN: alasqlExtension.mean,
		mean: alasqlExtension.mean,
		PROD: alasqlExtension.prod,
		prod: alasqlExtension.prod,
	})
);
