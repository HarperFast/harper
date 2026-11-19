/**
 * #3250 — `resources/subscribe` on custom `mcpResources` URIs.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/mcp/custom-resource-subscribe.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-custom-resource-subscribe');

const READER = { username: 'mcp_sub_reader', password: 'ReaderPw-3250!' };
const OUTSIDER = { username: 'mcp_sub_outsider', password: 'OutsiderPw-3250!' };

interface Session {
	sessionId: string;
	auth: string;
}

interface ProbeState {
	subscribes: Array<{
		kind: string;
		params: Record<string, string>;
		contextUser?: string;
		instanceUser?: string;
		ambientUser?: string;
		profile?: string;
	}>;
	released: Array<{ id: string; via: string }>;
	open: string[];
}

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

suite('MCP resources/subscribe on custom mcpResources (#3250)', (ctx: ContextWithHarper) => {
	let adminAuth: string;
	let rpcId = 0;

	async function op(body: Record<string, unknown>): Promise<void> {
		const res = await fetch(new URL('/', ctx.harper.operationsAPIURL), {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'authorization': adminAuth },
			body: JSON.stringify(body),
		});
		const text = await res.text();
		ok(res.ok, `operation ${body.operation} failed: ${res.status} ${text}`);
	}

	async function initialize(auth: string): Promise<Session> {
		const res = await fetch(new URL('/mcp', ctx.harper.httpURL), {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'accept': 'application/json, text/event-stream',
				'authorization': auth,
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: ++rpcId,
				method: 'initialize',
				params: {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: { name: 'subscribe-3250', version: '0' },
				},
			}),
		});
		const text = await res.text();
		strictEqual(res.status, 200, `initialize should 200: ${text}`);
		const sessionId = res.headers.get('mcp-session-id');
		ok(sessionId, 'initialize returned an Mcp-Session-Id');
		return { sessionId, auth };
	}

	function sessionHeaders(session: Session): Record<string, string> {
		return {
			'authorization': session.auth,
			'mcp-session-id': session.sessionId,
			'mcp-protocol-version': '2025-06-18',
		};
	}

	async function rpc(session: Session, method: string, params: Record<string, unknown>): Promise<any> {
		const res = await fetch(new URL('/mcp', ctx.harper.httpURL), {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'accept': 'application/json, text/event-stream',
				...sessionHeaders(session),
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
		});
		const text = await res.text();
		strictEqual(res.status, 200, `${method} should answer HTTP 200: ${text}`);
		return JSON.parse(text);
	}

	async function openSse(session: Session): Promise<{
		next: (predicate: (msg: any) => boolean, timeoutMs: number) => Promise<any | undefined>;
		close: () => void;
	}> {
		const abort = new AbortController();
		const res = await fetch(new URL('/mcp', ctx.harper.httpURL), {
			method: 'GET',
			headers: { accept: 'text/event-stream', ...sessionHeaders(session) },
			signal: abort.signal,
		});
		strictEqual(res.status, 200, 'GET SSE stream opens');
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		const parsed: any[] = [];
		const waiters: Array<{ predicate: (m: any) => boolean; resolve: (m: any) => void }> = [];
		let buffer = '';
		(async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					let index;
					while ((index = buffer.indexOf('\n\n')) !== -1) {
						const dataLine = buffer
							.slice(0, index)
							.split('\n')
							.find((line) => line.startsWith('data:'));
						buffer = buffer.slice(index + 2);
						if (!dataLine) continue;
						let msg: any;
						try {
							msg = JSON.parse(dataLine.slice(5).trim());
						} catch {
							continue;
						}
						parsed.push(msg);
						for (let i = waiters.length - 1; i >= 0; i--) {
							if (waiters[i].predicate(msg)) {
								waiters[i].resolve(msg);
								waiters.splice(i, 1);
							}
						}
					}
				}
			} catch {
				/* aborted on close */
			}
		})();
		return {
			next(predicate, timeoutMs) {
				const existing = parsed.find(predicate);
				if (existing) return Promise.resolve(existing);
				return new Promise((resolveFrame) => {
					const timer = setTimeout(() => resolveFrame(undefined), timeoutMs);
					waiters.push({
						predicate,
						resolve: (msg) => {
							clearTimeout(timer);
							resolveFrame(msg);
						},
					});
				});
			},
			close: () => abort.abort(),
		};
	}

	const updatedFor = (uri: string) => (msg: any) =>
		msg?.method === 'notifications/resources/updated' && msg.params?.uri === uri;

	async function probe(): Promise<ProbeState> {
		const res = await fetch(new URL('/Probe/', ctx.harper.httpURL), { headers: { authorization: adminAuth } });
		ok(res.ok, `Probe GET failed: ${res.status}`);
		return res.json();
	}

	async function waitForProbe(predicate: (state: ProbeState) => boolean, what: string): Promise<ProbeState> {
		const deadline = Date.now() + 5000;
		let state = await probe();
		while (!predicate(state)) {
			ok(Date.now() < deadline, `timed out waiting for ${what}: ${JSON.stringify(state)}`);
			await sleep(50);
			state = await probe();
		}
		return state;
	}

	async function emit(id: string): Promise<boolean> {
		const res = await fetch(new URL('/Probe/', ctx.harper.httpURL), {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'authorization': adminAuth },
			body: JSON.stringify({ id }),
		});
		const text = await res.text();
		ok(res.ok, `Probe POST failed: ${res.status} ${text}`);
		return JSON.parse(text).delivered;
	}

	async function setFailStatus(id: string, failStatus: string | number | null): Promise<void> {
		const res = await fetch(new URL('/Probe/', ctx.harper.httpURL), {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'authorization': adminAuth },
			body: JSON.stringify({ id, failStatus }),
		});
		const text = await res.text();
		ok(res.ok, `Probe failStatus POST failed: ${res.status} ${text}`);
	}

	const released = (state: ProbeState, id: string, via: string) =>
		state.released.some((entry) => entry.id === id && entry.via === via);

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { mcp: { application: { mountPath: '/mcp' }, session: { allowClientDelete: true } } },
			env: {},
		});
		adminAuth = basicAuth(ctx.harper.admin.username, ctx.harper.admin.password);
		await op({
			operation: 'add_role',
			role: 'mcp_sub_note_reader',
			permission: {
				super_user: false,
				data: {
					tables: { Note: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] } },
				},
			},
		});
		await op({ operation: 'add_role', role: 'mcp_sub_no_tables', permission: { super_user: false } });
		await op({ operation: 'add_user', role: 'mcp_sub_note_reader', ...READER, active: true });
		await op({ operation: 'add_user', role: 'mcp_sub_no_tables', ...OUTSIDER, active: true });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a change the author stream emits sends resources/updated; the method ran as the session user', async () => {
		const session = await initialize(basicAuth(READER.username, READER.password));
		const sse = await openSse(session);
		try {
			const uri = 'notes:///first';
			const sub = await rpc(session, 'resources/subscribe', { uri });
			deepStrictEqual(sub.result, {}, `subscribe succeeds: ${JSON.stringify(sub.error)}`);
			ok(await emit('first'), 'the author stream is open');
			const frame = await sse.next(updatedFor(uri), 5000);
			ok(frame, 'notifications/resources/updated delivered');
			deepStrictEqual(frame.params, { uri }, 'the notification carries only the URI');
			const seen = (await probe()).subscribes.find((entry) => entry.params.id === 'first');
			deepStrictEqual(seen, {
				kind: 'notes',
				params: { id: 'first' },
				contextUser: READER.username,
				instanceUser: READER.username,
				ambientUser: READER.username,
				profile: 'application',
			});
		} finally {
			sse.close();
		}
	});

	test('unsubscribe releases the author stream with end(), and nothing more is delivered', async () => {
		const session = await initialize(basicAuth(READER.username, READER.password));
		const sse = await openSse(session);
		try {
			const uri = 'notes:///unsub';
			deepStrictEqual((await rpc(session, 'resources/subscribe', { uri })).result, {});
			deepStrictEqual((await rpc(session, 'resources/unsubscribe', { uri })).result, {});
			ok(released(await probe(), 'unsub', 'end'), 'end() called on unsubscribe');
			strictEqual(await emit('unsub'), false, 'no author stream is left open to emit on');
			strictEqual(await sse.next(updatedFor(uri), 300), undefined);
		} finally {
			sse.close();
		}
	});

	test('closing the GET stream releases the author stream; reconnecting restores it even if sibling custom URIs now fail', async () => {
		const session = await initialize(basicAuth(READER.username, READER.password));
		const uri = 'notes:///reconnect';
		const first = await openSse(session);
		deepStrictEqual((await rpc(session, 'resources/subscribe', { uri })).result, {});
		deepStrictEqual((await rpc(session, 'resources/subscribe', { uri: 'notes:///vanished' })).result, {});
		deepStrictEqual((await rpc(session, 'resources/subscribe', { uri: 'notes:///faulted' })).result, {});
		first.close();
		await waitForProbe((state) => released(state, 'reconnect', 'end'), 'the stream to be released on GET close');
		await setFailStatus('vanished', 'null');
		await setFailStatus('faulted', 'error');
		const second = await openSse(session);
		try {
			await waitForProbe(
				(state) =>
					state.subscribes.filter((entry) => entry.params.id === 'reconnect').length === 2 &&
					state.open.includes('reconnect'),
				'the reconnect to re-run subscribe from the durable list'
			);
			ok(await emit('reconnect'));
			ok(await second.next(updatedFor(uri), 5000), 'the restored subscription delivers on the new stream');
		} finally {
			second.close();
		}
		await setFailStatus('faulted', null);
		const third = await openSse(session);
		try {
			await waitForProbe(
				(state) => state.open.includes('faulted'),
				'the retained faulted URI to restore once its error clears'
			);
			strictEqual(
				(await probe()).subscribes.filter((entry) => entry.params.id === 'vanished').length,
				2,
				'the null URI was pruned on the first restore and is not retried on the next reconnect'
			);
			ok(await emit('faulted'));
			ok(
				await third.next(updatedFor('notes:///faulted'), 5000),
				'the retained faulted subscription delivers once restored'
			);
		} finally {
			third.close();
			await setFailStatus('vanished', null);
			await setFailStatus('faulted', null);
		}
	});

	test('dropping a user releases its active custom subscription stream', async () => {
		const tempUser = { username: 'mcp_sub_temp_user', password: 'TempUserPw-3250!' };
		await op({ operation: 'add_user', role: 'mcp_sub_note_reader', ...tempUser, active: true });
		const session = await initialize(basicAuth(tempUser.username, tempUser.password));
		const sse = await openSse(session);
		try {
			const uri = 'notes:///revoked-user';
			deepStrictEqual((await rpc(session, 'resources/subscribe', { uri })).result, {});
			ok((await probe()).open.includes('revoked-user'), 'custom stream is open before drop_user');
			await op({ operation: 'drop_user', username: tempUser.username });
			await waitForProbe(
				(state) => released(state, 'revoked-user', 'end'),
				'the stream to be released when its user is dropped'
			);
			strictEqual(await emit('revoked-user'), false, 'no author stream remains open after drop_user');
			strictEqual(
				(await probe()).subscribes.filter((entry) => entry.params.id === 'revoked-user').length,
				1,
				'revocation does not re-run the author subscribe method'
			);
		} finally {
			sse.close();
		}
	});

	test('DELETE releases the author stream', async () => {
		const session = await initialize(basicAuth(READER.username, READER.password));
		const sse = await openSse(session);
		try {
			deepStrictEqual((await rpc(session, 'resources/subscribe', { uri: 'notes:///deleted' })).result, {});
			const res = await fetch(new URL('/mcp', ctx.harper.httpURL), {
				method: 'DELETE',
				headers: sessionHeaders(session),
			});
			strictEqual(res.status, 204);
			await waitForProbe((state) => released(state, 'deleted', 'end'), 'the stream to be released on DELETE');
		} finally {
			sse.close();
		}
	});

	test('a stream with only return() is released by it on unsubscribe, while idle', async () => {
		const session = await initialize(basicAuth(READER.username, READER.password));
		const sse = await openSse(session);
		try {
			const uri = 'notes-return:///idle';
			deepStrictEqual((await rpc(session, 'resources/subscribe', { uri })).result, {});
			ok((await probe()).open.includes('idle'), 'subscribed and idle');
			deepStrictEqual((await rpc(session, 'resources/unsubscribe', { uri })).result, {});
			ok(released(await probe(), 'idle', 'return'), 'return() called with no event pending');
		} finally {
			sse.close();
		}
	});

	test('a custom resource without subscribe or returning an unreleasable stream answers -32602', async () => {
		const session = await initialize(basicAuth(READER.username, READER.password));
		const sse = await openSse(session);
		try {
			const body = await rpc(session, 'resources/subscribe', { uri: 'plain:///readme' });
			strictEqual(body.error?.code, -32602);
			strictEqual(body.error.message, 'resource is not subscribable: plain:///readme');
			strictEqual((await rpc(session, 'resources/read', { uri: 'plain:///readme' })).result.contents[0].text, 'readme');
			const unreleasable = await rpc(session, 'resources/subscribe', { uri: 'notes:///unreleasable' });
			strictEqual(unreleasable.error?.code, -32602);
			strictEqual(unreleasable.error.message, 'resource is not subscribable: notes:///unreleasable');
		} finally {
			sse.close();
		}
	});

	test('an author subscribe error is a sanitized JSON-RPC error', async () => {
		const session = await initialize(basicAuth(READER.username, READER.password));
		const sse = await openSse(session);
		try {
			const body = await rpc(session, 'resources/subscribe', { uri: 'notes:///broken' });
			strictEqual(body.error?.code, -32603);
			strictEqual(body.error.message, 'resource subscription failed; retry the request');
			ok(!JSON.stringify(body).includes('sk-secret-3250'), 'the author error text stays in the server log');
		} finally {
			sse.close();
		}
	});

	test('a table-backed subscribe authorizes the session user', async () => {
		const id = `row_${Date.now().toString(36)}`;
		const uri = `rows:///${id}`;
		const put = async (text: string) => {
			const res = await fetch(new URL(`/Note/${id}`, ctx.harper.httpURL), {
				method: 'PUT',
				headers: { 'content-type': 'application/json', 'authorization': adminAuth },
				body: JSON.stringify({ id, text }),
			});
			const reply = await res.text();
			ok(res.ok, `PUT Note/${id} failed: ${res.status} ${reply}`);
		};
		await put('before subscribe');

		const outsider = await initialize(basicAuth(OUTSIDER.username, OUTSIDER.password));
		const outsiderSse = await openSse(outsider);
		try {
			const denied = await rpc(outsider, 'resources/subscribe', { uri });
			strictEqual(denied.error?.code, -32602);
			strictEqual(denied.error.message, `permission denied: ${uri}`);
		} finally {
			outsiderSse.close();
		}

		const reader = await initialize(basicAuth(READER.username, READER.password));
		const readerSse = await openSse(reader);
		try {
			const subscribed = await rpc(reader, 'resources/subscribe', { uri });
			deepStrictEqual(subscribed.result, {}, JSON.stringify(subscribed));
			await put('after subscribe');
			const frame = await readerSse.next(updatedFor(uri), 5000);
			ok(frame, 'a committed change to the row notifies the subscribed reader');
		} finally {
			readerSse.close();
		}
	});
});
