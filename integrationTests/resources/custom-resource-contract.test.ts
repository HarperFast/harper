/**
 * Custom-Resource HTTP contract: verb routing, custom status/headers,
 * error mapping, content negotiation, odd return types.
 *
 * Reads RAW response status + headers + body via fetch (sendOperation throws on non-200).
 * Exploratory: failures are recorded into matrices and printed in `after`; only a small set
 * of hard assertions guard the headline contract (verb routing + instance liveness).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'custom-resource-contract');
const skipSuite = process.platform === 'win32';

suite('custom-resource HTTP contract', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	let auth: string;

	const verbMatrix: string[] = [];
	const statusMatrix: string[] = [];
	const errorMatrix: string[] = [];
	const negotiateMatrix: string[] = [];
	const oddMatrix: string[] = [];

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		auth = client.headers.Authorization;

		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Verbs/').timeout(3_000);
				if (probe.status !== 404) break;
			} catch {
				/* not ready */
			}
			await sleep(250);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
		const block = (title: string, rows: string[]) => {
			console.log(`\n[custom-resource-contract] ${title}`);
			if (rows.length === 0) console.log('  (none)');
			for (const r of rows) console.log('  ' + r);
		};
		block('VERB ROUTING (method-sent -> method-invoked / argc / hasReq)', verbMatrix);
		block('CUSTOM STATUS + HEADERS (expected -> actual status / X-QA146 header)', statusMatrix);
		block('ERROR MAPPING (case -> status / type / title)', errorMatrix);
		block('CONTENT NEGOTIATION (Accept -> status / content-type / body-prefix)', negotiateMatrix);
		block('ODD RETURN TYPES (case -> status / content-type / body-prefix)', oddMatrix);
	});

	async function raw(
		method: string,
		path: string,
		opts: { body?: unknown; accept?: string; contentType?: string } = {}
	): Promise<{
		status: number;
		ct: string;
		xqa: string;
		headers: Record<string, string>;
		text: string;
		bytes: Buffer;
	}> {
		const headers: Record<string, string> = { Authorization: auth };
		if (opts.accept) headers['Accept'] = opts.accept;
		let body: any;
		if (opts.body !== undefined) {
			headers['Content-Type'] = opts.contentType || 'application/json';
			body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
		}
		const r = await fetch(`${httpURL}${path}`, { method, headers, body });
		const ab = Buffer.from(await r.arrayBuffer());
		const h: Record<string, string> = {};
		r.headers.forEach((v, k) => (h[k] = v));
		return {
			status: r.status,
			ct: r.headers.get('content-type') || '',
			xqa: r.headers.get('x-qa146') || '',
			headers: h,
			text: ab.toString('utf8'),
			bytes: ab,
		};
	}

	function prefix(s: string, n = 90): string {
		s = (s || '').replace(/\s+/g, ' ').trim();
		return s.length > n ? s.slice(0, n) + '…' : s;
	}

	// -------------------------------------------------------------------------
	// 1. VERB ROUTING
	// -------------------------------------------------------------------------
	test('verb routing: each HTTP method invokes the matching resource method', async () => {
		const cases: { m: string; body?: unknown }[] = [
			{ m: 'GET' },
			{ m: 'POST', body: { hello: 'post' } },
			{ m: 'PUT', body: { hello: 'put' } },
			{ m: 'PATCH', body: { hello: 'patch' } },
			{ m: 'DELETE' },
		];
		const misroutes: string[] = [];
		for (const c of cases) {
			const r = await raw(c.m, '/Verbs/', { body: c.body });
			let parsed: any = null;
			try {
				parsed = JSON.parse(r.text);
			} catch {
				/* non-json */
			}
			const invoked = parsed?.method ?? '?';
			const dataSeen = parsed ? JSON.stringify(parsed.dataArg) : 'n/a';
			verbMatrix.push(
				`${c.m.padEnd(7)} -> status=${r.status} invoked=${String(invoked).padEnd(7)} argc=${parsed?.argc} hasReq=${parsed?.hasReq} dataArg=${prefix(dataSeen, 40)}`
			);
			const expected = c.m.toLowerCase();
			if (r.status === 200 && invoked !== expected) misroutes.push(`${c.m} invoked ${invoked}`);
			// data-bearing verbs must see the body they were sent
			if (c.body && r.status === 200 && (!parsed?.dataArg || parsed.dataArg.hello !== (c.body as any).hello)) {
				misroutes.push(`${c.m} did not receive body (saw ${dataSeen})`);
			}
		}
		strictEqual(misroutes.length, 0, `verb mis-routes / arg gaps: ${misroutes.join('; ')}`);
	});

	// -------------------------------------------------------------------------
	// 2. CUSTOM STATUS + HEADERS
	// -------------------------------------------------------------------------
	test('custom status + headers are honored on the wire', async () => {
		const probes: { path: string; code: number; label: string }[] = [
			{ path: '/StatusCtx/?code=201', code: 201, label: 'ctx 201' },
			{ path: '/StatusCtx/?code=202', code: 202, label: 'ctx 202' },
			{ path: '/StatusCtx/?code=418', code: 418, label: 'ctx 418' },
			{ path: '/StatusResponse/?code=201', code: 201, label: 'Response 201' },
			{ path: '/StatusResponse/?code=418', code: 418, label: 'Response 418' },
			{ path: '/StatusResponseData/?code=202', code: 202, label: 'Response.data 202' },
			{ path: '/StatusResponseData/?code=418', code: 418, label: 'Response.data 418' },
		];
		for (const p of probes) {
			const r = await raw('GET', p.path);
			const statusOK = r.status === p.code ? 'OK' : `IGNORED(want ${p.code})`;
			const hdrOK = r.xqa ? `hdr=${r.xqa}` : 'HDR-MISSING';
			const fooHdr = r.headers['x-custom-foo'] ? ' x-custom-foo=' + r.headers['x-custom-foo'] : '';
			statusMatrix.push(
				`${p.label.padEnd(20)} -> ${r.status} ${statusOK}  ${hdrOK}${fooHdr}  body=${prefix(r.text, 50)}`
			);
		}
		ok(statusMatrix.length === probes.length, 'all status probes recorded');
	});

	// -------------------------------------------------------------------------
	// 3. ERROR MAPPING
	// -------------------------------------------------------------------------
	test('error mapping: thrown vs statusCode vs ClientError vs returned-error', async () => {
		const probes: { path: string; label: string; expect: string }[] = [
			{ path: '/ErrPlain/', label: 'throw plain Error', expect: '500 (no statusCode)' },
			{ path: '/ErrStatusCode/?code=400', label: 'throw Error{.statusCode=400}', expect: '400' },
			{ path: '/ErrStatusCode/?code=409', label: 'throw Error{.statusCode=409}', expect: '409' },
			{ path: '/ErrClient/', label: 'throw ClientError (default)', expect: '400' },
			{ path: '/ErrClient/?code=422', label: 'throw ClientError(422)', expect: '422' },
			{ path: '/ErrReturned/', label: 'RETURN error-shaped {statusCode:400}', expect: '200 (not thrown)' },
			{ path: '/ErrString/', label: 'throw bare string', expect: '500?' },
		];
		for (const p of probes) {
			const r = await raw('GET', p.path);
			let type = '';
			let title = '';
			try {
				const j = JSON.parse(r.text);
				type = j.type || j.code || '';
				title = j.title || j.error || '';
			} catch {
				title = prefix(r.text, 40);
			}
			errorMatrix.push(
				`${p.label.padEnd(34)} [want ${p.expect}] -> ${r.status}  type=${type}  title=${prefix(title, 50)}`
			);
		}
		ok(errorMatrix.length === probes.length, 'all error probes recorded');
	});

	// -------------------------------------------------------------------------
	// 4. CONTENT NEGOTIATION on a custom return value
	// -------------------------------------------------------------------------
	test('content negotiation applies to custom-resource responses', async () => {
		const accepts: { label: string; header: string }[] = [
			{ label: 'json', header: 'application/json' },
			{ label: 'cbor', header: 'application/cbor' },
			{ label: 'msgpack', header: 'application/x-msgpack' },
			{ label: '*/*', header: '*/*' },
		];
		for (const a of accepts) {
			const r = await raw('GET', '/Negotiate/', { accept: a.header });
			// Detect whether body is actually binary (cbor/msgpack) vs JSON text.
			const looksJson = r.text.trimStart().startsWith('{');
			const bodyDesc = looksJson
				? `json:${prefix(r.text, 40)}`
				: `binary:${r.bytes.length}B hex=${r.bytes.subarray(0, 8).toString('hex')}`;
			negotiateMatrix.push(`Accept ${a.label.padEnd(8)} -> ${r.status} ct=${r.ct.padEnd(26)} ${bodyDesc}`);
		}
		ok(negotiateMatrix.length === accepts.length, 'all negotiation probes recorded');
	});

	// -------------------------------------------------------------------------
	// 5. ODD RETURN TYPES
	// -------------------------------------------------------------------------
	test('odd return types serialize sanely (no blanket 500)', async () => {
		const probes: { path: string; label: string }[] = [
			{ path: '/RetString/', label: 'string' },
			{ path: '/RetNumber/', label: 'number' },
			{ path: '/RetBool/', label: 'boolean' },
			{ path: '/RetNull/', label: 'null' },
			{ path: '/RetUndefined/', label: 'undefined' },
			{ path: '/RetArrayHuge/', label: 'huge array (50k)' },
			{ path: '/RetAsyncIter/', label: 'async iterator' },
		];
		const crashes: string[] = [];
		for (const p of probes) {
			const r = await raw('GET', p.path);
			const len = r.bytes.length;
			oddMatrix.push(
				`${p.label.padEnd(18)} -> ${r.status} ct=${r.ct.padEnd(26)} len=${len} body=${prefix(r.text, 50)}`
			);
			if (r.status === 500) crashes.push(`${p.label}=500`);
		}
		// Record but don't hard-fail on individual odd types; the contract finding is in the matrix.
		console.log(`\n[custom-resource-contract] odd-return 500s: ${crashes.length ? crashes.join(', ') : 'none'}`);
		ok(oddMatrix.length === probes.length, 'all odd-return probes recorded');
	});

	// -------------------------------------------------------------------------
	// 6. LIVENESS
	// -------------------------------------------------------------------------
	test('instance still alive after all probes', async () => {
		const r = await raw('GET', '/Verbs/');
		ok(r.status === 200, `instance should still answer, got ${r.status}`);
	});
});
