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
} from './ast.ts';
import { EngineUnsupportedError } from '../errors.ts';

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
		case 'update':
		case 'delete':
			throw new EngineUnsupportedError(`${variant} is not implemented yet (phase 1: select only)`);
		default:
			throw new EngineUnsupportedError(`unknown SQL variant: ${variant}`);
	}
}

function normalizeSelect(stmt: AlaSqlNode): SelectNode {
	if (!Array.isArray(stmt.from) || stmt.from.length === 0) {
		throw new EngineUnsupportedError('SELECT requires a FROM clause', stmt);
	}
	if (stmt.from.length !== 1) {
		throw new EngineUnsupportedError('multi-table FROM is not supported in phase 1', stmt.from);
	}
	const from = normalizeTableRef((stmt.from as AlaSqlNode[])[0]);
	const joins: JoinNode[] = [];
	if (Array.isArray(stmt.joins) && stmt.joins.length > 0) {
		throw new EngineUnsupportedError('JOIN is not supported in phase 1', stmt.joins);
	}

	const columns = stmt.columns;
	if (!Array.isArray(columns)) {
		throw new EngineUnsupportedError('SELECT requires a column list');
	}
	const projections = columns.map((c) => normalizeProjection(c as AlaSqlNode));

	if (stmt.group != null && (stmt.group as unknown[]).length > 0) {
		throw new EngineUnsupportedError('GROUP BY is not supported in phase 1', stmt.group);
	}
	if (stmt.having != null) {
		throw new EngineUnsupportedError('HAVING is not supported in phase 1', stmt.having);
	}
	if (hasAggregate(projections)) {
		throw new EngineUnsupportedError('aggregate functions are not supported in phase 1', projections);
	}

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

function hasAggregate(projections: ProjectionNode[]): boolean {
	for (const p of projections) {
		if (containsAggCall(p.expr)) return true;
	}
	return false;
}

function containsAggCall(expr: ExprNode): boolean {
	if (expr.kind === 'aggCall') return true;
	if (expr.kind === 'binop') return containsAggCall(expr.left) || containsAggCall(expr.right);
	if (expr.kind === 'logical') return expr.args.some(containsAggCall);
	if (expr.kind === 'funcCall') return expr.args.some(containsAggCall);
	if (expr.kind === 'case') {
		for (const c of expr.cases) {
			if (containsAggCall(c.when) || containsAggCall(c.then)) return true;
		}
		if (expr.else && containsAggCall(expr.else)) return true;
	}
	return false;
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
		const arg =
			(node.expression as AlaSqlNode).columnid === '*'
				? ({ kind: 'star' } as const)
				: normalizeExpr(node.expression as AlaSqlNode);
		return {
			kind: 'aggCall',
			name: String(node.aggregatorid).toLowerCase(),
			arg,
			distinct: !!node.distinct,
		};
	}

	if (node.funcid != null) {
		const args = Array.isArray(node.args) ? (node.args as AlaSqlNode[]).map(normalizeExpr) : [];
		return {
			kind: 'funcCall',
			name: String(node.funcid).toLowerCase(),
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
