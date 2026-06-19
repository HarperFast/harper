// QA-146 — Custom-Resource HTTP contract probe.
//
// Probes the contract app developers build on:
//   - verb routing: does each HTTP method invoke the matching resource method, with right args?
//   - custom status + headers honored on the wire?
//   - error mapping: thrown plain Error vs error-with-.statusCode vs ClientError vs returned
//     error-shaped value -> what HTTP status?
//   - content negotiation on a CUSTOM return value (json/cbor/msgpack)
//   - odd return types: primitive, huge array, null, undefined.
//
// Live REST path (server/REST.ts switch) calls handlers as:
//   GET    resource.get(target, request)
//   POST   resource.post(target, data, request)
//   PUT    resource.put(target, data, request)
//   PATCH  resource.patch(target, data, request)
//   DELETE resource.delete(target, request)
// For loadAsInstance=false the first arg is the query/RequestTarget.
//
// Custom status: this.getContext().response.status = N, OR return a web Response.
// Custom headers: this.getContext().response.headers.set(name, value), OR Response headers.

// ---------------------------------------------------------------------------
// VERB ROUTING — one resource overriding every verb; each records which method
// ran and what args it observed, so the test can assert correct routing.
// ---------------------------------------------------------------------------
export class Verbs extends Resource {
	static loadAsInstance = false;
	async get(query, request) {
		return { method: 'get', argc: arguments.length, hasReq: !!request, dataArg: undefined };
	}
	async post(query, data, request) {
		return { method: 'post', argc: arguments.length, hasReq: !!request, dataArg: data };
	}
	async put(query, data, request) {
		return { method: 'put', argc: arguments.length, hasReq: !!request, dataArg: data };
	}
	async patch(query, data, request) {
		return { method: 'patch', argc: arguments.length, hasReq: !!request, dataArg: data };
	}
	async delete(query, request) {
		return { method: 'delete', argc: arguments.length, hasReq: !!request, dataArg: undefined };
	}
}

// ---------------------------------------------------------------------------
// CUSTOM STATUS + HEADERS via getContext().response
// ---------------------------------------------------------------------------
export class StatusCtx extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const want = Number((query.get && query.get('code')) || 201);
		const ctx = this.getContext();
		if (ctx?.response) {
			ctx.response.status = want;
			ctx.response.headers.set('X-QA146', 'ctx-' + want);
			ctx.response.headers.set('X-Custom-Foo', 'bar');
		}
		return { setVia: 'context', code: want };
	}
}

// CUSTOM STATUS + HEADERS via a returned web Response object
export class StatusResponse extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const want = Number((query.get && query.get('code')) || 202);
		return new Response(JSON.stringify({ setVia: 'Response', code: want }), {
			status: want,
			headers: { 'Content-Type': 'application/json', 'X-QA146': 'resp-' + want },
		});
	}
}

// Response object with `data` (let Harper serialize/negotiate) + explicit status/headers
export class StatusResponseData extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const want = Number((query.get && query.get('code')) || 418);
		return { status: want, headers: { 'X-QA146': 'respdata-' + want }, data: { setVia: 'Response.data', code: want } };
	}
}

// ---------------------------------------------------------------------------
// ERROR MAPPING
// ---------------------------------------------------------------------------
// Throw a PLAIN Error (no statusCode). Intended-vs-actual: does it leak as 500?
export class ErrPlain extends Resource {
	static loadAsInstance = false;
	async get() {
		throw new Error('QA146 plain error, no statusCode');
	}
}

// Throw an Error carrying a .statusCode (the documented escape hatch).
export class ErrStatusCode extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const code = Number((query.get && query.get('code')) || 400);
		const e = new Error('QA146 error with statusCode=' + code);
		e.statusCode = code;
		throw e;
	}
}

// Throw a Harper ClientError (defaults to 400 if no code passed).
export class ErrClient extends Resource {
	static loadAsInstance = false;
	async get(query) {
		// ClientError is available in the resource sandbox? Try; fall back to statusCode error.
		const code = query.get && query.get('code');
		if (typeof ClientError !== 'undefined') {
			throw code ? new ClientError('QA146 ClientError', Number(code)) : new ClientError('QA146 ClientError default');
		}
		const e = new Error('QA146 (ClientError unavailable, simulated)');
		e.statusCode = code ? Number(code) : 400;
		throw e;
	}
}

// RETURN an error-shaped value (NOT thrown) — does the body just serialize with 200?
export class ErrReturned extends Resource {
	static loadAsInstance = false;
	async get() {
		return { error: 'QA146 returned-but-not-thrown', statusCode: 400, code: 'BadRequest' };
	}
}

// Throw a non-Error (string) — how is it mapped?
export class ErrString extends Resource {
	static loadAsInstance = false;
	async get() {
		throw 'QA146 thrown string (not an Error)';
	}
}

// ---------------------------------------------------------------------------
// CONTENT NEGOTIATION on a custom return value
// ---------------------------------------------------------------------------
export class Negotiate extends Resource {
	static loadAsInstance = false;
	async get() {
		return { kind: 'negotiate', n: 42, list: [1, 2, 3], nested: { a: true, b: null }, s: 'héllo-ünïcode' };
	}
}

// ---------------------------------------------------------------------------
// ODD RETURN TYPES
// ---------------------------------------------------------------------------
export class RetString extends Resource {
	static loadAsInstance = false;
	async get() {
		return 'just a bare string';
	}
}
export class RetNumber extends Resource {
	static loadAsInstance = false;
	async get() {
		return 1234.5;
	}
}
export class RetBool extends Resource {
	static loadAsInstance = false;
	async get() {
		return true;
	}
}
export class RetNull extends Resource {
	static loadAsInstance = false;
	async get() {
		return null;
	}
}
export class RetUndefined extends Resource {
	static loadAsInstance = false;
	async get() {
		return undefined;
	}
}
export class RetArrayHuge extends Resource {
	static loadAsInstance = false;
	async get() {
		const n = 50000;
		const out = new Array(n);
		for (let i = 0; i < n; i++) out[i] = { i, v: 'row-' + i };
		return out;
	}
}
// Async iterator / streamed response
export class RetAsyncIter extends Resource {
	static loadAsInstance = false;
	async get() {
		async function* gen() {
			for (let i = 0; i < 5; i++) yield { i, v: 'stream-' + i };
		}
		return gen();
	}
}
