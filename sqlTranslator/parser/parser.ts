/**
 * Recursive-descent parser for Harper's SQL dialect, producing the AST in ast.ts.
 *
 * The dialect and the tree are the ones AlaSQL 4's LALR parser produced, which every SQL consumer here was
 * written against, so this parser reproduces that parser's decisions rather than standard SQL's:
 *
 * - Operator precedence and associativity follow the LALR precedence table (PRECEDENCE below), including where
 *   it is surprising: NOT binds tighter than IN (`NOT a IN (1)` is `(NOT a) IN (1)`), BETWEEN and AND share a
 *   level (BETWEEN is parsed as `BETWEEN1` and folded into the following AND), and `::` binds loosest.
 * - A prefix operator's operand takes every operator that binds tighter than the prefix operator itself,
 *   wherever the prefix appears, as a shift-preferring LALR parser does.
 * - Where the grammar was ambiguous, the LALR parser shifted, so the longer reading wins (`t.c.d` is the
 *   column `t.c` followed by `->d`, `SELECT VALUE ...` is the VALUE modifier).
 * - A few terminals (NON_RESERVED) stand for a lower-cased name where a name is expected and the terminal
 *   itself cannot continue the statement, as AlaSQL's error recovery for them did.
 * - Subqueries and EXISTS are recorded on the statement (`queries`, `exists`, `queriesidx`, `existsidx`) with
 *   the same bookkeeping the grammar actions did, quirks included.
 */
import * as ast from './ast.ts';
import { isAggregateName } from './functionNames.ts';
import { NON_RESERVED, type Token, tokenize, uncomment } from './lexer.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Binding power of each binary/postfix operator terminal; higher binds tighter. All are left-associative. */
const PRECEDENCE: Record<string, number> = {
	COMMA: 1,
	DOUBLECOLON: 2,
	OR: 3,
	AND: 4,
	BETWEEN: 4,
	NOT_BETWEEN: 4,
	IN: 5,
	NOT: 6,
	GT: 7,
	GE: 7,
	LT: 7,
	LE: 7,
	EQ: 7,
	NE: 7,
	EQEQ: 7,
	NEEQEQ: 7,
	EQEQEQ: 7,
	NEEQEQEQ: 7,
	IS: 8,
	LIKE: 9,
	NOT_LIKE: 9,
	REGEXP: 9,
	GLOB: 9,
	GTGT: 10,
	LTLT: 10,
	AMPERSAND: 10,
	BAR: 10,
	PLUS: 11,
	MINUS: 11,
	STAR: 12,
	SLASH: 12,
	MODULO: 12,
	CARET: 13,
	DOT: 14,
	ARROW: 14,
	EXCLAMATION: 14,
	TILDA: 15,
	SHARP: 16,
	BARBAR: 17,
};

const BINARY_OPS: Record<string, string> = {
	REGEXP: 'REGEXP',
	TILDA: 'REGEXP',
	GLOB: 'GLOB',
	BARBAR: '||',
	PLUS: '+',
	MINUS: '-',
	STAR: '*',
	SLASH: '/',
	MODULO: '%',
	CARET: '^',
	GTGT: '>>',
	LTLT: '<<',
	AMPERSAND: '&',
	BAR: '|',
	GT: '>',
	GE: '>=',
	LT: '<',
	LE: '<=',
	EQ: '=',
	EQEQ: '==',
	EQEQEQ: '===',
	NE: '!=',
	NEEQEQ: '!==',
	NEEQEQEQ: '!===',
	OR: 'OR',
	IS: 'IS',
};

const INFIX = new Set([
	...Object.keys(BINARY_OPS),
	'AND',
	'BETWEEN',
	'NOT_BETWEEN',
	'IN',
	'NOT',
	'LIKE',
	'NOT_LIKE',
	'DOT',
	'ARROW',
	'EXCLAMATION',
	'DOUBLECOLON',
]);
const COND_OPS = new Set(['GT', 'GE', 'LT', 'LE', 'EQ', 'NE']);
const ALL_SOME = new Set(['ALL', 'SOME', 'ANY']);
const AGGREGATORS: Record<string, string> = {
	SUM: 'SUM',
	TOTAL: 'TOTAL',
	COUNT: 'COUNT',
	MIN: 'MIN',
	MAX: 'MAX',
	AVG: 'AVG',
	FIRST: 'FIRST',
	LAST: 'LAST',
	AGGR: 'AGGR',
	ARRAY: 'ARRAY',
};
const SELECT_MODIFIERS = new Set(['VALUE', 'ROW', 'COLUMN', 'MATRIX', 'TEXTSTRING', 'INDEX', 'RECORDSET']);
const JOIN_STARTS = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'FULL', 'SEMI', 'ANTI', 'CROSS', 'NATURAL']);
const UNION_STARTS = new Set(['UNION', 'EXCEPT', 'INTERSECT']);

class SqlSyntaxError extends SyntaxError {}

/** The bookkeeping the grammar actions kept per parse for subqueries, EXISTS and `?` parameters. */
interface ParseState {
	question?: number;
	exists?: any[];
	queries?: any[];
	queriesStack?: any[][];
}

class Parser {
	private readonly tokens: Token[];
	private readonly input: string;
	private pos = 0;
	private state: ParseState = {};

	constructor(input: string) {
		this.input = input;
		this.tokens = tokenize(input);
	}

	// #section: token helpers

	private peek(offset = 0): Token {
		return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
	}

	private is(type: string, offset = 0): boolean {
		return this.peek(offset).type === type;
	}

	private next(): Token {
		const token = this.tokens[this.pos];
		if (this.pos < this.tokens.length - 1) this.pos++;
		return token;
	}

	private accept(type: string): Token | undefined {
		if (this.is(type)) return this.next();
	}

	private expect(type: string): Token {
		if (!this.is(type)) this.fail(type);
		return this.next();
	}

	/** Throws the same message shape AlaSQL's parser did: the text around the offending token. */
	fail(expected?: string): never {
		const token = this.peek();
		const past = this.input.slice(0, token.start);
		let pastText = (past.length > 20 ? '...' : '') + past.slice(-20).replace(/\n/g, '');
		let next = this.input.slice(token.start, token.end);
		if (next.length < 20) next += this.input.slice(token.end, token.end + 20 - next.length);
		const upcoming = (next.slice(0, 20) + (next.length > 20 ? '...' : '')).replace(/\n/g, '');
		const got = token.type;
		throw new SqlSyntaxError(
			`Parse error on line 1:\n${pastText}${upcoming}\n${'-'.repeat(pastText.length)}^\n` +
				`Expecting ${expected ? `'${expected}'` : 'a valid token'}, got '${got}'`
		);
	}

	// #section: statements

	parseStatements(): ast.Statements {
		const statements: any[] = [];
		if (this.is('EXPLAIN')) {
			this.next();
			if (this.is('QUERY')) {
				this.next();
				this.expect('PLAN');
			}
			const statement = this.parseAStatement();
			if (!statement) this.fail();
			statement.explain = true;
			statements.push(statement);
		} else {
			statements.push(this.parseAStatement());
		}
		while (this.is('SEMICOLON') || this.is('GO')) {
			this.next();
			const statement = this.parseAStatement();
			if (statement) statements.push(statement);
		}
		if (!this.is('EOF')) this.fail('EOF');
		return new ast.Statements({ statements });
	}

	private parseAStatement(): any {
		const statement = this.parseStatement();
		if (statement !== undefined) {
			if (this.state.exists) statement.exists = this.state.exists;
			if (this.state.queries) statement.queries = this.state.queries;
		}
		delete this.state.exists;
		delete this.state.queries;
		return statement;
	}

	private parseStatement(): any {
		switch (this.peek().type) {
			case 'SELECT':
			case 'LPAR':
				return this.parseSelect();
			case 'INSERT':
			case 'REPLACE':
				return this.parseInsert();
			case 'UPDATE':
				return this.parseUpdate();
			case 'DELETE':
				return this.parseDelete();
			case 'EOF':
			case 'SEMICOLON':
			case 'GO':
				return undefined;
			default:
				this.fail();
		}
	}

	// #section: SELECT

	/** `Select`: a full SELECT, a parenthesized one with set operations, ORDER BY and LIMIT after it. */
	parseSelect(): any {
		if (this.is('LPAR')) {
			this.next();
			const select = this.parseSelect();
			this.expect('RPAR');
			Object.assign(select, this.parseUnionClause(), this.parseOrderClause(), this.parseLimitClause());
			if (this.state.exists) select.exists = this.state.exists.slice();
			return select;
		}
		const select = this.parseSelectBody();
		Object.assign(select, this.parseOrderClause(), this.parseLimitClause());
		if (this.state.exists) select.exists = this.state.exists.slice();
		return select;
	}

	/** SelectClause through UnionClause: `SelectWithoutOrderOrLimit`, the shape both SELECT forms share. */
	private parseSelectBody(): any {
		const select = this.parseSelectClause();
		Object.assign(
			select,
			this.parseRemoveClause(),
			this.parseIntoClause(),
			this.parseFromClause(),
			this.parsePivotClause(),
			this.parseWhereClause(),
			this.parseGroupClause(),
			this.parseUnionClause()
		);
		return select;
	}

	private parseSelectClause(): any {
		const selectToken = this.expect('SELECT');
		let modifier: any = selectToken.text === 'SELECT' ? undefined : { modifier: selectToken.text };
		if (selectToken.text === 'SELECT' && SELECT_MODIFIERS.has(this.peek().type)) {
			modifier = { modifier: this.next().type };
		}
		if (this.is('DISTINCT')) {
			this.next();
			if (this.is('ON')) {
				this.next();
				this.expect('LPAR');
				const distinctOn = this.parseExprList();
				this.expect('RPAR');
				const top = this.parseTopClause();
				const select = new ast.Select({ columns: this.parseResultColumns(), distinctOn });
				return Object.assign(select, modifier, top);
			}
			const top = this.parseTopClause();
			return Object.assign(new ast.Select({ columns: this.parseResultColumns(), distinct: true }), modifier, top);
		}
		if (this.is('UNIQUE')) {
			this.next();
			const top = this.parseTopClause();
			return Object.assign(new ast.Select({ columns: this.parseResultColumns(), distinct: true }), modifier, top);
		}
		if (this.is('ALL')) {
			this.next();
			const top = this.parseTopClause();
			return Object.assign(new ast.Select({ columns: this.parseResultColumns(), all: true }), modifier, top);
		}
		const top = this.parseTopClause();
		if (!this.startsExpression()) {
			return new ast.Select({ columns: [new ast.Column({ columnid: '_' })], modifier: 'COLUMN' });
		}
		return Object.assign(new ast.Select({ columns: this.parseResultColumns() }), modifier, top);
	}

	private parseTopClause(): any {
		if (!this.is('TOP')) return undefined;
		this.next();
		if (this.accept('LPAR')) {
			const top = this.parseNumOrParam();
			this.expect('RPAR');
			return { top };
		}
		const top = this.parseNumOrParam();
		return { top, percent: this.accept('PERCENT') ? true : undefined };
	}

	private parseNumOrParam(): any {
		if (this.is('NUMBER')) return this.parseNumValue();
		const param = this.tryParamValue();
		if (!param) this.fail('NUMBER');
		return param;
	}

	private parseResultColumns(): any[] {
		const columns = [this.parseResultColumn()];
		while (this.accept('COMMA')) columns.push(this.parseResultColumn());
		return columns;
	}

	private parseResultColumn(): any {
		const expression = this.parseExpression();
		if (this.accept('AS')) {
			if (this.is('NUMBER')) expression.as = this.next().text;
			else if (this.isStringValueToken()) expression.as = this.parseStringValue().value;
			else expression.as = this.parseLiteral();
			return expression;
		}
		if (this.is('NUMBER')) expression.as = this.next().text;
		else if (this.isStringValueToken()) expression.as = this.parseStringValue().value;
		else if (this.startsLiteral(RESULT_COLUMN_FOLLOW)) expression.as = this.parseLiteral();
		return expression;
	}

	private parseRemoveClause(): any {
		if (!this.is('REMOVE')) return undefined;
		this.next();
		this.accept('COLUMN');
		const removecolumns = [this.parseRemoveColumn()];
		while (this.accept('COMMA')) removecolumns.push(this.parseRemoveColumn());
		return { removecolumns };
	}

	private parseRemoveColumn(): any {
		if (this.accept('LIKE')) return { like: this.parseStringValue() };
		return this.parseColumn();
	}

	private parseIntoClause(): any {
		if (!this.is('INTO')) return undefined;
		this.next();
		if (this.isStringToken()) {
			const s = this.next().text.slice(1, -1);
			const into = fileFunction(s);
			return into ? { into } : undefined;
		}
		if (this.is('AT')) return { into: this.parseVarValue() };
		const param = this.tryParamValue();
		if (param) return { into: param };
		if (this.startsLiteral() && this.is('LPAR', 1)) return { into: this.parseFuncValue() };
		return { into: this.parseTable() };
	}

	private parseFromClause(): any {
		if (!this.is('FROM')) return undefined;
		this.next();
		if (this.is('LPAR') && !this.is('SELECT', 1)) {
			this.next();
			const from = this.parseFromTablesList();
			const joins = this.parseJoinTablesList();
			if (!joins) this.fail('JOIN');
			this.expect('RPAR');
			return { from, joins };
		}
		const from = this.parseFromTablesList();
		const joins = this.parseJoinTablesList();
		if (!joins) return { from };
		if (this.is('COMMA')) {
			this.next();
			for (const t of this.parseFromTablesList()) {
				const join = new ast.Join({ joinmode: 'CROSS' });
				if (t.tableid) join.table = new ast.Table({ databaseid: t.databaseid, tableid: t.tableid });
				else if (t instanceof ast.Select) join.select = t;
				else if (t instanceof ast.ParamValue) join.param = t;
				else if (t instanceof ast.VarValue) join.variable = t.variable;
				else if (t instanceof ast.FuncValue) join.func = t;
				else if (t instanceof ast.Json) join.json = t;
				if (t.as) join.as = t.as;
				joins.push(join);
			}
		}
		return { from, joins };
	}

	private parseFromTablesList(): any[] {
		const tables = [this.parseFromTable()];
		// A comma followed by a join belongs to no table list; it is a syntax error either way.
		while (this.is('COMMA')) {
			this.next();
			tables.push(this.parseFromTable());
		}
		return tables;
	}

	private parseFromTable(): any {
		if (this.is('LPAR')) {
			this.next();
			const select = this.parseSelect();
			this.expect('RPAR');
			select.as = this.parseFromTableAlias() || 'default';
			return select;
		}
		if (this.is('INSERTED')) {
			this.next();
			return { inserted: true };
		}
		if (this.startsJson()) {
			const value = this.parseJson();
			const json = new ast.Json({ value });
			this.accept('AS');
			value.as = this.startsLiteral(FROM_FOLLOW) ? this.parseLiteral() : undefined;
			return json;
		}
		if (this.is('AT')) {
			const variable = this.parseVarValue();
			variable.as = this.parseFromTableAlias() || 'default';
			return variable;
		}
		const param = this.tryParamValue();
		if (param) {
			param.as = this.parseFromTableAlias() || 'default';
			return param;
		}
		if (this.isStringToken()) {
			const s = this.next().text.slice(1, -1);
			const func = fileFunction(s);
			if (!func) throw new SqlSyntaxError('Unknown string in FROM clause');
			func.as = this.parseFromTableAlias() || 'default';
			return func;
		}
		if (this.startsLiteral() && this.is('LPAR', 1)) {
			const func = this.parseFuncValue();
			func.as = this.parseFromTableAlias() || 'default';
			return func;
		}
		const table = this.parseTable();
		if (this.is('NOT') && this.is('INDEXED', 1)) {
			this.next();
			this.next();
			return table;
		}
		const alias = this.parseFromTableAlias();
		if (alias) table.as = alias;
		return table;
	}

	private parseFromTableAlias(): string | undefined {
		if (this.accept('AS')) return this.parseLiteral();
		if (this.startsLiteral(FROM_FOLLOW)) return this.parseLiteral();
	}

	private parseTable(): any {
		const first = this.parseLiteral();
		if (this.accept('DOT')) {
			const second = this.parseLiteral();
			if (first === 'INFORMATION_SCHEMA') {
				return new ast.FuncValue({ funcid: first, args: [new ast.StringValue({ value: second })] });
			}
			return new ast.Table({ databaseid: first, tableid: second });
		}
		return new ast.Table({ tableid: first });
	}

	private parseJoinTablesList(): any[] | undefined {
		let joins: any[] | undefined;
		for (;;) {
			let join;
			if ((this.is('CROSS') || this.is('OUTER')) && this.is('APPLY', 1)) join = this.parseApply();
			else if (JOIN_STARTS.has(this.peek().type) && this.startsJoin()) join = this.parseJoin();
			else break;
			(joins ??= []).push(join);
		}
		return joins;
	}

	private startsJoin(): boolean {
		// LEFT and RIGHT are names too; they start a join only when JOIN or OUTER follows.
		const type = this.peek().type;
		if (type === 'LEFT' || type === 'RIGHT') return this.is('JOIN', 1) || this.is('OUTER', 1);
		return true;
	}

	private parseApply(): any {
		const applymode = this.next().type;
		this.expect('APPLY');
		this.expect('LPAR');
		const select = this.parseSelect();
		this.expect('RPAR');
		this.accept('AS');
		return new ast.Apply({ select, applymode, as: this.parseLiteral() });
	}

	private parseJoin(): any {
		let mode: any;
		if (this.is('NATURAL')) {
			const natural = this.next();
			this.parseJoinModeMode();
			mode = { joinmode: natural.text, natural: true };
		} else {
			mode = { joinmode: this.parseJoinModeMode() };
		}
		const join = new ast.Join(mode);
		Object.assign(join, this.parseJoinTableAs(), this.parseOnClause());
		return join;
	}

	private parseJoinModeMode(): string {
		const token = this.next();
		switch (token.type) {
			case 'JOIN':
				return 'INNER';
			case 'INNER':
				this.expect('JOIN');
				return 'INNER';
			case 'LEFT':
				this.accept('OUTER');
				this.expect('JOIN');
				return 'LEFT';
			case 'RIGHT':
				this.accept('OUTER');
				this.expect('JOIN');
				return 'RIGHT';
			case 'OUTER':
				this.expect('JOIN');
				return 'OUTER';
			case 'FULL':
				this.expect('OUTER');
				this.expect('JOIN');
				return 'OUTER';
			case 'SEMI':
				this.expect('JOIN');
				return 'SEMI';
			case 'ANTI':
				this.expect('JOIN');
				return 'ANTI';
			case 'CROSS':
				this.expect('JOIN');
				return 'CROSS';
		}
		this.pos--;
		this.fail('JOIN');
	}

	private parseJoinTableAs(): any {
		if (this.is('LPAR')) {
			this.next();
			const select = this.parseSelect();
			this.expect('RPAR');
			return { select, as: this.parseRequiredAlias() };
		}
		if (this.startsJson()) {
			const value = this.parseJson();
			this.accept('AS');
			const as = this.startsLiteral(FROM_FOLLOW) ? this.parseLiteral() : undefined;
			return { json: new ast.Json({ value, as }) };
		}
		if (this.is('AT')) {
			const variable = this.parseVarValue();
			return { variable, as: this.parseFromTableAlias() || 'default' };
		}
		const param = this.tryParamValue();
		if (param) return { param, as: this.parseRequiredAlias() };
		if (this.startsLiteral() && this.is('LPAR', 1)) {
			const func = this.parseFuncValue();
			return { func, as: this.parseFromTableAlias() || 'default' };
		}
		const result: any = { table: this.parseTable() };
		const alias = this.parseFromTableAlias();
		if (alias) result.as = alias;
		return result;
	}

	private parseRequiredAlias(): string {
		const alias = this.parseFromTableAlias();
		if (alias === undefined) this.fail('LITERAL');
		return alias;
	}

	private parseOnClause(): any {
		if (this.accept('ON')) return { on: this.parseExpression() };
		if (this.accept('USING')) {
			if (this.accept('LPAR')) {
				const using = this.parseColumnsList();
				this.expect('RPAR');
				return { using };
			}
			return { using: this.parseColumnsList() };
		}
		return undefined;
	}

	private parsePivotClause(): any {
		if (this.accept('PIVOT')) {
			this.expect('LPAR');
			const expr = this.parseExpression();
			this.expect('FOR');
			const columnid = this.parseLiteral();
			let inlist;
			if (this.accept('IN')) {
				this.expect('LPAR');
				inlist = [this.parseAsPart()];
				while (this.accept('COMMA')) inlist.push(this.parseAsPart());
				this.expect('RPAR');
			}
			this.expect('RPAR');
			return { pivot: { expr, columnid, inlist, as: this.parseAsLiteral() } };
		}
		if (this.accept('UNPIVOT')) {
			this.expect('LPAR');
			const tocolumnid = this.parseLiteral();
			this.expect('FOR');
			const forcolumnid = this.parseLiteral();
			this.expect('IN');
			this.expect('LPAR');
			const inlist = this.parseColumnsList();
			this.expect('RPAR');
			this.expect('RPAR');
			return { unpivot: { tocolumnid, forcolumnid, inlist, as: this.parseAsLiteral() } };
		}
		return undefined;
	}

	private parseAsPart(): any {
		const expr = this.parseExpression();
		if (this.accept('AS')) return { expr, as: this.parseLiteral() };
		return { expr };
	}

	private parseAsLiteral(): string | undefined {
		if (this.accept('AS')) return this.parseLiteral();
		if (this.startsLiteral(FROM_FOLLOW)) return this.parseLiteral();
	}

	private parseWhereClause(): any {
		if (!this.accept('WHERE')) return undefined;
		return { where: new ast.Expression({ expression: this.parseExpression() }) };
	}

	private parseGroupClause(): any {
		if (!this.is('GROUP')) return undefined;
		this.next();
		this.expect('BY');
		const group = this.parseGroupExpressionsList();
		if (this.is('WITH') && (this.is('ROLLUP', 1) || this.is('CUBE', 1))) {
			this.next();
			const type = this.next().type;
			return Object.assign({ group: [new ast.GroupExpression({ type, group })] }, this.parseHavingClause());
		}
		return Object.assign({ group }, this.parseHavingClause());
	}

	private parseGroupExpressionsList(): any[] {
		const list = [this.parseGroupExpression()];
		while (this.accept('COMMA')) list.push(this.parseGroupExpression());
		return list;
	}

	private parseGroupExpression(): any {
		if (this.is('GROUPING')) {
			this.next();
			this.expect('SET');
			this.expect('LPAR');
			const group = this.parseGroupExpressionsList();
			this.expect('RPAR');
			return new ast.GroupExpression({ type: 'GROUPING SETS', group });
		}
		if ((this.is('ROLLUP') || this.is('CUBE')) && this.is('LPAR', 1)) {
			const type = this.next().type;
			this.next();
			const group = this.parseGroupExpressionsList();
			this.expect('RPAR');
			return new ast.GroupExpression({ type, group });
		}
		return this.parseExpression();
	}

	private parseHavingClause(): any {
		if (!this.accept('HAVING')) return undefined;
		return { having: this.parseExpression() };
	}

	private parseUnionClause(): any {
		if (!UNION_STARTS.has(this.peek().type)) return undefined;
		const opToken = this.next();
		let op = opToken.type.toLowerCase();
		if (opToken.type === 'UNION' && this.accept('ALL')) op = 'unionall';
		const corresponding = !!this.accept('CORRESPONDING');
		(this.state.queriesStack ??= []).push(this.state.queries || []);
		this.state.queries = [];
		let select;
		if (this.is('LPAR')) {
			this.next();
			select = this.parseSelect();
			this.expect('RPAR');
		} else {
			select = this.parseSelectBody();
			if (this.state.exists) select.exists = this.state.exists.slice();
		}
		if (this.state.queriesStack.length > 0) {
			if (this.state.queries && this.state.queries.length > 0) select.queries = this.state.queries;
			this.state.queries = this.state.queriesStack.pop();
		}
		const clause: any = { [op]: select };
		if (corresponding) clause.corresponding = true;
		return clause;
	}

	private parseOrderClause(): any {
		if (!this.is('ORDER') || !this.is('BY', 1)) return undefined;
		this.next();
		this.next();
		return { order: this.parseOrderExpressionsList() };
	}

	private parseOrderExpressionsList(): any[] {
		const list = [this.parseOrderExpression()];
		while (this.accept('COMMA')) list.push(this.parseOrderExpression());
		return list;
	}

	private parseOrderExpression(): any {
		const expression = this.parseExpression();
		if (this.is('COLLATE')) {
			this.next();
			this.expect('NOCASE');
			const direction = this.is('DIRECTION') ? this.next().text.toUpperCase() : 'ASC';
			return new ast.Expression({ expression, direction, nocase: true });
		}
		if (this.is('DIRECTION')) {
			const order = new ast.Expression({ expression, direction: this.next().text.toUpperCase() });
			if (this.is('NULLS') && (this.is('FIRST', 1) || this.is('LAST', 1))) {
				this.next();
				order.nullsOrder = this.next().type;
			}
			return order;
		}
		return new ast.Expression({ expression, direction: 'ASC' });
	}

	private parseLimitClause(): any {
		if (this.accept('LIMIT')) {
			const limit = this.parseNumOrParam();
			if (this.accept('OFFSET')) return { limit, offset: this.parseNumOrParam() };
			return { limit };
		}
		if (this.is('OFFSET')) {
			this.next();
			const offset = this.parseNumOrParam();
			this.accept('ROWS');
			this.expect('FETCH');
			this.accept('NEXT');
			const limit = this.parseNumOrParam();
			this.accept('ROWS');
			this.accept('ONLY');
			return { limit, offset };
		}
		return undefined;
	}

	// #section: INSERT, UPDATE, DELETE

	private parseInsert(): any {
		const params: any = {};
		let flag: any;
		if (this.accept('REPLACE')) {
			flag = { orreplace: true };
		} else {
			this.expect('INSERT');
			if (this.accept('IGNORE')) flag = { ignore: true };
			else if (this.is('OR') && this.is('REPLACE', 1)) {
				this.next();
				this.next();
				flag = { orreplace: true };
			}
		}
		this.accept('INTO');
		params.into = this.parseTargetTable();
		if (!flag && this.is('DEFAULT')) {
			this.next();
			this.parseValuesKeyword(true);
			params.default = true;
			return Object.assign(new ast.Insert(params), this.parseOutputClause());
		}
		if (!flag && this.is('SET')) {
			this.next();
			params.setcolumns = this.parseSetColumnsList();
			return Object.assign(new ast.Insert(params), this.parseOutputClause());
		}
		if (!flag?.orreplace && this.columnsListFollows()) {
			this.next();
			params.columns = this.parseColumnsList();
			this.expect('RPAR');
		}
		if (this.is('SELECT') || (this.is('LPAR') && this.is('SELECT', 1))) {
			if (flag?.orreplace && params.columns) this.fail('VALUES');
			params.select = this.parseSelect();
		} else {
			this.parseValuesKeyword(false);
			params.values = this.parseValuesListsList();
		}
		const insert = new ast.Insert(params);
		Object.assign(insert, flag, this.parseOutputClause());
		return reorderInsert(insert, flag);
	}

	/**
	 * Whether the parenthesized list after the target is a column list rather than a row with no VALUES keyword.
	 * The grammar committed to a column list once the first item was a column, a name not followed by `(`, so
	 * `(a + 1)` is an error rather than a row; any other first item makes the list a row.
	 */
	private columnsListFollows(): boolean {
		if (!this.is('LPAR')) return false;
		const first = this.peek(1).type;
		if (first === 'INSERTED' || first === 'DELETED') return true;
		if (first === 'VALUE' || first === 'NUMBER' || PRIMARY_FOLLOW.has(first)) return false;
		return this.literalAt(1) && !this.is('LPAR', 2);
	}

	private literalAt(offset: number): boolean {
		const type = this.peek(offset).type;
		return (
			type === 'LITERAL' ||
			type === 'BRALITERAL' ||
			type === 'KEY' ||
			type === 'OPEN' ||
			type === 'CLOSE' ||
			type === 'SEPARATOR' ||
			NON_RESERVED.has(type)
		);
	}

	private parseValuesKeyword(required: boolean): void {
		if (this.accept('VALUES') || this.accept('VALUE')) return;
		if (required) this.fail('VALUES');
	}

	private parseValuesListsList(): any[] {
		const list = [this.parseValuesListEntry()];
		while (this.accept('COMMA')) list.push(this.parseValuesListEntry());
		return list;
	}

	private parseValuesListEntry(): any {
		if (this.accept('LPAR')) {
			const row = [this.parseExpression()];
			while (this.accept('COMMA')) row.push(this.parseExpression());
			this.expect('RPAR');
			return row;
		}
		if (this.startsJson()) return this.parseJson();
		const param = this.tryParamValue();
		if (param) return param;
		this.fail('LPAR');
	}

	private parseTargetTable(): any {
		const param = this.tryParamValue();
		if (param) return param;
		const first = this.parseName();
		if (this.accept('DOT')) return new ast.Table({ databaseid: first, tableid: this.parseName() });
		return new ast.Table({ tableid: first });
	}

	private parseName(): string {
		if (this.is('DQSTRING')) {
			const text = this.next().text;
			const name = text.slice(1, -1).replace(/""/g, '"');
			if (!name || /['\\]/.test(name)) throw new SqlSyntaxError('Not a valid name: ' + text);
			return name;
		}
		return this.parseLiteral();
	}

	private parseUpdate(): any {
		this.expect('UPDATE');
		const table = this.parseTargetTable();
		this.expect('SET');
		const columns = this.parseSetColumnsList();
		const update = this.accept('WHERE')
			? new ast.Update({ table, columns, where: this.parseExpression() })
			: new ast.Update({ table, columns });
		return Object.assign(update, this.parseOutputClause());
	}

	private parseSetColumnsList(): any[] {
		const list = [this.parseSetColumn()];
		while (this.accept('COMMA')) list.push(this.parseSetColumn());
		return list;
	}

	private parseSetColumn(): any {
		if (this.is('AT') || this.is('DOLLAR')) {
			const method = this.next().text;
			const variable = this.parseLiteral();
			this.expect('EQ');
			return new ast.SetColumn({ variable, expression: this.parseExpression(), method });
		}
		const column = this.parseColumn();
		this.expect('EQ');
		return new ast.SetColumn({ column, expression: this.parseExpression() });
	}

	private parseDelete(): any {
		this.expect('DELETE');
		this.expect('FROM');
		const table = this.parseTargetTable();
		const statement = this.accept('WHERE')
			? new ast.Delete({ table, where: this.parseExpression() })
			: new ast.Delete({ table });
		return Object.assign(statement, this.parseOutputClause());
	}

	private parseOutputClause(): any {
		if (!this.accept('OUTPUT')) return undefined;
		const columns = this.parseResultColumns();
		if (!this.accept('INTO')) return { output: { columns } };
		if (this.is('AT') || this.is('DOLLAR')) {
			const method = this.next().text;
			return { output: { columns, intovar: this.parseLiteral(), method } };
		}
		const intotable = this.parseTable();
		if (this.accept('LPAR')) {
			const intocolumns = this.parseColumnsList();
			this.expect('RPAR');
			return { output: { columns, intotable, intocolumns } };
		}
		return { output: { columns, intotable } };
	}

	private parseColumnsList(): any[] {
		const list = [this.parseColumn()];
		while (this.accept('COMMA')) list.push(this.parseColumn());
		return list;
	}

	// #section: names

	/** Whether the current token can be read as a name, given the terminals that would continue instead. */
	private startsLiteral(follow?: Set<string>): boolean {
		const type = this.peek().type;
		if (type === 'LITERAL' || type === 'BRALITERAL') return true;
		if (type === 'KEY' || type === 'OPEN' || type === 'CLOSE' || type === 'SEPARATOR') return true;
		return NON_RESERVED.has(type) && !follow?.has(type);
	}

	private parseLiteral(): string {
		const token = this.peek();
		switch (token.type) {
			case 'LITERAL':
				this.next();
				return token.text;
			case 'BRALITERAL':
				this.next();
				return token.text.slice(1, -1).replace(/('')/g, "\\'");
			case 'KEY':
			case 'OPEN':
			case 'CLOSE':
			case 'SEPARATOR':
				this.next();
				return token.text.toLowerCase();
		}
		if (NON_RESERVED.has(token.type)) {
			this.next();
			return token.text.toLowerCase();
		}
		this.fail('LITERAL');
	}

	private parseColumn(): any {
		if (this.is('INSERTED') || this.is('DELETED')) {
			const tableid = this.next().type;
			if (this.accept('DOT')) return new ast.Column({ columnid: this.parseLiteral(), tableid });
			return new ast.Column({ columnid: tableid.toLowerCase() });
		}
		const first = this.parseLiteral();
		if (this.is('DOT')) {
			if (this.is('VALUE', 1)) {
				this.next();
				return new ast.Column({ columnid: this.next().text, tableid: first });
			}
			if (this.is('AT', 1)) {
				this.next();
				this.next();
				return new ast.Column({ columnid: '@' + this.parseLiteral(), tableid: first });
			}
			// After `name.` only a name, VALUE or `@name` can follow: the parser shifted the dot as part of the column.
			this.next();
			return new ast.Column({ columnid: this.parseLiteral(), tableid: first });
		}
		return new ast.Column({ columnid: first });
	}

	// #section: expressions

	private startsExpression(): boolean {
		const type = this.peek().type;
		return EXPRESSION_STARTS.has(type) || this.startsLiteral(SELECT_LIST_FOLLOW);
	}

	parseExpression(minPrecedence = 0): any {
		// Nesting recurses through here, so a parenthesis skips parsePrefix and parsePrimary, whose frames are large.
		let left = this.peek().type === 'LPAR' ? this.parseParenthesized() : this.parsePrefix();
		for (;;) {
			const token = this.peek();
			const type = token.type;
			const precedence = PRECEDENCE[type];
			// COMMA and SHARP have a precedence but no infix rule: one separates list items, the other is prefix only.
			if (precedence === undefined || precedence <= minPrecedence || !INFIX.has(type)) break;
			left = this.parseInfix(left, token, precedence);
		}
		return left;
	}

	private parseInfix(left: any, token: Token, precedence: number): any {
		const type = token.type;
		switch (type) {
			case 'AND': {
				this.next();
				const right = this.parseExpression(precedence);
				return andNode(left, right);
			}
			case 'BETWEEN':
			case 'NOT_BETWEEN': {
				this.next();
				const right = this.parseExpression(precedence);
				return new ast.Op({ left, op: type === 'BETWEEN' ? 'BETWEEN1' : 'NOT BETWEEN1', right });
			}
			case 'IN':
				this.next();
				return this.parseInTail(left, 'IN');
			case 'NOT':
				this.next();
				if (this.accept('IN')) return this.parseInTail(left, 'NOT IN');
				if (this.accept('NULL')) {
					return new ast.Op({
						op: 'IS',
						left,
						right: new ast.UniOp({ op: 'NOT', right: new ast.NullValue({ value: undefined }) }),
					});
				}
				this.fail('IN');
				break;
			case 'LIKE':
			case 'NOT_LIKE': {
				this.next();
				const op = type === 'LIKE' ? 'LIKE' : 'NOT LIKE';
				const right = this.parseExpression(precedence);
				if (this.accept('ESCAPE')) {
					return new ast.Op({ left, op, right, escape: this.parseExpression(precedence) });
				}
				return new ast.Op({ left, op, right });
			}
			case 'DOT':
			case 'ARROW':
			case 'EXCLAMATION': {
				this.next();
				const op = type === 'EXCLAMATION' ? '!' : '->';
				if (this.accept('LPAR')) {
					const right = this.parseExpression();
					this.expect('RPAR');
					return new ast.Op({ left, op, right });
				}
				if (this.is('NUMBER')) return new ast.Op({ left, op, right: this.parseNumValue() });
				if (this.startsLiteral() && this.is('LPAR', 1)) return new ast.Op({ left, op, right: this.parseFuncValue() });
				return new ast.Op({ left, op, right: this.parseLiteral() });
			}
			case 'DOUBLECOLON': {
				this.next();
				return Object.assign(new ast.Convert({ expression: left }), this.parseColumnType());
			}
		}
		const op = BINARY_OPS[type];
		this.next();
		if (COND_OPS.has(type) && ALL_SOME.has(this.peek().type) && this.is('LPAR', 1)) {
			const allsome = this.next().type;
			this.next();
			if (this.is('SELECT')) {
				const select = this.parseSelect();
				this.expect('RPAR');
				const queriesidx = this.recordSubquery(select);
				return new ast.Op({ left, op: token.text, allsome, right: select, queriesidx });
			}
			const right = this.parseExprList();
			this.expect('RPAR');
			return new ast.Op({ left, op: token.text, allsome, right });
		}
		const right = this.parseExpression(precedence);
		return op === 'IS' ? new ast.Op({ op, left, right }) : new ast.Op({ left, op, right });
	}

	/** Records an IN/ANY subquery the way the grammar did: queries gathered so far move into it. */
	private recordSubquery(select: any): number {
		const nested = (this.state.queries ??= []).slice();
		this.state.queries = [];
		if (nested.length > 0) select.queries = nested;
		this.state.queries.push(select);
		return this.state.queries.length - 1;
	}

	private parseInTail(left: any, op: string): any {
		if (this.accept('LPAR')) {
			if (this.accept('RPAR')) return new ast.Op({ left, op, right: [] });
			// Only `IN (SELECT`: `IN ((SELECT ...))` is a list holding a subquery expression.
			if (this.is('SELECT')) {
				const select = this.parseSelect();
				this.expect('RPAR');
				const queriesidx = this.recordSubquery(select);
				return new ast.Op({ left, op, right: select, queriesidx });
			}
			const right = this.parseExprList();
			this.expect('RPAR');
			return new ast.Op({ left, op, right });
		}
		if (this.is('AT')) {
			if (this.is('LPAR', 1)) {
				this.next();
				this.next();
				const right = this.parseExpression();
				this.expect('RPAR');
				return new ast.Op({ left, op, right });
			}
			return new ast.Op({ left, op, right: this.parseVarValue() });
		}
		if (this.startsLiteral() && this.is('LPAR', 1)) return new ast.Op({ left, op, right: this.parseFuncValue() });
		if (this.startsLiteral() || this.is('IF') || this.is('REPLACE') || this.is('INSERTED') || this.is('DELETED')) {
			if (this.is('IF') || this.is('REPLACE')) return new ast.Op({ left, op, right: this.parseFuncValue() });
			return new ast.Op({ left, op, right: this.parseColumn() });
		}
		this.fail('LPAR');
	}

	private parseExprList(): any[] {
		const list = [this.parseExpression()];
		while (this.accept('COMMA')) list.push(this.parseExpression());
		return list;
	}

	private parsePrefix(): any {
		const token = this.peek();
		switch (token.type) {
			case 'NOT':
				this.next();
				return new ast.UniOp({ op: 'NOT', right: this.parseExpression(PRECEDENCE.NOT) });
			case 'MINUS':
				this.next();
				return new ast.UniOp({ op: '-', right: this.parseExpression(PRECEDENCE.MINUS) });
			case 'PLUS':
				this.next();
				return new ast.UniOp({ op: '+', right: this.parseExpression(PRECEDENCE.PLUS) });
			case 'TILDA':
				this.next();
				return new ast.UniOp({ op: '~', right: this.parseExpression(PRECEDENCE.TILDA) });
			case 'SHARP':
				this.next();
				return new ast.UniOp({ op: '#', right: this.parseExpression(PRECEDENCE.SHARP) });
		}
		return this.parsePrimary();
	}

	private parseParenthesized(): any {
		// `((SELECT ...))` is a parenthesized subquery expression, not a parenthesized SELECT.
		if (this.is('SELECT', 1)) {
			this.next();
			const select = this.parseSelect();
			this.expect('RPAR');
			(this.state.queries ??= []).push(select);
			select.queriesidx = this.state.queries.length;
			return select;
		}
		if (this.is('INSERT', 1)) {
			this.next();
			const insert = this.parseInsert();
			this.expect('RPAR');
			(this.state.queries ??= []).push(insert);
			insert.queriesidx = this.state.queries.length;
			return insert;
		}
		this.next();
		const right = this.parseExpression();
		this.expect('RPAR');
		return new ast.UniOp({ right });
	}

	private parsePrimary(): any {
		const token = this.peek();
		switch (token.type) {
			case 'NUMBER':
				return this.parseNumValue();
			case 'STRING':
			case 'DQSTRING':
			case 'NSTRING':
				return this.parseStringValue();
			case 'TRUE':
				this.next();
				return new ast.LogicValue({ value: true });
			case 'FALSE':
				this.next();
				return new ast.LogicValue({ value: false });
			case 'NULL':
				this.next();
				return new ast.NullValue({ value: undefined });
			case 'STAR':
				this.next();
				return new ast.Column({ columnid: '*' });
			case 'VALUE':
				this.next();
				return new ast.DomainValueValue();
			case 'JAVASCRIPT':
				this.next();
				return new ast.JavaScript({ value: token.text.slice(2, -2) });
			case 'CURRENT_TIMESTAMP':
				this.next();
				return new ast.FuncValue({ funcid: 'CURRENT_TIMESTAMP' });
			case 'CURRENT_DATE':
				if (this.is('LPAR', 1) && this.is('RPAR', 2)) {
					this.next();
					this.next();
					this.next();
					return new ast.FuncValue({ funcid: token.text });
				}
				this.next();
				return new ast.FuncValue({ funcid: 'CURRENT_DATE' });
			case 'EXISTS': {
				this.next();
				this.expect('LPAR');
				const select = this.parseSelect();
				this.expect('RPAR');
				const exists = new ast.ExistsValue({ value: select, existsidx: (this.state.exists ??= []).length });
				this.state.exists.push(select);
				return exists;
			}
			case 'CASE':
				return this.parseCase();
			case 'CAST':
			case 'CONVERT':
				return this.parseCast();
			case 'ARRAYLBRA': {
				this.next();
				const value = this.parseExprList();
				this.expect('RBRA');
				return new ast.ArrayValue({ value });
			}
			case 'NEW': {
				this.next();
				if (this.startsLiteral() && this.is('LPAR', 1)) {
					const func = this.parseFuncValue();
					func.newid = true;
					return func;
				}
				return new ast.FuncValue({ funcid: this.parseLiteral(), newid: true });
			}
			case 'AT':
				if (this.is('LPAR', 1) || this.isStringValueToken(1) || this.is('NUMBER', 1) || this.is('TRUE', 1)) {
					return new ast.Json({ value: this.parseJson() });
				}
				if (this.is('FALSE', 1) || this.is('LCUR', 1) || this.is('DOLLAR', 1) || this.is('COLON', 1)) {
					return new ast.Json({ value: this.parseJson() });
				}
				if (this.is('QUESTION', 1) || this.is('BRAQUESTION', 1)) return new ast.Json({ value: this.parseJson() });
				return this.parseVarValue();
			case 'LCUR':
			case 'ATLBRA':
				return new ast.Json({ value: this.parseJson() });
			case 'DOLLAR':
			case 'COLON':
			case 'QUESTION':
			case 'BRAQUESTION':
				return this.tryParamValue() ?? this.fail();
			case 'IF':
				if (this.is('LPAR', 1)) return this.parseFuncValue();
				break;
			case 'REPLACE':
				if (this.is('LPAR', 1)) return this.parseFuncValue();
				break;
			case 'DATEADD':
			case 'DATEDIFF':
			case 'TIMESTAMPDIFF':
				return this.parseDateFunction();
			case 'INTERVAL': {
				this.next();
				const value = this.parseExpression();
				const unit = this.parseLiteral();
				return new ast.FuncValue({
					funcid: 'INTERVAL',
					args: [value, new ast.StringValue({ value: unit.toLowerCase() })],
				});
			}
			case 'GROUP_CONCAT':
				return this.parseGroupConcat();
			case 'INSERTED':
			case 'DELETED':
				if (this.is('DOT', 1) && this.is('STAR', 2)) {
					this.next();
					this.next();
					this.next();
					return new ast.Column({ columnid: '*', tableid: token.type });
				}
				return this.parseColumn();
		}
		if (AGGREGATORS[token.type] && this.is('LPAR', 1)) return this.parseAggregate();
		if (this.startsLiteral(PRIMARY_FOLLOW)) {
			if (this.is('LPAR', 1)) return this.parseFuncValue();
			if (this.is('DOT', 1) && this.is('STAR', 2)) {
				const tableid = this.parseLiteral();
				this.next();
				this.next();
				return new ast.Column({ columnid: '*', tableid });
			}
			return this.parseColumn();
		}
		this.fail();
	}

	private parseNumValue(): any {
		const token = this.expect('NUMBER');
		return new ast.NumValue({ value: +token.text });
	}

	/** A StringValue: quoted text, including `N'...'`. */
	private isStringValueToken(offset = 0): boolean {
		return this.isStringToken(offset) || this.is('NSTRING', offset);
	}

	/** AnyString: single- or double-quoted text (not `N'...'`), where the grammar wants a file name or key. */
	private isStringToken(offset = 0): boolean {
		const type = this.peek(offset).type;
		return type === 'STRING' || type === 'DQSTRING';
	}

	private parseStringValue(): any {
		const token = this.peek();
		if (token.type === 'NSTRING') {
			this.next();
			return new ast.StringValue({ value: unquote(token.text.slice(2, -1)) });
		}
		if (token.type !== 'STRING' && token.type !== 'DQSTRING') this.fail('STRING');
		this.next();
		const value = new ast.StringValue({ value: unquote(token.text.slice(1, -1)) });
		if (token.text[0] === '"') value.doubleQuoted = true;
		return value;
	}

	private parseVarValue(): any {
		this.expect('AT');
		return new ast.VarValue({ variable: this.parseLiteral() });
	}

	private tryParamValue(): any {
		const token = this.peek();
		switch (token.type) {
			case 'DOLLAR': {
				this.next();
				if (this.is('NUMBER')) return new ast.ParamValue({ param: this.next().text });
				return new ast.ParamValue({ param: this.parseLiteral() });
			}
			case 'COLON':
				this.next();
				return new ast.ParamValue({ param: this.parseLiteral() });
			case 'QUESTION':
				this.next();
				this.state.question ??= 0;
				return new ast.ParamValue({ param: this.state.question++ });
			case 'BRAQUESTION':
				this.next();
				this.state.question ??= 0;
				return new ast.ParamValue({ param: this.state.question++, array: true });
		}
		return undefined;
	}

	private parseCase(): any {
		this.expect('CASE');
		let expression;
		if (!this.is('WHEN')) expression = this.parseExpression();
		const whens = [];
		do {
			this.expect('WHEN');
			const when = this.parseExpression();
			this.expect('THEN');
			whens.push({ when, then: this.parseExpression() });
		} while (this.is('WHEN'));
		const elses = this.accept('ELSE') ? this.parseExpression() : undefined;
		this.expect('END');
		return expression === undefined
			? new ast.CaseValue({ whens, elses })
			: new ast.CaseValue({ expression, whens, elses });
	}

	private parseCast(): any {
		const keyword = this.next().type;
		this.expect('LPAR');
		if (keyword === 'CAST') {
			const expression = this.parseExpression();
			this.expect('AS');
			const type = this.parseColumnType();
			let convert;
			if (this.accept('COMMA')) convert = new ast.Convert({ expression, style: this.expect('NUMBER').text });
			else convert = new ast.Convert({ expression });
			this.expect('RPAR');
			return Object.assign(convert, type);
		}
		const type = this.parseColumnType();
		this.expect('COMMA');
		const expression = this.parseExpression();
		let convert;
		if (this.accept('COMMA')) convert = new ast.Convert({ expression, style: this.expect('NUMBER').text });
		else convert = new ast.Convert({ expression });
		this.expect('RPAR');
		return Object.assign(convert, type);
	}

	private parseColumnType(): any {
		let type: any;
		if (this.accept('ENUM')) {
			this.expect('LPAR');
			const enumvalues = this.parseExprList();
			this.expect('RPAR');
			type = { dbtypeid: 'ENUM', enumvalues };
		} else {
			let dbtypeid = this.expect('LITERAL').text;
			while (this.is('LITERAL')) dbtypeid += ' ' + this.next().text;
			if (this.accept('LPAR')) {
				const dbsize = this.is('MAXNUM') ? (this.next(), 'MAX') : +this.expect('NUMBER').text;
				if (this.accept('COMMA')) {
					const dbprecision = +this.expect('NUMBER').text;
					this.expect('RPAR');
					type = { dbtypeid, dbsize, dbprecision };
				} else {
					this.expect('RPAR');
					type = { dbtypeid, dbsize };
				}
			} else {
				type = { dbtypeid };
			}
		}
		if (this.is('BRALITERAL')) type.dbtypeid += '[' + this.next().text + ']';
		return type;
	}

	private parseDateFunction(): any {
		const funcid = this.next().type;
		this.expect('LPAR');
		const part = this.isStringValueToken()
			? this.parseStringValue()
			: new ast.StringValue({ value: this.parseLiteral() });
		this.expect('COMMA');
		const first = this.parseExpression();
		this.expect('COMMA');
		const second = this.parseExpression();
		this.expect('RPAR');
		return new ast.FuncValue({ funcid, args: [part, first, second] });
	}

	private parseGroupConcat(): any {
		this.expect('GROUP_CONCAT');
		this.expect('LPAR');
		const distinct = !!this.accept('DISTINCT');
		const expression = this.parseExpression();
		let order;
		if (this.is('ORDER') && this.is('BY', 1)) {
			this.next();
			this.next();
			order = this.parseOrderExpressionsList();
		}
		let separator;
		if (this.accept('SEPARATOR')) {
			if (!this.isStringToken()) this.fail('STRING');
			const text = this.next().text;
			separator = text
				.substring(1, text.length - 1)
				.replace(/\\n/g, '\n')
				.replace(/\\t/g, '\t')
				.replace(/\\r/g, '\r')
				.replace(/\\\\/g, '\\');
		}
		this.expect('RPAR');
		return distinct
			? new ast.AggrValue({ aggregatorid: 'REDUCE', funcid: 'GROUP_CONCAT', expression, distinct, order, separator })
			: new ast.AggrValue({ aggregatorid: 'REDUCE', funcid: 'GROUP_CONCAT', expression, order, separator });
	}

	private parseAggregate(): any {
		const aggregatorid = AGGREGATORS[this.next().type];
		this.expect('LPAR');
		if (this.accept('DISTINCT')) {
			const expression = this.parseExpression();
			this.expect('RPAR');
			return new ast.AggrValue({ aggregatorid, expression, distinct: true, over: this.parseOverClause() });
		}
		if (this.accept('ALL')) {
			const expression = this.parseExpression();
			this.expect('RPAR');
			return new ast.AggrValue({ aggregatorid, expression, over: this.parseOverClause() });
		}
		const args = this.parseExprList();
		this.expect('RPAR');
		const over = this.parseOverClause();
		if (args.length > 1 && (aggregatorid === 'MAX' || aggregatorid === 'MIN')) {
			return new ast.FuncValue({ funcid: aggregatorid, args });
		}
		return new ast.AggrValue({ aggregatorid, expression: args.pop(), over });
	}

	private parseOverClause(): any {
		if (!this.is('OVER')) return undefined;
		this.next();
		this.expect('LPAR');
		const over = new ast.Over();
		if (this.is('PARTITION')) {
			this.next();
			this.expect('BY');
			over.partition = this.parseGroupExpressionsList();
		}
		if (this.is('ORDER')) {
			this.next();
			this.expect('BY');
			over.order = this.parseOrderExpressionsList();
		}
		this.expect('RPAR');
		return over;
	}

	private parseFuncValue(): any {
		if (this.is('IF') || this.is('REPLACE')) {
			const funcid = this.next().type === 'IF' ? 'IIF' : 'REPLACE';
			this.expect('LPAR');
			const args = this.parseExprList();
			this.expect('RPAR');
			return new ast.FuncValue({ funcid, args });
		}
		const funcid = this.parseLiteral();
		this.expect('LPAR');
		if (this.accept('RPAR')) return new ast.FuncValue({ funcid, over: this.parseOverClause() });
		const quantifier = this.is('DISTINCT') || this.is('ALL') ? this.next().text : undefined;
		const args = this.parseExprList();
		this.expect('RPAR');
		const over = this.parseOverClause();
		const upper = funcid.toUpperCase();
		if (args.length > 1 && (upper === 'MIN' || upper === 'MAX')) return new ast.FuncValue({ funcid, args, over });
		if (isAggregateName(funcid)) {
			return new ast.AggrValue({
				aggregatorid: 'REDUCE',
				funcid,
				expression: args[0],
				args,
				distinct: quantifier === 'DISTINCT',
				over,
			});
		}
		return new ast.FuncValue({ funcid, args, over });
	}

	// #section: JSON literals

	private startsJson(): boolean {
		if (this.is('LCUR') || this.is('ATLBRA')) return true;
		if (!this.is('AT')) return false;
		const after = this.peek(1).type;
		return (
			after === 'LPAR' ||
			after === 'STRING' ||
			after === 'DQSTRING' ||
			after === 'NSTRING' ||
			after === 'NUMBER' ||
			after === 'TRUE' ||
			after === 'FALSE' ||
			after === 'LCUR' ||
			after === 'DOLLAR' ||
			after === 'COLON' ||
			after === 'QUESTION' ||
			after === 'BRAQUESTION'
		);
	}

	private parseJson(): any {
		if (this.is('LCUR')) return this.parseJsonObject();
		if (this.accept('ATLBRA')) return this.parseJsonArray();
		this.expect('AT');
		const type = this.peek().type;
		switch (type) {
			case 'LPAR': {
				this.next();
				const value = this.parseExpression();
				this.expect('RPAR');
				return value;
			}
			case 'STRING':
			case 'DQSTRING':
			case 'NSTRING':
				return this.parseStringValue().value;
			case 'NUMBER':
				return +this.parseNumValue().value;
			case 'TRUE':
			case 'FALSE':
				this.next();
				return type === 'TRUE';
			case 'LCUR':
				return this.parseJsonObject();
		}
		const param = this.tryParamValue();
		if (param) return param;
		this.fail('LCUR');
	}

	private parseJsonObject(): any {
		this.expect('LCUR');
		if (this.accept('RCUR')) return {};
		// The first property's object is the literal, so a `__proto__` key there sets its prototype.
		let object: any;
		for (;;) {
			const property = this.parseJsonProperty();
			if (object === undefined) object = property;
			else Object.assign(object, property);
			if (this.accept('COMMA')) {
				if (this.accept('RCUR')) return object;
				continue;
			}
			this.expect('RCUR');
			return object;
		}
	}

	private parseJsonProperty(): any {
		let key: string;
		if (this.isStringToken()) key = this.next().text.slice(1, -1);
		else if (this.is('NUMBER')) key = this.next().text;
		else key = this.parseLiteral();
		const property: any = {};
		if (this.accept('COLONDASH')) {
			property[key] = -this.parseNumValue().value;
			return property;
		}
		this.expect('COLON');
		property[key] = this.parseJsonValue();
		return property;
	}

	private parseJsonArray(): any[] {
		const array: any[] = [];
		if (this.accept('RBRA')) return array;
		for (;;) {
			array.push(this.parseJsonValue());
			if (this.accept('COMMA')) {
				if (this.accept('RBRA')) return array;
				continue;
			}
			this.expect('RBRA');
			return array;
		}
	}

	private parseJsonValue(): any {
		if (this.startsJson()) return this.parseJson();
		const token = this.peek();
		switch (token.type) {
			case 'NUMBER':
				return +this.parseNumValue().value;
			case 'MINUS':
				this.next();
				return -this.parseNumValue().value;
			case 'STRING':
			case 'DQSTRING':
			case 'NSTRING':
				return '' + this.parseStringValue().value;
			case 'TRUE':
			case 'FALSE':
				this.next();
				return token.type === 'TRUE';
			case 'NULL':
				this.next();
				return undefined;
			case 'LPAR': {
				this.next();
				const value = this.parseExpression();
				this.expect('RPAR');
				return value;
			}
		}
		const param = this.tryParamValue();
		if (param) return param;
		if ((this.startsLiteral() || this.is('IF') || this.is('REPLACE')) && this.is('LPAR', 1))
			return this.parseFuncValue();
		return this.parseColumn();
	}
}

/** `AND`, folding a preceding `BETWEEN1` into the BETWEEN it opened, as the grammar did. */
function andNode(left: any, right: any): any {
	if (left.op === 'BETWEEN1' || left.op === 'NOT BETWEEN1') {
		const op = left.op === 'BETWEEN1' ? 'BETWEEN' : 'NOT BETWEEN';
		if (left.left.op === 'AND') {
			return new ast.Op({
				left: left.left.left,
				op: 'AND',
				right: new ast.Op({ left: left.left.right, op, right1: left.right, right2: right }),
			});
		}
		return new ast.Op({ left: left.left, op, right1: left.right, right2: right });
	}
	return new ast.Op({ left, op: 'AND', right });
}

/** A string literal's value: a backslash-quote and a doubled quote both decode to a quote. */
function unquote(body: string): string {
	return body.replace(/(\\')/g, "'").replace(/('')/g, "'");
}

/** A file name in FROM or INTO names a file-reading function; any other string is not a source. */
function fileFunction(s: string): any {
	const x3 = s.substr(-3).toUpperCase();
	const x4 = s.substr(-4).toUpperCase();
	let funcid;
	if (s[0] === '#') funcid = 'HTML';
	else if (x3 === 'XLS' || x3 === 'CSV' || x3 === 'TAB') funcid = x3;
	else if (x4 === 'XLSX' || x4 === 'JSON') funcid = x4;
	else return undefined;
	return new ast.FuncValue({
		funcid,
		args: [new ast.StringValue({ value: s }), new ast.Json({ value: { headers: true } })],
	});
}

/** The keys of an INSERT, in the order the grammar actions assigned them. */
function reorderInsert(insert: any, flag: any): any {
	if (!flag) return insert;
	const ordered: any = new ast.Insert();
	const order = ['into', 'columns', 'values', 'select', 'ignore', 'orreplace'];
	for (const key of order) if (Object.hasOwn(insert, key)) ordered[key] = insert[key];
	for (const key of Object.keys(insert)) if (!Object.hasOwn(ordered, key)) ordered[key] = insert[key];
	return ordered;
}

const EXPRESSION_STARTS = new Set([
	'NUMBER',
	'STRING',
	'DQSTRING',
	'NSTRING',
	'TRUE',
	'FALSE',
	'NULL',
	'STAR',
	'VALUE',
	'JAVASCRIPT',
	'CURRENT_TIMESTAMP',
	'CURRENT_DATE',
	'EXISTS',
	'CASE',
	'CAST',
	'CONVERT',
	'ARRAYLBRA',
	'NEW',
	'LPAR',
	'AT',
	'LCUR',
	'ATLBRA',
	'DOLLAR',
	'COLON',
	'QUESTION',
	'BRAQUESTION',
	'IF',
	'REPLACE',
	'DATEADD',
	'DATEDIFF',
	'TIMESTAMPDIFF',
	'INTERVAL',
	'GROUP_CONCAT',
	'INSERTED',
	'DELETED',
	'NOT',
	'MINUS',
	'PLUS',
	'TILDA',
	'SHARP',
	'SUM',
	'TOTAL',
	'COUNT',
	'MIN',
	'MAX',
	'AVG',
	'FIRST',
	'LAST',
	'AGGR',
	'ARRAY',
]);

// Non-reserved terminals that continue the statement where they appear, so they are not names there.
const RESULT_COLUMN_FOLLOW = new Set(['ORDER', 'LIMIT', 'GO']);
const FROM_FOLLOW = new Set(['ORDER', 'LIMIT', 'GO', 'LEFT', 'RIGHT']);
const SELECT_LIST_FOLLOW = new Set(['ORDER', 'LIMIT', 'GO']);
// FIRST and LAST start an aggregate in an expression, so there they are never names.
const PRIMARY_FOLLOW = new Set(['FIRST', 'LAST']);

/** Parses SQL text (comments allowed) into its statements. Throws a SqlSyntaxError for invalid SQL. */
export function parse(sql: string): ast.Statements {
	return new Parser(uncomment(sql)).parseStatements();
}
