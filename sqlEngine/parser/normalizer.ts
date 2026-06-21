/**
 * Normalizes the AlaSQL AST into the internal IR.
 *
 * The full AlaSQL AST shape is documented inline. Highlights:
 *   - WHERE wraps the predicate as { expression: ExprAst }.
 *   - Binary expressions are { left, op, right }.
 *   - BETWEEN uses { op: 'BETWEEN', left, right1, right2 }.
 *   - IN uses { op: 'IN', left, right: [values] }.
 *   - IS NULL uses { op: 'IS', left, right: {} }.
 *   - NOT uses { op: 'NOT', right }.
 *   - Column refs are { columnid, tableid? }.
 *   - Literals are { value }.
 *   - Aggregates are columns with { aggregatorid, expression, as? }.
 *   - Function calls are { funcid, args }.
 *
 * Phase 1 only handles SELECT. INSERT/UPDATE/DELETE throw
 * EngineUnsupportedError.
 */

import type {
	ExprNode,
	JoinNode,
	ProjectionNode,
	SelectNode,
	SortNode,
	StatementNode,
	TableRefNode,
	BinaryOp,
	InsertNode,
	UpdateNode,
	DeleteNode,
} from './ast.ts';
import { EngineUnsupportedError } from '../errors.ts';
import { functionRegistry } from '../functions/registry.ts';

interface AlaSqlNode {
	[key: string]: unknown;
}

/**
 * Entry point. The caller passes `parsedSqlObject.ast.statements[0]` (an
 * `alasql.yy.Select` instance) plus the variant string.
 */
export function normalizeStatement(stmt: AlaSqlNode, variant: string): StatementNode {
	switch (variant) {
		case 'select':
			return normalizeSelect(stmt);
		case 'insert':
			return normalizeInsert(stmt);
		case 'update':
			return normalizeUpdate(stmt);
		case 'delete':
			return normalizeDelete(stmt);
		default:
			throw new EngineUnsupportedError(`unknown SQL variant: ${variant}`);
	}
}

/**
 * AlaSQL INSERT shape: { into: { databaseid, tableid }, columns: [{ columnid }],
 * values: [[ {value}|expr, … ], …] }. `INSERT … SELECT` (no `values`) is rejected
 * for now so 'auto' mode falls back to legacy.
 */
function normalizeInsert(stmt: AlaSqlNode): InsertNode {
	const into = stmt.into as AlaSqlNode | undefined;
	if (!into) throw new EngineUnsupportedError('INSERT requires an INTO clause', stmt);
	const table = normalizeTableRef(into);

	if (!Array.isArray(stmt.columns)) {
		throw new EngineUnsupportedError('INSERT requires an explicit column list', stmt);
	}
	const columns = (stmt.columns as AlaSqlNode[]).map((c) => {
		const id = (c as AlaSqlNode).columnid;
		if (typeof id !== 'string') throw new EngineUnsupportedError('INSERT column must be a plain name', c);
		return id;
	});

	if (!Array.isArray(stmt.values)) {
		throw new EngineUnsupportedError('INSERT … SELECT is not supported yet (v1: VALUES only)', stmt);
	}
	const values = (stmt.values as AlaSqlNode[][]).map((row) => {
		if (!Array.isArray(row)) throw new EngineUnsupportedError('INSERT VALUES row must be a list', stmt);
		if (row.length !== columns.length) {
			throw new EngineUnsupportedError('INSERT values do not match the number of columns', stmt);
		}
		return row.map((v) => normalizeExpr(v as AlaSqlNode));
	});

	return { kind: 'insert', table, columns, values };
}

/**
 * AlaSQL UPDATE shape: { table: { databaseid, tableid }, columns: [{ column: {
 * columnid }, expression }], where }.
 */
function normalizeUpdate(stmt: AlaSqlNode): UpdateNode {
	const tableNode = stmt.table as AlaSqlNode | undefined;
	if (!tableNode) throw new EngineUnsupportedError('UPDATE requires a table', stmt);
	const table = normalizeTableRef(tableNode);

	if (!Array.isArray(stmt.columns) || (stmt.columns as unknown[]).length === 0) {
		throw new EngineUnsupportedError('UPDATE requires a SET clause', stmt);
	}
	const assignments = (stmt.columns as AlaSqlNode[]).map((c) => {
		const column = (c.column as AlaSqlNode | undefined)?.columnid;
		if (typeof column !== 'string') throw new EngineUnsupportedError('UPDATE SET target must be a column', c);
		return { column, expr: normalizeExpr(c.expression as AlaSqlNode) };
	});

	const where = stmt.where ? normalizeExpr(extractWhere(stmt.where as AlaSqlNode)) : undefined;
	return { kind: 'update', table, assignments, where };
}

/** AlaSQL DELETE shape: { table: { databaseid, tableid }, where }. */
function normalizeDelete(stmt: AlaSqlNode): DeleteNode {
	const tableNode = stmt.table as AlaSqlNode | undefined;
	if (!tableNode) throw new EngineUnsupportedError('DELETE requires a table', stmt);
	const table = normalizeTableRef(tableNode);
	const where = stmt.where ? normalizeExpr(extractWhere(stmt.where as AlaSqlNode)) : undefined;
	return { kind: 'delete', table, where };
}

function normalizeSelect(stmt: AlaSqlNode): SelectNode {
	if (!Array.isArray(stmt.from) || stmt.from.length === 0) {
		throw new EngineUnsupportedError('SELECT requires a FROM clause', stmt);
	}
	const fromList = stmt.from as AlaSqlNode[];
	const from = normalizeTableRef(fromList[0]);

	// JOINs arrive in two AlaSQL shapes:
	//   - explicit `stmt.joins`: [{ joinmode, table, as, on, using }]
	//   - comma-separated FROM (`FROM a, b`): the extra `stmt.from` entries,
	//     which are implicit CROSS joins (any join predicate lands in WHERE).
	const joins: JoinNode[] = [];
	for (let i = 1; i < fromList.length; i++) {
		joins.push({ type: 'cross', table: normalizeTableRef(fromList[i]) });
	}
	if (Array.isArray(stmt.joins)) {
		for (const j of stmt.joins as AlaSqlNode[]) {
			joins.push(normalizeJoin(j));
		}
	}

	const columns = stmt.columns;
	if (!Array.isArray(columns)) {
		throw new EngineUnsupportedError('SELECT requires a column list');
	}
	const projections = columns.map((c) => normalizeProjection(c as AlaSqlNode));

	const groupBy =
		stmt.group != null && Array.isArray(stmt.group) && (stmt.group as unknown[]).length > 0
			? (stmt.group as AlaSqlNode[]).map(normalizeExpr)
			: undefined;

	const having = stmt.having != null ? normalizeExpr(extractWhere(stmt.having as AlaSqlNode)) : undefined;

	const where = stmt.where ? normalizeExpr(extractWhere(stmt.where as AlaSqlNode)) : undefined;
	const orderBy = stmt.order ? (stmt.order as AlaSqlNode[]).map(normalizeSort) : undefined;
	const limit = readNumValue(stmt.limit as AlaSqlNode | undefined);
	const offset = readNumValue(stmt.offset as AlaSqlNode | undefined);
	const distinct = !!stmt.distinct;

	return {
		kind: 'select',
		distinct,
		projections,
		from,
		joins,
		where,
		groupBy,
		having,
		orderBy,
		limit,
		offset,
	};
}

function extractWhere(where: AlaSqlNode): AlaSqlNode {
	if (where.expression != null) return where.expression as AlaSqlNode;
	return where;
}

function normalizeTableRef(node: AlaSqlNode): TableRefNode {
	const database = (node.databaseid as string | undefined) ?? '';
	const table = (node.tableid as string | undefined) ?? '';
	if (!table) throw new EngineUnsupportedError('FROM requires a table name', node);
	const alias = node.as as string | undefined;
	return { database, table, alias };
}

/**
 * AlaSQL join shape: { joinmode, table: { databaseid, tableid, as }, as?, on?, using? }.
 * `joinmode` is one of 'INNER' | 'LEFT' | 'RIGHT' | 'OUTER' | 'CROSS' (sometimes
 * suffixed with ' OUTER'). RIGHT/FULL OUTER are rejected per the v1 plan.
 */
function normalizeJoin(node: AlaSqlNode): JoinNode {
	const rawMode = String(node.joinmode ?? 'INNER').toUpperCase();
	let type: JoinNode['type'];
	if (rawMode.startsWith('LEFT')) type = 'left';
	else if (rawMode.startsWith('CROSS')) type = 'cross';
	else if (rawMode.startsWith('INNER') || rawMode === 'JOIN' || rawMode === '') type = 'inner';
	else if (rawMode.startsWith('RIGHT')) {
		throw new EngineUnsupportedError('RIGHT JOIN is not supported (v1)', node);
	} else if (rawMode.startsWith('FULL') || rawMode.startsWith('OUTER')) {
		throw new EngineUnsupportedError('FULL OUTER JOIN is not supported (v1)', node);
	} else {
		throw new EngineUnsupportedError(`unsupported join mode: ${rawMode}`, node);
	}

	const tableNode = node.table as AlaSqlNode | undefined;
	if (!tableNode) throw new EngineUnsupportedError('JOIN requires a table', node);
	const table = normalizeTableRef({ ...tableNode, as: tableNode.as ?? node.as });

	const on = node.on != null ? normalizeExpr(extractWhere(node.on as AlaSqlNode)) : undefined;
	const using = Array.isArray(node.using)
		? (node.using as AlaSqlNode[]).map((u) => String((u as AlaSqlNode).columnid ?? u))
		: undefined;
	if (type !== 'cross' && !on && !using) {
		throw new EngineUnsupportedError('JOIN requires an ON or USING clause', node);
	}
	return { type, table, on, using };
}

function normalizeProjection(col: AlaSqlNode): ProjectionNode {
	const alias = col.as as string | undefined;
	if (typeof col.columnid === 'string' && col.tableid == null && col.aggregatorid == null && col.funcid == null) {
		if (col.columnid === '*') {
			return { expr: { kind: 'star' }, alias };
		}
		return { expr: { kind: 'column', name: col.columnid }, alias };
	}
	if (typeof col.columnid === 'string' && typeof col.tableid === 'string') {
		if (col.columnid === '*') {
			return { expr: { kind: 'star', table: col.tableid }, alias };
		}
		return { expr: { kind: 'column', table: col.tableid, name: col.columnid }, alias };
	}
	return { expr: normalizeExpr(col), alias };
}

function normalizeSort(node: AlaSqlNode): SortNode {
	return {
		expr: normalizeExpr(node.expression as AlaSqlNode),
		descending: node.direction === 'DESC',
	};
}

function readNumValue(node: AlaSqlNode | undefined): number | undefined {
	if (node == null) return undefined;
	const v = node.value;
	if (typeof v === 'number') return v;
	if (typeof v === 'string') return Number(v);
	return undefined;
}

const ALASQL_BINARY_OPS: Record<string, BinaryOp> = {
	'=': '=',
	'==': '=',
	'!=': '!=',
	'<>': '<>',
	'<': '<',
	'<=': '<=',
	'>': '>',
	'>=': '>=',
	'+': '+',
	'-': '-',
	'*': '*',
	'/': '/',
	'%': '%',
	'||': '||',
};

function normalizeExpr(node: AlaSqlNode | null | undefined): ExprNode {
	if (node == null) {
		throw new EngineUnsupportedError('null expression');
	}
	if (typeof node !== 'object') {
		throw new EngineUnsupportedError(`unexpected non-object expression: ${typeof node}`);
	}

	if (node.aggregatorid != null && node.expression != null) {
		// AlaSQL uses aggregatorid='REDUCE' with funcid set for user-defined aggregates
		// (e.g. MEDIAN). Use funcid as the real name when aggregatorid is REDUCE.
		const rawName =
			String(node.aggregatorid).toUpperCase() === 'REDUCE' && node.funcid != null
				? String(node.funcid)
				: String(node.aggregatorid);
		const arg =
			(node.expression as AlaSqlNode).columnid === '*'
				? ({ kind: 'star' } as const)
				: normalizeExpr(node.expression as AlaSqlNode);
		return {
			kind: 'aggCall',
			name: rawName.toLowerCase(),
			arg,
			distinct: !!node.distinct,
		};
	}

	if (node.funcid != null) {
		const fnName = String(node.funcid).toLowerCase();
		const args = Array.isArray(node.args) ? (node.args as AlaSqlNode[]).map(normalizeExpr) : [];
		// If this funcCall is a registered aggregate (e.g. PROD, MEAN that AlaSQL
		// doesn't recognize as aggregates), treat it as an aggCall.
		const desc = functionRegistry.lookup(fnName);
		if (desc?.kind === 'aggregate') {
			const arg: ExprNode | { kind: 'star' } = args.length === 0 ? { kind: 'star' } : args[0];
			return { kind: 'aggCall', name: fnName, arg, distinct: !!node.distinct };
		}
		return {
			kind: 'funcCall',
			name: fnName,
			args,
			distinct: !!node.distinct,
		};
	}

	if (typeof node.columnid === 'string' && node.aggregatorid == null && node.funcid == null) {
		if (node.columnid === '*') {
			return { kind: 'star', table: node.tableid as string | undefined };
		}
		return {
			kind: 'column',
			table: node.tableid as string | undefined,
			name: node.columnid,
		};
	}

	if (Object.prototype.hasOwnProperty.call(node, 'value') && node.left == null && node.op == null) {
		const val = node.value;
		const sqlType =
			val === null
				? 'null'
				: typeof val === 'number'
					? 'number'
					: typeof val === 'string'
						? 'string'
						: typeof val === 'boolean'
							? 'boolean'
							: 'unknown';
		return { kind: 'literal', value: val, sqlType };
	}

	if (typeof node.op === 'string') {
		const op = node.op.toUpperCase();
		switch (op) {
			case '=':
			case '==':
			case '!=':
			case '<>':
			case '<':
			case '<=':
			case '>':
			case '>=':
			case '+':
			case '-':
			case '*':
			case '/':
			case '%':
			case '||':
				return {
					kind: 'binop',
					op: ALASQL_BINARY_OPS[op] ?? (op as BinaryOp),
					left: normalizeExpr(node.left as AlaSqlNode),
					right: normalizeExpr(node.right as AlaSqlNode),
				};
			case 'AND':
			case 'OR':
				return {
					kind: 'logical',
					op: op === 'AND' ? 'and' : 'or',
					args: [normalizeExpr(node.left as AlaSqlNode), normalizeExpr(node.right as AlaSqlNode)],
				};
			case 'NOT':
				return {
					kind: 'logical',
					op: 'not',
					args: [normalizeExpr((node.right ?? node.left) as AlaSqlNode)],
				};
			case 'IN':
			case 'NOT IN': {
				const list = Array.isArray(node.right)
					? (node.right as AlaSqlNode[]).map(normalizeExpr)
					: [normalizeExpr(node.right as AlaSqlNode)];
				return {
					kind: 'in',
					expr: normalizeExpr(node.left as AlaSqlNode),
					list,
					negated: op === 'NOT IN',
				};
			}
			case 'BETWEEN':
			case 'NOT BETWEEN':
				return {
					kind: 'between',
					expr: normalizeExpr(node.left as AlaSqlNode),
					low: normalizeExpr(node.right1 as AlaSqlNode),
					high: normalizeExpr(node.right2 as AlaSqlNode),
					negated: op === 'NOT BETWEEN',
				};
			case 'LIKE':
			case 'NOT LIKE':
				return {
					kind: 'like',
					expr: normalizeExpr(node.left as AlaSqlNode),
					pattern: normalizeExpr(node.right as AlaSqlNode),
					negated: op === 'NOT LIKE',
				};
			case 'IS': {
				const right = node.right as AlaSqlNode | undefined;
				const isEmpty = right != null && Object.keys(right).length === 0;
				const negated = !!node.not;
				if (isEmpty) {
					return { kind: 'isNull', expr: normalizeExpr(node.left as AlaSqlNode), negated };
				}
				if (right != null && Object.prototype.hasOwnProperty.call(right, 'value') && right.value == null) {
					return { kind: 'isNull', expr: normalizeExpr(node.left as AlaSqlNode), negated };
				}
				throw new EngineUnsupportedError(`IS expression with non-null right side is not supported`, node);
			}
			default:
				throw new EngineUnsupportedError(`unsupported operator ${op}`, node);
		}
	}

	throw new EngineUnsupportedError(`could not normalize expression`, node);
}
