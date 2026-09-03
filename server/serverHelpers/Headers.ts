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

/**
 * Add a field-name token to the `Vary` response header, appending to (and de-duplicating against) any
 * existing value rather than overwriting it. Used to declare cache-partitioning dimensions (Origin,
 * Authorization, Cookie) so a shared cache/CDN keys the response correctly (#1518, #1565).
 */
export function addVaryHeader(
	headers: { get(name: string): any; set(name: string, value: string): any },
	token: string
) {
	const existing = headers.get('Vary');
	if (!existing) {
		headers.set('Vary', token);
		return;
	}
	const existingString = Array.isArray(existing) ? existing.join(', ') : existing;
	const lowerToken = token.toLowerCase();
	for (const part of existingString.split(',')) {
		const trimmed = part.trim().toLowerCase();
		// a `Vary: *` already covers every dimension, and an exact token match is a no-op
		if (trimmed === lowerToken || trimmed === '*') return;
	}
	headers.set('Vary', existingString + ', ' + token);
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

// RFC 9111 cache-scope directives; boundaries on both sides so a token like `public-foo` doesn't match.
export const SHARED_CACHE_OPTIN = /(^|[,\s])(public|s-maxage)($|[\s,;=])/i;
export const PRIVATE_SCOPE = /(^|[,\s])(private|no-store)($|[\s,;=])/i;

function headerValueString(value: unknown): string {
	if (value == null) return '';
	return Array.isArray(value) ? value.join(', ') : String(value);
}

/**
 * Folds the middleware chain's response headers into the headers a fallback server produced for the
 * same request.
 *
 * Bun and uWS construct a new response from legacy Fastify when the chain declines a request, so the
 * chain's credential-dependent cache policy must be merged explicitly. Fastify wins headers it set,
 * `Vary` is unioned, and private cache scope is re-applied unless the final response explicitly opts
 * into RFC 9111 shared caching with `public` or `s-maxage`.
 */
export function mergeChainHeadersIntoFallback<
	T extends {
		get(name: string): any;
		set(name: string, value: any): any;
		has(name: string): boolean;
		append?(name: string, value: any): any;
	},
>(chainHeaders: any, finalHeaders: T): T {
	if (!chainHeaders?.[Symbol.iterator]) return finalHeaders;
	const chainVary = headerValueString(chainHeaders.get('Vary'));
	const chainCacheControl = headerValueString(chainHeaders.get('Cache-Control'));
	for (const [name, value] of chainHeaders) {
		const lowerName = String(name).toLowerCase();
		if (lowerName === 'vary' || lowerName === 'cache-control') continue;
		if (finalHeaders.has(name)) continue;
		if (Array.isArray(value)) {
			// Set-Cookie is the multi-valued case that must never be comma-joined.
			for (const single of value) appendHeader(finalHeaders, name, single, lowerName !== 'set-cookie');
		} else finalHeaders.set(name, value);
	}
	for (const token of chainVary.split(',')) {
		const trimmed = token.trim();
		if (trimmed) addVaryHeader(finalHeaders as any, trimmed);
	}
	if (chainCacheControl) {
		const finalCacheControl = headerValueString(finalHeaders.get('Cache-Control'));
		if (!finalCacheControl) finalHeaders.set('Cache-Control', chainCacheControl);
		else if (
			PRIVATE_SCOPE.test(chainCacheControl) &&
			!PRIVATE_SCOPE.test(finalCacheControl) &&
			!SHARED_CACHE_OPTIN.test(finalCacheControl)
		)
			finalHeaders.set('Cache-Control', finalCacheControl + ', private');
	}
	return finalHeaders;
}

/**
 * Presents a Node `ServerResponse`'s live header set through the Headers-like surface
 * `mergeChainHeadersIntoFallback` and `addVaryHeader` expect.
 */
function nodeResponseHeaders(nodeResponse: any) {
	return {
		get: (name: string) => nodeResponse.getHeader(name),
		set: (name: string, value: any) => nodeResponse.setHeader(name, value),
		has: (name: string) => nodeResponse.hasHeader(name),
		append: (name: string, value: any, commaDelimited?: boolean) => {
			const existing = nodeResponse.getHeader(name);
			if (existing == null) return nodeResponse.setHeader(name, value);
			if (commaDelimited)
				return nodeResponse.setHeader(name, (Array.isArray(existing) ? existing.join(', ') : existing) + ', ' + value);
			return nodeResponse.setHeader(name, Array.isArray(existing) ? [...existing, value] : [existing, value]);
		},
	};
}

/** `writeHead` accepts a flat `[name, value, …]` array, a `[name, value][]` array, or an object. */
function applyWriteHeadHeaders(nodeResponse: any, headers: any): void {
	if (Array.isArray(headers)) {
		if (Array.isArray(headers[0])) {
			for (const [name, value] of headers) nodeResponse.setHeader(name, value);
		} else {
			for (let i = 0; i + 1 < headers.length; i += 2) nodeResponse.setHeader(headers[i], headers[i + 1]);
		}
		return;
	}
	for (const name of Object.keys(headers)) {
		const value = headers[name];
		if (value != null) nodeResponse.setHeader(name, value);
	}
}

/**
 * Node's counterpart to the Bun and uWS fallback bridges: the chain's headers go onto the
 * `ServerResponse` before legacy Fastify runs, so a Fastify route that sets `Cache-Control` or `Vary`
 * replaces them outright and can make a credential-dependent response shared-cacheable (#1565).
 * Reconciliation therefore runs at `writeHead` — the last point the header set is still mutable, and
 * the one Node also routes implicit headers through — using the same policy as the other two bridges.
 */
export function bridgeChainHeadersToNodeResponse(chainHeaders: any, nodeResponse: any): void {
	if (!chainHeaders?.[Symbol.iterator]) return;
	for (const [name, value] of chainHeaders) nodeResponse.setHeader(name, value);
	const originalWriteHead = nodeResponse.writeHead;
	nodeResponse.writeHead = function (statusCode: number, statusMessage?: any, headers?: any) {
		if (this.headersSent) return originalWriteHead.apply(this, arguments as any);
		if (statusMessage != null && typeof statusMessage !== 'string') {
			headers = statusMessage;
			statusMessage = undefined;
		}
		if (headers) applyWriteHeadHeaders(this, headers);
		mergeChainHeadersIntoFallback(chainHeaders, nodeResponseHeaders(this));
		return statusMessage === undefined
			? originalWriteHead.call(this, statusCode)
			: originalWriteHead.call(this, statusCode, statusMessage);
	};
}
