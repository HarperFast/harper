/**
 * Expression compiler for the in-memory SQL engine: turns an AST node into a closure that evaluates it.
 *
 * Each node compiles to what AlaSQL 4's code generator (`toJS`) produced for it, because legacy SQL's results
 * are the ones users rely on:
 * - Operands of a binary operator are all evaluated first, left to right, with no short-circuit.
 * - Except for AND, OR, `||`, IS and an empty IN list, a NULL, undefined or NaN operand makes the result undefined.
 * - `=` is strict (`===`) but `<>` and `!=` are loose (`!=`); AND and OR return an operand, not a boolean.
 * - A column resolves against the scope object the way the generated `p['alias']['column']` did, including the
 *   lookup of an unqualified column in the first source whose row has it.
 * No expression is ever evaluated as JavaScript text.
 */
import { ClientError } from '../../utility/errors/hdbError.ts';
import * as ast from '../parser/ast.ts';
import {
	compileConvert,
	compileFunctionCall,
	deepEqual,
	flatArray,
	getValueOf,
	glob,
	regexpLike,
} from './functions.ts';
import { legacyLike } from '../legacyLike.ts';
import * as functions from './functions.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** What an expression is evaluated against: `s` is the scope (a row scope `p` or a group `g`). */
export interface Env {
	s: any;
	params: any;
	query: any;
}

export type Evaluator = (env: Env) => any;

/**
 * Where an expression is compiled, mirroring `toJS(context, tableid, defcols)`: `context` is `'p'` for a row
 * scope keyed by source alias, `'g'` for a group object keyed by group column or aggregate nick.
 */
export interface CompileContext {
	context: 'p' | 'g';
	tableid: string | -1;
	defcols?: any;
}

/** AlaSQL's `escapeq`: the text inside a single-quoted JavaScript string that decodes to `s`. */
export function escapeq(s: any): string {
	return ('' + s).replace(/["'\\\n\r\u2028\u2029]/g, (character) => {
		switch (character) {
			case '"':
			case "'":
			case '\\':
				return '\\' + character;
			case '\n':
				return '\\n';
			case '\r':
				return '\\r';
			case '\u2028':
				return '\\u2028';
			default:
				return '\\u2029';
		}
	});
}

/** The string a single-quoted JavaScript literal holding `text` decodes to (the inverse of escapeq). */
export function unescapeq(text: string): string {
	return decodeStringLiteral(text, "'");
}

/**
 * Decodes the body of a JavaScript string literal quoted with `quote`, as `new Function` would have; throws a
 * SyntaxError where the literal would not have compiled.
 */
export function decodeStringLiteral(body: string, quote: string): string {
	let out = '';
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (c === quote || c === '\n' || c === '\r') throw new SyntaxError('Invalid or unexpected token');
		if (c !== '\\') {
			out += c;
			continue;
		}
		const next = body[++i];
		switch (next) {
			case undefined:
				throw new SyntaxError('Invalid or unexpected token');
			case 'n':
				out += '\n';
				break;
			case 't':
				out += '\t';
				break;
			case 'r':
				out += '\r';
				break;
			case 'b':
				out += '\b';
				break;
			case 'f':
				out += '\f';
				break;
			case 'v':
				out += '\v';
				break;
			case '\r':
				if (body[i + 1] === '\n') i++;
				break;
			case '\n':
			case '\u2028':
			case '\u2029':
				break;
			case 'x': {
				const hex = body.slice(i + 1, i + 3);
				if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new SyntaxError('Invalid hexadecimal escape sequence');
				out += String.fromCharCode(parseInt(hex, 16));
				i += 2;
				break;
			}
			case 'u': {
				if (body[i + 1] === '{') {
					const end = body.indexOf('}', i + 2);
					const hex = end < 0 ? '' : body.slice(i + 2, end);
					const code = /^[0-9a-fA-F]+$/.test(hex) ? parseInt(hex, 16) : NaN;
					if (!(code <= 0x10ffff)) throw new SyntaxError('Invalid Unicode escape sequence');
					out += String.fromCodePoint(code);
					i = end;
				} else {
					const hex = body.slice(i + 1, i + 5);
					if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError('Invalid Unicode escape sequence');
					out += String.fromCharCode(parseInt(hex, 16));
					i += 4;
				}
				break;
			}
			default:
				if (next >= '0' && next <= '9') {
					// Only `\0` not followed by a digit is allowed in strict mode code; the generated functions were
					// sloppy-mode, where an octal escape is legal.
					let digits = next;
					while (digits.length < 3 && /[0-7]/.test(body[i + 1] ?? '') && parseInt(digits + body[i + 1], 8) < 256) {
						digits += body[++i];
					}
					if (/[89]/.test(digits)) out += digits;
					else out += String.fromCharCode(parseInt(digits, 8));
				} else {
					out += next;
				}
		}
	}
	return out;
}

const isNullish = (value: any) => value == null || (typeof value === 'number' && isNaN(value));

/**
 * A map keyed by row values: groups, join buckets, DISTINCT keys. It has no prototype, so a value such as
 * `__proto__` or `constructor` is an ordinary key rather than an inherited property.
 */
export function valueMap(): any {
	return Object.create(null);
}

/** NaN becomes undefined, as select columns' `(y=..., y===y?y:undefined)` did. */
export function nanToUndefined(evaluate: Evaluator): Evaluator {
	return (env) => {
		const value = evaluate(env);
		// eslint-disable-next-line no-self-compare
		return value === value ? value : undefined;
	};
}

/**
 * The value of an unqualified column from the first source that has it (`Column.fromAnySource`): a source with
 * column definitions decides by its definitions, any other by whether its row has the key.
 */
export function fromAnySource(aliases: string[], columnid: string, sources: any): Evaluator {
	return aliases.reduceRight<Evaluator>(
		(rest, alias) => {
			const columns = sources?.[alias];
			if (columns instanceof Set) {
				return columns.has(columnid) ? (env) => env.s[alias]?.[columnid] : rest;
			}
			return (env) => (columnid in Object(env.s[alias]) ? env.s[alias][columnid] : rest(env));
		},
		() => undefined
	);
}

/** A name AlaSQL wrote unescaped inside `'...'` in generated code: the string that literal decoded to. */
function literalName(name: any): string {
	return decodeStringLiteral(String(name), "'");
}

export function compileColumn(node: any, cc: CompileContext): Evaluator {
	const { context, tableid, defcols } = cc;
	const columnid = literalName(node.columnid);
	const isAll = node.columnid === '_';
	if (!node.tableid && (tableid as any) === '' && !defcols) {
		if (!isAll) return (env) => env.s[columnid];
		return context === 'g' ? (env) => env.s['_'] : (env) => env.s;
	}
	if (context === 'g') {
		const nick = literalName(node.nick || node.columnid);
		return (env) => env.s[nick];
	}
	const lookup = (table: string): Evaluator => (isAll ? (env) => env.s[table] : (env) => env.s[table][columnid]);
	if (node.tableid) return lookup(literalName(node.tableid));
	if (defcols) {
		const tbid = defcols[node.columnid];
		if (tbid === '-') {
			throw new Error(`Cannot resolve column "${node.columnid}" because it exists in two source tables`);
		} else if (tbid) {
			return lookup(literalName(tbid));
		} else if (!isAll && Object.keys(defcols['.']).length > 1) {
			return fromAnySource(Object.keys(defcols['.']).map(literalName), columnid, defcols['.']);
		}
		return lookup(literalName(tableid));
	}
	if (tableid === -1) return (env) => env.s[columnid];
	return lookup(literalName(tableid));
}

/** The key the group object holds an aggregate under. */
function aggregateKey(node: any): string {
	const colas = node.aggrNick || node.nick;
	return unescapeq(colas === undefined ? escapeq(node.toString()) : colas);
}

const COMPARISON: Record<string, (a: any, b: any) => any> = {
	'===': (a, b) => a === b,
	'!=': (a, b) => a != b, // eslint-disable-line eqeqeq
	'>': (a, b) => a > b,
	'>=': (a, b) => a >= b,
	'<': (a, b) => a < b,
	'<=': (a, b) => a <= b,
	'+': (a, b) => a + b,
	'-': (a, b) => a - b,
	'*': (a, b) => a * b,
	'/': (a, b) => a / b,
	'%': (a, b) => a % b,
	'^': (a, b) => a ^ b,
	'&': (a, b) => a & b,
	'|': (a, b) => a | b,
	'<<': (a, b) => a << b,
	'>>': (a, b) => a >> b,
	'&&': (a, b) => a && b,
	'||': (a, b) => a || b,
};

/** Runs a subquery the statement recorded (`queriesfn`), with the current scope as its outer scope. */
function runSubquery(index: number, env: Env): any {
	return env.query.queriesfn[index](env.params, null, env.s);
}

function compileOp(node: any, cc: CompileContext): Evaluator {
	const refs: Evaluator[] = [];
	const ref = (expr: any) => refs.push(compileExpression(expr, cc)) - 1;
	let op = node.op;
	let skipNullCheck = false;
	let body: ((y: any[], env: Env) => any) | undefined;

	if (node.op === '=') op = '===';
	else if (node.op === '<>') op = '!=';
	else if (node.op === 'OR') op = '||';

	if (node.op === '->') {
		const left = ref(node.left);
		const right = node.right;
		if (typeof right === 'string' || typeof right === 'number') {
			body = (y) => (y[left] || {})[right];
		} else if (right instanceof ast.FuncValue) {
			const args = (right.args ?? []).map(ref);
			const funcid = right.funcid;
			body = (y) => {
				const target = y[left] || {};
				return target[funcid](...args.map((i) => y[i]));
			};
		} else {
			const key = ref(right);
			body = (y) => (y[left] || {})[y[key]];
		}
	} else if (node.op === '!') {
		if (typeof node.right !== 'string') throw new SyntaxError('Unexpected token');
		const left = ref(node.left);
		// AlaSQL's object store is always empty here, so this read throws.
		body = (y) => (undefined as any)[y[left]];
	} else if (node.op === 'IS') {
		const left = ref(node.left);
		const right = ref(node.right);
		if (node.right instanceof ast.NullValue || (node.right.op === 'NOT' && node.right.right instanceof ast.NullValue)) {
			body = (y) => (y[left] == null) === (y[right] == null);
		} else {
			body = (y) => y[left] == y[right] || (y[left] < 0 && true == y[right]); // eslint-disable-line eqeqeq
		}
	} else if (node.op === '==') {
		const left = ref(node.left);
		const right = ref(node.right);
		body = (y) => deepEqual(y[left], y[right]);
	} else if (node.op === '===' || node.op === '!===') {
		const left = ref(node.left);
		const right = ref(node.right);
		const negate = node.op === '!===';
		body = (y) => negate !== (y[left].valueOf() === y[right].valueOf());
	} else if (node.op === '!==') {
		const left = ref(node.left);
		const right = ref(node.right);
		body = (y) => !deepEqual(y[left], y[right]);
	} else if (node.op === '||') {
		const left = ref(node.left);
		const right = ref(node.right);
		body = (y) => '' + (y[left] || '') + (y[right] || '');
	} else if (node.op === 'LIKE' || node.op === 'NOT LIKE') {
		const right = ref(node.right);
		const left = ref(node.left);
		const escape = node.escape ? ref(node.escape) : undefined;
		const negate = node.op === 'NOT LIKE';
		body =
			escape === undefined
				? (y) => negate !== legacyLike(y[right], y[left])
				: (y) => negate !== legacyLike(y[right], y[left], y[escape]);
	} else if (node.op === 'REGEXP') {
		const left = ref(node.left);
		const right = ref(node.right);
		body = (y) => regexpLike(y[left], y[right]);
	} else if (node.op === 'GLOB') {
		const left = ref(node.left);
		const right = ref(node.right);
		body = (y) => glob(y[left], y[right]);
	} else if (node.op === 'BETWEEN' || node.op === 'NOT BETWEEN') {
		const left = ref(node.left);
		const low = ref(node.right1);
		const high = ref(node.right2);
		const negate = node.op === 'NOT BETWEEN';
		body = (y) => negate !== (y[low] <= y[left] && y[left] <= y[high]);
	} else if (node.op === 'IN' || node.op === 'NOT IN') {
		const negate = node.op === 'NOT IN';
		if (node.right instanceof ast.Select) {
			const left = ref(node.left);
			const index = node.queriesidx;
			body = (y, env) => {
				const subquery = env.query.queriesfn[index];
				let found;
				if (subquery.query && subquery.query.isCorrelated) {
					found = flatArray(runSubquery(index, env)).indexOf(getValueOf(y[left])) > -1;
				} else {
					const cache = (env.query.subqueryCache ??= valueMap());
					const key = (negate ? 'notIn' : 'in') + index;
					cache[key] ??= new Set(flatArray(runSubquery(index, env)).map(getValueOf));
					found = cache[key].has(getValueOf(y[left]));
				}
				return negate !== found;
			};
		} else if (Array.isArray(node.right)) {
			if (node.right.length === 0) {
				ref(node.left);
				body = () => negate;
				skipNullCheck = true;
			} else {
				const items = node.right.map(ref);
				const left = ref(node.left);
				body = (y) => negate !== new Set(items.map((i: number) => y[i])).has(getValueOf(y[left]));
			}
		} else {
			const right = ref(node.right);
			const left = ref(node.left);
			body = negate ? (y) => y[right].indexOf(y[left]) === -1 : (y) => y[right].indexOf(y[left]) > -1;
		}
	}

	if (node.allsome === 'ALL' || node.allsome === 'SOME' || node.allsome === 'ANY') {
		const method = node.allsome === 'ALL' ? 'every' : 'some';
		const compare = COMPARISON[op];
		if (!compare) throw new SyntaxError('Unexpected token');
		if (node.right instanceof ast.Select) {
			const index = node.queriesidx;
			const left = ref(node.left);
			body = (y, env) => flatArray(runSubquery(index, env))[method]((b: any) => compare(y[left], b));
		} else if (Array.isArray(node.right)) {
			if (node.right.length === 1) {
				const only = ref(node.right[0]);
				const left = ref(node.left);
				body = (y) => y[only][method]((b: any) => compare(y[left], b));
			} else {
				const items = node.right.map(ref);
				const left = ref(node.left);
				body = (y) => items.map((i: number) => y[i])[method]((b: any) => compare(y[left], b));
			}
		} else {
			throw new Error(node.allsome === 'ALL' ? 'NOT IN operator without SELECT' : 'SOME/ANY operator without SELECT');
		}
	}

	if (node.op === 'AND') op = '&&';

	if (body === undefined) {
		const compare = COMPARISON[op];
		// Any other operator text did not compile as JavaScript.
		if (!compare) throw new SyntaxError('Unexpected identifier');
		if (refs.length === 0) {
			// The common case, a plain binary operator, without an operand array per row.
			return plainBinary(op, compileExpression(node.left, cc), compileExpression(node.right, cc));
		}
		const left = ref(node.left);
		const right = ref(node.right);
		body = (y) => compare(y[left], y[right]);
	}

	const evaluate = body;
	const count = refs.length;
	// One operand array reused across rows; a nested evaluation of this same node, if one ever ran, gets its own.
	let spare: any[] | undefined = new Array(count);
	const nullable = !(skipNullCheck || op === '&&' || op === '||' || op === 'IS');
	return (env) => {
		const y = spare ?? new Array(count);
		spare = undefined;
		try {
			for (let i = 0; i < count; i++) y[i] = refs[i](env);
			if (nullable) {
				for (let i = 0; i < count; i++) if (isNullish(y[i])) return undefined;
			}
			return evaluate(y, env);
		} finally {
			spare = y;
		}
	};
}

/** A binary operator over two operands, one closure per operator so each comparison is inlined. */
function plainBinary(op: string, left: Evaluator, right: Evaluator): Evaluator {
	const both =
		(apply: (a: any, b: any) => any): Evaluator =>
		(env) => {
			const a = left(env);
			const b = right(env);
			return isNullish(a) || isNullish(b) ? undefined : apply(a, b);
		};
	switch (op) {
		case '&&':
			return (env) => {
				const a = left(env);
				const b = right(env);
				return a && b;
			};
		case '||':
			return (env) => {
				const a = left(env);
				const b = right(env);
				return a || b;
			};
		case '===':
			return (env) => {
				const a = left(env);
				const b = right(env);
				return isNullish(a) || isNullish(b) ? undefined : a === b;
			};
		case '>':
			return (env) => {
				const a = left(env);
				const b = right(env);
				return isNullish(a) || isNullish(b) ? undefined : a > b;
			};
		case '<':
			return (env) => {
				const a = left(env);
				const b = right(env);
				return isNullish(a) || isNullish(b) ? undefined : a < b;
			};
		case '>=':
			return (env) => {
				const a = left(env);
				const b = right(env);
				return isNullish(a) || isNullish(b) ? undefined : a >= b;
			};
		case '<=':
			return (env) => {
				const a = left(env);
				const b = right(env);
				return isNullish(a) || isNullish(b) ? undefined : a <= b;
			};
		case '+':
			return (env) => {
				const a = left(env);
				const b = right(env);
				return isNullish(a) || isNullish(b) ? undefined : a + b;
			};
		case '*':
			return (env) => {
				const a = left(env);
				const b = right(env);
				return isNullish(a) || isNullish(b) ? undefined : a * b;
			};
		default:
			return both(COMPARISON[op]);
	}
}

function compileUniOp(node: any, cc: CompileContext): Evaluator {
	if (node.right instanceof ast.Column && node.op === '#') {
		// AlaSQL's object store is always empty here.
		return () => undefined;
	}
	const right = compileExpression(node.right, cc);
	switch (node.op) {
		case 'NOT':
			return (env) => !right(env);
		case '-':
			return (env) => -right(env);
		case '+':
			return (env) => +right(env);
		case '~':
			return (env) => ~right(env);
		case undefined:
		case null:
			return right;
	}
	throw new Error(`Unsupported operator: ${node.op}`);
}

/** A JSON literal's value, as `JSONtoJS` wrote it: strings and keys decoded as double-quoted JS literals. */
function compileJson(value: any, cc: CompileContext): Evaluator {
	if (typeof value === 'string') {
		const text = decodeStringLiteral(value, '"');
		return () => text;
	}
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return () => value;
	if (value !== null && typeof value === 'object') {
		if (Array.isArray(value)) {
			const items = value.map((item) => compileJson(item, cc));
			return (env) => items.map((item) => item(env));
		}
		if (typeof value.toString === 'function' && value instanceof ast.Node && !(value instanceof ast.Json)) {
			return compileExpression(value, cc);
		}
		const entries: [string, Evaluator][] = [];
		for (const key in value) {
			entries.push([decodeStringLiteral(key, '"'), compileJson(value[key], cc)]);
		}
		return (env) => {
			// An object literal: a `__proto__` key sets the prototype, as `{"__proto__": ...}` did.
			const object: any = {};
			for (const [key, item] of entries) {
				if (key === '__proto__') {
					const proto = item(env);
					if (proto === null || typeof proto === 'object' || typeof proto === 'function') {
						Object.setPrototypeOf(object, proto);
					}
				} else {
					object[key] = item(env);
				}
			}
			return object;
		};
	}
	// undefined (a NULL inside the literal) wrote nothing, which did not compile.
	throw new SyntaxError('Unexpected token');
}

function compileCase(node: any, cc: CompileContext): Evaluator {
	const whens = node.whens.map((w: any) => [compileExpression(w.when, cc), compileExpression(w.then, cc)]);
	const elses = node.elses ? compileExpression(node.elses, cc) : undefined;
	if (node.expression) {
		const subject = compileExpression(node.expression, cc);
		return (env) => {
			const v = subject(env);
			for (const [when, then] of whens) if (v === when(env)) return then(env);
			return elses ? elses(env) : undefined;
		};
	}
	return (env) => {
		for (const [when, then] of whens) if (when(env)) return then(env);
		return elses ? elses(env) : undefined;
	};
}

/** Compiles an expression node; throws where AlaSQL's generated code would not have compiled. */
export function compileExpression(node: any, cc: CompileContext): Evaluator {
	if (node instanceof ast.Op) return compileOp(node, cc);
	if (node instanceof ast.Column) return compileColumn(node, cc);
	if (node instanceof ast.NumValue) {
		const value = node.value;
		return () => value;
	}
	if (node instanceof ast.StringValue) {
		const value = '' + node.value;
		return () => value;
	}
	if (node instanceof ast.LogicValue) {
		const value = !!node.value;
		return () => value;
	}
	if (node instanceof ast.NullValue) return () => undefined;
	if (node instanceof ast.ParamValue) {
		const param = node.param;
		return (env) => env.params[param];
	}
	if (node instanceof ast.VarValue) return () => undefined;
	if (node instanceof ast.DomainValueValue) return (env) => env.s;
	if (node instanceof ast.UniOp) return compileUniOp(node, cc);
	if (node instanceof ast.FuncValue) {
		// An inlined function's arguments were compiled without the column definitions (`arg.toJS(context,
		// tableid)`), so an unqualified column in them reads the default source rather than any source.
		const argContext = functions.isInlineFunction(node.funcid) ? { context: cc.context, tableid: cc.tableid } : cc;
		const args = (node.args ?? []).map((arg: any) => compileExpression(arg, argContext));
		return compileFunctionCall(node.funcid, args, node.newid) as Evaluator;
	}
	if (node instanceof ast.AggrValue) {
		const key = aggregateKey(node);
		if (cc.context === 'g') return (env) => env.s[key];
		// Outside a group, the generated `g['...']` read a group that did not exist yet.
		return () => {
			throw new TypeError(`Cannot read properties of undefined (reading '${key}')`);
		};
	}
	if (node instanceof ast.CaseValue) return compileCase(node, cc);
	if (node instanceof ast.Convert)
		return compileConvert(node as any, compileExpression(node.expression, cc)) as Evaluator;
	if (node instanceof ast.Json) return compileJson(node.value, cc);
	if (node instanceof ast.ArrayValue) {
		const items = node.value.map((item: any) => compileExpression(item, cc));
		return (env) => items.map((item: Evaluator) => item(env));
	}
	if (node instanceof ast.ExistsValue) {
		const index = node.existsidx;
		return (env) => !!env.query.existsfn[index](env.params, null, env.s).data.length;
	}
	if (node instanceof ast.Select) {
		const index = node.queriesidx - 1;
		const inGroup = cc.context === 'g';
		return (env) => {
			const outer = inGroup ? env.query.groupSources?.get(env.s) || env.s : env.s;
			return flatArray(env.query.queriesfn[index](env.params, null, outer))[0];
		};
	}
	if (node instanceof ast.Expression) return compileExpression(node.expression, cc);
	if (node instanceof ast.JavaScript) {
		throw new ClientError('JavaScript expressions are not supported in SQL');
	}
	throw new Error(`Unsupported SQL expression: ${node?.constructor?.name ?? typeof node}`);
}
