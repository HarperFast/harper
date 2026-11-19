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
			// Detect a misroute regardless of status: a non-200 is itself a routing failure
			// (this resource has a handler for every verb, so anything but 200 is wrong), and a
			// 200 with the wrong `invoked` method is a silent misroute to a different handler.
			if (r.status !== 200) misroutes.push(`${c.m}: unexpected status ${r.status} (want 200, invoked=${expected})`);
			else if (invoked !== expected) misroutes.push(`${c.m} invoked ${invoked}`);
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
		const probes: { path: string; code: number; label: string; hdrPrefix: string }[] = [
			{ path: '/StatusCtx/?code=201', code: 201, label: 'ctx 201', hdrPrefix: 'ctx-' },
			{ path: '/StatusCtx/?code=202', code: 202, label: 'ctx 202', hdrPrefix: 'ctx-' },
			{ path: '/StatusCtx/?code=418', code: 418, label: 'ctx 418', hdrPrefix: 'ctx-' },
			{ path: '/StatusResponse/?code=201', code: 201, label: 'Response 201', hdrPrefix: 'resp-' },
			{ path: '/StatusResponse/?code=418', code: 418, label: 'Response 418', hdrPrefix: 'resp-' },
			{ path: '/StatusResponseData/?code=202', code: 202, label: 'Response.data 202', hdrPrefix: 'respdata-' },
			{ path: '/StatusResponseData/?code=418', code: 418, label: 'Response.data 418', hdrPrefix: 'respdata-' },
		];
		const mismatches: string[] = [];
		for (const p of probes) {
			const r = await raw('GET', p.path);
			const statusOK = r.status === p.code ? 'OK' : `IGNORED(want ${p.code})`;
			const hdrOK = r.xqa ? `hdr=${r.xqa}` : 'HDR-MISSING';
			const fooHdr = r.headers['x-custom-foo'] ? ' x-custom-foo=' + r.headers['x-custom-foo'] : '';
			statusMatrix.push(
				`${p.label.padEnd(20)} -> ${r.status} ${statusOK}  ${hdrOK}${fooHdr}  body=${prefix(r.text, 50)}`
			);
			if (r.status !== p.code) mismatches.push(`${p.label}: status ${r.status} !== ${p.code}`);
			const wantHdr = `${p.hdrPrefix}${p.code}`;
			if (r.xqa !== wantHdr) mismatches.push(`${p.label}: X-QA146 "${r.xqa}" !== "${wantHdr}"`);
		}
		strictEqual(mismatches.length, 0, `custom status/header contract violations: ${mismatches.join('; ')}`);
	});

	// -------------------------------------------------------------------------
	// 3. ERROR MAPPING
	// -------------------------------------------------------------------------
	test('error mapping: thrown vs statusCode vs ClientError vs returned-error', async () => {
		const probes: { path: string; label: string; expect: string; expectStatus: number }[] = [
			{ path: '/ErrPlain/', label: 'throw plain Error', expect: '500 (no statusCode)', expectStatus: 500 },
			{ path: '/ErrStatusCode/?code=400', label: 'throw Error{.statusCode=400}', expect: '400', expectStatus: 400 },
			{ path: '/ErrStatusCode/?code=409', label: 'throw Error{.statusCode=409}', expect: '409', expectStatus: 409 },
			{ path: '/ErrClient/', label: 'throw ClientError (default)', expect: '400', expectStatus: 400 },
			{ path: '/ErrClient/?code=422', label: 'throw ClientError(422)', expect: '422', expectStatus: 422 },
			{
				path: '/ErrReturned/',
				label: 'RETURN error-shaped {statusCode:400}',
				expect: '200 (not thrown)',
				expectStatus: 200,
			},
			{ path: '/ErrString/', label: 'throw bare string', expect: '500?', expectStatus: 500 },
		];
		const mismatches: string[] = [];
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
			if (r.status !== p.expectStatus) mismatches.push(`${p.label}: status ${r.status} !== ${p.expectStatus}`);
		}
		strictEqual(mismatches.length, 0, `error-mapping contract violations: ${mismatches.join('; ')}`);
	});

	// -------------------------------------------------------------------------
	// 4. CONTENT NEGOTIATION on a custom return value
	// -------------------------------------------------------------------------
	test('content negotiation applies to custom-resource responses', async () => {
		const accepts: { label: string; header: string; wantCt: string; wantJson: boolean }[] = [
			{ label: 'json', header: 'application/json', wantCt: 'application/json', wantJson: true },
			{ label: 'cbor', header: 'application/cbor', wantCt: 'application/cbor', wantJson: false },
			{ label: 'msgpack', header: 'application/x-msgpack', wantCt: 'application/x-msgpack', wantJson: false },
			{ label: '*/*', header: '*/*', wantCt: 'application/json', wantJson: true },
		];
		const mismatches: string[] = [];
		for (const a of accepts) {
			const r = await raw('GET', '/Negotiate/', { accept: a.header });
			// Detect whether body is actually binary (cbor/msgpack) vs JSON text.
			const looksJson = r.text.trimStart().startsWith('{');
			const bodyDesc = looksJson
				? `json:${prefix(r.text, 40)}`
				: `binary:${r.bytes.length}B hex=${r.bytes.subarray(0, 8).toString('hex')}`;
			negotiateMatrix.push(`Accept ${a.label.padEnd(8)} -> ${r.status} ct=${r.ct.padEnd(26)} ${bodyDesc}`);
			if (r.status !== 200) mismatches.push(`Accept ${a.label}: status ${r.status} !== 200`);
			if (!r.ct.startsWith(a.wantCt)) mismatches.push(`Accept ${a.label}: content-type "${r.ct}" !~ "${a.wantCt}"`);
			if (looksJson !== a.wantJson) mismatches.push(`Accept ${a.label}: body-is-json=${looksJson}, want ${a.wantJson}`);
		}
		strictEqual(mismatches.length, 0, `content-negotiation contract violations: ${mismatches.join('; ')}`);
	});

	// -------------------------------------------------------------------------
	// 5. ODD RETURN TYPES
	// -------------------------------------------------------------------------
	test('odd return types serialize sanely (no blanket 500)', async () => {
		// null/undefined mean "no resource" -> 404 per Harper GET-not-found semantics;
		// every other primitive/collection/iterator must serialize successfully as JSON.
		const probes: { path: string; label: string; expectStatus: number }[] = [
			{ path: '/RetString/', label: 'string', expectStatus: 200 },
			{ path: '/RetNumber/', label: 'number', expectStatus: 200 },
			{ path: '/RetBool/', label: 'boolean', expectStatus: 200 },
			{ path: '/RetNull/', label: 'null', expectStatus: 404 },
			{ path: '/RetUndefined/', label: 'undefined', expectStatus: 404 },
			{ path: '/RetArrayHuge/', label: 'huge array (50k)', expectStatus: 200 },
			{ path: '/RetAsyncIter/', label: 'async iterator', expectStatus: 200 },
		];
		const crashes: string[] = [];
		const mismatches: string[] = [];
		for (const p of probes) {
			const r = await raw('GET', p.path);
			const len = r.bytes.length;
			oddMatrix.push(
				`${p.label.padEnd(18)} -> ${r.status} ct=${r.ct.padEnd(26)} len=${len} body=${prefix(r.text, 50)}`
			);
			if (r.status === 500) crashes.push(`${p.label}=500`);
			if (r.status !== p.expectStatus) mismatches.push(`${p.label}: status ${r.status} !== ${p.expectStatus}`);
		}
		console.log(`\n[custom-resource-contract] odd-return 500s: ${crashes.length ? crashes.join(', ') : 'none'}`);
		strictEqual(mismatches.length, 0, `odd-return-type contract violations: ${mismatches.join('; ')}`);

		// Spot-check the successful cases actually round-trip the value, not just a 200.
		const asJson = (path: string) => raw('GET', path).then((r) => JSON.parse(r.text));
		strictEqual(await asJson('/RetString/'), 'just a bare string');
		strictEqual(await asJson('/RetNumber/'), 1234.5);
		strictEqual(await asJson('/RetBool/'), true);
		const huge = await asJson('/RetArrayHuge/');
		strictEqual(huge.length, 50000);
		strictEqual(huge[0].v, 'row-0');
		const streamed = await asJson('/RetAsyncIter/');
		strictEqual(streamed.length, 5);
		strictEqual(streamed[0].v, 'stream-0');
	});

	// -------------------------------------------------------------------------
	// 6. LIVENESS
	// -------------------------------------------------------------------------
	test('instance still alive after all probes', async () => {
		const r = await raw('GET', '/Verbs/');
		ok(r.status === 200, `instance should still answer, got ${r.status}`);
	});
});
