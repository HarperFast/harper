'use strict';
/**
 * Deterministic SQL generators for the parser golden test (parser.test.js): random statements from the dialect's
 * grammar, and random token-level mutations of real statements. Both are seeded, so a fixture can store only the
 * expected result of each generated statement.
 */

function rng(seed) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function generateStatements(seed, count) {
	const rnd = rng(seed);
	const pick = (a) => a[Math.floor(rnd() * a.length)];
	const chance = (p) => rnd() < p;
	const names = [
		'a',
		'b',
		'id',
		'name',
		'Value',
		'key',
		'open',
		'temp',
		'view',
		'left',
		'first',
		'order',
		'limit',
		'value',
		'`weird name`',
		'[x.y]',
		'n1',
		'_',
		'count',
		'go',
		'number',
		'right',
		'source',
		'last',
		'default',
		'inserted',
		'deleted',
		'show',
		'separator',
		'nulls',
		'target',
	];
	const funcs = [
		'UPPER',
		'lower',
		'concat',
		'coalesce',
		'abs',
		'round',
		'search_json',
		'date_format',
		'geoNear',
		'median',
		'MEDIAN',
		'mad',
		'foo',
		'IFNULL',
		'iif',
		'len',
		'substring',
		'now',
		'replace',
		'if',
		'distinct_array',
		'NOW',
		'Date',
		'current_date',
		'trim',
		'datediff',
		'date_diff',
		'stdev',
		'group_concat',
	];
	const aggs = [
		'COUNT',
		'SUM',
		'AVG',
		'MIN',
		'MAX',
		'FIRST',
		'LAST',
		'AGGR',
		'ARRAY',
		'TOTAL',
		'count',
		'sum',
		'min',
		'max',
	];
	const binops = [
		'+',
		'-',
		'*',
		'/',
		'%',
		'=',
		'==',
		'===',
		'!=',
		'<>',
		'!==',
		'<',
		'<=',
		'>',
		'>=',
		'AND',
		'OR',
		'||',
		'LIKE',
		'NOT LIKE',
		'ILIKE',
		'REGEXP',
		'IS',
		'&',
		'|',
		'^',
		'<<',
		'>>',
		'and',
		'or',
		'GLOB',
		'~',
	];
	const name = () => pick(names);
	const col = () => (chance(0.3) ? name() + '.' + name() : name());
	const lit = () =>
		pick([
			() => String(Math.floor(rnd() * 100)),
			() => (rnd() * 10).toFixed(2),
			() => "'s" + Math.floor(rnd() * 9) + "'",
			() => '"dq"',
			() => "'it''s'",
			() => 'NULL',
			() => 'TRUE',
			() => 'false',
			() => '1e3',
			() => '.5',
			() => "N'n'",
			() => '$1',
			() => '?',
			() => ':p',
			() => '@v',
			() => "'a\\'b'",
		])();
	const list = (n, f) => Array.from({ length: n }, f);
	function expr(d) {
		if (d <= 0) return chance(0.5) ? col() : lit();
		const r = rnd();
		if (r < 0.25) return expr(d - 1) + ' ' + pick(binops) + ' ' + expr(d - 1);
		if (r < 0.32) return pick(['NOT ', '-', '+', '~', 'not ']) + expr(d - 1);
		if (r < 0.38) return '(' + expr(d - 1) + ')';
		if (r < 0.44) {
			const items = list(1 + Math.floor(rnd() * 3), () => expr(d - 2));
			return expr(d - 1) + pick([' IN ', ' NOT IN ', ' in ']) + '(' + items.join(', ') + ')';
		}
		if (r < 0.48) return expr(d - 1) + pick([' BETWEEN ', ' NOT BETWEEN ']) + expr(d - 2) + ' AND ' + expr(d - 2);
		if (r < 0.52) return expr(d - 1) + pick([' IS NULL', ' IS NOT NULL', ' NOT NULL', ' is null']);
		if (r < 0.58) {
			const args = chance(0.15) ? '' : list(1 + Math.floor(rnd() * 3), () => expr(d - 2)).join(', ');
			return pick(funcs) + '(' + args + ')';
		}
		if (r < 0.63) {
			const arg = chance(0.2) ? '*' : expr(d - 2);
			return pick(aggs) + '(' + pick(['', 'DISTINCT ', 'ALL ', '']) + arg + (chance(0.1) ? ', ' + expr(0) : '') + ')';
		}
		if (r < 0.66) {
			const subject = chance(0.5) ? expr(d - 2) + ' ' : '';
			const otherwise = chance(0.5) ? ' ELSE ' + expr(d - 2) : '';
			return 'CASE ' + subject + 'WHEN ' + expr(d - 2) + ' THEN ' + expr(d - 2) + otherwise + ' END';
		}
		if (r < 0.68) {
			return pick([
				'CAST(' + expr(d - 2) + ' AS INT)',
				'CAST(' + expr(d - 2) + ' AS VARCHAR(10))',
				'CONVERT(DECIMAL(5,2), ' + expr(d - 2) + ')',
				expr(0) + '::INT',
			]);
		}
		if (r < 0.71) return expr(d - 1) + pick(['->', '.', '!']) + pick([name(), '0', '(' + expr(0) + ')']);
		if (r < 0.73) return 'EXISTS (' + select(d - 2) + ')';
		if (r < 0.76) return expr(d - 1) + pick([' IN ', ' NOT IN ']) + '(' + select(d - 2) + ')';
		if (r < 0.78) return '(' + select(d - 2) + ')';
		if (r < 0.8) {
			const right = chance(0.5) ? select(d - 2) : expr(0) + ', ' + expr(0);
			return expr(d - 1) + pick([' = ', ' > ', ' <> ']) + pick(['ANY', 'ALL', 'SOME']) + ' (' + right + ')';
		}
		if (r < 0.82) {
			return pick(['{a: 1, "b": ' + expr(0) + '}', '@{x: 1}', '@[1, 2]', "@'s'", '@(' + expr(0) + ')', '{}']);
		}
		if (r < 0.84) return expr(d - 1) + ' LIKE ' + expr(d - 2) + ' ESCAPE ' + expr(0);
		if (r < 0.86) {
			return pick([
				'GROUP_CONCAT(' + expr(0) + ')',
				'GROUP_CONCAT(DISTINCT ' + expr(0) + ' ORDER BY ' + col() + " SEPARATOR '-')",
				'DATEADD(day, 1, ' + expr(0) + ')',
				'DATEDIFF(day, ' + expr(0) + ', ' + expr(0) + ')',
				'INTERVAL 1 DAY',
				'CURRENT_TIMESTAMP',
				'CURRENT_DATE()',
				'CURRENT_DATE',
			]);
		}
		return chance(0.5) ? col() : lit();
	}
	const alias = () => pick([' AS ' + name(), ' ' + name(), ' AS "q"', " 'sq'", ' AS 5', '', '', '', '']);
	const table = () =>
		pick(['dev.dog', 'dog', 'data.`T`', 'system.hdb_user', '`dev`.`t`', 'dev.[x y]', 't']) +
		pick(['', ' d', ' AS d', ' x', ' temp', ' view']);
	const joins = [
		'JOIN',
		'INNER JOIN',
		'LEFT JOIN',
		'LEFT OUTER JOIN',
		'RIGHT JOIN',
		'CROSS JOIN',
		'FULL OUTER JOIN',
		'OUTER JOIN',
		'NATURAL JOIN',
	];
	function select(d) {
		let s = 'SELECT ' + pick(['', '', 'DISTINCT ', 'TOP 3 ', 'ALL ', 'VALUE ', 'TOP (5) ', 'TOP 10 PERCENT ']);
		s += list(1 + Math.floor(rnd() * 3), () =>
			chance(0.1) ? pick(['*', 'd.*']) : expr(Math.max(0, d)) + alias()
		).join(', ');
		if (chance(0.9)) {
			s += ' FROM ' + table();
			const joinCount = chance(0.4) ? Math.floor(rnd() * 3) : 0;
			for (let i = 0; i < joinCount; i++) {
				s += ' ' + pick(joins) + ' ' + table() + pick([' ON ' + expr(1), ' USING (id)', ' USING id', '']);
			}
			if (chance(0.1)) s += ', ' + table();
		}
		if (chance(0.6)) s += ' WHERE ' + expr(d);
		if (chance(0.2)) {
			s += ' GROUP BY ' + col() + (chance(0.3) ? ', ' + expr(0) : '') + (chance(0.3) ? ' HAVING ' + expr(1) : '');
		}
		if (chance(0.05)) {
			s += pick([' UNION SELECT 1', ' UNION ALL SELECT a FROM t', ' EXCEPT SELECT 1', ' INTERSECT SELECT 2']);
		}
		if (chance(0.3)) {
			const direction = pick(['', ' ASC', ' desc', ' DESC NULLS FIRST', ' COLLATE NOCASE']);
			s += ' ORDER BY ' + expr(0) + direction + (chance(0.3) ? ', ' + col() : '');
		}
		if (chance(0.2)) s += ' LIMIT ' + Math.floor(rnd() * 10) + (chance(0.5) ? ' OFFSET 2' : '');
		return s;
	}
	function statement() {
		const r = rnd();
		if (r < 0.6) return select(3);
		if (r < 0.75) {
			const sets = list(1 + Math.floor(rnd() * 2), () => col() + ' = ' + expr(2)).join(', ');
			return (
				'UPDATE ' + pick(['dev.dog', 'dog', '`d`.`t`']) + ' SET ' + sets + (chance(0.8) ? ' WHERE ' + expr(3) : '')
			);
		}
		if (r < 0.87) return 'DELETE FROM ' + pick(['dev.dog', 'dog']) + (chance(0.8) ? ' WHERE ' + expr(3) : '');
		const verb = pick([
			'INSERT INTO ',
			'insert into ',
			'INSERT ',
			'REPLACE INTO ',
			'INSERT OR REPLACE INTO ',
			'INSERT IGNORE INTO ',
		]);
		const rows = list(1 + Math.floor(rnd() * 2), () => '(' + expr(1) + ', ' + expr(1) + ')').join(', ');
		return (
			verb + pick(['dev.dog', 'dog']) + pick([' (id, name)', ' (a)', '']) + pick([' VALUES ', ' VALUE ', ' ']) + rows
		);
	}
	return list(count, statement);
}

const SNIPPETS = [
	"'",
	'"',
	'`',
	'[',
	']',
	'--c\n',
	'/*c*/',
	'/* x',
	"'a\\\\'",
	"'a\\''",
	"'x''y'",
	'"a""b"',
	"N'x'",
	"X'1f'",
	'1.',
	'.5e-3',
	'1e',
	'0x1',
	'12abc',
	'é',
	' ',
	'\t',
	'\n',
	'\r\n',
	' NOT  BETWEEN ',
	' not\nlike ',
	' ILIKE ',
	'~~',
	'!~~*',
	'::',
	'->',
	'!',
	'@[1]',
	'[?]',
	'?',
	'$a',
	':b',
	'@c',
	'{a:1}',
	'@{}',
	'(',
	')',
	',',
	';',
	' GO ',
	'VALUE OF SELECT',
	'value of search',
	'SELECT',
	'select',
	'FROM',
	'from',
	'WHERE',
	'AND',
	'OR',
	'IN',
	'NOT',
	'IS',
	'NULL',
	'TRUE',
	'AS',
	'x',
	'y.z',
	'`q q`',
	'[r.s]',
	'temp',
	'key',
	'value',
	'order',
	'left',
	'number',
	'database',
	'schemas',
	'max(',
	'min(',
	'max,',
	'auto_increment',
	'columns',
	'COUNT(*)',
	'sum(a)',
	'CASE WHEN 1 THEN 2 END',
	'``1+1``',
	' ESCAPE ',
	'%',
	'*',
	'+',
	'-',
	'/',
	'<>',
	'!=',
	'!==',
	'===',
	'>=',
	'<=',
	'<<',
	'>>',
	'&',
	'|',
	'||',
	'^',
	'~',
	'#',
	' ',
	'  ',
];

function mutateStatements(corpus, seed, count) {
	const rnd = rng(seed);
	const pick = (a) => a[Math.floor(rnd() * a.length)];
	const out = [];
	for (let i = 0; i < count; i++) {
		let s = pick(corpus);
		const n = 1 + Math.floor(rnd() * 3);
		for (let j = 0; j < n; j++) {
			const at = Math.floor(rnd() * (s.length + 1));
			const r = rnd();
			if (r < 0.5) s = s.slice(0, at) + pick(SNIPPETS) + s.slice(at);
			else if (r < 0.7) s = s.slice(0, at) + s.slice(at + 1 + Math.floor(rnd() * 4));
			else s = s.slice(0, at) + ' ' + pick(SNIPPETS) + ' ' + s.slice(at);
		}
		out.push(s);
	}
	return out;
}

module.exports = { generateStatements, mutateStatements };
