/**
 * SELECT execution for the in-memory SQL engine, over parameter arrays (`FROM ?`), as legacy SQL runs it.
 *
 * This reproduces AlaSQL 4's query pipeline step for step, because legacy SQL's results are what users see:
 * nested-loop joins (an equality ON joins by the string form of its keys, RIGHT and OUTER joins by `==`), row
 * scopes keyed by alias, groups keyed by the concatenated group values, its aggregate accumulators, the
 * `(value || '')` ORDER BY comparator, DISTINCT by joined values, and LIMIT applied only when non-zero. Maps keyed
 * by row values have no prototype (`valueMap()`), where AlaSQL's did.
 */
import { ClientError } from '../../utility/errors/hdbError.ts';
import * as ast from '../parser/ast.ts';
import {
	compileColumn,
	compileExpression,
	type CompileContext,
	decodeStringLiteral,
	type Env,
	escapeq,
	type Evaluator,
	fromAnySource,
	nanToUndefined,
	unescapeq,
	valueMap,
} from './expression.ts';
import { AGGREGATES, cloneDeep, deepEqual, isInlineFunction, Recordset, setOwn } from './functions.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Statement = ((params: any, cb?: any, oldscope?: any) => any) & { query: any };

const returnTrue = () => true;
const GROUP_STAR = Symbol('group *');
const literal = (name: any) => decodeStringLiteral(String(name), "'");

function prepareFromData(data: any, array?: boolean): any {
	let res = data;
	if (typeof data === 'string') {
		res = data.split(/\r?\n/);
		if (array) res = res.map((item: any) => [item]);
	} else if (array) {
		res = data.map((item: any) => [item]);
	} else if (typeof data === 'object' && !Array.isArray(data)) {
		res = [];
		for (const key in data) {
			if (Object.prototype.hasOwnProperty.call(data, key)) res.push([key, data[key]]);
		}
	}
	return res;
}

// #section: compile

export function compileSelect(select: any): Statement {
	const query: any = {
		removeKeys: [],
		aggrKeys: [],
		modifier: select.modifier,
		selectGroup: [],
		groupColumns: {},
	};

	compileWhereExists(select, query);
	compileQueries(select, query);
	query.defcols = compileDefCols(select);
	compileFrom(select, query);
	if (select.joins) compileJoins(select, query);
	query.rownums = [];
	query.grouprownums = [];
	query.windowaggrs = [];
	if (select.into) throw new ClientError('SELECT INTO is not supported');

	compileSelectGroup0(select, query);
	const grouped = () => select.group || query.selectGroup.length > 0;
	if (grouped()) query.selectgfns = compileSelectGroup1(select, query);
	else query.selectfns = compileSelect1(select, query);
	compileRemoveColumns(select, query);
	compileWhereJoins(select, query);
	query.wherefn = select.where ? compileExpression(select.where, contextP(query)) : returnTrue;
	if (grouped()) query.groupfn = compileGroup(select, query);
	if (select.having) query.havingfn = compileHaving(select, query);
	if (select.order) {
		query.orderfn = compileOrder(select);
		query.orderColumns = select.orderColumns;
	}
	if (grouped()) query.selectgfn = compileSelectGroup2(select, query);
	else query.selectfn = compileSelect2(select, query);

	query.distinct = select.distinct;
	query.distinctOn = !!select.distinctOn;
	if (select.distinctOn && (grouped() || select.union || select.unionall || select.except || select.intersect)) {
		throw new Error('DISTINCT ON is not supported with GROUP BY, aggregates, UNION, INTERSECT or EXCEPT');
	}
	if (select.pivot || select.unpivot) throw new ClientError('PIVOT and UNPIVOT are not supported');
	if (select.top) {
		if (select.top instanceof ast.ParamValue) query.limitParam = select.top.param;
		else query.limit = select.top.value;
	} else if (select.limit) {
		if (select.limit instanceof ast.ParamValue) query.limitParam = select.limit.param;
		else query.limit = select.limit.value;
		if (select.offset) {
			if (select.offset instanceof ast.ParamValue) query.offsetParam = select.offset.param;
			else query.offset = select.offset.value;
		}
	}
	query.percent = select.percent;
	query.corresponding = select.corresponding;
	for (const op of ['union', 'unionall', 'except', 'intersect']) {
		if (!select[op]) continue;
		query[op + 'fn'] = compileSelect(select[op]);
		if (!query.orderfn && select[op].order) query.orderfn = compileOrder(select[op]);
		break;
	}

	const statement = ((params: any, cb?: any, oldscope?: any) => {
		query.params = params;
		if (query.limitParam !== undefined) query.limit = params ? params[query.limitParam] : undefined;
		if (query.offsetParam !== undefined) query.offset = params ? params[query.offsetParam] : undefined;
		const res = runQuery(query, oldscope);
		if (query.rownums.length > 0) {
			for (let i = 0; i < res.length; i++) {
				for (const key of query.rownums) res[i][key] = i + 1;
			}
		}
		applyGroupRowNumbers(query, res);
		applyWindowAggregates(query, res);
		const result = modify(query, res);
		if (cb) cb(result);
		return result;
	}) as Statement;
	statement.query = query;
	return statement;
}

function contextP(query: any): CompileContext {
	return { context: 'p', tableid: query.defaultTableid, defcols: query.defcols };
}

function compileWhereExists(select: any, query: any) {
	if (!select.exists) return;
	query.existsfn = select.exists.map((ex: any) => {
		const nq = compileSelect(ex);
		nq.query.modifier = 'RECORDSET';
		return nq;
	});
}

function compileQueries(select: any, query: any) {
	if (!select.queries) return;
	const isCorrelated = (subquery: any) => {
		if (!subquery.from) return false;
		const tables = new Set();
		for (const f of subquery.from) {
			if (f.tableid) tables.add(f.tableid);
			if (f.as) tables.add(f.as);
		}
		const referencesExternal = (node: any): boolean => {
			if (!node) return false;
			if (node instanceof ast.Column && node.tableid && !tables.has(node.tableid)) return true;
			for (const key of Object.keys(node)) {
				if (node[key] && typeof node[key] === 'object' && referencesExternal(node[key])) return true;
			}
			return false;
		};
		return referencesExternal(subquery.where) || referencesExternal(subquery.columns);
	};
	query.queriesfn = select.queries.map((q: any) => {
		const nq = compileSelect(q);
		nq.query.modifier = 'RECORDSET';
		nq.query.isCorrelated = isCorrelated(q);
		if (q.queries && q.queries.length > 0 && !nq.query.queriesfn) {
			nq.query.queriesfn = q.queries.map((qq: any) => {
				const nnq = compileSelect(qq);
				nnq.query.modifier = 'RECORDSET';
				return nnq;
			});
		}
		return nq;
	});
	const share = (queriesfn: any[]) => {
		for (const nq of queriesfn) {
			if (!nq.query.queriesfn) nq.query.queriesfn = queriesfn;
			else if (nq.query.queriesfn !== queriesfn) share(nq.query.queriesfn);
		}
	};
	share(query.queriesfn);
}

/** A named table does not exist here, as in AlaSQL with no tables created. */
function missingTable(table: any): never {
	if (table.databaseid) throw new TypeError("Cannot read properties of undefined (reading 'tables')");
	throw new Error('Table does not exist: ' + table.tableid);
}

function compileDefCols(select: any): any {
	const defcols: any = { '.': {} };
	for (const fr of select.from ?? []) {
		defcols['.'][fr.as || fr.tableid] = true;
		if (fr instanceof ast.Table) missingTable(fr);
		if (!(fr instanceof ast.ParamValue || fr instanceof ast.Select || fr instanceof ast.Json)) {
			if (!(fr instanceof ast.FuncValue || fr instanceof ast.VarValue || fr.inserted)) {
				throw new Error('Unknown type of FROM clause');
			}
		}
	}
	for (const jn of select.joins ?? []) {
		defcols['.'][jn.as || jn.table.tableid] = true;
		if (jn.table) missingTable(jn.table);
		else if (!jn.select && !jn.param && !jn.func) throw new Error('Unknown type of FROM clause');
	}
	return defcols;
}

function compileFrom(select: any, query: any) {
	query.sources = [];
	query.aliases = {};
	if (!select.from) return;
	for (const tq of select.from) {
		const alias = tq.as || tq.tableid;
		let datafn: (params: any, query: any) => any;
		if (tq instanceof ast.ParamValue) {
			query.aliases[alias] = { type: 'paramvalue' };
			const param = tq.param;
			const array = tq.array;
			datafn = (params) => prepareFromData(params[param], array);
		} else if (tq instanceof ast.Json) {
			query.aliases[alias] = { type: 'json' };
			const value = compileExpression(tq, { context: 'p', tableid: undefined as any });
			const array = tq.array;
			datafn = (params, outer) => prepareFromData(value({ s: {}, params, query: outer }), array);
		} else if (tq instanceof ast.Select) {
			query.aliases[alias] = { type: 'subquery' };
			datafn = subqueryDatafn(tq);
		} else {
			throw new Error('Only parameter, JSON and subquery sources are supported in FROM');
		}
		query.sources.push({
			alias,
			databaseid: 'alasql',
			tableid: tq.tableid,
			joinmode: 'INNER',
			onmiddlefn: returnTrue,
			srcwherefn: returnTrue,
			datafn,
		});
	}
	query.defaultTableid = query.sources[0].alias;
}

function subqueryDatafn(select: any): (params: any, outer: any) => any {
	const subquery = compileSelect(select);
	if (subquery.query.modifier === undefined) subquery.query.modifier = 'RECORDSET';
	return (params, outer) => {
		// Subqueries inside it were recorded on the outer statement, so it shares the outer compiled list.
		if (!subquery.query.queriesfn && outer.queriesfn) subquery.query.queriesfn = outer.queriesfn;
		return subquery(outer.params).data;
	};
}

/** The source aliases an expression reads, decided as AlaSQL did from its generated code's `p['alias']` text. */
function aliasesRead(node: any, query: any, cc: CompileContext): Set<string> {
	const found = new Set<string>();
	// `withDefcols` false below an inlined function, whose arguments were written without the column definitions,
	// so an unqualified column there names only the default source (see compileExpression).
	const visit = (n: any, withDefcols: boolean) => {
		if (n === null || typeof n !== 'object') return;
		if (n instanceof ast.Column) {
			if (n.tableid) found.add(literal(n.tableid));
			else if (!withDefcols) found.add(literal(cc.tableid));
			else {
				const tbid = query.defcols[n.columnid];
				if (tbid && tbid !== '-') found.add(literal(tbid));
				else if (n.columnid !== '_' && Object.keys(query.defcols['.']).length > 1) {
					for (const alias of Object.keys(query.defcols['.'])) found.add(literal(alias));
				} else found.add(literal(cc.tableid));
			}
			return;
		}
		if (n instanceof ast.Select || n instanceof ast.AggrValue) return;
		const inline = n instanceof ast.FuncValue && isInlineFunction(n.funcid);
		for (const key of Object.keys(n)) visit(n[key], withDefcols && !(inline && key === 'args'));
	};
	visit(node, true);
	return found;
}

function compileJoins(select: any, query: any) {
	for (const jn of select.joins) {
		if (jn.joinmode === 'CROSS') jn.joinmode = 'INNER';
		if (jn instanceof ast.Apply) throw new ClientError('APPLY is not supported');
		let datafn: (params: any, outer: any) => any;
		if (jn.select) {
			datafn = subqueryDatafn(jn.select);
			query.aliases[jn.as] = { type: 'subquery' };
		} else if (jn.param) {
			const param = jn.param.param;
			const array = jn.array;
			datafn = (params) => prepareFromData(params[param], array);
			query.aliases[jn.as] = { type: 'paramvalue' };
		} else {
			throw new Error('Only parameter and subquery sources are supported in JOIN');
		}
		const source: any = {
			alias: jn.as,
			joinmode: jn.joinmode,
			onmiddlefn: returnTrue,
			srcwherefn: returnTrue,
			datafn,
		};
		const alias = source.alias;
		if (jn.natural)
			throw new Error('In this version of Alasql NATURAL JOIN works for tables with predefined columns only');
		if (jn.using) {
			const prev = query.sources[query.sources.length - 1];
			const leftAlias = literal(prev.alias || prev.tableid);
			const rightAlias = literal(source.alias || source.tableid);
			const columns = jn.using.map((col: any) => literal(col.columnid));
			const key = (table: string) => (env: Env) => {
				let value: any = env.s[table][columns[0]];
				for (let i = 1; i < columns.length; i++) value = value + '`' + env.s[table][columns[i]];
				return value;
			};
			source.onleftfn = key(leftAlias);
			source.onrightfn = key(rightAlias);
			source.optimization = 'ix';
		} else if (jn.on) {
			const cc = contextP(query);
			if (jn.on instanceof ast.Op && jn.on.op === '=' && !jn.on.allsome) {
				source.optimization = 'ix';
				const ls = aliasesRead(jn.on.left, query, cc);
				const rs = aliasesRead(jn.on.right, query, cc);
				const only = (set: Set<string>) => set.size > 0 && [...set].every((a) => a === alias);
				let lefts: any;
				let rights: any;
				let middlef = false;
				if (ls.has(alias) && !rs.has(alias)) {
					if (only(ls)) rights = jn.on.left;
					else middlef = true;
				} else if (!ls.has(alias) && rs.has(alias)) {
					if (only(rs)) lefts = jn.on.left;
					else middlef = true;
				} else middlef = true;
				if (rs.has(alias) && !ls.has(alias)) {
					if (only(rs)) rights = jn.on.right;
					else middlef = true;
				} else if (!rs.has(alias) && ls.has(alias)) {
					if (only(ls)) lefts = jn.on.right;
					else middlef = true;
				} else middlef = true;
				if (middlef) {
					source.onleftfn = () => undefined;
					source.onrightfn = () => undefined;
					source.onmiddlefn = compileExpression(jn.on, cc);
					source.optimization = 'no';
				} else {
					source.onleftfn = lefts ? compileExpression(lefts, cc) : () => undefined;
					source.onrightfn = rights ? compileExpression(rights, cc) : () => undefined;
				}
			} else {
				source.optimization = 'no';
				source.onmiddlefn = compileExpression(jn.on, cc);
			}
		}
		query.sources.push(source);
	}
}

const columnName = (col: any) => col.as || col.columnid || col.toString();

function compileSelectStar(query: any, aliases: string[]): ((r: any, env: Env) => void)[] {
	const steps: ((r: any, env: Env) => void)[] = [];
	for (const alias of aliases) {
		const table = literal(alias);
		steps.push((r, env) => {
			const w = env.s[table];
			for (const k in w) setOwn(r, k, w[k]);
		});
		query.dirtyColumns = true;
	}
	return steps;
}

function compileSelect1(select: any, query: any) {
	query.columns = [];
	query.xcolumns = {};
	query.selectColumns = {};
	query.dirtyColumns = false;
	const entries: [string, Evaluator][] = [];
	let after: ((r: any, env: Env) => void)[] = [];
	const cc = contextP(query);
	const addColumn = (columnid: any) => {
		const coldef = { columnid };
		query.columns.push(coldef);
		query.xcolumns[coldef.columnid] = coldef;
	};
	for (const col of select.columns) {
		if (col instanceof ast.Column) {
			if (col.columnid === '*') {
				if (col.tableid) after = after.concat(compileSelectStar(query, [col.tableid]));
				else after = after.concat(compileSelectStar(query, Object.keys(query.aliases)));
				continue;
			}
			let tbid = col.tableid;
			if (!tbid) tbid = query.defcols[col.columnid];
			if (!tbid) tbid = query.defaultTableid;
			const key = col.as || col.columnid;
			if (col.columnid !== '_') {
				const needsRuntimeResolution =
					!col.tableid &&
					query.sources.length > 1 &&
					(!query.defcols[col.columnid] || query.defcols[col.columnid] === '-');
				if (needsRuntimeResolution) {
					entries.push([
						key,
						fromAnySource(Object.keys(query.aliases).map(literal), literal(col.columnid), query.defcols['.']),
					]);
				} else {
					const table = literal(tbid);
					const columnid = literal(col.columnid);
					entries.push([key, (env) => env.s[table][columnid]]);
				}
			} else {
				const table = literal(tbid);
				entries.push([key, (env) => env.s[table]]);
			}
			query.selectColumns[escapeq(key)] = true;
			addColumn(key);
		} else if (col instanceof ast.AggrValue) {
			if (!col.as) col.as = escapeq(col.toString());
			if (col.over) {
				query.windowaggrs.push({
					as: col.as,
					aggregatorid: col.aggregatorid,
					expression: col.expression,
					partitionColumns: col.over.partition ? col.over.partition.map((p: any) => p.columnid || p.toString()) : [],
				});
			}
			addColumn(col.as || col.columnid || col.toString());
		} else {
			entries.push([columnName(col), nanToUndefined(compileExpression(col, cc))]);
			query.selectColumns[escapeq(columnName(col))] = true;
			addColumn(columnName(col));
		}
	}
	return { entries, after };
}

function compileSelect2(select: any, query: any): (env: Env) => any {
	const { entries, after } = query.selectfns;
	const orderSteps = orderColumnSteps(select, query, (v: any) => {
		if (v instanceof ast.Column && query.xcolumns[v.columnid]) {
			const key = v.columnid;
			return (r: any) => r[key];
		}
		if (v instanceof ast.ParamValue) {
			return (r: any, env: Env) =>
				query.xcolumns[env.params[v.param]] ? r[env.params[v.param]] : compileExpression(v, contextP(query))(env);
		}
		const evaluate = compileExpression(v, contextP(query));
		return (_r: any, env: Env) => evaluate(env);
	});
	let distinctOn: ((r: any, env: Env) => any) | undefined;
	if (select.distinctOn) {
		const exprs = select.distinctOn.map((e: any) => {
			if (e instanceof ast.Column && query.xcolumns[e.columnid]) return (r: any) => r[e.columnid];
			if (e instanceof ast.NumValue) return (r: any) => r[Object.keys(r)[e.value - 1]];
			const evaluate = compileExpression(e, contextP(query));
			return (_r: any, env: Env) => evaluate(env);
		});
		distinctOn = (r, env) => JSON.stringify(exprs.map((f: any) => f(r, env)));
		query.removeKeys.push('$$distinctOn');
	}
	return (env) => {
		const r: any = {};
		for (const [key, evaluate] of entries) r[key] = evaluate(env);
		for (const step of after) step(r, env);
		for (const [key, value] of orderSteps) r[key] = value(r, env);
		if (distinctOn) r['$$distinctOn'] = distinctOn(r, env);
		return r;
	};
}

/** The `$$$<n>` sort keys a row carries for ORDER BY, removed after sorting. */
function orderColumnSteps(
	select: any,
	query: any,
	stepFor: (v: any) => (r: any, env: Env) => any
): [string, (r: any, env: Env) => any][] {
	const steps: [string, (r: any, env: Env) => any][] = [];
	if (!select.orderColumns || select.orderColumns.length === 0) return steps;
	if (select.union || select.unionall || select.except || select.intersect) return steps;
	select.orderColumns.forEach((v: any, idx: number) => {
		const key = '$$$' + idx;
		if (v._useColumnIndex !== undefined) {
			const index = v.columnIndex;
			steps.push([key, (r: any) => r[Object.keys(r)[index]]]);
		} else {
			steps.push([key, stepFor(v)]);
		}
		query.removeKeys.push(key);
	});
	return steps;
}

function compileSelectGroup0(select: any, query: any) {
	let groupByAliasMap: any = null;
	let selectColumnNames: any = null;
	if (select.group) {
		groupByAliasMap = {};
		select.group.forEach((gp: any, idx: number) => {
			if (gp instanceof ast.Column && gp.columnid && !gp.tableid) groupByAliasMap[gp.columnid] = idx;
		});
		selectColumnNames = {};
		for (const col of select.columns) {
			if (col instanceof ast.Column && col.columnid) selectColumnNames[col.columnid] = true;
		}
	}
	select.columns.forEach((col: any, idx: number) => {
		if (col instanceof ast.Column && col.columnid === '*') {
			query.groupStar = col.tableid || 'default';
			return;
		}
		let colas = col instanceof ast.Column ? escapeq(col.columnid) : escapeq(col.toString(true));
		for (let i = 0; i < idx; i++) {
			if (colas === select.columns[i].nick) {
				colas = select.columns[i].nick + ':' + idx;
				break;
			}
		}
		col.nick = colas;
		if (select.group) {
			const groupIdx = select.group.findIndex((gp: any) => gp.columnid === col.columnid && gp.tableid === col.tableid);
			if (groupIdx > -1) select.group[groupIdx].nick = colas;
			if (col.as && groupByAliasMap && Object.hasOwn(groupByAliasMap, col.as) && !selectColumnNames[col.as]) {
				const groupExpr = cloneDeep(col);
				delete groupExpr.as;
				groupExpr.nick = colas;
				select.group[groupByAliasMap[col.as]] = groupExpr;
			}
		}
		if (col.funcid && (col.funcid.toUpperCase() === 'ROWNUM' || col.funcid.toUpperCase() === 'ROW_NUMBER')) {
			if (col.over && col.over.partition) {
				query.grouprownums.push({
					as: col.as,
					partitionColumns: col.over.partition.map((p: any) => p.columnid || p.toString()),
				});
			} else {
				query.rownums.push(col.as);
			}
		}
		if (col.funcid && col.funcid.toUpperCase() === 'GROUP_ROW_NUMBER') {
			query.grouprownums.push({ as: col.as, columnIndex: 0 });
		}
	});
	for (const col of select.columns) findAggregator(col, query);
	if (select.having) findAggregator(select.having, query);
}

/** Collects the aggregates an expression holds into `query.selectGroup`, as `findAggregator` did. */
function findAggregator(node: any, query: any) {
	if (node instanceof ast.AggrValue) {
		if (node.over) return;
		const existing = query.selectGroup.find((agg: any) => agg.toString() === node.toString());
		if (existing) {
			node.aggrNick = existing.nick;
		} else {
			if (!node.nick) {
				node.nick = escapeq(node.toString()) + ':' + query.selectGroup.length;
				if (!query.removeKeys.includes(node.nick)) query.removeKeys.push(node.nick);
			}
			node.aggrNick = node.nick;
			query.selectGroup.push(node);
		}
		return;
	}
	if (node instanceof ast.Op) {
		if (node.left) findAggregator(node.left, query);
		if (node.op === 'BETWEEN' || node.op === 'NOT BETWEEN') {
			if (node.right1) findAggregator(node.right1, query);
			if (node.right2) findAggregator(node.right2, query);
		}
		if (node.right && !node.allsome) findAggregator(node.right, query);
	} else if (node instanceof ast.UniOp) {
		findAggregator(node.right, query);
	} else if (node instanceof ast.FuncValue) {
		for (const arg of node.args ?? []) findAggregator(arg, query);
	} else if (node instanceof ast.Expression) {
		findAggregator(node.expression, query);
	} else if (node instanceof ast.Convert) {
		findAggregator(node.expression, query);
	} else if (node instanceof ast.CaseValue) {
		// AlaSQL's CaseValue had no findAggregator: aggregates inside CASE are not collected.
	} else if (Array.isArray(node)) {
		for (const item of node) findAggregator(item, query);
	}
}

function compileSelectGroup1(select: any, query: any) {
	const entries: [string | typeof GROUP_STAR, Evaluator | null][] = [];
	for (const col of select.columns) {
		if (col instanceof ast.Column && col.columnid === '*') {
			entries.push([GROUP_STAR, null]);
			continue;
		}
		let colas = col.as;
		if (colas === undefined) colas = col instanceof ast.Column ? escapeq(col.columnid) : col.nick;
		query.groupColumns[colas] = col.nick;
		const key = unescapeq(colas);
		if (col instanceof ast.Column) {
			const inner = compileColumn(col, { context: 'p', tableid: query.defaultTableid });
			entries.push([
				key,
				nanToUndefined((env) =>
					inner({ s: env.query.groupSources.get(env.s) || env.s, params: env.params, query: env.query })
				),
			]);
		} else {
			entries.push([key, nanToUndefined(compileExpression(col, { context: 'g', tableid: '' as any }))]);
		}
		const removeAt = query.removeKeys.indexOf(colas);
		if (removeAt >= 0) query.removeKeys.splice(removeAt, 1);
	}
	return { entries };
}

function compileSelectGroup2(select: any, query: any): (env: Env) => any {
	const { entries } = query.selectgfns;
	const hasOrderColumns =
		select.orderColumns &&
		select.orderColumns.length > 0 &&
		!select.union &&
		!select.unionall &&
		!select.except &&
		!select.intersect;
	const needsOrderColumnMaps = hasOrderColumns && select.orderColumns.some((col: any) => col instanceof ast.Column);
	const groupColMap: any = {};
	const groupProjectedColumnMap: any = {};
	const projectedSelectColumnMap: any = {};
	if (select.group) {
		for (const gp of select.group) groupColMap[(gp.tableid || '') + '\t' + gp.columnid] = gp;
		if (needsOrderColumnMaps) {
			for (const col of select.columns) {
				if (!(col instanceof ast.Column)) continue;
				const key = (col.tableid || '') + '\t' + col.columnid;
				if (!groupColMap[key]) continue;
				if (!col.as) groupProjectedColumnMap[key] = col.columnid;
				else if (!groupProjectedColumnMap[key]) groupProjectedColumnMap[key] = col.as;
			}
		}
	}
	if (needsOrderColumnMaps) {
		for (const col of select.columns) {
			if (col instanceof ast.Column && col.columnid === '*') continue;
			const projectedKey = col.as || (col instanceof ast.Column ? col.columnid : col.nick);
			if (projectedKey) projectedSelectColumnMap[projectedKey] = true;
		}
	}
	const groupOverrides: [string, string][] = [];
	for (const col of select.columns) {
		if (col instanceof ast.Column && col.columnid === '*') continue;
		let groupCol = null;
		if (col instanceof ast.Column && select.group) groupCol = groupColMap[(col.tableid || '') + '\t' + col.columnid];
		const isInGroup = (groupCol !== null && groupCol !== undefined) || query.ingroup.indexOf(col.nick) > -1;
		if (isInGroup) {
			const groupNick = (groupCol && groupCol.nick) || col.nick;
			groupOverrides.push([unescapeq(col.as || col.nick), unescapeq(groupNick)]);
		}
	}
	const orderSteps = hasOrderColumns
		? orderColumnSteps(select, query, (v: any) => {
				const groupKey = (v.tableid || '') + '\t' + v.columnid;
				if (v instanceof ast.Column && groupProjectedColumnMap[groupKey]) {
					const key = unescapeq(groupProjectedColumnMap[groupKey]);
					return (r: any) => r[key];
				}
				if (v instanceof ast.Column && projectedSelectColumnMap[v.columnid]) {
					const key = unescapeq(v.columnid);
					return (r: any) => r[key];
				}
				if (v instanceof ast.Column && groupColMap[groupKey]) {
					const nick = unescapeq(groupColMap[groupKey].nick);
					return (_r: any, env: Env) => env.s[nick];
				}
				const evaluate = compileExpression(v, { context: 'g', tableid: '' as any });
				return (_r: any, env: Env) => evaluate(env);
			})
		: [];
	return (env) => {
		const r: any = {};
		for (const [key, evaluate] of entries) {
			if (key === GROUP_STAR) {
				for (const k in env.s) setOwn(r, k, env.s[k]);
			} else {
				r[key] = evaluate!(env);
			}
		}
		for (const [key, nick] of groupOverrides) r[key] = env.s[nick];
		for (const [key, value] of orderSteps) r[key] = value(r, env);
		return r;
	};
}

function compileRemoveColumns(select: any, query: any) {
	if (select.removecolumns === undefined) return;
	query.removeKeys = query.removeKeys.concat(
		select.removecolumns.filter((column: any) => column.like === undefined).map((column: any) => column.columnid)
	);
	query.removeLikeKeys = select.removecolumns
		.filter((column: any) => column.like !== undefined)
		.map((column: any) => column.like.value);
}

// #section: GROUP BY

function groupingSets(select: any, query: any): [string, Evaluator][][] {
	if (!select.group) return [[]];
	return decartes(select.group, query).map((set: GroupEntry[]) => set.map(({ nick, evaluate }) => [nick, evaluate]));
}

// A group column of one grouping set. Not an array, so `concat` appends it, as AlaSQL's `nick\tcode` strings were.
interface GroupEntry {
	nick: string;
	evaluate: Evaluator;
}

function groupContext(query: any): CompileContext {
	return { context: 'p', tableid: query.sources[0]?.alias, defcols: query.defcols };
}

/** AlaSQL's `decartes`: a GROUP BY list becomes its grouping sets; a single item, its group columns. */
function decartes(gv: any, query: any): any[] {
	const cc = groupContext(query);
	if (Array.isArray(gv)) {
		let res: any[] = [[]];
		for (const item of gv) {
			if (item instanceof ast.Column) {
				item.nick = item.nick ? escapeq(item.nick) : escapeq(item.columnid);
				query.groupColumns[item.nick] = item.nick;
				const entry: GroupEntry = { nick: item.nick, evaluate: compileExpression(item, cc) };
				res = res.map((r) => r.concat(entry));
			} else if (item instanceof ast.FuncValue) {
				const nick = escapeq(item.toString());
				query.groupColumns[nick] = nick;
				const entry: GroupEntry = { nick, evaluate: compileExpression(item, cc) };
				res = res.map((r) => r.concat(entry));
			} else if (item instanceof ast.GroupExpression) {
				if (item.type == 'ROLLUP') res = cartes(res, rollup(item.group, query));
				else if (item.type == 'CUBE') res = cartes(res, cube(item.group, query));
				else if (item.type == 'GROUPING SETS') res = cartes(res, groupingSetsOf(item.group, query));
				else throw new Error('Unknown grouping function');
			} else if (item === '') {
				res = [[{ nick: '1', evaluate: () => 1 }]];
			} else {
				const entry: GroupEntry = { nick: escapeq(item.toString()), evaluate: compileExpression(item, cc) };
				res = res.map((r) => r.concat(entry));
			}
		}
		return res;
	}
	if (gv instanceof ast.FuncValue) {
		query.groupColumns[escapeq(gv.toString())] = escapeq(gv.toString());
		return [{ nick: gv.toString(), evaluate: compileExpression(gv, cc) }];
	}
	if (gv instanceof ast.Column) {
		gv.nick = escapeq(gv.columnid);
		query.groupColumns[gv.nick] = gv.nick;
		return [{ nick: gv.nick, evaluate: compileExpression(gv, cc) }];
	}
	query.groupColumns[escapeq(gv.toString())] = escapeq(gv.toString());
	return [{ nick: escapeq(gv.toString()), evaluate: compileExpression(gv, cc) }];
}

/** ROLLUP(a, b): the sets (), (a), (a, b), in that order. */
function rollup(items: any[], query: any): GroupEntry[][] {
	const cc = groupContext(query);
	const entries = items.map((item): GroupEntry => {
		if (item instanceof ast.Column) {
			item.nick = escapeq(item.columnid);
			query.groupColumns[escapeq(item.columnid)] = item.nick;
			return { nick: item.nick, evaluate: compileExpression(item, cc) };
		}
		query.groupColumns[escapeq(item.toString())] = escapeq(item.toString());
		return { nick: escapeq(item.toString()), evaluate: compileExpression(item, cc) };
	});
	const sets: GroupEntry[][] = [];
	for (let size = 0; size <= entries.length; size++) sets.push(entries.slice(0, size));
	return sets;
}

/** CUBE(a, b): every subset, ordered by the bits of its index (a is bit 0). */
function cube(items: any[], query: any): any[][] {
	const sets: any[][] = [];
	for (let mask = 0; mask < 1 << items.length; mask++) {
		let set: any[] = [];
		for (let i = 0; i < items.length; i++) if (mask & (1 << i)) set = set.concat(decartes(items[i], query));
		sets.push(set);
	}
	return sets;
}

function groupingSetsOf(items: any[], query: any): any[] {
	return items.reduce((acc: any[], item: any) => acc.concat(decartes(item, query)), []);
}

function cartes(left: any[], right: any[]): any[] {
	const res = [];
	for (const a of left) for (const b of right) res.push(a.concat(b));
	return res;
}

type Init = (g: any, env: Env) => void;
type Update = (g: any, env: Env) => void;

function compileGroup(select: any, query: any): (env: Env) => void {
	const cc: CompileContext = { context: 'p', tableid: query.sources[0]?.alias ?? '', defcols: query.defcols };
	const allgroup = groupingSets(select, query);
	const allgroups: string[] = [];
	for (const set of allgroup) for (const [nick] of set) if (!allgroups.includes(nick)) allgroups.push(nick);
	query.allgroups = allgroups;
	query.ingroup = [];

	const reduceStart = query.aggrKeys.length;
	const aggregates = query.selectGroup.map((col: any) => compileAggregate(col, query, cc));
	// AlaSQL recorded a named aggregate once per grouping set, so it was finished once per set.
	const reduced = query.aggrKeys.slice(reduceStart);
	for (let i = 1; i < allgroup.length; i++) query.aggrKeys.push(...reduced);
	const sets = allgroup.map((agroup, setIdx) => {
		const keyParts: Evaluator[] = [];
		for (const [nick, evaluate] of agroup) {
			query.ingroup.push(nick);
			keyParts.push(evaluate!);
		}
		const prefix = allgroup.length > 1 ? `${setIdx}\`` : undefined;
		const key =
			keyParts.length === 0
				? () => ''
				: (env: Env) => {
						let value: any = keyParts[0](env);
						for (let i = 1; i < keyParts.length; i++) value = value + '`' + keyParts[i](env);
						return prefix === undefined ? value : prefix + value;
					};
		const columns = agroup;
		const nulls = allgroups.filter((nick) => !agroup.some(([n]) => n === nick));
		return { key, columns, nulls };
	});
	const groupStar = query.groupStar === undefined ? undefined : literal(query.groupStar);

	const setCount = sets.length;
	const aggregateCount = aggregates.length;
	const inits = aggregates.map((a: any) => a.init);
	const updates = aggregates.map((a: any) => a.update);
	const afters = aggregates.map((a: any) => a.after).filter(Boolean);
	const setKeys = sets.map((set) => set.key);
	const setColumns = sets.map((set) => set.columns.map(([nick, evaluate]) => [unescapeq(nick), evaluate] as const));
	const setNulls = sets.map((set) => set.nulls.map(unescapeq));
	return (env) => {
		for (let i = 0; i < setCount; i++) {
			const k = setKeys[i](env);
			let g = query.xgroups[k];
			if (!g) {
				g = {};
				for (const [nick, evaluate] of setColumns[i]) g[nick] = evaluate(env);
				for (const nick of setNulls[i]) g[nick] = null;
				for (let a = 0; a < aggregateCount; a++) inits[a](g, env);
				query.xgroups[k] = g;
				for (const after of afters) after(g, env);
				query.groups.push(g);
				query.groupSources.set(g, Object.assign({}, env.s));
				if (groupStar !== undefined) {
					const row = env.s[groupStar];
					for (const f in row) setOwn(g, f, row[f]);
				}
			} else {
				for (let a = 0; a < aggregateCount; a++) updates[a](g, env);
			}
		}
	};
}

/** First-row value, and the update for each later row, of one aggregate, as `compileGroup` generated them. */
function compileAggregate(col: any, query: any, cc: CompileContext): { init: Init; update: Update; after?: Init } {
	const colas = unescapeq(col.nick);
	const value = compileExpression(col.expression, cc);
	const hasFuncid = 'funcid' in col.expression;
	// The first argument of the function an aggregate wraps, which some aggregates' type checks read instead. Compiled
	// only by those, as AlaSQL read `args[0]` only there: COUNT(CURRENT_TIMESTAMP), whose call has no `args`, runs.
	let firstArg: Evaluator | undefined;
	const first = () => (firstArg ??= hasFuncid ? compileExpression(col.expression.args[0], cc) : value);
	let afterInit: Init | undefined;
	const distinctKey = '$$_VALUES_' + colas;
	if (col.distinct) {
		afterInit = (g, env) => {
			g[distinctKey] = valueMap();
			g[distinctKey][value(env)] = true;
		};
	}
	const wrap = (update: Update): Update => {
		if (!col.distinct) return update;
		return (g, env) => {
			const v = value(env);
			if (typeof v != 'undefined' && !g[distinctKey][v]) {
				update(g, env);
				g[distinctKey][value(env)] = true;
			}
		};
	};
	const chain = (a: Init | undefined, b: Init | undefined): Init | undefined =>
		a && b ? (g, env) => (a(g, env), b(g, env)) : a || b;

	switch (col.aggregatorid) {
		case 'SUM':
			return {
				init: (g, env) => {
					const y = value(env);
					g[colas] = y instanceof Date ? undefined : y || typeof y == 'number' ? y : undefined;
				},
				update: wrap(hasFuncid ? sumUpdateFunc(colas, value, first()) : sumUpdate(colas, value)),
				after: afterInit,
			};
		case 'TOTAL': {
			const operand = hasFuncid ? first() : value;
			return {
				init: (g, env) => {
					const v = operand(env);
					g[colas] =
						v || typeof v == 'number'
							? v
							: v == 'string' && typeof Number(v) == 'number'
								? Number(v)
								: typeof v == 'boolean'
									? Number(v)
									: 0;
				},
				update: wrap(totalUpdate(colas, operand)),
				after: afterInit,
			};
		}
		case 'FIRST':
			return {
				init: (g, env) => (g[colas] = value(env)),
				// FIRST generated no update at all, so DISTINCT did not mark later values seen.
				update: () => {},
				after: afterInit,
			};
		case 'LAST':
			return {
				init: (g, env) => (g[colas] = value(env)),
				update: wrap((g, env) => (g[colas] = value(env))),
				after: afterInit,
			};
		case 'MIN':
		case 'MAX': {
			const greater = col.aggregatorid === 'MAX';
			return {
				init: (g, env) => {
					const y = value(env);
					g[colas] =
						y !== null &&
						(typeof y == 'number' ||
							typeof y == 'bigint' ||
							(typeof y == 'object' && (typeof Number(y) == 'number' || y instanceof Date)))
							? y
							: undefined;
				},
				update: wrap(minMaxUpdate(colas, value, hasFuncid ? first() : value, greater)),
				after: afterInit,
			};
		}
		case 'ARRAY':
			return {
				init: (g, env) => (g[colas] = [value(env)]),
				update: wrap((g, env) => g[colas].push(value(env))),
				after: afterInit,
			};
		case 'COUNT': {
			if (col.expression.columnid === '*') {
				return {
					init: (g) => (g[colas] = 1),
					update: wrap((g) => g[colas]++),
					after: afterInit,
				};
			}
			return {
				init: (g, env) => {
					const v = value(env);
					g[colas] = typeof v == 'undefined' || v === null ? 0 : 1;
				},
				update: wrap((g, env) => {
					const v = value(env);
					if (typeof v != 'undefined' && v !== null) g[colas]++;
				}),
				after: afterInit,
			};
		}
		case 'AVG': {
			const sumKey = '_SUM_' + colas;
			const countKey = '_COUNT_' + colas;
			query.removeKeys.push(`_SUM_${col.nick}`);
			query.removeKeys.push(`_COUNT_${col.nick}`);
			return {
				init: (g, env) => {
					const t = value(env);
					g[colas] = t instanceof Date ? undefined : t;
					g[sumKey] = t instanceof Date ? undefined : t || 0;
					g[countKey] = typeof t == 'undefined' || t === null ? 0 : 1;
				},
				update: wrap((g, env) => {
					const y = value(env);
					g[countKey] += typeof y == 'undefined' || y === null ? 0 : 1;
					if (y instanceof Date || (g[sumKey] && g[sumKey] instanceof Date)) {
						g[sumKey] = undefined;
						g[colas] = undefined;
					} else if (typeof g[sumKey] === 'bigint' || typeof y === 'bigint') {
						g[sumKey] = BigInt(g[sumKey]);
						g[sumKey] += BigInt(y || 0);
						g[colas] = BigInt(g[sumKey]) / BigInt(g[countKey]);
					} else {
						g[sumKey] += y || 0;
						g[colas] = g[sumKey] / g[countKey];
					}
				}),
				after: afterInit,
			};
		}
		case 'AGGR': {
			const overGroup = compileExpression(col.expression, { context: 'g', tableid: -1 });
			const set: Init = (g, env) => (g[colas] = overGroup({ s: g, params: env.params, query: env.query }));
			return { init: () => {}, update: wrap(set), after: chain(afterInit, set) };
		}
		case 'REDUCE': {
			query.aggrKeys.push(col);
			const aggregate = AGGREGATES[col.funcid];
			const groupConcat = col.funcid && col.funcid.toUpperCase() === 'GROUP_CONCAT';
			const extra: any[] = groupConcat
				? [
						col.separator,
						col.order && col.order.length > 0 && col.order[0].direction ? col.order[0].direction : undefined,
					]
				: [];
			const args: Evaluator[] =
				col.args && col.args.length > 1 ? col.args.map((arg: any) => compileExpression(arg, cc)) : [value];
			const only = args.length === 1 && extra.length === 0 ? args[0] : undefined;
			const call = (env: Env, accumulator: any, stage: number) => {
				if (!aggregate) throw new TypeError(`alasql.aggr.${col.funcid} is not a function`);
				if (only) return aggregate(only(env), accumulator, stage);
				return aggregate(...args.map((arg) => arg(env)), accumulator, stage, ...extra);
			};
			return {
				init: (g, env) => (g[colas] = call(env, undefined, 1)),
				update: wrap((g, env) => (g[colas] = call(env, g[colas], 2))),
				after: afterInit,
			};
		}
	}
	return { init: () => {}, update: wrap(() => {}), after: afterInit };
}

function sumUpdate(colas: string, value: Evaluator): Update {
	return (g, env) => {
		const gv = g[colas];
		const v = value(env);
		const tv = typeof v;
		if (gv == null && v == null) g[colas] = undefined;
		else if (typeof gv === 'bigint' || typeof v === 'bigint') g[colas] = BigInt(gv) + BigInt(v);
		else if (
			(typeof gv !== 'object' && typeof gv !== 'number' && tv !== 'object' && tv !== 'number') ||
			((gv == null || (typeof gv !== 'number' && typeof gv !== 'object')) &&
				(v == null || (tv !== 'number' && tv !== 'object')))
		)
			g[colas] = undefined;
		else if (typeof gv !== 'object' && typeof gv !== 'number' && tv == 'number') g[colas] = v;
		else if (typeof gv == 'number' && v == null) g[colas] = gv;
		else if (gv == null && tv == 'number') g[colas] = v;
		else if (gv instanceof Date || v instanceof Date) g[colas] = undefined;
		else g[colas] += v || 0;
	};
}

/** SUM over a function call: its type checks read the call's first argument; a bigint there throws. */
function sumUpdateFunc(colas: string, value: Evaluator, first: Evaluator): Update {
	return (g, env) => {
		const gv = g[colas];
		const v1 = first(env);
		const t1 = typeof v1;
		if (gv == null && v1 == null) g[colas] = undefined;
		else if (typeof gv === 'bigint' || t1 === 'bigint') throw new ReferenceError('__colexp is not defined');
		else if (
			(typeof gv !== 'object' && typeof gv !== 'number' && t1 !== 'object' && t1 !== 'number') ||
			((gv == null || (typeof gv !== 'number' && typeof gv !== 'object')) &&
				(v1 == null || (t1 !== 'number' && t1 !== 'object')))
		)
			g[colas] = undefined;
		else if ((typeof gv !== 'object' && typeof gv !== 'number' && t1 == 'number') || (gv == null && t1 == 'number'))
			g[colas] = value(env);
		else if (typeof gv == 'number' && v1 == null) g[colas] = gv;
		else if (gv instanceof Date || v1 instanceof Date) g[colas] = undefined;
		else g[colas] += value(env) || 0;
	};
}

function totalUpdate(colas: string, value: Evaluator): Update {
	return (g, env) => {
		const gv = g[colas];
		const v = value(env);
		const tg = typeof gv;
		const tv = typeof v;
		if (
			tg === 'string' &&
			!isNaN(gv) &&
			typeof Number(gv) === 'number' &&
			tv === 'string' &&
			!isNaN(v as any) &&
			typeof Number(v) === 'number'
		)
			g[colas] = Number(gv) + Number(v);
		else if (tg === 'bigint' || tv === 'bigint') g[colas] = BigInt(gv || 0) + BigInt(v || 0);
		else if (tg === 'string' && tv === 'string') g[colas] = 0;
		else if (tg === 'string' && tv === 'number') g[colas] = v;
		else if (tv === 'string' && tg === 'number') g[colas] = gv;
		else g[colas] += v || 0;
	};
}

function minMaxUpdate(colas: string, value: Evaluator, check: Evaluator, greater: boolean): Update {
	return (g, env) => {
		let y: any;
		const gv = g[colas];
		const c = check(env);
		let pass;
		if (gv == null && c !== null) pass = y = value(env);
		else if (gv !== null && c == null) pass = y = gv;
		else {
			y = value(env);
			pass = greater ? y > g[colas] : y < g[colas];
		}
		if (pass) {
			if (typeof y == 'number' || typeof y == 'bigint') g[colas] = y;
			else if (typeof y == 'object' && y instanceof Date) g[colas] = y;
			else if (typeof y == 'object' && typeof Number(y) == 'number') g[colas] = Number(y);
		} else if (g[colas] !== null && typeof g[colas] == 'object' && y instanceof Date) {
			// A Date accumulator stays a Date; the branch below would turn it into a number.
		} else if (g[colas] !== null && typeof g[colas] == 'object') {
			g[colas] = Number(g[colas]);
		}
	};
}

// #section: HAVING, ORDER BY

function resolveHavingAliases(node: any, query: any) {
	if (!node || typeof node !== 'object') return;
	if (node instanceof ast.Select || node instanceof ast.AggrValue) return;
	if (node instanceof ast.Column) {
		const nick = query.groupColumns[node.columnid];
		if (
			!node.tableid &&
			nick !== undefined &&
			nick !== node.columnid &&
			!(query.defcols && query.defcols[node.columnid])
		) {
			node.nick = nick;
		}
		return;
	}
	for (const key in node) resolveHavingAliases(node[key], query);
}

function compileHaving(select: any, query: any): Evaluator {
	resolveHavingAliases(select.having, query);
	return compileExpression(select.having, { context: 'g', tableid: -1 });
}

function compileOrder(select: any): (a: any, b: any) => number {
	select.orderColumns = [];
	const keys: { key: string; direction: string; nocase: boolean; nullsOrder?: string; valueOf: boolean }[] = [];
	select.order.forEach((ord: any, idx: number) => {
		let v;
		if (ord.expression instanceof ast.NumValue) {
			if (ord.expression.value < 1) {
				throw new Error(`Invalid column number ${ord.expression.value}. Column numbers must be at least 1.`);
			}
			v = select.columns[ord.expression.value - 1];
			const hasWildcard =
				select.columns.length === 1 && select.columns[0] instanceof ast.Column && select.columns[0].columnid === '*';
			if (hasWildcard) {
				v = { _useColumnIndex: true, columnIndex: ord.expression.value - 1 };
			} else {
				if (ord.expression.value > select.columns.length) {
					throw new Error(
						`You are trying to order by column number ${ord.expression.value} but you have only selected ${select.columns.length} columns.`
					);
				}
				if (v instanceof ast.Column && v.columnid === '*')
					v = { _useColumnIndex: true, columnIndex: ord.expression.value - 1 };
			}
		} else if (ord.expression instanceof ast.StringValue) {
			v = new ast.Column({ columnid: ord.expression.value });
		} else {
			v = ord.expression;
		}
		select.orderColumns.push(v);
		// AlaSQL's `valueof` option (on by default) compared a named sort key by its valueOf(), so equal Dates tie.
		const named =
			ord.expression instanceof ast.Column
				? ord.expression.columnid
				: ord.expression instanceof ast.StringValue
					? ord.expression.value
					: ord.expression instanceof ast.ParamValue;
		keys.push({
			key: '$$$' + idx,
			direction: ord.direction,
			nocase: !!ord.nocase,
			nullsOrder: ord.nullsOrder,
			valueOf: !!named,
		});
	});
	const count = keys.length;
	const keyNames = keys.map((k) => k.key);
	const ascending = keys.map((k) => k.direction == 'ASC');
	const nocase = keys.map((k) => k.nocase);
	const nullsOrder = keys.map((k) => k.nullsOrder);
	const valueOf = keys.map((k) => k.valueOf);
	return (a, b) => {
		for (let i = 0; i < count; i++) {
			const key = keyNames[i];
			if (nullsOrder[i]) {
				if (nullsOrder[i] === 'FIRST' && a[key] != null && b[key] == null) return 1;
				if (nullsOrder[i] === 'LAST' && a[key] == null && b[key] != null) return 1;
				if ((a[key] == null) !== (b[key] == null)) return -1;
			}
			let va = a[key] || '';
			let vb = b[key] || '';
			if (valueOf[i]) {
				va = va.valueOf();
				vb = vb.valueOf();
			}
			if (nocase[i]) {
				if (typeof va == 'string') va = va.toUpperCase();
				if (typeof vb == 'string') vb = vb.toUpperCase();
			}
			if (ascending[i] ? va > vb : va < vb) return 1;
			// eslint-disable-next-line eqeqeq
			if (va == vb) continue;
			return -1;
		}
		return 0;
	};
}

// #section: run

function runQuery(query: any, oldscope: any): any[] {
	query.subqueryCache = valueMap();
	if (query.queriesfn) {
		query.queriesdata = [];
		for (const q of query.queriesfn) q.query.params = query.params;
	}
	query.scope = oldscope ? cloneDeep(oldscope) : {};
	for (const source of query.sources) source.data = source.datafn(query.params, query);
	query.groupSources = new WeakMap();

	preIndex(query);
	query.data = [];
	query.xgroups = valueMap();
	query.groups = [];
	if (query.joinsorted) {
		query.joinrows = [];
		query.joinat = [];
		for (const source of query.sources) {
			if (source.optimization != 'ix') continue;
			source.rowat = new Map();
			source.data.forEach((row: any, i: number) => {
				if (!source.rowat.has(row)) source.rowat.set(row, i);
			});
		}
	}
	const env: Env = { s: query.scope, params: query.params, query };
	doJoin(query, env, 0);
	if (query.joinsorted) emitJoinRows(query);

	if (query.groupfn) {
		query.data = [];
		if (query.groups.length === 0 && query.allgroups.length === 0) {
			// Keyed by the escaped nick, as a plain value: an aggregate whose text holds a quote or backslash
			// reads its own (raw) key and finds nothing.
			const g: any = {};
			for (const sg of query.selectGroup) {
				g[sg.nick] =
					sg.aggregatorid == 'COUNT' || sg.aggregatorid == 'SUM' || sg.aggregatorid == 'TOTAL' ? 0 : undefined;
			}
			query.groups = [g];
		}
		for (const g of query.groups) {
			for (const col of query.aggrKeys) {
				const aggregate = AGGREGATES[col.funcid];
				if (!aggregate) throw new TypeError(`alasql.aggr[${JSON.stringify(col.funcid)}] is not a function`);
				const undefinedArgs = new Array(col.args && col.args.length > 1 ? col.args.length : 1).fill(undefined);
				// The escaped nick again (`JSON.stringify(col.nick)`): with a quote or backslash in the aggregate's
				// text, the accumulator under the raw key is never finalized.
				g[col.nick] = aggregate(...undefinedArgs, g[col.nick], 3);
			}
			const groupEnv: Env = { s: g, params: query.params, query };
			if (!query.havingfn || query.havingfn(groupEnv)) {
				const d = query.selectgfn(groupEnv);
				for (const key in query.groupColumns) {
					const target = query.groupColumns[key];
					if (target !== key && d[target] && !query.groupColumns[target]) {
						let otherAliasExists = false;
						for (const otherKey in query.groupColumns) {
							if (otherKey !== key && query.groupColumns[otherKey] === target && d[otherKey]) {
								otherAliasExists = true;
								break;
							}
						}
						if (!otherAliasExists) delete d[target];
					}
				}
				query.data.push(d);
			}
		}
	}

	doDistinct(query);
	let orderApplied = false;
	let limitApplied = false;
	const setOps = ['unionallfn', 'unionfn', 'exceptfn', 'intersectfn'];
	const branchHasOrder = setOps.some(
		(name) => query[name]?.query && (query[name].query.orderfn || query[name].query.limit)
	);
	if (branchHasOrder && (query.orderfn || query.limit)) {
		if (query.orderfn) {
			addSetOrderColumns(query);
			query.data = query.data.sort(query.orderfn);
			if (query.orderColumns) {
				for (const row of query.data) for (let idx = 0; idx < query.orderColumns.length; idx++) delete row['$$$' + idx];
			}
			orderApplied = true;
		}
		if (query.limit) {
			doLimit(query);
			limitApplied = true;
		}
	}
	combineSetOperation(query);
	if (query.orderfn && !orderApplied && query.orderColumns && setOps.some((name) => query[name]))
		addSetOrderColumns(query);
	if (query.orderfn && !orderApplied) query.data = query.data.sort(query.orderfn);
	if (query.distinctOn) {
		const seen = new Set();
		query.data = query.data.filter((r: any) => {
			if (seen.has(r['$$distinctOn'])) return false;
			seen.add(r['$$distinctOn']);
			return true;
		});
	}
	if (!limitApplied) doLimit(query);
	if (query.removeKeys.length > 0) {
		const removeKeys = query.removeKeys;
		for (const row of query.data) for (const key of removeKeys) delete row[key];
		if (query.columns && query.columns.length > 0) {
			query.columns = query.columns.filter((column: any) => !removeKeys.some((key: any) => column.columnid == key)); // eslint-disable-line eqeqeq
		}
	}
	if (query.removeLikeKeys !== undefined && query.removeLikeKeys.length > 0) {
		throw new ClientError('REMOVE COLUMNS LIKE is not supported');
	}
	return query.data;
}

// #section: comma joins

/**
 * AlaSQL's `compileWhereJoins`, for sources joined without an equality ON (`FROM ?, ?`, CROSS JOIN, a non-equality
 * ON): a WHERE equality between a source and one before it becomes that source's index lookup, and an equality
 * between a source and a constant filters the source before the join. Each is a conjunct of the WHERE, which still
 * runs on every combination, so they only skip combinations it rejects. When FROM order leaves a source unlinked,
 * the join runs in another order (`joinOrder`) and its rows are sorted back into FROM order (`emitJoinRows`).
 */
function compileWhereJoins(select: any, query: any) {
	if (!select.where || query.sources.length <= 1) return;
	if (query.sources.some((source: any, idx: number) => idx > 0 && source.onleftfn)) return;
	const cc = contextP(query);
	const aliasToIdx = valueMap();
	query.sources.forEach((source: any, idx: number) => {
		aliasToIdx[source.alias] = idx;
	});
	const links: { a: number; aExpr: Evaluator; b: number; bExpr: Evaluator }[] = [];
	const filters: [Evaluator, Evaluator][][] = query.sources.map(() => []);
	const pinned: boolean[] = [];
	for (const cond of whereEqualities(select.where)) {
		if (cond.allsome) continue;
		const leftAliases = sourcesRead(cond.left, query.defcols);
		const rightAliases = sourcesRead(cond.right, query.defcols);
		if (!leftAliases || !rightAliases) continue;
		const ls = compileExpression(cond.left, cc);
		const rs = compileExpression(cond.right, cc);
		if (leftAliases.length === 1 && rightAliases.length === 1) {
			const a = aliasToIdx[leftAliases[0]];
			const b = aliasToIdx[rightAliases[0]];
			if (a === undefined || b === undefined || a === b) continue;
			links.push({ a, aExpr: ls, b, bExpr: rs });
		} else if (leftAliases.length === 1 && rightAliases.length === 0) {
			const idx = aliasToIdx[leftAliases[0]];
			if (idx !== undefined) {
				filters[idx].push([ls, rs]);
				pinned[idx] = true;
			}
		} else if (leftAliases.length === 0 && rightAliases.length === 1) {
			const idx = aliasToIdx[rightAliases[0]];
			if (idx !== undefined) {
				filters[idx].push([ls, rs]);
				pinned[idx] = true;
			}
		}
	}
	const order = joinOrder(query.sources, links, pinned);
	const position: number[] = [];
	order.forEach((idx, k) => (position[idx] = k));
	order.forEach((idx, k) => {
		if (k === 0) return;
		const source = query.sources[idx];
		for (const link of links) {
			if (link.a === idx && position[link.b] < k) {
				indexJoin(source, link.bExpr, link.aExpr);
				break;
			} else if (link.b === idx && position[link.a] < k) {
				indexJoin(source, link.aExpr, link.bExpr);
				break;
			}
		}
	});
	query.sources.forEach((source: any, idx: number) => {
		const conditions = filters[idx];
		if (conditions.length === 0) return;
		source.filtered = true;
		source.srcwherefn = (env: Env) => {
			for (const [left, right] of conditions) {
				// eslint-disable-next-line eqeqeq
				if (!(left(env) == right(env))) return false;
			}
			return true;
		};
	});
	if (order.some((idx, k) => idx !== k)) {
		query.sources = order.map((idx) => query.sources[idx]);
		query.sources.forEach((source: any, k: number) => (source.fromidx = order[k]));
		query.joinsorted = true;
	}
}

/**
 * The order AlaSQL joined comma-joined sources in. FROM order is kept when every source links to one before it.
 * Otherwise, when every source is an inner join, the first source with a constant condition (else the first) goes
 * first, then repeatedly the first in FROM order linked to one already placed (else the first not placed).
 */
function joinOrder(sources: any[], links: { a: number; b: number }[], pinned: boolean[]): number[] {
	const n = sources.length;
	const fromOrder = sources.map((_, idx) => idx);
	const movable = sources.every((source) => !source.joinmode || source.joinmode === 'INNER');
	let linkedInFrom = true;
	for (let k = 1; k < n && linkedInFrom; k++) {
		linkedInFrom = links.some((l) => (l.a === k && l.b < k) || (l.b === k && l.a < k));
	}
	if (links.length === 0 || !movable || linkedInFrom) return fromOrder;
	const placed: boolean[] = [];
	let start = 0;
	for (let i = 0; i < n; i++) {
		if (pinned[i]) {
			start = i;
			break;
		}
	}
	const order = [start];
	placed[start] = true;
	while (order.length < n) {
		let next = -1;
		for (let i = 0; i < n && next < 0; i++) {
			if (placed[i]) continue;
			if (links.some((l) => (l.a === i && placed[l.b]) || (l.b === i && placed[l.a]))) next = i;
		}
		if (next < 0) next = fromOrder.find((i) => !placed[i])!;
		order.push(next);
		placed[next] = true;
	}
	return order;
}

function indexJoin(source: any, left: Evaluator, right: Evaluator) {
	if (source.onleftfn) return;
	source.onleftfn = left;
	source.onrightfn = right;
	source.optimization = 'ix';
}

/**
 * The `=` conditions of a WHERE's top-level AND chain, as `extractWhereConditions` found them: it stepped into any
 * node's `expression`, so the operand of a top-level CASE or CAST counts too.
 */
function whereEqualities(where: any): any[] {
	const conditions: any[] = [];
	const traverse = (node: any) => {
		if (!node) return;
		if (node.expression) {
			traverse(node.expression);
			return;
		}
		if (!(node instanceof ast.Op)) return;
		if (node.op === 'AND') {
			traverse(node.left);
			traverse(node.right);
		} else if (node.op === '=') conditions.push(node);
	};
	traverse(where);
	return conditions;
}

/**
 * The aliases of the sources an expression reads, in the order met, or null when that cannot be told (a subquery,
 * an aggregate, a node not listed, or a bare column no single source answers for). Inside a function, CASE or
 * list a bare column never counts, since its code read the first source.
 */
function sourcesRead(node: any, defcols: any): string[] | null {
	const aliases: string[] = [];
	let known = true;
	const walk = (n: any, nested: boolean) => {
		if (!known || n === null || typeof n !== 'object') return;
		if (n instanceof ast.Column) {
			const alias = n.tableid || (!nested && defcols && defcols[n.columnid]);
			if (typeof alias !== 'string' || alias === '-' || alias === '.') known = false;
			else if (!aliases.includes(alias)) aliases.push(alias);
		} else if (n instanceof ast.Op) {
			if (n.allsome || n.queriesidx !== undefined) known = false;
			else {
				walk(n.left, nested);
				walk(n.right, nested);
			}
		} else if (n instanceof ast.UniOp) {
			walk(n.right, nested);
		} else if (n instanceof ast.FuncValue) {
			for (const arg of n.args || []) walk(arg, true);
		} else if (n instanceof ast.CaseValue) {
			walk(n.expression, true);
			for (const w of n.whens || []) {
				walk(w.when, true);
				walk(w.then, true);
			}
			walk(n.elses, true);
		} else if (n instanceof ast.ArrayValue) {
			for (const item of n.value || []) walk(item, true);
		} else if (!(
			n instanceof ast.NumValue ||
			n instanceof ast.StringValue ||
			n instanceof ast.LogicValue ||
			n instanceof ast.NullValue ||
			n instanceof ast.ParamValue ||
			n instanceof ast.VarValue ||
			n instanceof ast.DomainValueValue
		)) {
			known = false;
		}
	};
	walk(node, false);
	return known ? aliases : null;
}

function preIndex(query: any) {
	for (let k = 0; k < query.sources.length; k++) {
		const source = query.sources[k];
		delete source.ix;
		if (k > 0 && source.optimization == 'ix' && source.onleftfn && source.onrightfn) {
			source.ix = valueMap();
			const scope: any = {};
			const env: Env = { s: scope, params: query.params, query };
			for (let i = 0; i < source.data.length; i++) {
				const dataw = source.data[i];
				scope[source.alias || source.tableid] = dataw;
				if (source.srcwherefn(env)) {
					const addr = source.onrightfn(env);
					let group = source.ix[addr];
					if (!group) group = source.ix[addr] = [];
					group.push(dataw);
				}
			}
		} else if (source.filtered) {
			// AlaSQL filtered twice, evaluating the conditions again on the rows that passed.
			const scope: any = {};
			const env: Env = { s: scope, params: query.params, query };
			const pass = (row: any) => {
				scope[source.alias] = row;
				return source.srcwherefn(env);
			};
			source.data = source.data.filter(pass).filter(pass);
		}
	}
}

function emit(query: any, env: Env) {
	if (query.wherefn(env)) {
		if (query.joinrows) {
			const at: number[] = [];
			for (let k = 0; k < query.sources.length; k++) at[query.sources[k].fromidx] = query.joinat[k];
			query.joinrows.push({ at, scope: Object.assign({}, env.s) });
		} else if (query.groupfn) query.groupfn(env);
		else query.data.push(query.selectfn(env));
	}
}

/** Hands a reordered join's rows on in FROM order, as a join in FROM order would have produced them. */
function emitJoinRows(query: any) {
	query.joinrows.sort((a: any, b: any) => {
		for (let k = 0; k < a.at.length; k++) {
			if (a.at[k] !== b.at[k]) return a.at[k] - b.at[k];
		}
		return 0;
	});
	for (const row of query.joinrows) {
		const env: Env = { s: row.scope, params: query.params, query };
		if (query.groupfn) query.groupfn(env);
		else query.data.push(query.selectfn(env));
	}
	query.joinrows = query.joinat = undefined;
	for (const source of query.sources) source.rowat = undefined;
}

function doJoin(query: any, env: Env, h: number) {
	if (h >= query.sources.length) {
		emit(query, env);
		return;
	}
	const scope = env.s;
	let source = query.sources[h];
	let nextsource = query.sources[h + 1];
	const tableid = source.alias || source.tableid;
	let pass = false;
	let data = source.data;
	let opt = false;
	if (
		source.joinmode != 'RIGHT' &&
		source.joinmode != 'OUTER' &&
		source.joinmode != 'ANTI' &&
		source.optimization == 'ix'
	) {
		data = source.ix[source.onleftfn(env)] || [];
		opt = true;
	}
	if (data === undefined) throw new Error('Data source number ' + h + ' in undefined');
	const ilen = data.length;
	let dataw;
	let i = 0;
	while ((dataw = data[i]) || i < ilen) {
		scope[tableid] = dataw;
		if (query.joinrows) query.joinat[h] = opt ? source.rowat.get(dataw) : i;
		let usingPassed = !source.onleftfn;
		if (!usingPassed) {
			let left = source.onleftfn(env);
			let right = source.onrightfn(env);
			if (left instanceof String || left instanceof Number) left = left.valueOf();
			if (right instanceof String || right instanceof Number) right = left.valueOf();
			usingPassed = left == right; // eslint-disable-line eqeqeq
		}
		if (usingPassed && source.onmiddlefn(env)) {
			if (source.joinmode != 'SEMI' && source.joinmode != 'ANTI') doJoin(query, env, h + 1);
			if (source.joinmode != 'LEFT' && source.joinmode != 'INNER') dataw._rightjoin = true;
			pass = true;
		}
		i++;
	}
	if ((source.joinmode == 'LEFT' || source.joinmode == 'OUTER' || source.joinmode == 'SEMI') && !pass) {
		scope[tableid] = {};
		doJoin(query, env, h + 1);
	}
	if (h == 0) {
		for (let nh = h + 1; nh < query.sources.length; nh++) {
			if (nextsource.joinmode == 'OUTER' || nextsource.joinmode == 'RIGHT' || nextsource.joinmode == 'ANTI') {
				scope[source.alias] = {};
				const jlen = nextsource.data.length;
				let j = 0;
				let row;
				while ((row = nextsource.data[j]) || j < jlen) {
					if (row._rightjoin) {
						delete row._rightjoin;
					} else {
						scope[nextsource.alias] = row;
						doJoin(query, env, nh + 1);
					}
					j++;
				}
			}
			source = query.sources[nh];
			nextsource = query.sources[nh + 1];
		}
	}
	scope[tableid] = undefined;
}

/** The `$$$<n>` sort keys of a statement with a set operation, read from the result columns. */
function addSetOrderColumns(query: any) {
	if (!query.orderColumns) return;
	query.data.forEach((r: any, i: number) => {
		query.orderColumns.forEach((v: any, idx: number) => {
			const key = '$$$' + idx;
			r[key] = v instanceof ast.Column && r[v.columnid] !== undefined ? r[v.columnid] : undefined;
			if (i === 0 && query.removeKeys.indexOf(key) === -1) query.removeKeys.push(key);
		});
	});
}

function setOperationRows(query: any, nd: any, reverse = false): any[] {
	const rows = [];
	for (const row of nd.data) {
		const r: any = {};
		if (reverse) {
			for (let j = Math.min(query.columns.length, nd.columns.length) - 1; j >= 0; j--) {
				r[query.columns[j].columnid] = row[nd.columns[j].columnid];
			}
		} else if (query.columns.length) {
			const jlen = Math.min(query.columns.length, nd.columns.length);
			for (let j = 0; j < jlen; j++) r[query.columns[j].columnid] = row[nd.columns[j].columnid];
		} else {
			for (const col of nd.columns) r[col.columnid] = row[col.columnid];
		}
		rows.push(r);
	}
	return rows;
}

function combineSetOperation(query: any) {
	const deepUnion = (a: any[], b: any[]) => {
		const r = b.slice(0);
		for (const ai of a) if (!r.some((ri) => deepEqual(ai, ri))) r.push(ai);
		return r;
	};
	const run = (fn: any, corresponding: string | undefined) => {
		if (query.corresponding) {
			if (fn.query && !fn.query.modifier) fn.query.modifier = corresponding;
			return { rows: fn(query.params), recordset: false };
		}
		if (fn.query && !fn.query.modifier) fn.query.modifier = 'RECORDSET';
		return { rows: fn(query.params), recordset: true };
	};
	if (query.unionallfn) {
		const { rows, recordset } = run(query.unionallfn, undefined);
		query.data = query.data.concat(recordset ? setOperationRows(query, rows) : rows);
	} else if (query.unionfn) {
		const { rows, recordset } = run(query.unionfn, 'ARRAY');
		query.data = deepUnion(query.data, recordset ? setOperationRows(query, rows) : rows);
	} else if (query.exceptfn) {
		const { rows, recordset } = run(query.exceptfn, 'ARRAY');
		const ud = recordset ? setOperationRows(query, rows, true) : rows;
		query.data = query.data.filter((ai: any) => !ud.some((bi: any) => deepEqual(ai, bi)));
	} else if (query.intersectfn) {
		const { rows, recordset } = run(query.intersectfn, undefined);
		const ud = recordset ? setOperationRows(query, rows) : rows;
		query.data = query.data.filter((ai: any) => ud.some((bi: any) => deepEqual(ai, bi)));
	}
}

function applyGroupRowNumbers(query: any, res: any[]) {
	for (const config of query.grouprownums) {
		const partitionColumns =
			config.partitionColumns && config.partitionColumns.length > 0
				? config.partitionColumns
				: [Object.keys(res[0] || {})[0]];
		let prevValues: any = null;
		let rowNum = 0;
		for (let i = 0; i < res.length; i++) {
			const currentValues = partitionColumns.map((col: any) => res[i][col]).join('|');
			rowNum = i === 0 || currentValues !== prevValues ? 1 : rowNum + 1;
			res[i][config.as] = rowNum;
			prevValues = currentValues;
		}
	}
}

function applyWindowAggregates(query: any, res: any[]) {
	for (const config of query.windowaggrs) {
		const partitions: Record<string, number[]> = {};
		for (let i = 0; i < res.length; i++) {
			const partitionKey =
				config.partitionColumns && config.partitionColumns.length > 0
					? config.partitionColumns.map((col: any) => res[i][col]).join('|')
					: '__all__';
			(partitions[partitionKey] ??= []).push(i);
		}
		for (const partitionKey in partitions) {
			const rowIndices = partitions[partitionKey];
			const values: any[] = [];
			const colId = config.expression && config.expression.columnid;
			if (config.aggregatorid !== 'COUNT' || (colId && colId !== '*')) {
				for (const k of rowIndices) {
					const val = res[k][colId];
					if (val != null) values.push(val);
				}
			}
			let aggregateValue;
			switch (config.aggregatorid) {
				case 'COUNT':
					aggregateValue = colId && colId !== '*' ? values.length : rowIndices.length;
					break;
				case 'SUM':
					aggregateValue = values.reduce((sum, v) => sum + v, 0);
					break;
				case 'AVG':
					aggregateValue = values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
					break;
				case 'MAX':
					aggregateValue = values.length > 0 ? Math.max(...values) : null;
					break;
				case 'MIN':
					aggregateValue = values.length > 0 ? Math.min(...values) : null;
					break;
			}
			for (const k of rowIndices) res[k][config.as] = aggregateValue;
		}
	}
}

function doLimit(query: any) {
	if (query.limit) {
		let offset = 0;
		if (query.offset) {
			offset = query.offset | 0 || 0;
			offset = offset < 0 ? 0 : offset;
		}
		const limit = query.percent ? (((query.data.length * query.limit) / 100) | 0) + offset : (query.limit | 0) + offset;
		query.data = query.data.slice(offset, limit);
	}
}

function doDistinct(query: any) {
	if (!query.distinct) return;
	const uniq = valueMap();
	const keys = Object.keys(query.data[0] || []);
	for (const row of query.data) {
		const uix = keys
			.map((k) => {
				const val = row[k];
				return typeof val === 'object' ? JSON.stringify(val) : val;
			})
			.join('`');
		uniq[uix] = row;
	}
	query.data = [];
	for (const key in uniq) query.data.push(uniq[key]);
}

function modify(query: any, res: any): any {
	if (typeof res === 'undefined' || typeof res === 'number' || typeof res === 'string' || typeof res === 'boolean') {
		return res;
	}
	const modifier = query.modifier;
	let columns = query.columns;
	if (query.dirtyColumns && res.length > 0) {
		const allcol: any = {};
		for (let i = Math.min(res.length, 10) - 1; i >= 0; i--) for (const key in res[i]) allcol[key] = true;
		const dataColumns = Object.keys(allcol).map((columnid) => ({ columnid }));
		if (!columns || columns.length === 0) {
			columns = dataColumns;
		} else {
			const existing: any = {};
			for (const col of columns) existing[col.columnid] = true;
			for (const col of dataColumns) if (!existing[col.columnid]) columns.push(col);
		}
	} else if (columns === undefined || columns.length === 0) {
		if (res.length > 0) {
			const allcol: any = {};
			for (let i = Math.min(res.length, 10) - 1; i >= 0; i--) for (const key in res[i]) allcol[key] = true;
			columns = Object.keys(allcol).map((columnid) => ({ columnid }));
		} else {
			columns = [];
		}
	}
	switch (modifier) {
		case 'VALUE': {
			if (res.length === 0) return undefined;
			const key = columns && columns.length > 0 ? columns[0].columnid : Object.keys(res[0])[0];
			return res[0][key];
		}
		case 'ROW':
			if (res.length === 0) return undefined;
			return Object.values(res[0]);
		case 'COLUMN': {
			if (res.length === 0) return [];
			const key = columns && columns.length > 0 ? columns[0].columnid : Object.keys(res[0])[0];
			const ar = res.map((row: any) => row[key]);
			return query.distinct ? distinctArray(ar) : ar;
		}
		case 'MATRIX':
			if (res.length === 0) return undefined;
			return res.map((row: any) => columns.map((col: any) => row[col.columnid]));
		case 'INDEX': {
			if (res.length === 0) return undefined;
			const keyIndex = columns && columns.length > 0 ? columns[0].columnid : Object.keys(res[0])[0];
			const valIndex = columns && columns.length > 1 ? columns[1].columnid : Object.keys(res[0])[1];
			return res.reduce((acc: any, row: any) => ({ ...acc, [row[keyIndex]]: row[valIndex] }), {});
		}
		case 'RECORDSET':
			return new Recordset({ columns, data: res });
		case 'TEXTSTRING': {
			if (res.length === 0) return undefined;
			const key = columns && columns.length > 0 ? columns[0].columnid : Object.keys(res[0])[0];
			return res.map((row: any) => row[key]).join('\n');
		}
	}
	return res;
}

/** The distinct values of a COLUMN result, keyed as `alasql.utils.distinctArray` keyed them. */
function distinctArray(data: any[]): any[] {
	const uniq = valueMap();
	for (const item of data) {
		const uix =
			typeof item === 'object'
				? Object.keys(item)
						.sort()
						.map((k) => k + '`' + item[k])
						.join('`')
				: item;
		uniq[uix] = item;
	}
	const res = [];
	for (const key in uniq) res.push(uniq[key]);
	return res;
}
