/**
 * AST node classes for Harper's SQL dialect. Each node is a plain property bag (`Object.assign(this, params)`),
 * with the same class names and properties AlaSQL's parser produced, because the permission check, the legacy
 * engine and the new engine's normalizer all walk these properties. `toString()` writes the node back as SQL
 * text that parses to the same node: legacy SQL runs that text, so the writers for string, JSON and number
 * literals quote and spell values so they read back as the same value (see sqlText.ts).
 */
import { AGGREGATE_FUNCTIONS, SCALAR_FUNCTIONS, STANDARD_FUNCTIONS } from './functionNames.ts';
import { jsonText, numberText, quoteString, unwritable } from './sqlText.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

export class Node {
	[key: string]: any;
	constructor(params?: Record<string, any>) {
		Object.assign(this, params);
	}
}

export class Statements extends Node {
	toString() {
		return this.statements.map((statement: any) => statement.toString()).join('; ');
	}
}

export class Select extends Node {
	toString() {
		let s = '';
		if (this.explain) s += 'EXPLAIN ';
		s += 'SELECT ';
		if (this.modifier) s += this.modifier + ' ';
		if (this.distinct) s += 'DISTINCT ';
		if (this.distinctOn) s += 'DISTINCT ON (' + this.distinctOn.map((e: any) => e.toString()).join(',') + ') ';
		if (this.top) {
			s += 'TOP ' + this.top.toString() + ' ';
			if (this.percent) s += 'PERCENT ';
		}
		s += this.columns
			.map((col: any) => {
				let text = col.toString();
				if (typeof col.as !== 'undefined') text += ' AS ' + col.as;
				return text;
			})
			.join(', ');
		if (this.from) {
			s +=
				' FROM ' +
				this.from
					.map((f: any) => {
						let text = f.toString();
						if (f.as) text += ' AS ' + f.as;
						return text;
					})
					.join(',');
		}
		if (this.joins) {
			s += this.joins
				.map((jn: any) => {
					let text = ' ';
					if (jn.joinmode) text += jn.joinmode + ' ';
					if (jn.table) text += 'JOIN ' + jn.table.toString();
					else if (jn.select) text += 'JOIN (' + jn.select.toString() + ')';
					else if (jn instanceof Apply) text += jn.toString();
					else throw new Error('Wrong type in JOIN mode');
					if (jn.as) text += ' AS ' + jn.as;
					if (jn.using) text += ' USING ' + jn.using.toString();
					if (jn.on) text += ' ON ' + jn.on.toString();
					return text;
				})
				.join('');
		}
		if (this.where) s += ' WHERE ' + this.where.toString();
		if (this.group && this.group.length > 0) s += ' GROUP BY ' + this.group.map((g: any) => g.toString()).join(', ');
		if (this.having) s += ' HAVING ' + this.having.toString();
		if (this.order && this.order.length > 0) s += ' ORDER BY ' + this.order.map((o: any) => o.toString()).join(', ');
		if (this.limit) s += ' LIMIT ' + this.limit.toString();
		if (this.offset) s += ' OFFSET ' + this.offset.toString();
		const corresponding = this.corresponding ? 'CORRESPONDING ' : '';
		if (this.union) s += ' UNION ' + corresponding + this.union.toString();
		if (this.unionall) s += ' UNION ALL ' + corresponding + this.unionall.toString();
		if (this.except) s += ' EXCEPT ' + corresponding + this.except.toString();
		if (this.intersect) s += ' INTERSECT ' + corresponding + this.intersect.toString();
		return s;
	}
}

function outputText(output: any): string {
	if (!output) return '';
	let s = ' OUTPUT ' + output.columns.map((col: any) => col.toString()).join(', ');
	if (output.intovar) {
		s += ' INTO ' + output.method + output.intovar;
	} else if (output.intotable) {
		s += ' INTO ' + output.intotable.toString();
		if (output.intocolumns) s += '(' + output.intocolumns.map((col: any) => col.toString()).join(', ') + ')';
	}
	return s;
}

export class Insert extends Node {
	toString() {
		let s = 'INSERT ';
		if (this.orreplace) s += 'OR REPLACE ';
		if (this.replaceonly) s = 'REPLACE ';
		if (this.ignore) s += 'IGNORE ';
		s += 'INTO ' + this.into.toString();
		if (this.columns) s += '(' + this.columns.toString() + ')';
		if (this.values) s += ' VALUES ' + this.values.map((value: any) => '(' + value.toString() + ')').join(',');
		if (this.select) s += ' ' + this.select.toString();
		if (this.setcolumns) s += ' SET ' + this.setcolumns.map((col: any) => col.toString()).join(', ');
		return s + outputText(this.output);
	}
}

export class Update extends Node {
	toString() {
		let s = 'UPDATE ' + this.table.toString();
		if (this.columns) s += ' SET ' + this.columns.toString();
		if (this.where) s += ' WHERE ' + this.where.toString();
		return s + outputText(this.output);
	}
}

export class Delete extends Node {
	toString() {
		let s = 'DELETE FROM ' + this.table.toString();
		if (this.where) s += ' WHERE ' + this.where.toString();
		return s + outputText(this.output);
	}
}

export class SetColumn extends Node {
	toString() {
		return this.column.toString() + '=' + this.expression.toString();
	}
}

export class Expression extends Node {
	toString() {
		let s = this.expression.toString();
		if (this.order) s += ' ' + this.order.toString();
		if (this.nocase) s += ' COLLATE NOCASE';
		if (this.direction) s += ' ' + this.direction;
		return s;
	}
}

export class JavaScript extends Node {
	toString() {
		return '``' + this.value + '``';
	}
}

export class Join extends Node {
	toString() {
		let s = ' ';
		if (this.joinmode) s += this.joinmode + ' ';
		return s + 'JOIN ' + this.table.toString();
	}
}

export class Apply extends Node {
	toString() {
		let s = `${this.applymode} APPLY (${this.select.toString()})`;
		if (this.as) s += ` AS ${this.as}`;
		return s;
	}
}

export class Table extends Node {
	toString() {
		let s = this.tableid;
		if (this.databaseid) s = this.databaseid + '.' + s;
		return s;
	}
}

export class Op extends Node {
	toString() {
		const text = this.baseText();
		return this.escape && (this.op === 'LIKE' || this.op === 'NOT LIKE')
			? `${text} ESCAPE ${this.escape.toString()}`
			: text;
	}

	private baseText(): string {
		const leftText = this.left.toString();
		if (this.op === 'IN' || this.op === 'NOT IN') return `${leftText} ${this.op} (${this.right.toString()})`;
		if (this.allsome) return `${leftText} ${this.op} ${this.allsome} (${this.right.toString()})`;
		if (this.op === '->' || this.op === '!') {
			const s = `${leftText}${this.op}`;
			if (typeof this.right !== 'string' && typeof this.right !== 'number') return s + `(${this.right.toString()})`;
			return s + this.right.toString();
		}
		if (this.op === 'BETWEEN' || this.op === 'NOT BETWEEN') {
			return `${leftText} ${this.op} ${this.right1.toString()} AND ${this.right2.toString()}`;
		}
		return `${leftText} ${this.op} ${this.right.toString()}`;
	}
}

export class VarValue extends Node {
	toString() {
		return '@' + this.variable;
	}
}

export class NumValue extends Node {
	toString() {
		return typeof this.value === 'number' ? numberText(this.value) : String(this.value);
	}
}

export class StringValue extends Node {
	toString() {
		const text = quoteString(String(this.value));
		if (text === undefined) throw unwritable('A string literal');
		return text;
	}
}

export class DomainValueValue extends Node {
	toString() {
		return 'VALUE';
	}
}

export class ArrayValue extends Node {
	toString() {
		return 'ARRAY[]';
	}
}

export class LogicValue extends Node {
	toString() {
		return this.value ? 'TRUE' : 'FALSE';
	}
}

export class NullValue extends Node {
	toString() {
		return 'NULL';
	}
}

export class ParamValue extends Node {
	toString() {
		return '$' + this.param;
	}
}

export class UniOp extends Node {
	toString() {
		const text = this.right.toString();
		switch (this.op) {
			case '~':
			case '-':
			case '+':
			case '#':
				return this.op + text;
			case 'NOT':
				return this.op + '(' + text + ')';
			default:
				return '(' + text + ')';
		}
	}
}

const NEEDS_BRACKETS = /[\s.\-[\]]/;

function needsBrackets(id: any): boolean {
	if (id == null) return false;
	// eslint-disable-next-line eqeqeq
	if (id == +id) return true;
	return NEEDS_BRACKETS.test(id);
}

function wrapId(id: any): string {
	return needsBrackets(id) ? '[' + id + ']' : id;
}

export class Column extends Node {
	toString() {
		const bracketed = needsBrackets(this.columnid);
		let s = bracketed ? '[' + this.columnid + ']' : this.columnid;
		if (this.tableid) {
			s = wrapId(this.tableid) + (bracketed ? '' : '.') + s;
			if (this.databaseid) s = wrapId(this.databaseid) + '.' + s;
		}
		return s;
	}
}

const INVALID_FUNCTION_NAME_CHARS = /[^0-9A-Z_$]+/i;

export class AggrValue extends Node {
	toString() {
		const name =
			this.aggregatorid === 'REDUCE' ? this.funcid.replace(INVALID_FUNCTION_NAME_CHARS, '') : this.aggregatorid;
		const distinct = this.distinct ? 'DISTINCT ' : '';
		const expression = this.expression ? this.expression.toString() : '';
		const over = this.over ? ` ${this.over.toString()}` : '';
		return `${name}(${distinct}${expression})${over}`;
	}
}

export class FuncValue extends Node {
	toString() {
		let s = '';
		if (SCALAR_FUNCTIONS.has(this.funcid) || AGGREGATE_FUNCTIONS.has(this.funcid)) s += this.funcid;
		else if (STANDARD_FUNCTIONS.has(this.funcid.toUpperCase())) {
			s += this.funcid.toUpperCase().replace(INVALID_FUNCTION_NAME_CHARS, '');
		}
		if (this.funcid !== 'CURRENT_TIMESTAMP') {
			s += '(';
			if (this.args && this.args.length > 0) s += this.args.map((arg: any) => arg.toString()).join(',');
			s += ')';
		}
		if (this.over) s += ' ' + this.over.toString();
		return s;
	}
}

export class CaseValue extends Node {
	toString() {
		let s = 'CASE ';
		if (this.expression) s += this.expression.toString();
		if (this.whens) {
			s += this.whens.map((w: any) => ' WHEN ' + w.when.toString() + ' THEN ' + w.then.toString()).join();
		}
		return s + ' END';
	}
}

export class Json extends Node {
	toString() {
		return jsonText(this.value);
	}
}

export class Convert extends Node {
	toString() {
		let s = 'CONVERT(' + this.dbtypeid;
		if (typeof this.dbsize != 'undefined') {
			s += '(' + this.dbsize;
			if (this.dbprecision) s += ',' + this.dbprecision;
			s += ')';
		}
		s += ',' + this.expression.toString();
		if (this.style) s += ',' + this.style;
		return s + ')';
	}
}

export class ExistsValue extends Node {
	toString() {
		return 'EXISTS(' + this.value.toString() + ')';
	}
}

export class Over extends Node {
	toString() {
		let s = 'OVER (';
		if (this.partition) {
			s += `PARTITION BY ${this.partition.toString()}`;
			if (this.order) s += ' ';
		}
		if (this.order) s += `ORDER BY ${this.order.toString()}`;
		return s + ')';
	}
}

export class GroupExpression extends Node {
	toString() {
		return this.type + '(' + this.group.toString() + ')';
	}
}
