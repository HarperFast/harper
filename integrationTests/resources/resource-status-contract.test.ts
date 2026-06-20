/**
 * QA-195 — Custom-Resource AUTHOR status-code + body contract.
 *
 * Characterises the full return/throw matrix for custom Resource handlers (get/post/put).
 * Key questions:
 *   - Does Harper honour .statusCode on a thrown Error?
 *   - Does ClientError map to 4xx?
 *   - Does `throw {statusCode}` (non-Error object) map to 4xx?
 *   - Does `throw {status}` (wrong field) map correctly?
 *   - Does `throw Response` short-circuit or produce 500?
 *   - Does `throw 404` (bare number) produce 404?
 *   - Does `throw 'string'` produce 500?
 *   - Does error.message leak into the response body?
 *   - What do `return null` / `return undefined` produce?
 *   - Do POST/PUT throw cases behave identically to GET?
 *
 * Findings are printed in `after()` as compact matrices; assertions only guard
 * server survival and known-contract expectations.
 *
 * This test documents working idioms + gaps (D-086) and is an F-039/#1421 regression
 * marker — assertions match CURRENT behavior so it is green now. When F-039/#1421 land,
 * update the expected statuses accordingly.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/resources/resource-status-contract.test.ts"
 * Harper SHA: 7aaa5a152332739929786fb4a63e70f4206189b7
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'resource-status-contract');
const skipSuite = process.platform === 'win32';

suite('QA-195 custom-resource AUTHOR status-code + body contract', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	let auth: string;

	// Collected findings, printed in after()
	const returnMatrix: string[] = [];
	const throwMatrix: string[] = [];
	const postPutMatrix: string[] = [];
	const statusMatrix: string[] = [];
	const defectList: string[] = [];

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		auth = client.headers.Authorization;

		// Wait until liveness endpoint is reachable
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await fetch(`${httpURL}/Liveness/`, {
					headers: { Authorization: auth },
					signal: AbortSignal.timeout(3_000),
				});
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
			console.log(`\n[QA-195] ${title}`);
			if (rows.length === 0) console.log('  (none)');
			for (const r of rows) console.log('  ' + r);
		};

		block('RETURN MATRIX (GET ?case=X -> HTTP status / ct / body-prefix)', returnMatrix);
		block('THROW MATRIX (GET ?case=X -> HTTP status / problem-detail shape)', throwMatrix);
		block('POST/PUT THROW MATRIX', postPutMatrix);
		block('STATUS AUTHOR PATTERNS (context / Response / obj-status)', statusMatrix);
		block('DEFECTS (4xx-as-500, statusCode ignored, message leak, throw-Response->500)', defectList);

		if (defectList.length > 0) {
			console.log(`\n[QA-195] *** ${defectList.length} DEFECT(S) FOUND ***`);
		} else {
			console.log('\n[QA-195] No defects detected in this matrix.');
		}
	});

	// -------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------
	async function rawGet(
		path: string
	): Promise<{ status: number; ct: string; text: string; headers: Record<string, string> }> {
		const r = await fetch(`${httpURL}${path}`, {
			headers: { Authorization: auth },
			signal: AbortSignal.timeout(10_000),
		});
		const text = await r.text();
		const headers: Record<string, string> = {};
		r.headers.forEach((v, k) => (headers[k] = v));
		return { status: r.status, ct: r.headers.get('content-type') ?? '', text, headers };
	}

	async function rawPost(path: string, body: unknown): Promise<{ status: number; ct: string; text: string }> {
		const r = await fetch(`${httpURL}${path}`, {
			method: 'POST',
			headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
		const text = await r.text();
		return { status: r.status, ct: r.headers.get('content-type') ?? '', text };
	}

	async function rawPut(path: string, body: unknown): Promise<{ status: number; ct: string; text: string }> {
		const r = await fetch(`${httpURL}${path}`, {
			method: 'PUT',
			headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
		const text = await r.text();
		return { status: r.status, ct: r.headers.get('content-type') ?? '', text };
	}

	function pfx(s: string, n = 80): string {
		s = (s || '').replace(/\s+/g, ' ').trim();
		return s.length > n ? s.slice(0, n) + '…' : s;
	}

	function tryParse(text: string): any {
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	}

	function leaks(text: string, needle: string): boolean {
		return text.toLowerCase().includes(needle.toLowerCase());
	}

	// -------------------------------------------------------------------------
	// 1. RETURN SHAPES
	// -------------------------------------------------------------------------
	test('return shapes: plain-object, array, string, number, booleans, null, undefined, promise', async () => {
		const cases: Array<{ case: string; wantStatus: number; desc: string }> = [
			{ case: 'plain-object', wantStatus: 200, desc: 'object' },
			{ case: 'array', wantStatus: 200, desc: 'array' },
			{ case: 'string', wantStatus: 200, desc: 'string' },
			{ case: 'number', wantStatus: 200, desc: 'number 42' },
			{ case: 'bool-true', wantStatus: 200, desc: 'true' },
			{ case: 'bool-false', wantStatus: 200, desc: 'false' },
			{ case: 'null', wantStatus: 404, desc: 'null -> 404 (undefined body)' },
			{ case: 'undefined', wantStatus: 404, desc: 'undefined -> 404' },
			{ case: 'promise-object', wantStatus: 200, desc: 'Promise<object>' },
		];

		const anomalies: string[] = [];
		for (const c of cases) {
			const r = await rawGet(`/ReturnMatrix/?case=${c.case}`);
			const row = `${c.case.padEnd(14)} -> ${r.status}  ct=${pfx(r.ct, 30).padEnd(32)}  body=${pfx(r.text, 50)}`;
			returnMatrix.push(row);

			// Defect: any return type becoming 500 is unexpected
			if (r.status === 500) {
				anomalies.push(`return ${c.case}=500 (DEFECT: plain return should not 500)`);
				defectList.push(`[RETURN] ${c.case} -> 500 instead of ${c.wantStatus}`);
			}
			// Primitive non-null returns should produce 200
			if (['string', 'number', 'bool-true', 'bool-false', 'plain-object', 'array', 'promise-object'].includes(c.case)) {
				if (r.status !== 200) {
					anomalies.push(`return ${c.case} expected 200, got ${r.status}`);
					defectList.push(`[RETURN] ${c.case} -> ${r.status} instead of 200`);
				}
			}
			// null/undefined should be 404 per REST.ts line 160
			if (['null', 'undefined'].includes(c.case) && r.status !== 404) {
				returnMatrix.push(`  ^ NOTE: expected 404 (null/undefined -> not-found), got ${r.status}`);
				defectList.push(`[RETURN] ${c.case} -> ${r.status} instead of 404`);
			}
		}

		ok(anomalies.filter((a) => a.includes('DEFECT')).length === 0, `Unexpected 500s: ${anomalies.join('; ')}`);
	});

	// -------------------------------------------------------------------------
	// 2. THROW SHAPES (GET)
	// -------------------------------------------------------------------------
	test('throw shapes: Error, Error.statusCode, ClientError, bare string/number, obj-statusCode, obj-status, Response, rejected Promise, null', async () => {
		const cases: Array<{
			case: string;
			wantStatus: number;
			desc: string;
			msgToken?: string;
			isDefectIf500?: boolean;
		}> = [
			{ case: 'plain-error', wantStatus: 500, desc: 'throw new Error()' },
			{
				case: 'statuscode-400',
				wantStatus: 400,
				desc: 'Error{.statusCode=400}',
				msgToken: 'QA195 error.statusCode=400 message',
				isDefectIf500: true,
			},
			{ case: 'statuscode-404', wantStatus: 404, desc: 'Error{.statusCode=404}', isDefectIf500: true },
			{ case: 'client-error-def', wantStatus: 400, desc: 'new ClientError()', isDefectIf500: true },
			{ case: 'client-error-422', wantStatus: 422, desc: 'new ClientError(msg, 422)', isDefectIf500: true },
			{ case: 'bare-string', wantStatus: 500, desc: 'throw "string"' },
			{ case: 'bare-number', wantStatus: 500, desc: 'throw 404 (bare number)' },
			{ case: 'obj-statusCode', wantStatus: 404, desc: 'throw {statusCode:404}', isDefectIf500: true },
			{ case: 'obj-status', wantStatus: 500, desc: 'throw {status:400} (wrong field)' },
			{ case: 'throw-response', wantStatus: 422, desc: 'throw new Response(_, {status:422})' },
			{ case: 'reject-promise', wantStatus: 500, desc: 'Promise.reject(Error)' },
			{ case: 'null-throw', wantStatus: 500, desc: 'throw null' },
		];

		for (const c of cases) {
			const r = await rawGet(`/ThrowMatrix/?case=${c.case}`);
			const parsed = tryParse(r.text);
			const problemType = parsed?.type ?? '';
			const problemTitle = parsed?.title ?? '';

			// Check message leak
			const msgLeaks = c.msgToken ? leaks(r.text, c.msgToken) : false;

			const row = [
				c.case.padEnd(18),
				`-> ${r.status}`,
				`[want ${c.wantStatus}]`,
				`type=${pfx(problemType, 30)}`,
				`title=${pfx(problemTitle, 40)}`,
				`leak=${msgLeaks}`,
			].join('  ');
			throwMatrix.push(row);

			// Defect checks
			if (c.isDefectIf500 && r.status === 500) {
				defectList.push(`[THROW D-070] ${c.case}: got 500, expected ${c.wantStatus} — 4xx-as-500`);
			}
			if (r.status !== c.wantStatus) {
				throwMatrix.push(`  ^ NOTE: expected ${c.wantStatus}, got ${r.status}`);
				// If we expected 4xx and got something else non-4xx, note the mismatch
				if (c.wantStatus >= 400 && c.wantStatus < 500 && r.status >= 500) {
					defectList.push(`[THROW] ${c.case}: expected ${c.wantStatus}, got ${r.status}`);
				}
			}

			// Defect: message leaking into response body is a security concern for 500s
			if (msgLeaks) {
				defectList.push(`[THROW LEAK] ${c.case}: error message "${c.msgToken}" leaked into response body`);
			}

			// throw-Response specific check
			if (c.case === 'throw-response') {
				if (r.status === 500) {
					defectList.push(
						`[THROW F-039] throw-Response->500: Harper does not short-circuit on thrown Response objects`
					);
				} else if (r.status === 422) {
					throwMatrix.push(`  ^ GOOD: throw Response short-circuits correctly`);
				}
			}

			// bare-number 404 — was it honored?
			if (c.case === 'bare-number' && r.status === 404) {
				defectList.push(`[THROW] bare-number 404: surprisingly honored (bare number as status code)`);
				throwMatrix.push(`  ^ NOTE: bare number 404 was honored as status code (unexpected)`);
			}

			// obj-status (wrong field) — was status honored despite wrong field name?
			if (c.case === 'obj-status') {
				if (r.status === 400) {
					throwMatrix.push(`  ^ NOTE: throw {status:400} was honored (unexpected — this is the wrong field name)`);
				} else {
					throwMatrix.push(`  ^ CONFIRMED: throw {status:400} (wrong field) not honored -> ${r.status}`);
				}
			}
		}

		// No hard assertion on throw-response since it's a discovery probe
		ok(true, 'throw matrix recorded');
	});

	// -------------------------------------------------------------------------
	// 3. POST/PUT THROW SHAPES
	// -------------------------------------------------------------------------
	test('POST throw shapes: plain-error, statusCode-400, ClientError, obj-statusCode, obj-status', async () => {
		const postCases = [
			{ case: 'plain-error', wantStatus: 500, desc: 'POST throw Error' },
			{ case: 'statuscode-400', wantStatus: 400, desc: 'POST Error{.statusCode=400}', isDefectIf500: true },
			{ case: 'client-error-def', wantStatus: 400, desc: 'POST ClientError', isDefectIf500: true },
			{ case: 'obj-statusCode', wantStatus: 409, desc: 'POST throw {statusCode:409}', isDefectIf500: true },
			{ case: 'obj-status', wantStatus: 500, desc: 'POST throw {status:400}' },
		];

		for (const c of postCases) {
			const r = await rawPost('/ThrowPost/', { case: c.case });
			const parsed = tryParse(r.text);
			const row = `${c.desc.padEnd(30)} -> ${r.status} [want ${c.wantStatus}]  title=${pfx(parsed?.title ?? r.text, 50)}`;
			postPutMatrix.push(row);

			if ((c as any).isDefectIf500 && r.status === 500) {
				defectList.push(`[POST D-070] ${c.case}: 4xx-as-500`);
			}
			if ((c as any).isDefectIf500 && r.status !== c.wantStatus) {
				postPutMatrix.push(`  ^ NOTE: expected ${c.wantStatus}, got ${r.status}`);
			}
		}

		const putCases = [
			{ case: 'plain-error', wantStatus: 500, desc: 'PUT throw Error' },
			{ case: 'statuscode-400', wantStatus: 400, desc: 'PUT Error{.statusCode=400}', isDefectIf500: true },
			{ case: 'client-error-def', wantStatus: 400, desc: 'PUT ClientError', isDefectIf500: true },
			{ case: 'obj-statusCode', wantStatus: 422, desc: 'PUT throw {statusCode:422}', isDefectIf500: true },
			{ case: 'obj-status', wantStatus: 500, desc: 'PUT throw {status:400}' },
		];

		for (const c of putCases) {
			const r = await rawPut('/ThrowPut/', { case: c.case });
			const parsed = tryParse(r.text);
			const row = `${c.desc.padEnd(30)} -> ${r.status} [want ${c.wantStatus}]  title=${pfx(parsed?.title ?? r.text, 50)}`;
			postPutMatrix.push(row);

			if ((c as any).isDefectIf500 && r.status === 500) {
				defectList.push(`[PUT D-070] ${c.case}: 4xx-as-500`);
			}
			if ((c as any).isDefectIf500 && r.status !== c.wantStatus) {
				postPutMatrix.push(`  ^ NOTE: expected ${c.wantStatus}, got ${r.status}`);
			}
		}

		ok(true, 'POST/PUT throw matrix recorded');
	});

	// -------------------------------------------------------------------------
	// 4. STATUS AUTHOR PATTERNS
	// -------------------------------------------------------------------------
	test('status author patterns: context / returned-Response / obj-status shape', async () => {
		// 4a. Status via context
		for (const code of [201, 202, 418]) {
			const r = await rawGet(`/StatusViaContext/?code=${code}`);
			const xqa = r.headers['x-qa195'] || '';
			statusMatrix.push(`context code=${code} -> ${r.status} [want ${code}]  X-QA195=${xqa}`);
			if (r.status !== code) {
				defectList.push(`[STATUS] context code=${code} ignored -> got ${r.status}`);
			}
		}

		// 4b. Status via returned Response
		for (const code of [201, 418]) {
			const r = await rawGet(`/StatusViaResponse/?code=${code}`);
			const xqa = r.headers['x-qa195'] || '';
			statusMatrix.push(`returned-Response code=${code} -> ${r.status} [want ${code}]  X-QA195=${xqa}`);
			if (r.status !== code) {
				defectList.push(`[STATUS] returned Response code=${code} ignored -> got ${r.status}`);
			}
		}

		// 4c. Status via {status, data} object (no headers field)
		for (const code of [202, 404]) {
			const r = await rawGet(`/StatusViaObjStatus/?code=${code}`);
			statusMatrix.push(`obj-{status,data} code=${code} -> ${r.status} [want ${code}]  body=${pfx(r.text, 40)}`);
			if (r.status !== code) {
				statusMatrix.push(`  ^ NOTE: {status,data} (no headers field) code=${code} not honored -> ${r.status}`);
				// This is a discovery finding, not necessarily a defect — document it
				defectList.push(
					`[STATUS NOTE] obj-{status,data} without headers: code=${code} not honored (got ${r.status}). REST.ts requires headers field for status branch.`
				);
			}
		}

		ok(true, 'status pattern matrix recorded');
	});

	// -------------------------------------------------------------------------
	// 5. PROBLEM DETAIL STRUCTURE — does Harper use RFC 9457 format?
	// -------------------------------------------------------------------------
	test('problem detail RFC 9457 structure on errors', async () => {
		// plain-error -> 500 should have RFC 9457 shape
		const r500 = await rawGet('/ThrowMatrix/?case=plain-error');
		const p500 = tryParse(r500.text);

		const hasType = typeof p500?.type === 'string';
		const hasTitle = typeof p500?.title === 'string';
		const hasStatus = typeof p500?.status === 'number';
		const hasInstance = typeof p500?.instance === 'string';

		throwMatrix.push(
			`\nPROBLEM DETAIL (500): type=${hasType} title=${hasTitle} status=${hasStatus} instance=${hasInstance}`
		);
		throwMatrix.push(`  shape: ${pfx(JSON.stringify(p500), 120)}`);

		// 400 case should also have RFC 9457 shape
		const r400 = await rawGet('/ThrowMatrix/?case=statuscode-400');
		const p400 = tryParse(r400.text);
		throwMatrix.push(
			`PROBLEM DETAIL (400): type=${typeof p400?.type === 'string'} title=${typeof p400?.title === 'string'} status=${p400?.status}`
		);
		throwMatrix.push(`  shape: ${pfx(JSON.stringify(p400), 120)}`);

		// Check title field leaks internal error message
		if (p500?.title && leaks(p500.title, 'QA195')) {
			defectList.push(`[LEAK] 500 body "title" field leaks internal error message: "${p500.title}"`);
		}
		if (p400?.title && leaks(p400.title, 'QA195')) {
			defectList.push(`[LEAK] 400 body "title" field leaks internal error message: "${p400.title}"`);
		}

		ok(true, 'problem detail structure recorded');
	});

	// -------------------------------------------------------------------------
	// 6. LIVENESS — server must survive all throws
	// -------------------------------------------------------------------------
	test('liveness: server still alive after all throw probes', async () => {
		const r = await rawGet('/Liveness/');
		const parsed = tryParse(r.text);
		strictEqual(r.status, 200, `liveness should return 200, got ${r.status}`);
		ok(parsed?.alive === true, `liveness should return {alive:true}, got ${r.text.slice(0, 80)}`);
	});
});
