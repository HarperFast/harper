'use strict';
/**
 * The SQL parser reproduces the dialect, tree and text AlaSQL 4 produced, which every SQL consumer was written
 * against. parserGolden.json holds the expected result of each statement in the SQL text of the test suites, and of
 * seeded generated and mutated statements; it was generated, and checked against AlaSQL's own parser, while AlaSQL
 * was still a dependency. Statements AlaSQL accepted only by silently discarding tokens in its error recovery are
 * errors here.
 */
const assert = require('assert');
const crypto = require('crypto');
const { parse } = require('#src/sqlTranslator/parser/parser');
const golden = require('./fixtures/parserGolden.json');
const { generateStatements, mutateStatements } = require('./fixtures/sqlFuzz');

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
		.update(JSON.stringify([canonical(result), text]))
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

	describe('errors', function () {
		it('shows the text around the token it could not read', function () {
			assert.throws(
				() => parse('SELECT * FROM t WHERE ) x'),
				// The 20 characters before it, then it and what follows, up to 20 characters.
				(error) => error instanceof SyntaxError && error.message.split('\n')[1] === '...LECT * FROM t WHERE ) x'
			);
		});

		it('refuses a statement other than SELECT, INSERT, UPDATE and DELETE', function () {
			assert.throws(() => parse('CREATE TABLE t (a INT)'), SyntaxError);
			assert.throws(() => parse('SELECT 1; DROP TABLE t'), SyntaxError);
		});
	});
});
