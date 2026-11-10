/**
 * Lowers an ExprNode to a row-context closure.
 *
 * The compiler runs once per query at physical-plan time; the resulting
 * closure is invoked per row by Filter/Project operators. SQL three-valued
 * logic for AND/OR/NOT and comparisons is handled here so residual filters match
 * Resource API semantics (NULL → drop). Coercion is loose to match AlaSQL
 * behavior, except that a blank string is no number.
 */

import type { ExprNode } from '../parser/ast.ts';
import type { Row, SqlType } from '../types.ts';
import { EngineUnsupportedError } from '../errors.ts';
import { functionRegistry } from '../functions/registry.ts';
import { compileLike, type LikeMatcher } from './like.ts';

export interface CompiledExpr {
	eval(row: Row): unknown;
	type: SqlType;
}

/**
 * Compiles an expression to a per-row closure.
 *
 * When `qualified` is true (join queries), column references are looked up by
 * their canonical `<alias>.<name>` key — the binder has set `column.table` to
 * the owning alias and the scan output is keyed the same way (see
 * physical/PhysicalQualify). Single-table queries pass `qualified = false` and
 * columns resolve by bare name.
 */
export function compileExpr(expr: ExprNode, qualified = false): CompiledExpr {
	switch (expr.kind) {
		case 'literal':
			return { eval: () => expr.value, type: expr.sqlType };
		case 'column': {
			const key = qualified && expr.table ? `${expr.table}.${expr.name}` : expr.name;
			return { eval: (row) => row[key], type: 'unknown' };
		}
		case 'star':
			throw new EngineUnsupportedError('star expression cannot be compiled directly');
		case 'binop': {
			const l = compileExpr(expr.left, qualified);
			const r = compileExpr(expr.right, qualified);
			const op = expr.op;
			return {
				eval: (row) => {
					const a = l.eval(row);
					const b = r.eval(row);
					return applyBinaryOp(op, a, b);
				},
				type: arithmeticType(op),
			};
		}
		case 'logical': {
			if (expr.op === 'not') {
				const inner = compileExpr(expr.args[0], qualified);
				return {
					eval: (row) => {
						const v = inner.eval(row);
						if (v == null) return null;
						return !truthy(v);
					},
					type: 'boolean',
				};
			}
			const args = expr.args.map((a) => compileExpr(a, qualified));
			if (expr.op === 'and') {
				return {
					eval: (row) => {
						let sawNull = false;
						for (const a of args) {
							const v = a.eval(row);
							if (v == null) sawNull = true;
							else if (!truthy(v)) return false;
						}
						return sawNull ? null : true;
					},
					type: 'boolean',
				};
			}
			return {
				eval: (row) => {
					let sawNull = false;
					for (const a of args) {
						const v = a.eval(row);
						if (v == null) sawNull = true;
						else if (truthy(v)) return true;
					}
					return sawNull ? null : false;
				},
				type: 'boolean',
			};
		}
		case 'in': {
			if (!Array.isArray(expr.list)) {
				throw new EngineUnsupportedError('subquery IN list is not supported in phase 1');
			}
			const target = compileExpr(expr.expr, qualified);
			const list = expr.list.map((e) => compileExpr(e, qualified));
			const negated = expr.negated;
			return {
				eval: (row) => {
					const v = target.eval(row);
					if (v == null) return null;
					let sawNull = false;
					for (const l of list) {
						const lv = l.eval(row);
						if (lv == null) sawNull = true;
						else if (looseEquals(v, lv)) return !negated;
					}
					if (sawNull) return null;
					return negated;
				},
				type: 'boolean',
			};
		}
		case 'between': {
			const e = compileExpr(expr.expr, qualified);
			const lo = compileExpr(expr.low, qualified);
			const hi = compileExpr(expr.high, qualified);
			const negated = expr.negated;
			return {
				eval: (row) => {
					const v = e.eval(row);
					if (neverEqual(v)) return null;
					// three-valued `v >= low AND v <= high`: a FALSE side decides it, an unknown one leaves it NULL
					const low = lo.eval(row);
					const fromLow = low == null ? Number.NaN : compare(v, low);
					if (fromLow < 0) return negated;
					const high = hi.eval(row);
					const toHigh = high == null ? Number.NaN : compare(v, high);
					if (toHigh > 0) return negated;
					if (Number.isNaN(fromLow) || Number.isNaN(toHigh)) return null;
					return !negated;
				},
				type: 'boolean',
			};
		}
		case 'like': {
			const e = compileExpr(expr.expr, qualified);
			const { escape, negated } = expr;
			if (expr.pattern.kind === 'literal' && typeof expr.pattern.value === 'string') {
				const matches = compileLike(expr.pattern.value, escape);
				return {
					eval: (row) => {
						const v = e.eval(row);
						if (v == null) return null;
						const r = matches(String(v));
						return negated ? !r : r;
					},
					type: 'boolean',
				};
			}
			const p = compileExpr(expr.pattern, qualified);
			let lastPattern: string | undefined;
			let lastMatches: LikeMatcher | undefined;
			return {
				eval: (row) => {
					const v = e.eval(row);
					const pat = p.eval(row);
					if (v == null || pat == null) return null;
					if (typeof pat !== 'string') return null;
					if (pat !== lastPattern) {
						lastMatches = compileLike(pat, escape);
						lastPattern = pat;
					}
					const r = lastMatches!(String(v));
					return negated ? !r : r;
				},
				type: 'boolean',
			};
		}
		case 'isNull': {
			const e = compileExpr(expr.expr, qualified);
			const negated = expr.negated;
			return {
				eval: (row) => {
					const v = e.eval(row);
					const r = v == null;
					return negated ? !r : r;
				},
				type: 'boolean',
			};
		}
		case 'funcCall': {
			const desc = functionRegistry.lookup(expr.name);
			if (!desc) {
				throw new EngineUnsupportedError(`unknown function: ${expr.name}`);
			}
			if (desc.kind !== 'scalar') {
				throw new EngineUnsupportedError(`${expr.name} is an aggregate; not allowed here`);
			}
			const args = expr.args.map((a) => compileExpr(a, qualified));
			const fn = desc.impl as (args: unknown[]) => unknown;
			return {
				eval: (row) => fn(args.map((a) => a.eval(row))),
				type: desc.returnType,
			};
		}
		case 'case': {
			const branches = expr.cases.map((c) => ({
				when: compileExpr(c.when, qualified),
				then: compileExpr(c.then, qualified),
			}));
			const otherwise = expr.else ? compileExpr(expr.else, qualified) : undefined;
			return {
				eval: (row) => {
					for (const b of branches) {
						const cond = b.when.eval(row);
						if (cond != null && truthy(cond)) return b.then.eval(row);
					}
					return otherwise ? otherwise.eval(row) : null;
				},
				type: 'unknown',
			};
		}
		case 'cast':
			throw new EngineUnsupportedError('CAST is not supported in phase 1');
		case 'aggCall':
			throw new EngineUnsupportedError('aggregate call cannot be compiled as a row expression');
		case 'subquery':
			throw new EngineUnsupportedError('subqueries are not supported in phase 1');
	}
}

/** The one place a WHERE, ON or HAVING value becomes a row decision; operators must not test the value themselves. */
export function compilePredicate(expr: ExprNode, qualified = false): (row: Row) => boolean {
	const evaluate = compileExpr(expr, qualified).eval;
	return (row) => truthy(evaluate(row));
}

// NaN matches NaN in Table.search and in a JSON hash key, so a join skips such a key
export function neverEqual(v: unknown): boolean {
	return v == null || Number.isNaN(v);
}

function applyBinaryOp(op: string, a: unknown, b: unknown): unknown {
	if (a == null || b == null) return null;
	switch (op) {
		case '=':
			return looseEquals(a, b);
		case '!=':
		case '<>':
			return !looseEquals(a, b);
		case '<': {
			const order = compare(a, b);
			return Number.isNaN(order) ? null : order < 0;
		}
		case '<=': {
			const order = compare(a, b);
			return Number.isNaN(order) ? null : order <= 0;
		}
		case '>': {
			const order = compare(a, b);
			return Number.isNaN(order) ? null : order > 0;
		}
		case '>=': {
			const order = compare(a, b);
			return Number.isNaN(order) ? null : order >= 0;
		}
		case '+':
			return numeric(a) + numeric(b);
		case '-':
			return numeric(a) - numeric(b);
		case '*':
			return numeric(a) * numeric(b);
		case '/':
			return numeric(a) / numeric(b);
		case '%':
			return numeric(a) % numeric(b);
		case '||':
			return String(a) + String(b);
		default:
			throw new EngineUnsupportedError(`unsupported binary op: ${op}`);
	}
}

function arithmeticType(op: string): SqlType {
	if (op === '||') return 'string';
	switch (op) {
		case '+':
		case '-':
		case '*':
		case '/':
		case '%':
			return 'number';
		default:
			return 'boolean';
	}
}

// legacy AlaSQL's rule for a predicate
function truthy(v: unknown): boolean {
	return Boolean(v);
}

function looseEquals(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a === 'number' && typeof b === 'string') return a === stringToNumber(b);
	if (typeof a === 'string' && typeof b === 'number') return stringToNumber(a) === b;
	return false;
}

// NaN when a and b have no order (a NaN on either side), which every comparison reads as NULL
function compare(a: unknown, b: unknown): number {
	if (typeof a === 'number' && typeof b === 'number') {
		const difference = a - b;
		return difference === difference ? difference : compareNumbers(a, b);
	}
	if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
	const ax = numeric(a);
	const bx = numeric(b);
	if (!Number.isNaN(ax) && !Number.isNaN(bx)) return compareNumbers(ax, bx);
	if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
	// a string with no numeric reading sorts after any value with one, as Harper's indexes order them
	if (typeof a === 'string' && !Number.isNaN(bx)) return 1;
	if (typeof b === 'string' && !Number.isNaN(ax)) return -1;
	const as = String(a);
	const bs = String(b);
	return as < bs ? -1 : as > bs ? 1 : 0;
}

function compareNumbers(x: number, y: number): number {
	const difference = x - y;
	if (difference === difference) return difference;
	// Infinity - Infinity is NaN, but equal infinities are ordered
	return x === y ? 0 : Number.NaN;
}

// Number('') and Number(' \n') are 0, but a blank string is no number
function stringToNumber(s: string): number {
	const n = Number(s);
	return n === 0 && s.trim() === '' ? Number.NaN : n;
}

function numeric(v: unknown): number {
	if (typeof v === 'number') return v;
	if (typeof v === 'string') return stringToNumber(v);
	if (typeof v === 'boolean') return v ? 1 : 0;
	if (v instanceof Date) return v.getTime();
	return Number.NaN;
}
