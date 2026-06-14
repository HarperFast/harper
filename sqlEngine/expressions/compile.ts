/**
 * Lowers an ExprNode to a row-context closure.
 *
 * The compiler runs once per query at physical-plan time; the resulting
 * closure is invoked per row by Filter/Project operators. SQL three-valued
 * logic for AND/OR/NOT is handled here so residual filters match Resource API
 * semantics (NULL → drop). Coercion is loose to match AlaSQL behavior.
 */

import type { ExprNode } from '../parser/ast.ts';
import type { Row, SqlType } from '../types.ts';
import { EngineUnsupportedError } from '../errors.ts';
import { functionRegistry } from '../functions/registry.ts';

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
					const a = lo.eval(row);
					const b = hi.eval(row);
					if (v == null || a == null || b == null) return null;
					const r = compare(v, a) >= 0 && compare(v, b) <= 0;
					return negated ? !r : r;
				},
				type: 'boolean',
			};
		}
		case 'like': {
			const e = compileExpr(expr.expr, qualified);
			const p = compileExpr(expr.pattern, qualified);
			const negated = expr.negated;
			return {
				eval: (row) => {
					const v = e.eval(row);
					const pat = p.eval(row);
					if (v == null || pat == null) return null;
					if (typeof pat !== 'string') return null;
					const re = likeToRegex(pat);
					const r = re.test(String(v));
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

function applyBinaryOp(op: string, a: unknown, b: unknown): unknown {
	if (a == null || b == null) {
		switch (op) {
			case '=':
			case '!=':
			case '<>':
			case '<':
			case '<=':
			case '>':
			case '>=':
				return null;
			default:
				return null;
		}
	}
	switch (op) {
		case '=':
			return looseEquals(a, b);
		case '!=':
		case '<>':
			return !looseEquals(a, b);
		case '<':
			return compare(a, b) < 0;
		case '<=':
			return compare(a, b) <= 0;
		case '>':
			return compare(a, b) > 0;
		case '>=':
			return compare(a, b) >= 0;
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

function truthy(v: unknown): boolean {
	if (typeof v === 'boolean') return v;
	if (typeof v === 'number') return v !== 0;
	if (typeof v === 'string') return v.length > 0;
	return v != null;
}

function looseEquals(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
	if (typeof a === 'string' && typeof b === 'number') return Number(a) === b;
	return false;
}

function compare(a: unknown, b: unknown): number {
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
	const ax = numeric(a);
	const bx = numeric(b);
	if (!Number.isNaN(ax) && !Number.isNaN(bx)) return ax - bx;
	const as = String(a);
	const bs = String(b);
	return as < bs ? -1 : as > bs ? 1 : 0;
}

function numeric(v: unknown): number {
	if (typeof v === 'number') return v;
	if (typeof v === 'string') return Number(v);
	if (typeof v === 'boolean') return v ? 1 : 0;
	if (v instanceof Date) return v.getTime();
	return Number.NaN;
}

function likeToRegex(pattern: string): RegExp {
	let r = '^';
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i++];
		if (ch === '%') r += '.*';
		else if (ch === '_') r += '.';
		else if (/[\\^$+?.()|{}[\]]/.test(ch)) r += '\\' + ch;
		else r += ch;
	}
	r += '$';
	return new RegExp(r);
}
