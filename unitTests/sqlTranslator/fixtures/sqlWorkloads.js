'use strict';
/**
 * Deterministic SELECT workloads for the in-memory SQL engine golden test (memoryEngine.test.js): random statements
 * of the shapes legacy SQL runs (parameter tables joined, filtered, grouped, sorted) over random rows, and a second
 * set exercising modifiers, set operations, window aggregates, row numbers and subqueries.
 */

function rng(seed) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function joinWorkloads(seed, count) {
	const rnd = rng(seed);
	const pick = (a) => a[Math.floor(rnd() * a.length)];
	const chance = (p) => rnd() < p;
	const int = (n) => Math.floor(rnd() * n);
	const WIDTH = 5;
	function value() {
		return pick([
			() => int(10),
			() => int(10),
			() => -int(5),
			() => +(rnd() * 10).toFixed(2),
			() => 0,
			() => String(int(10)),
			() => '0' + int(9),
			() => '',
			() => ' ',
			() => pick(['a', 'B', 'abc', 'Abc', 'b', 'zz', 'a%b', "it's"]),
			() => null,
			() => undefined,
			() => true,
			() => false,
			() => NaN,
			() => new Date(1700000000000 + int(5) * 86400000),
			() => ({ x: int(3), y: pick(['p', 'q']) }),
			() => [int(3), int(3)],
		])();
	}
	function table(rows) {
		return Array.from({ length: rows }, () => {
			const r = [];
			const w = WIDTH - (chance(0.2) ? int(3) : 0);
			for (let i = 0; i < w; i++) r.push(value());
			return r;
		});
	}
	function makeQuery() {
		const nTables = chance(0.6) ? 1 : 2 + (chance(0.3) ? 1 : 0);
		const aliases = ['a', 'b', 'c'].slice(0, nTables);
		const params = aliases.map(() => table(int(7)));
		const col = (alias) => (chance(0.3) || !alias ? `[${int(WIDTH)}]` : `${alias}.[${int(WIDTH)}]`);
		const anyCol = () => col(chance(0.2) ? null : pick(aliases));
		const lit = () =>
			pick([
				String(int(10)),
				'0',
				"'" + pick(['a', 'B', '5', '', 'abc', 'a%']) + "'",
				'NULL',
				'TRUE',
				'FALSE',
				'2.5',
				'?',
			]);
		function expr(d) {
			if (d <= 0) return chance(0.6) ? anyCol() : lit();
			const r = rnd();
			if (r < 0.3)
				return (
					expr(d - 1) +
					' ' +
					pick([
						'=',
						'<>',
						'!=',
						'<',
						'<=',
						'>',
						'>=',
						'+',
						'-',
						'*',
						'/',
						'%',
						'AND',
						'OR',
						'||',
						'LIKE',
						'NOT LIKE',
						'==',
						'IS',
					]) +
					' ' +
					expr(d - 1)
				);
			if (r < 0.38) return pick(['NOT ', '-', '']) + '(' + expr(d - 1) + ')';
			if (r < 0.46)
				return (
					expr(d - 1) +
					pick([' IN ', ' NOT IN ']) +
					'(' +
					Array.from({ length: 1 + int(3) }, () => lit()).join(', ') +
					')'
				);
			if (r < 0.52) return expr(d - 1) + pick([' BETWEEN ', ' NOT BETWEEN ']) + lit() + ' AND ' + lit();
			if (r < 0.58) return expr(d - 1) + pick([' IS NULL', ' IS NOT NULL']);
			if (r < 0.66)
				return (
					pick([
						'UPPER',
						'LOWER',
						'LEN',
						'ABS',
						'ROUND',
						'IFNULL',
						'COALESCE',
						'CONCAT',
						'IIF',
						'INSTR',
						'TRIM',
						'SUBSTRING',
					]) +
					'(' +
					expr(d - 1) +
					(chance(0.4) ? ', ' + lit() : '') +
					(chance(0.15) ? ', ' + lit() : '') +
					')'
				);
			if (r < 0.7)
				return (
					'CASE ' +
					(chance(0.5) ? expr(0) + ' ' : '') +
					'WHEN ' +
					expr(d - 1) +
					' THEN ' +
					expr(0) +
					(chance(0.5) ? ' ELSE ' + expr(0) : '') +
					' END'
				);
			if (r < 0.74) return anyCol() + '->' + pick(['x', 'y', '0', 'length']);
			if (r < 0.77)
				return (
					'CAST(' +
					expr(d - 1) +
					' AS ' +
					pick(['INT', 'NUMBER', 'STRING', 'BOOLEAN', 'DATE', 'FLOAT', 'VARCHAR(2)']) +
					')'
				);
			return chance(0.5) ? anyCol() : lit();
		}
		const grouped = chance(0.3);
		const aggs = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'FIRST', 'LAST', 'ARRAY', 'TOTAL'];
		const reduce = [
			'MEDIAN',
			'median',
			'MODE',
			'MAD',
			'MEAN',
			'PROD',
			'GROUP_CONCAT',
			'DISTINCT_ARRAY',
			'VAR',
			'STDEV',
		];
		const groupCols = grouped && chance(0.7) ? Array.from({ length: 1 + int(2) }, () => anyCol()) : [];
		const columns = [];
		const ncols = 1 + int(4);
		for (let i = 0; i < ncols; i++) {
			let c;
			const asAggregate = grouped && chance(0.6);
			if (asAggregate) {
				const fn = chance(0.75) ? pick(aggs) : pick(reduce);
				c =
					fn +
					'(' +
					(fn === 'COUNT' && chance(0.3) ? '*' : (chance(0.15) ? 'DISTINCT ' : '') + expr(chance(0.7) ? 0 : 1)) +
					')';
			} else if (grouped && groupCols.length && chance(0.6)) c = pick(groupCols);
			else c = chance(0.6) ? anyCol() : expr(1 + int(2));
			if (chance(0.6)) c += ' AS [' + pick(['x', 'y', 'z', 'n', 'c' + i, '0', '1', 'a.b']) + ']';
			columns.push(c);
		}
		if (!grouped && chance(0.08)) columns.push(pick(['*', 'a.*']));
		let sql =
			'SELECT ' + (chance(0.15) ? 'DISTINCT ' : '') + (chance(0.06) ? 'TOP ' + int(4) + ' ' : '') + columns.join(', ');
		sql += ' FROM ? AS a';
		for (let i = 1; i < nTables; i++) {
			const mode = pick([
				'INNER JOIN',
				'LEFT JOIN',
				'LEFT OUTER JOIN',
				'RIGHT JOIN',
				'FULL OUTER JOIN',
				'CROSS JOIN',
				'JOIN',
				'OUTER JOIN',
			]);
			const al = aliases[i];
			const on =
				mode === 'CROSS JOIN'
					? ''
					: pick([
							` ON ${aliases[i - 1]}.[${int(WIDTH)}] = ${al}.[${int(WIDTH)}]`,
							` ON ${al}.[${int(WIDTH)}] = a.[${int(WIDTH)}]`,
							` ON ${aliases[i - 1]}.[${int(2)}] < ${al}.[${int(2)}]`,
							` ON ${expr(1)}`,
							` USING ([${int(WIDTH)}])`,
						]);
			sql += ` ${mode} ? AS ${al}${on}`;
		}
		if (chance(0.6)) sql += ' WHERE ' + expr(1 + int(2));
		if (grouped && groupCols.length) sql += ' GROUP BY ' + groupCols.join(', ');
		if (grouped && chance(0.3))
			sql +=
				' HAVING ' + pick(['COUNT(*) > 1', 'SUM(' + anyCol() + ') > 2', expr(1), 'MAX(' + anyCol() + ') IS NOT NULL']);
		if (chance(0.45))
			sql +=
				' ORDER BY ' +
				Array.from(
					{ length: 1 + int(2) },
					() =>
						pick([anyCol(), String(1 + int(ncols)), expr(1), "'x'", pick(['[x]', '[y]', 'x'])]) +
						pick(['', ' ASC', ' DESC', ' DESC NULLS FIRST', ' ASC NULLS LAST', ' COLLATE NOCASE'])
				).join(', ');
		if (chance(0.25)) sql += ' LIMIT ' + int(5) + (chance(0.4) ? ' OFFSET ' + int(4) : '');
		if (sql.includes('?')) {
			// parameters 0..: tables first, then values for any `?` in expressions
		}
		return { sql, params };
	}

	return Array.from({ length: count }, () => {
		const { sql, params } = makeQuery();
		return { sql, params: params.concat([5, 'a', null]) };
	});
}

function featureWorkloads(seed, count) {
	const rnd = rng(seed);
	const pick = (a) => a[Math.floor(rnd() * a.length)];
	const chance = (p) => rnd() < p;
	const int = (n) => Math.floor(rnd() * n);
	const value = () =>
		pick([
			() => int(6),
			() => String(int(4)),
			() => pick(['a', 'b', 'B', '']),
			() => null,
			() => undefined,
			() => true,
			() => +(rnd() * 5).toFixed(1),
		])();
	const table = () => Array.from({ length: int(6) }, () => [value(), value(), value()]);
	const lit = () => pick([String(int(5)), "'a'", "'b'", 'NULL', 'TRUE', '2.5']);
	const col = () => pick(['[0]', '[1]', '[2]', 'a.[0]', 'a.[1]']);
	function select(fromAllowed, depth = 0) {
		const cols = Array.from({ length: 1 + int(3) }, (_, i) => {
			const r = rnd();
			let c;
			if (!fromAllowed)
				c = pick([
					lit(),
					lit() + ' + ' + lit(),
					'UPPER(' + lit() + ')',
					'NOW() > 0',
					'(SELECT ' + lit() + ')',
					'ABS(-' + int(5) + ')',
				]);
			else if (r < 0.15)
				c =
					pick(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']) +
					'(' +
					pick(['*', col()]) +
					') OVER (' +
					(chance(0.6) ? 'PARTITION BY ' + col() : '') +
					')';
			else if (r < 0.25) c = 'ROW_NUMBER()' + (chance(0.4) ? ' OVER (PARTITION BY ' + col() + ')' : '');
			else if (r < 0.32 && depth < 1) c = '(SELECT ' + lit() + ')';
			else if (r < 0.38 && depth < 1) c = 'EXISTS(SELECT ' + lit() + ')';
			else if (r < 0.44 && depth < 1) c = col() + ' IN (SELECT ' + lit() + ' UNION ALL SELECT ' + lit() + ')';
			else c = chance(0.5) ? col() : lit();
			return c + (chance(0.6) ? ' AS [' + pick(['x', 'y', 'z', 'c' + i, '1']) + ']' : '');
		});
		let s =
			'SELECT ' +
			(chance(0.25) ? pick(['VALUE ', 'ROW ', 'COLUMN ', 'MATRIX ', 'INDEX ', 'TEXTSTRING ', 'RECORDSET ']) : '') +
			(chance(0.15) ? 'DISTINCT ' : '') +
			cols.join(', ');
		if (fromAllowed)
			s += ' FROM ? AS a' + (chance(0.4) ? ' WHERE ' + col() + pick([' = ', ' > ', ' <> ']) + lit() : '');
		return s;
	}
	function query() {
		const from = chance(0.7);
		let s = select(from);
		if (chance(0.35)) {
			const op = pick([
				' UNION ',
				' UNION ALL ',
				' EXCEPT ',
				' INTERSECT ',
				' UNION CORRESPONDING ',
				' UNION ALL CORRESPONDING ',
			]);
			s += op + select(chance(0.5) && from);
		}
		if (chance(0.4)) s += ' ORDER BY ' + pick(['1', '2', '[x]', 'a.[0]', '[0]']) + pick(['', ' DESC']);
		if (chance(0.2)) s += ' LIMIT ' + int(4) + (chance(0.4) ? ' OFFSET ' + int(3) : '');
		return s;
	}

	return Array.from({ length: count }, () => {
		const sql = query();
		return { sql, params: [table(), table()] };
	});
}

module.exports = { joinWorkloads, featureWorkloads };
