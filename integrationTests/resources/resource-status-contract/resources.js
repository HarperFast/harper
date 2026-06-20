/* oxlint-disable no-undef -- intentionally references the (absent) ClientError sandbox global to characterize D-070 */
// QA-195 — Custom-Resource AUTHOR status-code + body contract.
//
// Probes the full return/throw matrix that a custom Resource author can produce:
//
// RETURN shapes (all via ReturnMatrix GET ?case=<name>):
//   plain-object | array | string | number | bool-true | bool-false | null | undefined | promise-object
//
// THROW shapes (all via ThrowMatrix GET ?case=<name>):
//   plain-error       -> throw new Error('msg')
//   statuscode-400    -> Error with .statusCode=400
//   statuscode-404    -> Error with .statusCode=404
//   client-error-def  -> new ClientError('msg')   [default 400]
//   client-error-422  -> new ClientError('msg', 422)
//   bare-string       -> throw 'oops'
//   bare-number       -> throw 404
//   obj-statusCode    -> throw {statusCode: 404, message: 'nope'}
//   obj-status        -> throw {status: 400, body: 'bad'}  (status field, not statusCode)
//   throw-response    -> throw new Response('body', {status: 422})
//   reject-promise    -> get() returns Promise.reject(new Error('rejected'))
//   null-throw        -> throw null
//
// POST/PUT throw shapes (ThrowPost, ThrowPut): same cases via body {case:...}
//
// Additional probes:
//   /StatusViaContext/?code=N  -> set status via this.getContext().response.status
//   /StatusViaResponse/?code=N -> return new Response(body, {status:N})
//   /StatusViaObjStatus/?code=N -> return {status:N, data:{ok:true}}  (obj-status pattern)
//   /Liveness/                 -> always returns {alive:true, method:'get'}

// ---------------------------------------------------------------------------
// RETURN MATRIX — ?case=<name>
// ---------------------------------------------------------------------------
export class ReturnMatrix extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const c = query?.get && query.get('case');
		switch (c) {
			case 'plain-object':
				return { value: 1, label: 'plain-object' };
			case 'array':
				return [1, 2, 3];
			case 'string':
				return 'hello';
			case 'number':
				return 42;
			case 'bool-true':
				return true;
			case 'bool-false':
				return false;
			case 'null':
				return null;
			case 'undefined':
				return undefined;
			case 'promise-object':
				return Promise.resolve({ value: 'from-promise' });
			default:
				return { error: 'unknown case', case: c };
		}
	}
}

// ---------------------------------------------------------------------------
// THROW MATRIX — ?case=<name>
// ---------------------------------------------------------------------------
export class ThrowMatrix extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const c = query?.get && query.get('case');
		switch (c) {
			case 'plain-error':
				throw new Error('QA195 plain error message');

			case 'statuscode-400': {
				const e = new Error('QA195 error.statusCode=400 message');
				e.statusCode = 400;
				throw e;
			}
			case 'statuscode-404': {
				const e = new Error('QA195 error.statusCode=404 message');
				e.statusCode = 404;
				throw e;
			}
			case 'client-error-def':
				// ClientError is injected into the resource sandbox via the framework
				if (typeof ClientError !== 'undefined') {
					throw new ClientError('QA195 ClientError default (400)');
				}
				// fallback: plain error with statusCode
				{
					const e = new Error('QA195 ClientError-unavailable fallback');
					e.statusCode = 400;
					throw e;
				}

			case 'client-error-422':
				if (typeof ClientError !== 'undefined') {
					throw new ClientError('QA195 ClientError 422', 422);
				}
				{
					const e = new Error('QA195 ClientError-422 fallback');
					e.statusCode = 422;
					throw e;
				}

			case 'bare-string':
				throw 'QA195 bare thrown string';

			case 'bare-number':
				throw 404;

			case 'obj-statusCode':
				// Plain object with .statusCode — not an Error instance
				throw { statusCode: 404, message: 'QA195 obj-statusCode nope' };

			case 'obj-status':
				// Plain object with .status (NOT .statusCode) — common mistake
				throw { status: 400, body: 'QA195 obj-status bad', message: 'QA195 obj-status message' };

			case 'throw-response':
				// Some frameworks short-circuit throw Response; does Harper?
				throw new Response(JSON.stringify({ shortCircuit: true, qa: 'QA195' }), {
					status: 422,
					headers: { 'Content-Type': 'application/json', 'X-QA195-Thrown': 'response' },
				});

			case 'reject-promise':
				return Promise.reject(new Error('QA195 rejected promise error'));

			case 'null-throw':
				throw null;

			default:
				return { error: 'unknown throw case', case: c };
		}
	}
}

// ---------------------------------------------------------------------------
// POST throw matrix — same cases via body {case:...}
// ---------------------------------------------------------------------------
export class ThrowPost extends Resource {
	static loadAsInstance = false;
	async post(query, data) {
		const c = data?.case;
		switch (c) {
			case 'plain-error':
				throw new Error('QA195-POST plain error');
			case 'statuscode-400': {
				const e = new Error('QA195-POST statusCode=400');
				e.statusCode = 400;
				throw e;
			}
			case 'client-error-def':
				if (typeof ClientError !== 'undefined') throw new ClientError('QA195-POST ClientError');
				{
					const e = new Error('QA195-POST ClientError fallback');
					e.statusCode = 400;
					throw e;
				}
			case 'obj-statusCode':
				throw { statusCode: 409, message: 'QA195-POST obj-statusCode conflict' };
			case 'obj-status':
				throw { status: 400, body: 'QA195-POST obj-status bad' };
			default:
				return { ok: true, received: c };
		}
	}
}

// ---------------------------------------------------------------------------
// PUT throw matrix — same cases via body {case:...}
// ---------------------------------------------------------------------------
export class ThrowPut extends Resource {
	static loadAsInstance = false;
	async put(query, data) {
		const c = data?.case;
		switch (c) {
			case 'plain-error':
				throw new Error('QA195-PUT plain error');
			case 'statuscode-400': {
				const e = new Error('QA195-PUT statusCode=400');
				e.statusCode = 400;
				throw e;
			}
			case 'client-error-def':
				if (typeof ClientError !== 'undefined') throw new ClientError('QA195-PUT ClientError');
				{
					const e = new Error('QA195-PUT ClientError fallback');
					e.statusCode = 400;
					throw e;
				}
			case 'obj-statusCode':
				throw { statusCode: 422, message: 'QA195-PUT obj-statusCode unprocessable' };
			case 'obj-status':
				throw { status: 400, body: 'QA195-PUT obj-status bad' };
			default:
				return { ok: true, received: c };
		}
	}
}

// ---------------------------------------------------------------------------
// STATUS VIA CONTEXT
// ---------------------------------------------------------------------------
export class StatusViaContext extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const want = Number((query?.get && query.get('code')) || 201);
		const ctx = this.getContext();
		if (ctx?.response) {
			ctx.response.status = want;
			ctx.response.headers.set('X-QA195', 'context');
		}
		return { setVia: 'context', code: want };
	}
}

// ---------------------------------------------------------------------------
// STATUS VIA RETURNED Response
// ---------------------------------------------------------------------------
export class StatusViaResponse extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const want = Number((query?.get && query.get('code')) || 201);
		return new Response(JSON.stringify({ setVia: 'Response', code: want }), {
			status: want,
			headers: { 'Content-Type': 'application/json', 'X-QA195': 'response' },
		});
	}
}

// ---------------------------------------------------------------------------
// STATUS VIA {status, data} object shape
// ---------------------------------------------------------------------------
export class StatusViaObjStatus extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const want = Number((query?.get && query.get('code')) || 202);
		// REST.ts lines 164-191: if responseData.headers exists it enters the Response branch.
		// Does returning {status, data} without headers also work?
		return { status: want, data: { setVia: 'obj-status', code: want } };
	}
}

// ---------------------------------------------------------------------------
// LIVENESS
// ---------------------------------------------------------------------------
export class Liveness extends Resource {
	static loadAsInstance = false;
	async get() {
		return { alive: true, method: 'get' };
	}
}
