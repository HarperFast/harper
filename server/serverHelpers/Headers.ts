/**
 * Fast implementation of standard Headers
 */
export class Headers extends Map<string, [string, string | string[]]> {
	constructor(init?: Headers | HeadersInit) {
		if (init) {
			if ((init as any)[Symbol.iterator]) {
				super(init as any);
			} else {
				super();
				for (const name in init) this.set(name, init[name]);
			}
		} else super();
	}
	set(name, value) {
		if (typeof name !== 'string') name = '' + name;
		if (Array.isArray(value)) {
			// Ensure all array elements are strings
			value = value.map((v) => (typeof v === 'string' ? v : '' + v));
		} else if (typeof value !== 'string') {
			value = '' + value;
		}
		return super.set(name.toLowerCase(), [name, value]);
	}
	// @ts-ignore
	get(name) {
		if (typeof name !== 'string') name = '' + name;
		return super.get(name.toLowerCase())?.[1];
	}
	has(name) {
		if (typeof name !== 'string') name = '' + name;
		return super.has(name.toLowerCase());
	}
	setIfNone(name, value) {
		if (typeof name !== 'string') name = '' + name;
		if (typeof value !== 'string') value = '' + value;
		const lowerName = name.toLowerCase();
		if (!super.has(lowerName)) return super.set(lowerName, [name, value]);
	}
	append(name: any, value: any, commaDelimited?: any) {
		if (typeof name !== 'string') name = '' + name;
		if (typeof value !== 'string') value = '' + value;
		const lowerName = name.toLowerCase();
		const existing = super.get(lowerName);
		if (existing) {
			const existingValue = existing[1];
			if (commaDelimited)
				value = (typeof existingValue === 'string' ? existingValue : (existingValue as any).join(', ')) + ', ' + value;
			else if (typeof existingValue === 'string') value = [existingValue, value];
			else {
				(existingValue as any).push(value);
				return;
			}
		}
		return super.set(lowerName, [name, value]);
	}
	// @ts-expect-error return type differs from Map
	[Symbol.iterator]() {
		return super.values()[Symbol.iterator]();
	}
}

export function appendHeader(headers, name, value, commaDelimited) {
	if (headers.append) {
		headers.append(name, value, commaDelimited);
	} else if (headers.set) {
		const existingValue = headers.get(name);
		if (existingValue) {
			if (commaDelimited)
				value = (typeof existingValue === 'string' ? existingValue : (existingValue as any).join(', ')) + ', ' + value;
			else if (typeof existingValue === 'string') value = [existingValue, value];
			else {
				(existingValue as any).push(value);
				return;
			}
		}
		return headers.set(name, value);
	} else {
		headers[name] = (headers[name] ? headers[name] + ', ' : '') + value;
	}
}

/**
 * Merge headers from source into target, ensuring that target is a Headers object, and avoiding any overwrite
 * of existing headers in target.
 * @param target
 * @param source
 */
export function mergeHeaders(target: any, source: Headers) {
	// ensure target is a Headers object, which could be this Headers class, the global.Headers, or even a Map, which is ok
	if (typeof target.set !== 'function' || typeof target.has !== 'function') target = new Headers(target);
	for (const [name, value] of source) {
		if (!target.has(name)) target.set(name, value);
		else if (name.toLowerCase() === 'set-cookie') {
			// Set-Cookie headers must NEVER be comma-delimited
			// If value is an array, append each one separately; otherwise append the single value
			const values = Array.isArray(value) ? value : [value];
			if (target.append) {
				for (const v of values) target.append(name, v);
			} else {
				// Fallback for Map or objects without append method
				// We know existing exists because we're in the else-if branch (target.has(name) is true)
				const existing = target.get(name);
				const newValue = Array.isArray(existing) ? [...existing, ...values] : [existing, ...values];
				target.set(name, newValue);
			}
		}
	}
	return target;
}

/**
 * Normalize a response's headers into the form `ServerResponse.writeHead` accepts.
 *
 * `writeHead`'s array form is a FLAT `[name, value, name, value]` list, not a list of tuples — so an
 * iterable of `[name, value]` pairs (a `Headers`/`Map`) must be turned into an object. Passing
 * `Array.from(headers)` (nested `[[name, value], …]`) makes Node read a tuple as a header name and throw
 * `TypeError: The "name" argument must be of type string. Received an instance of Array`.
 *
 * Multi-valued headers (notably `Set-Cookie`, which by spec retains its multiple values when iterating
 * a `Headers` object instead of being comma-joined) must be grouped into arrays rather than collapsed
 * via `Object.fromEntries` last-wins. `writeHead` accepts `{name: ['value1', 'value2']}` for that, and
 * emits the values as separate header lines on the wire. A plain object (or a falsy value, e.g. when
 * there are no headers) is returned unchanged.
 */
export function toWriteHeadHeaders(headers: any): any {
	if (!headers) return headers;
	if (!headers[Symbol.iterator]) return headers;
	const result: Record<string, string | string[]> = {};
	for (const [name, value] of headers) {
		const existing = result[name];
		if (existing === undefined) result[name] = value;
		else if (Array.isArray(existing)) existing.push(value);
		else result[name] = [existing, value];
	}
	return result;
}
