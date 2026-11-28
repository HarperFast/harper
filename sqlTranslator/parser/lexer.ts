/**
 * Tokenizer for Harper's SQL dialect. The dialect is the one AlaSQL 4 accepted, which Harper's SQL operation
 * exposed for years, so the rules below reproduce its lexer exactly: rules are tried in order and the FIRST
 * one that matches wins (not the longest), keywords are case-insensitive and must end at a word boundary, and
 * a handful of rules (`DATABASE`, `SCHEMA`, `MAX(`/`MIN(`) have quirks that statements in the wild depend on.
 */

export interface Token {
	type: string;
	text: string;
	start: number;
	end: number;
}

// Word keywords: the matched word (upper-cased) → terminal, with the text a few rules normalize to.
const KEYWORDS = new Map<string, string>();
const KEYWORD_TEXT = new Map<string, string>([
	['SELECT', 'SELECT'],
	['DISTINCT', 'DISTINCT'],
]);
for (const word of [
	'SELECT ABSOLUTE ACTION ADD AFTER AGGR AGGREGATE ALL ALTER AND ANTI ANY APPLY ARRAY AS ASSERT ATTACH AVG BEFORE',
	'BEGIN BETWEEN BREAK BY CALL CASE CASCADE CAST CHECK CLASS CLOSE COLLATE COLUMN COMMIT CONSTRAINT CONTENT',
	'CONTINUE CONVERT CORRESPONDING COUNT CREATE CROSS CUBE CURRENT_TIMESTAMP CURRENT_DATE CURSOR DATEADD DATEDIFF',
	'TIMESTAMPDIFF DECLARE DEFAULT DELETE DELETED DETACH DISTINCT DROP ECHO EDGE END ENUM ELSE ESCAPE EXCEPT EXISTS',
	'EXPLAIN FALSE FETCH FIRST FOR FOREIGN FROM FULL FUNCTION GLOB GO GRAPH GROUP GROUP_CONCAT GROUPING HAVING IF',
	'IDENTITY IGNORE IS IN INDEX INDEXED INNER INSTEAD INSERT INSERTED INTERSECT INTERVAL INTO ITERATE JOIN KEY LAST',
	'LET LEAVE LEFT LIKE LIMIT MATCHED MATRIX MERGE MODIFY NATURAL NEXT NEW NOCASE NO NOT NULL NULLS OFF ON ONLY OF',
	'OFFSET OPEN OPTION OR ORDER OUTER OUTPUT OVER PATH PARTITION PERCENT PIVOT PLAN PRIMARY PRINT PRIOR QUERY READ',
	'RECORDSET REDUCE RECURSIVE REFERENCES REGEXP REINDEX RELATIVE REMOVE RENAME REPEAT REPLACE RESTRICT REQUIRE',
	'RESTORE RETURN RIGHT ROLLBACK ROLLUP ROW ROWS SEARCH SEMI SEPARATOR SET SHOW SOME SOURCE STRATEGY STORE SUM',
	'TOTAL TABLE TARGET TEMP TEXTSTRING THEN TIMEOUT TO TOP TRANSACTION TRIGGER TRUE TRUNCATE UNION UNIQUE UNPIVOT',
	'UPDATE USE USING VALUE VALUES VERTEX VIEW WHEN WHERE WHILE WITH',
]
	.join(' ')
	.split(' ')) {
	KEYWORDS.set(word, word);
}
for (const [word, type] of [
	['AGGREGATOR', 'AGGREGATE'],
	['ASC', 'DIRECTION'],
	['DESC', 'DIRECTION'],
	['ILIKE', 'LIKE'],
	['COLUMNS', 'COLUMN'],
	['CURDATE', 'CURRENT_DATE'],
	['EXEC', 'CALL'],
	['EXECUTE', 'CALL'],
	['MINUS', 'EXCEPT'],
	['RETURNS', 'RETURN'],
	['SETS', 'SET'],
	['TABLES', 'TABLE'],
	['TEMPORARY', 'TEMP'],
	['TRAN', 'TRANSACTION'],
	['WORK', 'TRANSACTION'],
]) {
	KEYWORDS.set(word, type);
}

/**
 * Terminals the grammar lets stand for a name (lower-cased) where a name is expected and the terminal itself
 * is not: AlaSQL's error recovery for the PostgreSQL non-reserved keywords that are also its own terminals.
 */
export const NON_RESERVED = new Set([
	'ABSOLUTE',
	'ACTION',
	'ADD',
	'AFTER',
	'BEFORE',
	'CALL',
	'CASCADE',
	'CLOSE',
	'CONTENT',
	'CONTINUE',
	'DEFAULT',
	'DELETED',
	'FIRST',
	'GO',
	'IGNORE',
	'INSERTED',
	'INSTEAD',
	'KEY',
	'LAST',
	'LEFT',
	'LIMIT',
	'MATCHED',
	'NEXT',
	'NULLS',
	'NUMBER',
	'OFF',
	'OPEN',
	'OPTION',
	'ORDER',
	'OUTPUT',
	'PATH',
	'PLAN',
	'PRIOR',
	'READ',
	'RELATIVE',
	'RESTORE',
	'RESTRICT',
	'RIGHT',
	'SEPARATOR',
	'SHOW',
	'SOURCE',
	'TARGET',
	'TEMP',
	'TRANSACTION',
	'VALUE',
	'VALUES',
	'VIEW',
]);

const isLineTerminator = (c: string) => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';

/**
 * Where AlaSQL's rule `(['](\\.|[^']|\\')*?['])+` (and its `"` form) stopped matching a quoted string that starts at
 * `at`, or -1 when it did not match, found in one pass rather than by running that regex. Each part closes at the
 * first quote reached when a backslash takes the character after it; when that runs off the end, the regex fell back
 * to the last quote such a backslash had taken. Parts repeat while the next character opens another (`'it''s'`).
 */
function quotedEnd(input: string, at: number, quote: string): number {
	let end = quotedPart(input, at, quote);
	if (end < 0) return -1;
	let next: number;
	while (input[end] === quote && (next = quotedPart(input, end, quote)) >= 0) end = next;
	return end;
}

function quotedPart(input: string, at: number, quote: string): number {
	let lastTaken = -1;
	let i = at + 1;
	while (i < input.length) {
		const c = input[i];
		if (c === quote) return i + 1;
		if (c === '\\' && i + 1 < input.length && !isLineTerminator(input[i + 1])) {
			if (input[i + 1] === quote) lastTaken = i + 1;
			i += 2;
		} else i++;
	}
	return lastTaken < 0 ? -1 : lastTaken + 1;
}

const quotedRule =
	(quote: string, prefix?: string) =>
	(input: string, at: number): number => {
		const start = prefix === undefined ? at : at + 1;
		if (prefix !== undefined && input[at]?.toUpperCase() !== prefix) return -1;
		if (input[start] !== quote) return -1;
		const end = quotedEnd(input, start, quote);
		return end < 0 ? -1 : end - at;
	};

type Rule = RegExp | ((input: string, at: number) => number);

// Rules tried before any keyword, in order. A RegExp is sticky, so it matches only at the current offset.
const LEADING_RULES: [Rule, string | null][] = [
	[/``([^`])+``/y, 'JAVASCRIPT'],
	[/\[\?\]/y, 'BRAQUESTION'],
	[/@\[/y, 'ATLBRA'],
	[/ARRAY\[/iy, 'ARRAYLBRA'],
	[/\[([^\]'])*?\]/y, 'BRALITERAL'],
	[/`([^`'])*?`/y, 'BRALITERAL'],
	[quotedRule("'", 'N'), 'NSTRING'],
	[quotedRule("'", 'X'), 'NSTRING'],
	[quotedRule("'"), 'STRING'],
	[quotedRule('"'), 'DQSTRING'],
	[/--(.*?)($|\r\n|\r|\n)/y, null],
	[/\s+/y, null],
	[/\|\|/y, 'BARBAR'],
	[/\|/y, 'BAR'],
];

// `VALUE OF SELECT` and its siblings lex as one SELECT token whose text is the modifier.
const VALUE_OF_SEARCH = /VALUE\s+OF\s+SEARCH\b/iy;
const OF_SELECT = /(VALUE|ROW|COLUMN|MATRIX|INDEX|RECORDSET|TEXT)\s+OF\s+SELECT\b/iy;
const NOT_WORD = /NOT\s+(BETWEEN|LIKE|ILIKE)\b/iy;
const WORD = /[A-Za-z0-9_]+/y;
const MAX_OR_MIN = /(MAX|MIN)\s*(?=(\(|,|\)))/iy;
const AUTO_INCREMENT = /AUTO(_)?INCREMENT\b/iy;
// `DATABASE(S)?` and `SCHEMA(S)?` have no word boundary, so `schema_name` lexes as DATABASE then `_name`.
const DATABASE_PREFIX = /(DATABASE|SCHEMA)(S)?/iy;
const EXPONENT_NUMBER = /\d+(\.\d*)?[eE][+-]?\d+(?![a-zA-Z_0-9])/y;
const LITERAL = /[0-9]*[a-zA-Z_]+[a-zA-Z_0-9]*/y;
const NUMBER = /(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?(?![a-zA-Z_0-9])/y;
const WORD_START = /[A-Za-z0-9_]/;
const WORD_RULES = [
	[EXPONENT_NUMBER, 'NUMBER'],
	[LITERAL, 'LITERAL'],
	[NUMBER, 'NUMBER'],
] as const;

const SYMBOL_RULES: [string, string][] = [
	['~~*', 'LIKE'],
	['!~~*', 'NOT_LIKE'],
	['~~', 'LIKE'],
	['!~~', 'NOT_LIKE'],
];
const OPERATOR_RULES: [string, string][] = [
	['->', 'ARROW'],
	['#', 'SHARP'],
	['+', 'PLUS'],
	['-', 'MINUS'],
	['*', 'STAR'],
	['/', 'SLASH'],
	['%', 'MODULO'],
	['!===', 'NEEQEQEQ'],
	['===', 'EQEQEQ'],
	['!==', 'NEEQEQ'],
	['==', 'EQEQ'],
	['>=', 'GE'],
	['&', 'AMPERSAND'],
	['<<', 'LTLT'],
	['>>', 'GTGT'],
	['>', 'GT'],
	['<=', 'LE'],
	['<>', 'NE'],
	['<', 'LT'],
	['=', 'EQ'],
	['!=', 'NE'],
	['(', 'LPAR'],
	[')', 'RPAR'],
	['{', 'LCUR'],
	['}', 'RCUR'],
	[']', 'RBRA'],
	[':-', 'COLONDASH'],
	['?-', 'QUESTIONDASH'],
	['..', 'DOTDOT'],
	['.', 'DOT'],
	[',', 'COMMA'],
	['::', 'DOUBLECOLON'],
	[':', 'COLON'],
	[';', 'SEMICOLON'],
	['$', 'DOLLAR'],
	['?', 'QUESTION'],
	['!', 'EXCLAMATION'],
	['^', 'CARET'],
	['~', 'TILDA'],
	['@', 'AT'],
];

function stickyMatch(regex: RegExp, input: string, at: number): RegExpExecArray | null {
	regex.lastIndex = at;
	return regex.exec(input);
}

export function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let at = 0;
	const push = (type: string, text: string, length: number) => {
		tokens.push({ type, text, start: at, end: at + length });
		at += length;
	};
	outer: while (at < input.length) {
		for (const [rule, type] of LEADING_RULES) {
			let length: number;
			if (rule instanceof RegExp) {
				const match = stickyMatch(rule, input, at);
				if (!match) continue;
				length = match[0].length;
			} else {
				length = rule(input, at);
				if (length < 0) continue;
			}
			if (type === null) {
				at += length;
				continue outer;
			}
			push(type, input.slice(at, at + length), length);
			continue outer;
		}
		let match = stickyMatch(VALUE_OF_SEARCH, input, at);
		if (match) {
			push('SEARCH', 'VALUE', match[0].length);
			continue;
		}
		if ((match = stickyMatch(OF_SELECT, input, at))) {
			push('SELECT', match[1].toUpperCase(), match[0].length);
			continue;
		}
		const char = input[at];
		if (WORD_START.test(char)) {
			if ((match = stickyMatch(NOT_WORD, input, at))) {
				push('NOT_' + (match[1].toUpperCase() === 'BETWEEN' ? 'BETWEEN' : 'LIKE'), match[0], match[0].length);
				continue;
			}
			const word = stickyMatch(WORD, input, at)![0];
			const upper = word.toUpperCase();
			if ((match = stickyMatch(DATABASE_PREFIX, input, at))) {
				push('DATABASE', match[0], match[0].length);
				continue;
			}
			if ((upper === 'MAX' || upper === 'MIN') && (match = stickyMatch(MAX_OR_MIN, input, at))) {
				const type = match[2] === '(' ? upper : upper === 'MAX' ? 'MAXNUM' : null;
				if (type) {
					push(type, match[0], match[0].length);
					continue;
				}
			}
			if ((match = stickyMatch(AUTO_INCREMENT, input, at))) {
				push('IDENTITY', match[0], match[0].length);
				continue;
			}
			const keyword = KEYWORDS.get(upper);
			if (keyword) {
				push(keyword, KEYWORD_TEXT.get(upper) ?? word, word.length);
				continue;
			}
			for (const [regex, type] of WORD_RULES) {
				if ((match = stickyMatch(regex, input, at))) {
					push(type, match[0], match[0].length);
					continue outer;
				}
			}
		}
		for (const [text, type] of SYMBOL_RULES) {
			if (input.startsWith(text, at)) {
				push(type, text, text.length);
				continue outer;
			}
		}
		if (char === '.' && (match = stickyMatch(NUMBER, input, at))) {
			push('NUMBER', match[0], match[0].length);
			continue;
		}
		for (const [text, type] of OPERATOR_RULES) {
			if (input.startsWith(text, at)) {
				push(type, text, text.length);
				continue outer;
			}
		}
		push('INVALID', char, 1);
	}
	tokens.push({ type: 'EOF', text: '', start: at, end: at });
	return tokens;
}

/**
 * Removes `--` line comments and `/* *\/` block comments outside quoted text, as AlaSQL did before parsing.
 * Single and double quotes and `[...]` (not `@[`) quote; backticks do not.
 */
export function uncomment(sql: string): string {
	const chars = ('__' + sql + '__').split('');
	let quote = false;
	let quoteSign = '';
	let blockComment = false;
	let lineComment = false;
	for (let i = 0, l = chars.length; i < l; i++) {
		const unescaped = chars[i - 1] !== '\\' || chars[i - 2] === '\\';
		if (quote) {
			if (chars[i] === quoteSign && unescaped) quote = false;
		} else if (blockComment) {
			if (chars[i] === '*' && chars[i + 1] === '/') {
				chars[i] = chars[i + 1] = '';
				blockComment = false;
				i++;
			} else {
				chars[i] = '';
			}
		} else if (lineComment) {
			if (chars[i + 1] === '\n' || chars[i + 1] === '\r' || chars.length - 2 === i) lineComment = false;
			chars[i] = '';
		} else if (chars[i] === '"' || chars[i] === "'") {
			quote = true;
			quoteSign = chars[i];
		} else if (chars[i] === '[' && chars[i - 1] !== '@') {
			quote = true;
			quoteSign = ']';
		} else if (chars[i] === '-' && chars[i + 1] === '-') {
			chars[i] = '';
			lineComment = true;
		} else if (chars[i] === '/' && chars[i + 1] === '*') {
			chars[i] = '';
			blockComment = true;
		}
	}
	return chars.join('').slice(2, -2);
}
