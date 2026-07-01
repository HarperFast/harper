/**
 * MCP v1 — server-push SSE channel + list_changed delivery over real HTTP.
 *
 * Regression coverage for two bugs found on `main`:
 *
 *  - N1: the application-profile GET (Harper's own HTTP server) never flushed
 *    response headers — the SSE stream's queue yields nothing until a push, and
 *    Node defers header transmission until the first body byte, so the GET hung
 *    until the client gave up. The fix frames the queue into a primed SSE
 *    Readable (an initial comment flushes headers immediately).
 *
 *  - N2: `listChanged` was advertised and the dispatcher fired, but the
 *    operations-profile SSE never streamed the pushed frames — `reply.send(queue)`
 *    on Fastify sent headers then stopped draining, so `tools/list_changed` sat
 *    in the queue undelivered. The fix hijacks the reply and pipes a framed SSE
 *    stream to the raw socket.
 *
 * Both profiles are exercised end-to-end against a real booted Harper.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/custom-resources');

function basicAuth(user: string, pass: string): string {
	return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function adminAuth(ctx: ContextWithHarper): string {
	return basicAuth(ctx.harper.admin.username, ctx.harper.admin.password);
}

/** Call the operations API as admin (add_role / add_user / alter_user). */
async function op(ctx: ContextWithHarper, operation: Record<string, unknown>): Promise<void> {
	const res = await fetch(new URL('/', ctx.harper.operationsAPIURL), {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'authorization': adminAuth(ctx) },
		body: JSON.stringify(operation),
	});
	ok(res.ok, `operation ${operation.operation} failed: ${res.status} ${await res.text()}`);
}

/** POST an MCP `initialize` and return the negotiated session. */
async function initialize(baseUrl: string, auth: string): Promise<{ sessionId: string; protocolVersion: string }> {
	const res = await fetch(new URL('/mcp', baseUrl), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'accept': 'application/json, text/event-stream',
			'authorization': auth,
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sse-it', version: '0' } },
		}),
	});
	// Read the body exactly once: an `await res.text()` inside the assertion
	// message is evaluated eagerly (template args run before `strictEqual`), so it
	// consumes the body even on a 200 and a later `res.json()` then throws
	// "Body has already been read". Read the text up front and parse it.
	const text = await res.text();
	strictEqual(res.status, 200, `initialize should 200: ${text}`);
	const sessionId = res.headers.get('mcp-session-id');
	ok(sessionId, 'initialize returned an Mcp-Session-Id');
	const json: any = JSON.parse(text);
	return { sessionId: sessionId!, protocolVersion: json.result.protocolVersion };
}

async function toolsCount(
	baseUrl: string,
	auth: string,
	session: { sessionId: string; protocolVersion: string }
): Promise<number> {
	const res = await fetch(new URL('/mcp', baseUrl), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'accept': 'application/json, text/event-stream',
			'authorization': auth,
			'mcp-session-id': session.sessionId,
			'mcp-protocol-version': session.protocolVersion,
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
	});
	const json: any = await res.json();
	return json?.result?.tools?.length ?? -1;
}

/** Send a JSON-RPC POST to the MCP endpoint and return the parsed response. */
async function mcpCall(
	baseUrl: string,
	auth: string,
	session: { sessionId: string; protocolVersion: string },
	method: string,
	params: Record<string, unknown>,
	id: number
): Promise<any> {
	const res = await fetch(new URL('/mcp', baseUrl), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'accept': 'application/json, text/event-stream',
			'authorization': auth,
			'mcp-session-id': session.sessionId,
			'mcp-protocol-version': session.protocolVersion,
		},
		body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
	});
	return res.json();
}

/** Upsert a WorkItem record by id through the application REST API. */
async function putWorkItem(ctx: ContextWithHarper, id: string, body: Record<string, unknown>): Promise<void> {
	const res = await fetch(new URL(`/WorkItem/${id}`, ctx.harper.httpURL), {
		method: 'PUT',
		headers: { 'content-type': 'application/json', 'authorization': adminAuth(ctx) },
		body: JSON.stringify(body),
	});
	ok(res.ok, `PUT WorkItem/${id} failed: ${res.status} ${await res.text()}`);
}

/**
 * Open a GET SSE stream and resolve with `{ status, contentType }` once headers
 * arrive (rejecting if they never flush — the N1 hang), plus a
 * `next(predicate, timeoutMs)` that resolves to the first parsed JSON-RPC frame
 * matching the predicate (or undefined on timeout).
 */
async function openSse(
	url: string,
	auth: string,
	session: { sessionId: string; protocolVersion: string },
	headerTimeoutMs = 2500
): Promise<{
	status: number;
	contentType: string | null;
	next: (predicate: (msg: any) => boolean, timeoutMs: number) => Promise<any | undefined>;
	close: () => void;
}> {
	const ac = new AbortController();
	const resP = fetch(new URL('/mcp', url), {
		method: 'GET',
		headers: {
			'accept': 'text/event-stream',
			'authorization': auth,
			'mcp-session-id': session.sessionId,
			'mcp-protocol-version': session.protocolVersion,
		},
		signal: ac.signal,
	});
	// Guard against the N1 hang: if headers never arrive, fail fast rather than
	// hang the whole test run.
	const res = (await Promise.race([
		resP,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error('SSE headers never flushed (hung)')), headerTimeoutMs)
		),
	])) as Response;

	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const parsed: any[] = [];
	const waiters: Array<{ predicate: (m: any) => boolean; resolve: (m: any) => void }> = [];

	function dispatch(frame: string): void {
		const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
		if (!dataLine) return;
		let msg: any;
		try {
			msg = JSON.parse(dataLine.slice(5).trim());
		} catch {
			return;
		}
		parsed.push(msg);
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (waiters[i].predicate(msg)) {
				waiters[i].resolve(msg);
				waiters.splice(i, 1);
			}
		}
	}

	(async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let idx;
				while ((idx = buffer.indexOf('\n\n')) !== -1) {
					dispatch(buffer.slice(0, idx));
					buffer = buffer.slice(idx + 2);
				}
			}
		} catch {
			/* aborted on close */
		}
	})();

	return {
		status: res.status,
		contentType: res.headers.get('content-type'),
		next(predicate, timeoutMs) {
			const existing = parsed.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve) => {
				const t = setTimeout(() => resolve(undefined), timeoutMs);
				waiters.push({
					predicate,
					resolve: (m) => {
						clearTimeout(t);
						resolve(m);
					},
				});
			});
		},
		close: () => ac.abort(),
	};
}

suite('MCP v1 SSE channel + list_changed delivery', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { mcp: { operations: { mountPath: '/mcp' }, application: { mountPath: '/mcp' } } },
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('N1: application-profile GET opens an SSE stream with headers flushed immediately', async () => {
		const session = await initialize(ctx.harper.httpURL, adminAuth(ctx));
		const sse = await openSse(ctx.harper.httpURL, adminAuth(ctx), session, 2500);
		try {
			strictEqual(sse.status, 200, 'application GET SSE establishes (was: hung, headers never flushed)');
			ok((sse.contentType ?? '').includes('text/event-stream'), `expected text/event-stream, got ${sse.contentType}`);
		} finally {
			sse.close();
		}
	});

	test('N2: operations-profile delivers tools/list_changed when the visible surface changes', async () => {
		const suffix = Date.now().toString(36);
		const loRole = `sse_lo_${suffix}`;
		const hiRole = `sse_hi_${suffix}`;
		const username = `sse_user_${suffix}`;
		const password = 'Abc1234!';
		await op(ctx, { operation: 'add_role', role: loRole, permission: { super_user: false } });
		await op(ctx, { operation: 'add_role', role: hiRole, permission: { super_user: true } });
		await op(ctx, { operation: 'add_user', role: loRole, username, password, active: true });

		const auth = basicAuth(username, password);
		const session = await initialize(ctx.harper.operationsAPIURL, auth);
		const before = await toolsCount(ctx.harper.operationsAPIURL, auth, session);
		strictEqual(before, 0, 'restricted user starts with no operations tools (valid trigger)');

		const sse = await openSse(ctx.harper.operationsAPIURL, auth, session, 2500);
		try {
			strictEqual(sse.status, 200, 'operations GET SSE establishes');
			// Flip the user to a super_user role — changes its visible tool surface.
			await op(ctx, { operation: 'alter_user', username, role: hiRole });
			const evt = await sse.next((m) => m?.method === 'notifications/tools/list_changed', 5000);
			ok(evt, 'tools/list_changed delivered on the SSE stream after the surface changed');

			const after = await toolsCount(ctx.harper.operationsAPIURL, auth, session);
			ok(after > 0, `surface actually changed (tools ${before} → ${after})`);
		} finally {
			sse.close();
		}
	});

	test('N3: application-profile delivers notifications/resources/updated after a subscribed record changes', async () => {
		const id = `sub_${Date.now().toString(36)}`;
		const uri = new URL(`/WorkItem/${id}`, ctx.harper.httpURL).href;
		// Seed the record before subscribing — subscriptions use omitCurrent, so only
		// changes after subscribe should notify (not this initial write).
		await putWorkItem(ctx, id, { state: 'pending', payload: 'x' });

		const session = await initialize(ctx.harper.httpURL, adminAuth(ctx));
		const sse = await openSse(ctx.harper.httpURL, adminAuth(ctx), session, 2500);
		try {
			strictEqual(sse.status, 200, 'application GET SSE establishes');
			const sub = await mcpCall(ctx.harper.httpURL, adminAuth(ctx), session, 'resources/subscribe', { uri }, 10);
			strictEqual(sub.error, undefined, `resources/subscribe should succeed: ${JSON.stringify(sub.error)}`);
			// Mutate the subscribed record → a committed change pushes resources/updated.
			await putWorkItem(ctx, id, { state: 'done', payload: 'x', result: 'r' });
			const evt = await sse.next((m) => m?.method === 'notifications/resources/updated', 5000);
			ok(evt, 'notifications/resources/updated delivered after the subscribed record changed');
			strictEqual(evt.params.uri, uri, 'notification carries the subscribed URI');
		} finally {
			sse.close();
		}
	});

	test('N4: subscribing to a collection URI notifies on any record change in the table', async () => {
		// The collection URI is what resources/list advertises (no record id). It must
		// watch the whole table, not a phantom record named after the resource.
		const uri = new URL('/WorkItem', ctx.harper.httpURL).href;
		const session = await initialize(ctx.harper.httpURL, adminAuth(ctx));
		const sse = await openSse(ctx.harper.httpURL, adminAuth(ctx), session, 2500);
		try {
			strictEqual(sse.status, 200, 'application GET SSE establishes');
			const sub = await mcpCall(ctx.harper.httpURL, adminAuth(ctx), session, 'resources/subscribe', { uri }, 10);
			strictEqual(sub.error, undefined, `collection resources/subscribe should succeed: ${JSON.stringify(sub.error)}`);
			// A brand-new record in the table must trigger the collection subscription.
			await putWorkItem(ctx, `coll_${Date.now().toString(36)}`, { state: 'pending', payload: 'z' });
			const evt = await sse.next((m) => m?.method === 'notifications/resources/updated', 5000);
			ok(evt, 'notifications/resources/updated delivered after a record changed in the subscribed collection');
			strictEqual(evt.params.uri, uri, 'notification carries the subscribed collection URI');
		} finally {
			sse.close();
		}
	});
});
