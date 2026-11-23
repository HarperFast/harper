/**
 * Writers for literal values in SQL text. Legacy SQL authorizes the parsed statement but runs the statement's
 * `toString()` text, so that text must parse back to every literal a literal and every name one name.
 */
import { ClientError } from '../../utility/errors/hdbError.ts';

/**
 * Single-quoted text that the lexer decodes back to `value`, or undefined when there is none. A backslash takes
 * the next character, and `\'` and `''` decode to `'`, so an odd run of backslashes at the end has no spelling.
 */
export function quoteString(value: string): string | undefined {
	let text = "'";
	let i = 0;
	while (i < value.length) {
		let backslashes = 0;
		while (value[i + backslashes] === '\\') backslashes++;
		const next = value[i + backslashes];
		if (next === undefined) {
			if (backslashes % 2) return undefined;
			text += value.slice(i);
			break;
		}
		if (next === "'") {
			if (backslashes % 2) text += '\\'.repeat(backslashes + 1) + "''";
			else text += '\\'.repeat(backslashes) + (backslashes ? "\\'" : "''");
		} else {
			text += value.slice(i, i + backslashes + 1);
		}
		i += backslashes + 1;
	}
	return text + "'";
}

// A JSON key is the token body undecoded, so it must lex as it stands inside one of the quotes.
function quoteKey(key: string): string | undefined {
	if (lexesInside(key, '"')) return `"${key}"`;
	if (lexesInside(key, "'")) return `'${key}'`;
}

function lexesInside(body: string, quote: string): boolean {
	for (let i = 0; i < body.length; i++) {
		if (body[i] === '\\') {
			if (++i >= body.length) return false;
		} else if (body[i] === quote && body[++i] !== quote) {
			return false;
		}
	}
	return true;
}

/** `1e+25` lexes as `1e + 25` and `Infinity` as a column, so every number is written in plain decimal. */
export function numberText(value: number): string {
	if (!Number.isFinite(value)) throw unwritable(`The number ${value}`);
	const text = String(value);
	const e = text.indexOf('e');
	if (e < 0) return text;
	const sign = text[0] === '-' ? '-' : '';
	const [whole, fraction = ''] = text.slice(sign.length, e).split('.');
	const digits = whole + fraction;
	const point = whole.length + Number(text.slice(e + 1));
	if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
	if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
	return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** A generated result name that reads back as one name: in brackets, or in double quotes when it holds `]`. */
export function generatedName(name: string): string {
	if (!name.includes(']')) return `[${name}]`;
	if (!name.includes('"')) return `"${name}"`;
	throw unwritable(`The name ${JSON.stringify(name)}`);
}

export function unwritable(what: string) {
	return new ClientError(
		`${what} cannot be written back to SQL text for the legacy SQL engine. Remove the quotes, backticks, brackets or backslashes, or use the new SQL engine.`
	);
}

export function isJsonData(value: any): boolean {
	return Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype;
}

/** The text of a JSON literal's value: nested objects and arrays, scalars, and AST nodes it holds. */
export function jsonText(value: any): string {
	if (typeof value === 'string') {
		const text = quoteString(value);
		if (text === undefined) throw unwritable('A string in a JSON literal');
		return text;
	}
	if (value == null) return 'NULL';
	if (typeof value === 'number') return numberText(value);
	if (typeof value !== 'object') return String(value);
	// Any other object is an AST node inside the literal, a nested JSON literal included.
	if (!isJsonData(value)) return value.toString();
	if (Array.isArray(value)) return `@[${value.map(jsonText).join(',')}]`;
	const properties = [];
	for (const key in value) {
		const keyText = quoteKey(key);
		if (keyText === undefined) throw unwritable('A key in a JSON literal');
		properties.push(`${keyText}:${jsonText(value[key])}`);
	}
	return `{${properties.join(',')}}`;
}
