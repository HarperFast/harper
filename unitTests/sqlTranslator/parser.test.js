'use strict';
/**
 * The SQL parser reproduces the dialect, tree and text AlaSQL 4 produced, which every SQL consumer was written
 * against. parserGolden.json holds the expected result of each statement in the SQL text of the test suites, and of
 * seeded generated and mutated statements; it was generated, and checked against AlaSQL's own parser, while AlaSQL
 * was still a dependency. Statements AlaSQL accepted only by silently discarding tokens in its error recovery are
 * errors here.
 */
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const crypto = require('node:crypto');
const { parse } = require('#src/sqlTranslator/parser/parser');
const golden = require('./fixtures/parserGolden.json');
const { generateStatements, mutateStatements } = require('./fixtures/sqlFuzz');
const { tokenize } = require('#src/sqlTranslator/parser/lexer');

function canonical(node) {
	if (node === undefined) return '<undef>';
	if (node === null || typeof node !== 'object') return node;
	if (Array.isArray(node)) return node.map(canonical);
	const out = {};
	if (node.constructor && node.constructor.name !== 'Object') out.$class = node.constructor.name;
	for (const key of Object.keys(node)) {
		if (typeof node[key] !== 'function') out[key] = canonical(node[key]);
	}
	return out;
}

/**
 * Paths at which a node already reached by another path appears. Consumers walk the tree with iterators that
 * refuse a node seen twice, so which nodes are shared decides which statements they accept.
 */
function sharedPaths(root) {
	const seen = new Set();
	const paths = [];
	(function walk(node, path) {
		if (node === null || typeof node !== 'object') return;
		if (seen.has(node)) {
			paths.push(path);
			return;
		}
		seen.add(node);
		for (const key of Object.keys(node)) walk(node[key], path + '.' + key);
	})(root, '$');
	return paths;
}

function digest(sql) {
	let result;
	try {
		result = parse(sql);
	} catch {
		return 'error';
	}
	const text = result.statements.map((statement) => {
		try {
			return statement && statement.toString();
		} catch (error) {
			return 'ERR:' + error.message;
		}
	});
	return crypto
		.createHash('sha1')
		.update(JSON.stringify([canonical(result), text, sharedPaths(result)]))
		.digest('hex')
		.slice(0, 16);
}

const first = (sql) => parse(sql).statements[0];
const where = (sql) => first(sql).where.expression;

describe('SQL parser', function () {
	describe('matches the golden results', function () {
		it('for every statement in the corpus', function () {
			const mismatches = golden.corpus.filter(([sql, expected]) => digest(sql) !== expected).map(([sql]) => sql);
			assert.deepStrictEqual(mismatches, []);
		});

		it('for generated statements', function () {
			const { seed, count, digests } = golden.generated;
			const statements = generateStatements(seed, count);
			const mismatches = statements.filter((sql, i) => digest(sql) !== digests[i]);
			assert.deepStrictEqual(mismatches, []);
		});

		it('for mutated statements', function () {
			const { seed, count, digests } = golden.mutated;
			const statements = mutateStatements(
				golden.corpus.map(([sql]) => sql),
				seed,
				count
			);
			const mismatches = statements.filter((sql, i) => digest(sql) !== digests[i]);
			assert.deepStrictEqual(mismatches, []);
		});
	});

	describe('operator precedence', function () {
		it('binds NOT tighter than IN and looser than comparisons', function () {
			const notIn = where('SELECT a FROM t WHERE NOT a IN (1)');
			assert.strictEqual(notIn.op, 'IN');
			assert.strictEqual(notIn.left.op, 'NOT');
			const notEq = where('SELECT a FROM t WHERE NOT a = b');
			assert.strictEqual(notEq.op, 'NOT');
			assert.strictEqual(notEq.right.op, '=');
		});

		it('folds BETWEEN into the AND that follows it', function () {
			const expression = where('SELECT a FROM t WHERE x = 1 AND y BETWEEN 2 AND 3');
			assert.strictEqual(expression.op, 'AND');
			assert.strictEqual(expression.right.op, 'BETWEEN');
			assert.strictEqual(expression.right.right1.value, 2);
			assert.strictEqual(expression.right.right2.value, 3);
		});

		it('gives a prefix minus every operator tighter than itself', function () {
			assert.strictEqual(first('SELECT -a * b FROM t').columns[0].toString(), '-a * b');
			assert.strictEqual(first('SELECT -a * b FROM t').columns[0].op, '-');
		});

		// Legacy SQL ran expressions nested about 2,270 parentheses deep before its stack ran out.
		it('parses parentheses nested 3,000 deep', function () {
			const depth = 3000;
			let node = first(`SELECT ${'('.repeat(depth)}1${')'.repeat(depth)} AS x`).columns[0];
			for (let i = 0; i < depth; i++) node = node.right;
			assert.strictEqual(node.value, 1);
		});
	});

	describe('names', function () {
		it('reads a non-reserved keyword as a lower-cased name where nothing else fits', function () {
			const statement = first('SELECT temp, View, a value FROM t key');
			assert.deepStrictEqual(
				statement.columns.map((c) => [c.columnid, c.as]),
				[
					['temp', undefined],
					['view', undefined],
					['a', 'value'],
				]
			);
			assert.strictEqual(statement.from[0].as, 'key');
		});

		it('keeps the case of a plain name and strips backticks and brackets', function () {
			assert.deepStrictEqual(
				first('SELECT MixedCase, `back tick`, [brack et] FROM d.T').columns.map((c) => c.columnid),
				['MixedCase', 'back tick', 'brack et']
			);
		});

		it('reads `t.c.d` as the column t.c followed by ->d', function () {
			const column = first('SELECT t.c.d FROM t').columns[0];
			assert.strictEqual(column.op, '->');
			assert.strictEqual(column.left.tableid, 't');
			assert.strictEqual(column.right, 'd');
		});
	});

	describe('function calls', function () {
		it('parses a call to a registered aggregate, or to a name every object inherits, as an aggregate', function () {
			const [median, inherited, scalar] = first('SELECT median(a), toString(b), UPPER(c) FROM t').columns;
			assert.strictEqual(median.constructor.name, 'AggrValue');
			assert.strictEqual(inherited.constructor.name, 'AggrValue');
			assert.strictEqual(scalar.constructor.name, 'FuncValue');
		});

		it('writes an unknown function name as a bare parenthesized list', function () {
			assert.strictEqual(first('SELECT foo(a), upper(b) FROM t').toString(), 'SELECT (a), UPPER(b) FROM t');
		});
	});

	describe('INSERT', function () {
		it('reads a parenthesized list starting with a name as the column list', function () {
			const statement = first('INSERT INTO dev.dog (id, name) VALUES (1, 2)');
			assert.deepStrictEqual(
				statement.columns.map((c) => c.columnid),
				['id', 'name']
			);
			assert.strictEqual(statement.values[0][1].value, 2);
			assert.throws(() => parse('INSERT INTO dev.dog (id + 1) VALUES (1)'));
		});

		it('reads any other parenthesized list as a row', function () {
			assert.strictEqual(first("INSERT INTO dev.dog ('a', b)").values[0][0].value, 'a');
		});
	});

	describe('subqueries', function () {
		it('records them on the statement as AlaSQL did', function () {
			const statement = first('SELECT * FROM t WHERE a IN (SELECT b FROM u) AND EXISTS (SELECT 1 FROM v)');
			assert.strictEqual(statement.queries.length, 1);
			assert.strictEqual(statement.exists.length, 1);
			assert.strictEqual(statement.where.expression.left.queriesidx, 0);
			assert.strictEqual(statement.where.expression.right.existsidx, 0);
		});
	});

	describe('text', function () {
		it('writes a statement that parses back to the same statement', function () {
			const sql = "SELECT a AS x, COUNT(DISTINCT b) FROM dev.t AS q WHERE c LIKE 'x!%' ESCAPE '!' AND d IN (1,2)";
			const statement = first(sql);
			assert.strictEqual(first(statement.toString()).toString(), statement.toString());
			assert.match(statement.toString(), /ESCAPE '!'/);
		});
	});

	describe('quoted strings', function () {
		// AlaSQL's string rules, which the lexer reproduces without running them.
		const RULES = [
			[/N(['](\\.|[^']|\\')*?['])+/iy, 'NSTRING'],
			[/X(['](\\.|[^']|\\')*?['])+/iy, 'NSTRING'],
			[/(['](\\.|[^']|\\')*?['])+/y, 'STRING'],
			[/(["](\\.|[^"]|\\")*?["])+/y, 'DQSTRING'],
		];
		const expected = (input) => {
			for (const [regex, type] of RULES) {
				regex.lastIndex = 0;
				const match = regex.exec(input);
				if (match) return `${type}:${match[0].length}`;
			}
			return 'none';
		};
		const actual = (input) => {
			const token = tokenize(input)[0];
			return ['NSTRING', 'STRING', 'DQSTRING'].includes(token.type) ? `${token.type}:${token.end}` : 'none';
		};

		it("match AlaSQL's rules on every short input", function () {
			const alphabet = ["'", '\\', 'a', '\n', '"'];
			const mismatches = [];
			const visit = (input, left) => {
				if (expected(input) !== actual(input)) mismatches.push(input);
				if (left > 0) for (const c of alphabet) visit(input + c, left - 1);
			};
			for (const start of ["'", '"', "N'", "x'"]) visit(start, 6);
			assert.deepStrictEqual(mismatches, []);
		});

		it('lex a long unterminated string in linear time', function () {
			const child = spawnSync(process.execPath, [...process.execArgv, join(__dirname, 'fixtures', 'lexTiming.js')], {
				input: "SELECT '" + '\\x'.repeat(50000),
				encoding: 'utf8',
				timeout: 20_000,
			});
			assert.strictEqual(child.signal, null, 'the lexer did not finish within 20 s');
			assert.strictEqual(child.status, 0, child.stderr);
			const { ms, second } = JSON.parse(child.stdout);
			assert.notStrictEqual(second, 'STRING');
			assert.ok(ms < 2000, `took ${ms} ms`);
		});
	});

	describe('grouping sets', function () {
		// AlaSQL's grammar had no parenthesized tuple inside ROLLUP, CUBE or GROUPING SETS either.
		it('refuse a parenthesized list as one item', function () {
			assert.throws(() => parse('SELECT a FROM t GROUP BY GROUPING SETS ((a, b), (a))'), SyntaxError);
			assert.throws(() => parse('SELECT a FROM t GROUP BY ROLLUP((a, b), c)'), SyntaxError);
		});
	});

	describe('errors', function () {
		it('shows the text around the token it could not read', function () {
			assert.throws(
				() => parse('SELECT * FROM t WHERE ) x'),
				(error) => error instanceof SyntaxError && error.message.split('\n')[1] === '...LECT * FROM t WHERE ) x'
			);
		});

		it('refuses a statement other than SELECT, INSERT, UPDATE and DELETE', function () {
			assert.throws(() => parse('CREATE TABLE t (a INT)'), SyntaxError);
			assert.throws(() => parse('SELECT 1; DROP TABLE t'), SyntaxError);
		});
	});
});
