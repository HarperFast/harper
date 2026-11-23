/**
 * The function names the SQL dialect knows, which decide how a call parses and how it is written back to text:
 * a call to a name in AGGREGATE_FUNCTIONS parses as an aggregate, and `FuncValue#toString()` writes the name of
 * a call only when the name is in one of these sets (an unknown name is written as a bare parenthesized list).
 * The scalar and aggregate sets are case-sensitive, as their keys were; the standard set is matched upper-cased.
 */

/** Scalar functions registered by exact name, including Harper's date, geo and JSON functions. */
export const SCALAR_FUNCTIONS = new Set([
	'Date',
	'Number',
	'String',
	'Boolean',
	'TIMESTAMPDIFF',
	'DISTINCT_ARRAY',
	'distinct_array',
	'SEARCH_JSON',
	'search_json',
	'__ala__',
	'CURRENT_DATE',
	'current_date',
	'CURRENT_TIME',
	'current_time',
	'EXTRACT',
	'extract',
	'DATE',
	'date',
	'DATE_FORMAT',
	'date_format',
	'DATE_ADD',
	'date_add',
	'DATE_SUB',
	'date_sub',
	'DATEDIFF',
	'datediff',
	'DATE_DIFF',
	'date_diff',
	'NOW',
	'now',
	'OFFSET_UTC',
	'offset_utc',
	'GET_SERVER_TIME',
	'get_server_time',
	'GETDATE',
	'getdate',
	'CURRENT_TIMESTAMP',
	'current_timestamp',
	...['Area', 'Circle', 'Contains', 'Convert', 'Crosses', 'Difference', 'Distance', 'Equal', 'Length', 'Near'].flatMap(
		(name) => [`geo${name}`, `GEO${name.toUpperCase()}`, `geo${name.toLowerCase()}`]
	),
]);

/** Aggregate functions called by name, `MEDIAN(x)`, rather than through an aggregate keyword such as `SUM`. */
export const AGGREGATE_FUNCTIONS = new Set([
	'GROUP_CONCAT',
	'group_concat',
	'MEDIAN',
	'median',
	'MODE',
	'mode',
	'QUART',
	'QUART2',
	'QUART3',
	'VAR',
	'STDEV',
	'VARP',
	'STDEVP',
	'STDDEV',
	'STD',
	'MAD',
	'mad',
	'MEAN',
	'mean',
	'PROD',
	'prod',
]);

/** Built-in scalar functions, matched case-insensitively and written upper-cased. */
export const STANDARD_FUNCTIONS = new Set([
	// expression-inlined functions
	'ABS',
	'CLONEDEEP',
	'EXP',
	'IIF',
	'IFNULL',
	'INSTR',
	'LENGTH',
	'LEN',
	'LCASE',
	'LOWER',
	'LTRIM',
	'RTRIM',
	'GREATEST',
	'MAX',
	'LEAST',
	'MIN',
	'MID',
	'SUBSTR',
	'SUBSTRING',
	'NULLIF',
	'ISNULL',
	'POWER',
	'RANDOM',
	'CEILING',
	'CEIL',
	'FLOOR',
	'ROWNUM',
	'ROW_NUMBER',
	'GROUP_ROW_NUMBER',
	'SQRT',
	'TRIM',
	'UCASE',
	'UPPER',
	// called functions
	'CONCAT',
	'REGEXP_LIKE',
	'ROUND',
	'CONCAT_WS',
	'REPLACE',
	'GEN_RANDOM_UUID',
	'UUID',
	'NEWID',
	'CONVERT',
	'EXTEND',
	'CHAR',
	'ASCII',
	'COALESCE',
	'USER',
	'OBJECT_ID',
	'DATE',
	'NOW',
	'GETDATE',
	'CURRENT_TIMESTAMP',
	'CURRENT_DATE',
	'CURDATE',
	'SECOND',
	'MINUTE',
	'HOUR',
	'WEEKDAY',
	'DAYOFWEEK',
	'DAYOFMONTH',
	'DAY',
	'MONTH',
	'YEAR',
	'DATEDIFF',
	'DATEADD',
	'INTERVAL',
	'ADDDATE',
	'DATE_ADD',
	'SUBDATE',
	'DATE_SUB',
]);

/**
 * Whether a call to `name` parses as an aggregate. The registries were plain objects, so a name every object
 * inherits (`toString`, `valueOf`, `constructor`, ...) was found there too.
 */
export function isAggregateName(name: string): boolean {
	return AGGREGATE_FUNCTIONS.has(name) || name in Object.prototype;
}

/** Whether `FuncValue#toString()` writes `name` as it stands (see isAggregateName for inherited names). */
export function isRegisteredName(name: string): boolean {
	return SCALAR_FUNCTIONS.has(name) || isAggregateName(name);
}
