// requires-isolation
/**
 * Regression anchor for #4494 (#4346, #4347, #4362, #4352) (`mcp.application.stateless`,
 * `instructions`, `serverCard`, component API, strict validation).
 *
 * Covers five uncovered multi-factor interaction corners on real Harper instances:
 *   1. Multi-worker (`threads.count: 2`) + Storage engine parity (`rocksdb` & `lmdb`)
 *      with stateless `mcp.application` alongside stateful `mcp.operations`.
 *   2. Component API (`server.setMcpInstructions`, `server.setMcpServerCard`) + config
 *      precedence/merge + runtime mutation + `restartHttpWorkers()` restoration.
 *   3. `server-card` HTTP/routing boundaries (trailing-slash `mountPath`, sub-path,
 *      `HEAD`/`OPTIONS`/`POST`, `If-None-Match` 304/200/400, `http.cors` + restrictive
 *      `corsAccessList`, `Vary` presence/absence, and `X-Forwarded-Proto: https`).
 *   4. Stateless streaming `tools/call` (progress, `notifications/cancelled` ignored,
 *      client socket disconnect aborts `signal` & releases concurrency slot), custom
 *      `mcpPrompts`, `server.setMcpQuotaHandler`, stateless rate limiting across
 *      principals & `x-forwarded-for`, and `hdb.log` `mcp.audit` verification.
 *   5. Env-var config boundaries (`MCP_APPLICATION_STATELESS`, `MCP_APPLICATION_INSTRUCTIONS`,
 *      `MCP_APPLICATION_SERVERCARD_*`) and invalid config validation / boot rejection.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	createHarperContext,
	setupHarperWithFixture,
	teardownHarper,
	type HarperTestContext,
	type StartedHarperTestContext,
} from '@harperfast/integration-testing';
import { createApiClient } from '../apiTests/utils/client.mjs';
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';
import { parseSseBlocks } from '../utils/sseStream.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/application-stateless-boundaries');
const PROTOCOL_VERSION = '2025-06-18';

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function waitForHealth(httpURL: string, auth: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastStatus: number | undefined;
	let lastErr: string | undefined;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${httpURL}/Health/`, { headers: { Authorization: auth } });
			lastStatus = res.status;
			await res.text();
			if (res.status !== 404) return;
		} catch (err) {
			lastErr = err instanceof Error ? err.message : String(err);
		}
		await sleep(200);
	}
	throw new Error(`Health route not ready within ${timeoutMs}ms (lastStatus=${lastStatus}, lastErr=${lastErr})`);
}

async function mcpPost(
	url: string,
	body: unknown,
	headers: Record<string, string> = {}
): Promise<{ status: number; headers: Headers; text: string; json: any }> {
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'accept': 'application/json, text/event-stream',
			...headers,
		},
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
	const text = await res.text();
	let json: any;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	return { status: res.status, headers: res.headers, text, json };
}

function parseToolJson(rpcBody: any): any {
	const text = rpcBody?.result?.content?.[0]?.text;
	strictEqual(typeof text, 'string', `expected content[0].text string, got: ${JSON.stringify(rpcBody)}`);
	return JSON.parse(text);
}

/**
 * Open a streaming POST SSE request using `node:http` so we can inspect frames as they arrive,
 * trigger mid-stream actions (e.g. `notifications/cancelled` or socket destroy), and assert clean completion.
 */
function openSsePost(
	urlStr: string,
	body: unknown,
	headers: Record<string, string>,
	hooks: {
		onFirstDataBlock?: (req: http.ClientRequest, block: Record<string, string>) => void | Promise<void>;
		timeoutMs?: number;
	} = {}
): Promise<{
	status: number;
	contentType: string | undefined;
	raw: string;
	blocks: Array<Record<string, string>>;
	terminatedBy: 'end' | 'close' | 'error';
}> {
	const url = new URL(urlStr);
	const payload = JSON.stringify(body);
	return new Promise((resolvePromise, rejectPromise) => {
		let settled = false;
		let status = 0;
		let contentType: string | undefined;
		let raw = '';
		let firstFired = false;
		const timer = setTimeout(() => {
			if (!settled) {
				req.destroy(new Error(`openSsePost timed out after ${hooks.timeoutMs ?? 15_000}ms`));
			}
		}, hooks.timeoutMs ?? 15_000);

		const finish = (terminatedBy: 'end' | 'close' | 'error') => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise({ status, contentType, raw, blocks: parseSseBlocks(raw), terminatedBy });
		};

		const req = http.request(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'accept': 'application/json, text/event-stream',
					'content-length': Buffer.byteLength(payload),
					...headers,
				},
			},
			(res) => {
				status = res.statusCode ?? 0;
				contentType = res.headers['content-type'];
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => {
					raw += chunk;
					if (!firstFired && hooks.onFirstDataBlock) {
						const blocks = parseSseBlocks(raw);
						const dataBlock = blocks.find((b) => b.data);
						if (dataBlock) {
							firstFired = true;
							void Promise.resolve(hooks.onFirstDataBlock(req, dataBlock));
						}
					}
				});
				res.on('end', () => finish('end'));
				res.on('close', () => finish('close'));
				res.on('error', () => finish('error'));
			}
		);
		req.on('error', (err) => {
			if (!settled && status !== 0) finish('error');
			else if (!settled) {
				settled = true;
				clearTimeout(timer);
				rejectPromise(err);
			}
		});
		req.write(payload);
		req.end();
	});
}

// ---------------------------------------------------------------------------
// 1. Multi-worker (threads.count: 2) + Storage engine parity (rocksdb & lmdb)
//    + stateless mcp.application alongside stateful mcp.operations
// ---------------------------------------------------------------------------
for (const engine of ['rocksdb', 'lmdb'] as const) {
	suite(`MCP stateless boundaries [1] Multi-worker + ${engine} parity: stateless app + stateful ops`, () => {
		const node: HarperTestContext = createHarperContext(`mcp-stateless-parity-${engine}`);
		let started: StartedHarperTestContext;
		let auth: string;
		let appUrl: string;
		let opsUrl: string;

		before(async () => {
			await setupHarperWithFixture(node, FIXTURE_PATH, {
				config: {
					threads: { count: 2 },
					authentication: { authorizeLocal: false },
					mcp: {
						application: {
							mountPath: '/mcp',
							stateless: true,
							instructions: 'Config instructions win over component',
							serverCard: {
								name: 'com.qa/multiworker-parity',
								description: `Stateless multi-worker parity (${engine})`,
							},
						},
						operations: {
							mountPath: '/mcp',
						},
					},
				},
				env: {
					AUTHENTICATION_AUTHORIZELOCAL: 'false',
					QA_INIT_INSTRUCTIONS: 'Component instructions that config must override',
					...(engine === 'lmdb' ? { HARPER_STORAGE_ENGINE: 'lmdb' } : {}),
				},
			});
			started = node as StartedHarperTestContext;
			auth = basicAuth(started.harper.admin.username, started.harper.admin.password);
			appUrl = `${started.harper.httpURL}/mcp`;
			opsUrl = `${started.harper.operationsAPIURL}/mcp`;
			await waitForHealth(started.harper.httpURL, auth);
		});

		after(async () => {
			if (node.harper) await teardownHarper(node as StartedHarperTestContext);
		});

		test(`on-disk storage engine matches ${engine}`, () => {
			const dbDir = join(started.harper.dataRootDir, 'database');
			const rocksDataDir = join(dbDir, 'data');
			const lmdbDataFile = join(dbDir, 'data.mdb');
			if (engine === 'rocksdb') {
				ok(existsSync(rocksDataDir) && statSync(rocksDataDir).isDirectory(), `expected ${rocksDataDir} dir`);
				strictEqual(existsSync(lmdbDataFile), false, `did not expect ${lmdbDataFile} under rocksdb`);
			} else {
				ok(existsSync(lmdbDataFile) && statSync(lmdbDataFile).isFile(), `expected ${lmdbDataFile} file`);
			}
		});

		test('full stateless application protocol lifecycle + 0 rows in system.mcp_session + stateful ops creates 1 row without instructions', async () => {
			const authHeaders = { authorization: auth };

			// 1. initialize (stateless application)
			const init = await mcpPost(
				appUrl,
				{
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: {
						protocolVersion: PROTOCOL_VERSION,
						capabilities: { roots: {} },
						clientInfo: { name: 'qa', version: '1' },
					},
				},
				authHeaders
			);
			strictEqual(init.status, 200, init.text);
			strictEqual(init.headers.get('mcp-session-id'), null, 'stateless initialize must not mint Mcp-Session-Id');
			strictEqual(init.json.result.protocolVersion, PROTOCOL_VERSION);
			strictEqual(
				init.json.result.instructions,
				'Config instructions win over component',
				'config instructions must override server.setMcpInstructions()'
			);
			deepStrictEqual(init.json.result.capabilities, {
				tools: {},
				resources: {},
				prompts: {},
				completions: {},
			});

			const protoHeaders = { ...authHeaders, 'mcp-protocol-version': PROTOCOL_VERSION };

			// 2. notifications/initialized -> 202
			const notif = await mcpPost(appUrl, { jsonrpc: '2.0', method: 'notifications/initialized' }, protoHeaders);
			strictEqual(notif.status, 202, notif.text);

			// 3. tools/list
			const toolsList = await mcpPost(
				appUrl,
				{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
				protoHeaders
			);
			strictEqual(toolsList.status, 200, toolsList.text);
			const toolNames: string[] = toolsList.json.result.tools.map((t: { name: string }) => t.name);
			ok(toolNames.includes('qa_echo'), `qa_echo missing: ${toolNames.join(', ')}`);
			ok(toolNames.includes('create_Note'), `create_Note missing: ${toolNames.join(', ')}`);
			ok(toolNames.includes('get_Note'), `get_Note missing: ${toolNames.join(', ')}`);

			// 4. tools/call: CRUD Note + custom qa_echo
			const createNote = await mcpPost(
				appUrl,
				{
					jsonrpc: '2.0',
					id: 3,
					method: 'tools/call',
					params: { name: 'create_Note', arguments: { id: `n-${engine}`, body: `hello-${engine}` } },
				},
				protoHeaders
			);
			strictEqual(createNote.status, 200, createNote.text);
			strictEqual(createNote.json.result.isError, undefined, createNote.text);
			strictEqual(createNote.json.result.structuredContent?.id, `n-${engine}`);

			const getNote = await mcpPost(
				appUrl,
				{ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_Note', arguments: { id: `n-${engine}` } } },
				protoHeaders
			);
			strictEqual(getNote.status, 200, getNote.text);
			strictEqual(getNote.json.result.structuredContent?.body, `hello-${engine}`);

			// Issue several qa_echo calls with Connection: close to encourage multi-worker distribution
			const seenThreads = new Set<number>();
			for (let i = 0; i < 8; i++) {
				const echo = await mcpPost(
					appUrl,
					{
						jsonrpc: '2.0',
						id: 10 + i,
						method: 'tools/call',
						params: { name: 'qa_echo', arguments: { msg: `m-${i}` } },
					},
					{ ...protoHeaders, connection: 'close' }
				);
				strictEqual(echo.status, 200, echo.text);
				const payload = parseToolJson(echo.json);
				strictEqual(payload.sessionIdIsUndefined, true);
				strictEqual(payload.sessionIdValue, '__UNDEFINED__');
				strictEqual(payload.hasServerRequest, false);
				strictEqual(payload.username, 'admin');
				strictEqual(payload.echo, `m-${i}`);
				seenThreads.add(payload.threadId);
			}
			ok(seenThreads.size >= 1, `expected >=1 worker threadId, got ${[...seenThreads].join(',')}`);
			console.log(
				`[mcp-stateless-boundaries][${engine}] observed worker threadIds across 8 calls: ${[...seenThreads].join(', ')}`
			);

			// 5. prompts/list & prompts/get
			const promptsList = await mcpPost(
				appUrl,
				{ jsonrpc: '2.0', id: 20, method: 'prompts/list', params: {} },
				protoHeaders
			);
			strictEqual(promptsList.status, 200, promptsList.text);
			ok(promptsList.json.result.prompts.some((p: { name: string }) => p.name === 'qa_prompt'));

			const promptGet = await mcpPost(
				appUrl,
				{ jsonrpc: '2.0', id: 21, method: 'prompts/get', params: { name: 'qa_prompt', arguments: { topic: engine } } },
				protoHeaders
			);
			strictEqual(promptGet.status, 200, promptGet.text);
			const renderedPrompt = JSON.parse(promptGet.json.result.messages[0].content.text);
			console.log(
				`[mcp-stateless-boundaries][${engine}] custom mcpPrompts render observed: ${JSON.stringify(renderedPrompt)}`
			);
			strictEqual(renderedPrompt.topic, engine);
			// Diagnostic: tools/application.ts:1161 currently drops context (pre-existing F-1216);
			// assert the stateless sessionId invariant so this anchor holds before and after F-1216 lands.
			strictEqual(renderedPrompt.sessionIdIsUndefined, true);
			strictEqual(renderedPrompt.sessionIdValue, '__UNDEFINED__');

			// 6. resources/list & resources/read
			const resList = await mcpPost(
				appUrl,
				{ jsonrpc: '2.0', id: 22, method: 'resources/list', params: {} },
				protoHeaders
			);
			strictEqual(resList.status, 200, resList.text);
			const uris: string[] = resList.json.result.resources.map((r: { uri: string }) => r.uri);
			ok(uris.includes('harper://openapi'), `missing harper://openapi in ${uris.join(', ')}`);

			const resRead = await mcpPost(
				appUrl,
				{ jsonrpc: '2.0', id: 23, method: 'resources/read', params: { uri: 'harper://openapi' } },
				protoHeaders
			);
			strictEqual(resRead.status, 200, resRead.text);
			ok(Array.isArray(resRead.json.result.contents) && resRead.json.result.contents.length === 1);

			// 7. ping
			const ping = await mcpPost(appUrl, { jsonrpc: '2.0', id: 24, method: 'ping' }, protoHeaders);
			strictEqual(ping.status, 200, ping.text);
			deepStrictEqual(ping.json.result, {});

			// 8. SESSION_METHODS -> -32601
			for (const [idx, reqBody] of [
				{ jsonrpc: '2.0', id: 30, method: 'resources/subscribe', params: { uri: 'harper://openapi' } },
				{ jsonrpc: '2.0', id: 31, method: 'resources/unsubscribe', params: { uri: 'harper://openapi' } },
				{ jsonrpc: '2.0', id: 32, method: 'logging/setLevel', params: { level: 'info' } },
			].entries()) {
				const r = await mcpPost(appUrl, reqBody, protoHeaders);
				strictEqual(r.status, 200, `${reqBody.method}: ${r.text}`);
				strictEqual(r.json.error.code, -32601, `${reqBody.method}: ${r.text}`);
				match(r.json.error.message, /stateless/i, `${reqBody.method}: ${r.text}`);
				void idx;
			}

			// 9. GET and DELETE -> 405 Allow: POST
			for (const method of ['GET', 'DELETE']) {
				const r = await fetch(appUrl, {
					method,
					headers: { accept: 'text/event-stream', authorization: auth },
				});
				await r.text();
				strictEqual(r.status, 405, method);
				strictEqual(r.headers.get('allow'), 'POST', method);
			}

			// 10. Unsupported MCP-Protocol-Version -> 400
			const badProto = await mcpPost(
				appUrl,
				{ jsonrpc: '2.0', id: 33, method: 'ping' },
				{ ...authHeaders, 'mcp-protocol-version': '1999-01-01' }
			);
			strictEqual(badProto.status, 400, badProto.text);
			strictEqual(badProto.json.error.code, -32600);

			// 11. Leftover Mcp-Session-Id ignored
			const staleSess = await mcpPost(
				appUrl,
				{ jsonrpc: '2.0', id: 34, method: 'ping' },
				{ ...protoHeaders, 'mcp-session-id': '00000000-0000-4000-8000-000000000000' }
			);
			strictEqual(staleSess.status, 200, staleSess.text);
			deepStrictEqual(staleSess.json.result, {});

			// 12. Verify system.mcp_session has 0 rows after all stateless application traffic
			const probeBefore = await fetch(`${started.harper.httpURL}/SessionTableProbe/`, { headers: authHeaders });
			strictEqual(probeBefore.status, 200);
			const sessionsBefore = (await probeBefore.json()) as { count: number; rows: unknown[] };
			strictEqual(
				sessionsBefore.count,
				0,
				`expected 0 rows in system.mcp_session after stateless app traffic, got ${JSON.stringify(sessionsBefore)}`
			);

			// 13. Stateful mcp.operations initialize on operations port DOES create 1 session row and omits instructions
			const opsInit = await mcpPost(
				opsUrl,
				{
					jsonrpc: '2.0',
					id: 40,
					method: 'initialize',
					params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'qa-ops', version: '1' } },
				},
				authHeaders
			);
			strictEqual(opsInit.status, 200, opsInit.text);
			const opsSessionId = opsInit.headers.get('mcp-session-id');
			ok(opsSessionId && opsSessionId.length > 0, 'stateful operations initialize must mint Mcp-Session-Id');
			strictEqual(opsInit.json.result.instructions, undefined, 'operations profile must omit instructions');
			strictEqual(opsInit.json.result.capabilities.resources.subscribe, true);
			deepStrictEqual(opsInit.json.result.capabilities.logging, {});

			const probeAfter = await fetch(`${started.harper.httpURL}/SessionTableProbe/`, { headers: authHeaders });
			strictEqual(probeAfter.status, 200);
			const sessionsAfter = (await probeAfter.json()) as { count: number; rows: Array<{ id: string; user: string }> };
			strictEqual(
				sessionsAfter.count,
				1,
				`expected 1 row in system.mcp_session after ops initialize: ${JSON.stringify(sessionsAfter)}`
			);
			strictEqual(sessionsAfter.rows[0].id, opsSessionId);
			strictEqual(sessionsAfter.rows[0].user, 'admin');
		});
	});
}

// ---------------------------------------------------------------------------
// 2 & 3. Component API + config merge/precedence + runtime mutation +
//        restartHttpWorkers() + server-card HTTP/routing/CORS/XFP boundaries
// ---------------------------------------------------------------------------
suite(
	'MCP stateless boundaries [2&3] Component API, config merge, runtime mutation, restartHttpWorkers, and server-card HTTP/CORS/XFP boundaries',
	() => {
		const node: HarperTestContext = createHarperContext('mcp-stateless-card-api-cors');
		let started: StartedHarperTestContext;
		let auth: string;
		let mcpEndpoint: string;
		let cardUrl: string;

		const INIT_INSTRUCTIONS = 'Component module-load instructions';
		const INIT_CARD = {
			name: 'com.qa/stateless-app',
			description: 'from-code',
			title: 'Code Title',
			version: '1.2.3',
		};

		before(async () => {
			await setupHarperWithFixture(node, FIXTURE_PATH, {
				config: {
					threads: { count: 1 },
					authentication: { authorizeLocal: false },
					http: {
						cors: true,
						corsAccessList: ['https://allowed.example'],
					},
					mcp: {
						application: {
							mountPath: '/api/mcp/',
							stateless: true,
							authentication: { required: true },
							// Partial config card: overrides `description`, leaves `name`/`title`/`version`/`url` to component
							serverCard: {
								description: 'from-config',
							},
						},
					},
				},
				env: {
					AUTHENTICATION_AUTHORIZELOCAL: 'false',
					QA_INIT_INSTRUCTIONS: INIT_INSTRUCTIONS,
					QA_INIT_SERVER_CARD: JSON.stringify(INIT_CARD),
				},
			});
			started = node as StartedHarperTestContext;
			auth = basicAuth(started.harper.admin.username, started.harper.admin.password);
			mcpEndpoint = `${started.harper.httpURL}/api/mcp`;
			cardUrl = `${started.harper.httpURL}/api/mcp/server-card`;
			await waitForHealth(started.harper.httpURL, auth);
		});

		after(async () => {
			if (node.harper) await teardownHarper(node as StartedHarperTestContext);
		});

		test('trailing-slash mountPath, partial config/component merge, HTTP methods, ETag/If-None-Match, sub-path, CORS, and X-Forwarded-Proto', async () => {
			// 1. GET /api/mcp/server-card without credentials (even with authentication.required: true)
			//    and with a DISALLOWED Origin header under restrictive http.corsAccessList
			const resDisallowedOrigin = await fetch(cardUrl, {
				headers: { Origin: 'https://disallowed.example' },
			});
			const body1 = await resDisallowedOrigin.text();
			strictEqual(resDisallowedOrigin.status, 200, body1);
			strictEqual(resDisallowedOrigin.headers.get('content-type'), 'application/mcp-server-card+json');
			strictEqual(resDisallowedOrigin.headers.get('access-control-allow-origin'), '*');
			strictEqual(resDisallowedOrigin.headers.get('vary'), 'Host, X-Forwarded-Proto');
			const initialEtag = resDisallowedOrigin.headers.get('etag');
			ok(initialEtag && initialEtag.startsWith('"'), `expected quoted ETag, got ${initialEtag}`);

			const card1 = JSON.parse(body1);
			strictEqual(card1.name, 'com.qa/stateless-app', 'component-only name preserved');
			strictEqual(card1.description, 'from-config', 'config description overrides component description');
			strictEqual(card1.title, 'Code Title', 'component-only title preserved');
			strictEqual(card1.version, '1.2.3', 'component-only version preserved');
			deepStrictEqual(card1.remotes, [
				{
					type: 'streamable-http',
					url: `${started.harper.httpURL}/api/mcp`,
					supportedProtocolVersions: ['2025-06-18', '2025-03-26'],
				},
			]);

			// Also check with ALLOWED Origin — server card must still serve Access-Control-Allow-Origin: *
			const resAllowedOrigin = await fetch(cardUrl, {
				headers: { Origin: 'https://allowed.example' },
			});
			await resAllowedOrigin.text();
			strictEqual(resAllowedOrigin.status, 200);
			strictEqual(resAllowedOrigin.headers.get('access-control-allow-origin'), '*');

			// 2. X-Forwarded-Proto: https with !card.url — record exact observed remotes[0].url vs Vary header!
			const resXfp = await fetch(cardUrl, {
				headers: { 'X-Forwarded-Proto': 'https' },
			});
			const xfpCard = JSON.parse(await resXfp.text());
			const xfpObservedUrl = xfpCard.remotes?.[0]?.url;
			const xfpVary = resXfp.headers.get('vary');
			console.log(
				`[mcp-stateless-boundaries][XFP] X-Forwarded-Proto: https -> Vary="${xfpVary}", remotes[0].url="${xfpObservedUrl}", etagMatch=${resXfp.headers.get('etag') === initialEtag}`
			);
			strictEqual(xfpVary, 'Host, X-Forwarded-Proto');
			// On Node HTTP, NodeRequest.protocol checks socket.encrypted / PROXY v2 TLS TLV (not X-Forwarded-Proto),
			// whereas uWS honors X-Forwarded-Proto: https; assert the exact transport-specific derived URL.
			const expectedXfpUrl =
				process.env.HARPER_UWS_HTTP === '1'
					? `${started.harper.httpURL.replace(/^http:/, 'https:')}/api/mcp`
					: `${started.harper.httpURL}/api/mcp`;
			strictEqual(xfpObservedUrl, expectedXfpUrl);

			// 3. HEAD -> 200, empty body, same ETag & headers
			const headRes = await fetch(cardUrl, { method: 'HEAD' });
			const headBody = await headRes.text();
			strictEqual(headRes.status, 200);
			strictEqual(headBody, '');
			strictEqual(headRes.headers.get('etag'), initialEtag);
			strictEqual(headRes.headers.get('content-type'), 'application/mcp-server-card+json');
			strictEqual(headRes.headers.get('access-control-allow-origin'), '*');

			// 4. OPTIONS -> 204 preflight
			const optRes = await fetch(cardUrl, {
				method: 'OPTIONS',
				headers: {
					'Origin': 'https://disallowed.example',
					'Access-Control-Request-Method': 'GET',
					'Access-Control-Request-Headers': 'if-none-match',
				},
			});
			await optRes.text();
			strictEqual(optRes.status, 204);
			strictEqual(optRes.headers.get('access-control-allow-origin'), '*');
			strictEqual(optRes.headers.get('access-control-allow-methods'), 'GET');

			// 5. POST -> 405 Allow: GET, HEAD, OPTIONS
			const postCard = await fetch(cardUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
			});
			await postCard.text();
			strictEqual(postCard.status, 405);
			strictEqual(postCard.headers.get('allow'), 'GET, HEAD, OPTIONS');

			// 6. If-None-Match: matching -> 304, mismatching -> 200, malformed -> 400
			const inmMatch = await fetch(cardUrl, { headers: { 'If-None-Match': initialEtag! } });
			strictEqual(inmMatch.status, 304);
			strictEqual(await inmMatch.text(), '');

			const inmMismatch = await fetch(cardUrl, { headers: { 'If-None-Match': '"different-etag"' } });
			strictEqual(inmMismatch.status, 200);
			strictEqual(JSON.parse(await inmMismatch.text()).name, 'com.qa/stateless-app');

			const inmMalformed = await fetch(cardUrl, { headers: { 'If-None-Match': 'not-a-quoted-etag' } });
			await inmMalformed.text();
			strictEqual(inmMalformed.status, 400);

			// 7. Sub-path /api/mcp/server-card/extra must NOT leak to mcpHarperHttpHandler (must 404)
			const subGet = await fetch(`${cardUrl}/extra`, { headers: { Authorization: auth } });
			const subGetText = await subGet.text();
			strictEqual(subGet.status, 404, `GET /server-card/extra expected 404, got ${subGet.status}: ${subGetText}`);

			const subPost = await fetch(`${cardUrl}/extra`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'accept': 'application/json', 'authorization': auth },
				body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }),
			});
			const subPostText = await subPost.text();
			strictEqual(
				subPost.status,
				404,
				`POST /server-card/extra expected 404 (not MCP handler), got ${subPost.status}: ${subPostText}`
			);

			// 8. Meanwhile MCP endpoint itself enforces http.corsAccessList Origin validation (403 on disallowed, 200 on allowed)
			const mcpDisallowed = await mcpPost(
				mcpEndpoint,
				{ jsonrpc: '2.0', id: 1, method: 'ping' },
				{ authorization: auth, origin: 'https://disallowed.example' }
			);
			strictEqual(mcpDisallowed.status, 403, mcpDisallowed.text);
			deepStrictEqual(mcpDisallowed.json, { error: 'origin_not_allowed' });

			const mcpAllowed = await mcpPost(
				mcpEndpoint,
				{
					jsonrpc: '2.0',
					id: 2,
					method: 'initialize',
					params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'qa', version: '1' } },
				},
				{ authorization: auth, origin: 'https://allowed.example' }
			);
			strictEqual(mcpAllowed.status, 200, mcpAllowed.text);
			strictEqual(mcpAllowed.json.result.instructions, INIT_INSTRUCTIONS);
		});

		test('runtime mutation updates card + ETag, drops Vary when url is set, clearing returns 404, and restartHttpWorkers restores module-load registrations', async () => {
			const initBefore = await fetch(cardUrl);
			const etagBefore = initBefore.headers.get('etag');
			await initBefore.text();

			// Runtime update: change title and set canonical url -> Vary must disappear, ETag must change, config description still wins
			const updateCardRes = await fetch(`${started.harper.httpURL}/QaControl/`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'authorization': auth },
				body: JSON.stringify({
					action: 'set_card',
					value: {
						name: 'com.qa/stateless-app',
						description: 'runtime-overridden-by-config',
						title: 'Runtime Updated Title',
						url: 'https://canonical.example/api/mcp',
					},
				}),
			});
			strictEqual(updateCardRes.status, 200, await updateCardRes.text());

			const cardAfterUpdate = await fetch(cardUrl);
			const cardAfterJson = JSON.parse(await cardAfterUpdate.text());
			strictEqual(cardAfterUpdate.status, 200);
			strictEqual(cardAfterJson.title, 'Runtime Updated Title');
			strictEqual(cardAfterJson.description, 'from-config', 'config must still override runtime description');
			strictEqual(cardAfterJson.remotes[0].url, 'https://canonical.example/api/mcp');
			notStrictEqual(cardAfterUpdate.headers.get('etag'), etagBefore, 'ETag must change after runtime update');
			strictEqual(cardAfterUpdate.headers.get('vary'), null, 'Vary must be omitted when card.url is set');

			// Runtime update instructions
			const updateInstrRes = await fetch(`${started.harper.httpURL}/QaControl/`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'authorization': auth },
				body: JSON.stringify({ action: 'set_instructions', value: 'Runtime updated instructions' }),
			});
			strictEqual(updateInstrRes.status, 200, await updateInstrRes.text());

			const initUpdated = await mcpPost(
				mcpEndpoint,
				{
					jsonrpc: '2.0',
					id: 10,
					method: 'initialize',
					params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'qa', version: '1' } },
				},
				{ authorization: auth }
			);
			strictEqual(initUpdated.status, 200, initUpdated.text);
			strictEqual(initUpdated.json.result.instructions, 'Runtime updated instructions');

			// Invalid runtime setMcpServerCard throws TypeError and leaves previous card intact
			const invalidCardRes = await fetch(`${started.harper.httpURL}/QaControl/`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'authorization': auth },
				body: JSON.stringify({ action: 'try_invalid_card', value: { name: 'no-slash' } }),
			});
			strictEqual(invalidCardRes.status, 200);
			const invalidCardOutcome = (await invalidCardRes.json()) as { threw: boolean; name: string; message: string };
			strictEqual(invalidCardOutcome.threw, true);
			strictEqual(invalidCardOutcome.name, 'TypeError');
			match(invalidCardOutcome.message, /name/);

			// Still serving the previous updated card intact
			const stillUpdated = await fetch(cardUrl);
			strictEqual(stillUpdated.status, 200);
			strictEqual(JSON.parse(await stillUpdated.text()).title, 'Runtime Updated Title');

			// Clear card -> config only has description (no name) -> /server-card returns 404
			const clearCardRes = await fetch(`${started.harper.httpURL}/QaControl/`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'authorization': auth },
				body: JSON.stringify({ action: 'set_card', value: null }),
			});
			strictEqual(clearCardRes.status, 200, await clearCardRes.text());

			const cardCleared = await fetch(cardUrl);
			await cardCleared.text();
			strictEqual(cardCleared.status, 404, 'clearing component card removes required name -> 404');
			strictEqual(cardCleared.headers.get('access-control-allow-origin'), '*');

			// Clear instructions -> initialize omits instructions
			const clearInstrRes = await fetch(`${started.harper.httpURL}/QaControl/`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'authorization': auth },
				body: JSON.stringify({ action: 'set_instructions', value: null }),
			});
			strictEqual(clearInstrRes.status, 200, await clearInstrRes.text());

			const initCleared = await mcpPost(
				mcpEndpoint,
				{
					jsonrpc: '2.0',
					id: 11,
					method: 'initialize',
					params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'qa', version: '1' } },
				},
				{ authorization: auth }
			);
			strictEqual(initCleared.status, 200, initCleared.text);
			strictEqual(initCleared.json.result.instructions, undefined);

			// Restart HTTP workers -> module-load registrations cleanly restored!
			const apiClient = createApiClient(started.harper);
			await restartHttpWorkers(apiClient, '/Health/', 60_000);

			const cardRestored = await fetch(cardUrl);
			const cardRestoredJson = JSON.parse(await cardRestored.text());
			strictEqual(cardRestored.status, 200, 'restartHttpWorkers must restore module-load server card');
			strictEqual(cardRestoredJson.name, 'com.qa/stateless-app');
			strictEqual(cardRestoredJson.title, 'Code Title');
			strictEqual(cardRestoredJson.description, 'from-config');
			strictEqual(cardRestored.headers.get('vary'), 'Host, X-Forwarded-Proto');

			const initRestored = await mcpPost(
				mcpEndpoint,
				{
					jsonrpc: '2.0',
					id: 12,
					method: 'initialize',
					params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'qa', version: '1' } },
				},
				{ authorization: auth }
			);
			strictEqual(initRestored.status, 200, initRestored.text);
			strictEqual(initRestored.json.result.instructions, INIT_INSTRUCTIONS);
		});
	}
);

// ---------------------------------------------------------------------------
// 4. Stateless streaming tools/call, custom mcpPrompts, durable quota handler,
//    audit log (hdb.log), and stateless rate limiting
// ---------------------------------------------------------------------------
suite(
	'MCP stateless boundaries [4] Stateless streaming, disconnect abort, quota, rate limiting, prompts, and audit log',
	() => {
		const node: HarperTestContext = createHarperContext('mcp-stateless-stream-quota-rl');
		let started: StartedHarperTestContext;
		let adminAuth: string;
		let user2Auth: string;
		let appUrl: string;

		before(async () => {
			await setupHarperWithFixture(node, FIXTURE_PATH, {
				config: {
					threads: { count: 1 },
					authentication: { authorizeLocal: false },
					logging: { level: 'info', file: true },
					mcp: {
						application: {
							mountPath: '/mcp',
							stateless: true,
							rateLimit: {
								perToolPerSecond: 0.001,
								perToolBurst: 2,
								sessionConcurrency: 1,
								identityHeader: 'x-forwarded-for',
							},
						},
					},
				},
				env: {
					AUTHENTICATION_AUTHORIZELOCAL: 'false',
					QA_ENABLE_QUOTA: 'true',
				},
			});
			started = node as StartedHarperTestContext;
			adminAuth = basicAuth(started.harper.admin.username, started.harper.admin.password);
			appUrl = `${started.harper.httpURL}/mcp`;
			await waitForHealth(started.harper.httpURL, adminAuth);

			// Create a second super_user principal to verify per-(user, ip) stateless bucket isolation
			const addUserRes = await fetch(started.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'authorization': adminAuth },
				body: JSON.stringify({
					operation: 'add_user',
					username: 'qa_user2',
					password: 'QaUser2Pass!1',
					role: 'super_user',
					active: true,
				}),
			});
			strictEqual(addUserRes.status, 200, await addUserRes.text());
			user2Auth = basicAuth('qa_user2', 'QaUser2Pass!1');
		});

		after(async () => {
			if (node.harper) await teardownHarper(node as StartedHarperTestContext);
		});

		test('streaming tools/call delivers progress frames, ignores notifications/cancelled, and aborts + releases slot on client disconnect', async () => {
			const baseHeaders = {
				'authorization': adminAuth,
				'mcp-protocol-version': PROTOCOL_VERSION,
				'x-forwarded-for': '10.0.1.1',
			};

			// 1. Happy-path streaming + notifications/cancelled ignored
			let cancelStatus = 0;
			const streamRes = await openSsePost(
				appUrl,
				{
					jsonrpc: '2.0',
					id: 501,
					method: 'tools/call',
					params: {
						name: 'qa_stream',
						arguments: { steps: 3, delayMs: 120, tag: 'no-cancel' },
						_meta: { progressToken: 'tok-no-cancel' },
					},
				},
				baseHeaders,
				{
					onFirstDataBlock: async () => {
						const cancelRes = await mcpPost(
							appUrl,
							{
								jsonrpc: '2.0',
								method: 'notifications/cancelled',
								params: { requestId: 501, reason: 'should be ignored in stateless mode' },
							},
							baseHeaders
						);
						cancelStatus = cancelRes.status;
					},
				}
			);
			strictEqual(streamRes.status, 200);
			match(streamRes.contentType ?? '', /text\/event-stream/);
			strictEqual(cancelStatus, 202, 'notifications/cancelled returns 202 no-op');

			const frames = streamRes.blocks.filter((b) => b.data).map((b) => JSON.parse(b.data));
			const progressFrames = frames.filter((f) => f.method === 'notifications/progress');
			const finalFrame = frames.find((f) => f.id === 501);
			strictEqual(progressFrames.length, 3, `expected 3 progress frames, got ${JSON.stringify(frames)}`);
			deepStrictEqual(
				progressFrames.map((f) => ({
					token: f.params.progressToken,
					progress: f.params.progress,
					total: f.params.total,
				})),
				[
					{ token: 'tok-no-cancel', progress: 1, total: 3 },
					{ token: 'tok-no-cancel', progress: 2, total: 3 },
					{ token: 'tok-no-cancel', progress: 3, total: 3 },
				]
			);
			ok(finalFrame, `expected final JSON-RPC frame for id 501, got ${JSON.stringify(frames)}`);
			const finalPayload = parseToolJson(finalFrame);
			strictEqual(finalPayload.tag, 'no-cancel');
			strictEqual(finalPayload.completedSteps, 3);
			strictEqual(finalPayload.aborted, false);
			strictEqual(finalPayload.sessionIdIsUndefined, true);
			strictEqual(finalPayload.hasServerRequest, false);

			// 2. Client socket disconnect DOES abort context.signal and release concurrency slot
			const discHeaders = {
				'authorization': adminAuth,
				'mcp-protocol-version': PROTOCOL_VERSION,
				'x-forwarded-for': '10.0.1.2',
			};
			let concurrentRejection: any;
			await openSsePost(
				appUrl,
				{
					jsonrpc: '2.0',
					id: 502,
					method: 'tools/call',
					params: {
						name: 'qa_stream',
						arguments: { steps: 20, delayMs: 150, tag: 'disconnect-test' },
						_meta: { progressToken: 'tok-disc' },
					},
				},
				discHeaders,
				{
					onFirstDataBlock: async (req) => {
						// While the streaming call is holding the single concurrency slot, a second call for the same (user, ip) must hit concurrency limit
						const concurrent = await mcpPost(
							appUrl,
							{
								jsonrpc: '2.0',
								id: 503,
								method: 'tools/call',
								params: { name: 'qa_echo', arguments: { msg: 'blocked' } },
							},
							discHeaders
						);
						concurrentRejection = parseToolJson(concurrent.json);
						// Now drop the client socket abruptly
						req.destroy();
					},
				}
			);
			strictEqual(
				concurrentRejection?.kind,
				'rate_limited',
				`expected concurrency rate limit while stream in-flight: ${JSON.stringify(concurrentRejection)}`
			);
			strictEqual(concurrentRejection?.scope, 'concurrency');

			// Poll QaControl for the stream_aborted event proving context.signal aborted on disconnect
			let abortEvent: any;
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				const evRes = await fetch(`${started.harper.httpURL}/QaControl/?action=events&kind=stream_aborted`, {
					headers: { authorization: adminAuth },
				});
				strictEqual(evRes.status, 200);
				const data = (await evRes.json()) as { events: Array<{ payload: any }> };
				abortEvent = data.events.find((e) => e.payload?.tag === 'disconnect-test')?.payload;
				if (abortEvent) break;
				await sleep(100);
			}
			ok(abortEvent, 'expected stream_aborted event after client socket disconnect');
			strictEqual(abortEvent.aborted, true);
			strictEqual(abortEvent.sessionIdIsUndefined, true);
			strictEqual(abortEvent.hasServerRequest, false);
			match(abortEvent.reason, /disconnected/i);

			// Concurrency slot must now be released — immediate qa_echo for the same (user, ip) succeeds
			const afterDisc = await mcpPost(
				appUrl,
				{ jsonrpc: '2.0', id: 504, method: 'tools/call', params: { name: 'qa_echo', arguments: { msg: 'recovered' } } },
				discHeaders
			);
			strictEqual(afterDisc.status, 200, afterDisc.text);
			strictEqual(afterDisc.json.result.isError, undefined, afterDisc.text);
			strictEqual(parseToolJson(afterDisc.json).echo, 'recovered');
		});

		test('custom mcpPrompts, durable quota handler (sessionId: undefined + slot release), stateless rate limiting across principals & IPs, and hdb.log mcp.audit', async () => {
			// 1. Custom mcpPrompts prompts/get in stateless mode
			const promptRes = await mcpPost(
				appUrl,
				{
					jsonrpc: '2.0',
					id: 600,
					method: 'prompts/get',
					params: { name: 'qa_prompt', arguments: { topic: 'stateless-suite4' } },
				},
				{ 'authorization': adminAuth, 'mcp-protocol-version': PROTOCOL_VERSION, 'x-forwarded-for': '10.0.2.9' }
			);
			strictEqual(promptRes.status, 200, promptRes.text);
			const promptPayload = JSON.parse(promptRes.json.result.messages[0].content.text);
			strictEqual(promptPayload.sessionIdIsUndefined, true);
			strictEqual(promptPayload.sessionIdValue, '__UNDEFINED__');

			// 2. Durable quota handler denial + concurrency slot release (sessionConcurrency: 1)
			const quotaHeaders = {
				'authorization': adminAuth,
				'mcp-protocol-version': PROTOCOL_VERSION,
				'x-forwarded-for': '10.0.0.99',
			};
			for (let attempt = 1; attempt <= 2; attempt++) {
				const qRes = await mcpPost(
					appUrl,
					{
						jsonrpc: '2.0',
						id: 610 + attempt,
						method: 'tools/call',
						params: { name: 'qa_echo', arguments: { msg: `q-${attempt}` } },
					},
					quotaHeaders
				);
				strictEqual(qRes.status, 200, qRes.text);
				strictEqual(qRes.json.result.isError, true, qRes.text);
				const qPayload = parseToolJson(qRes.json);
				strictEqual(
					qPayload.kind,
					'quota_exceeded',
					`attempt ${attempt} must get quota_exceeded (slot released, not concurrency): ${JSON.stringify(qPayload)}`
				);
				strictEqual(qPayload.message, 'qa stateless quota exceeded');
				strictEqual(qPayload.retryAfterSeconds, 42);
			}
			// Verify recorded quota handler invocations saw sessionId === undefined
			const quotaEvRes = await fetch(`${started.harper.httpURL}/QaControl/?action=events&kind=quota`, {
				headers: { authorization: adminAuth },
			});
			strictEqual(quotaEvRes.status, 200);
			const quotaEvs = ((await quotaEvRes.json()) as { events: Array<{ payload: any }> }).events;
			const deniedEv = quotaEvs.find((e) => e.payload.identity === '10.0.0.99');
			ok(deniedEv, 'expected recorded quota handler event for 10.0.0.99');
			strictEqual(deniedEv.payload.sessionIdIsUndefined, true);
			strictEqual(deniedEv.payload.sessionIdValue, '__UNDEFINED__');
			strictEqual(deniedEv.payload.profile, 'application');
			strictEqual(deniedEv.payload.username, 'admin');

			// 3. Stateless rate limiting: perToolBurst: 2 per (user, ip)
			const callEcho = (authHdr: string, ip: string, id: number) =>
				mcpPost(
					appUrl,
					{ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'qa_echo', arguments: { msg: `rl-${id}` } } },
					{ 'authorization': authHdr, 'mcp-protocol-version': PROTOCOL_VERSION, 'x-forwarded-for': ip }
				);

			// (admin, 10.0.2.1): burst 2 succeeds, 3rd hits per_tool
			const a1 = await callEcho(adminAuth, '10.0.2.1', 701);
			const a2 = await callEcho(adminAuth, '10.0.2.1', 702);
			const a3 = await callEcho(adminAuth, '10.0.2.1', 703);
			strictEqual(a1.json.result.isError, undefined, a1.text);
			strictEqual(a2.json.result.isError, undefined, a2.text);
			strictEqual(a3.json.result.isError, true, a3.text);
			strictEqual(parseToolJson(a3.json).kind, 'rate_limited');
			strictEqual(parseToolJson(a3.json).scope, 'per_tool');

			// Same user (admin), DIFFERENT IP (10.0.2.2): independent bucket -> succeeds!
			const b1 = await callEcho(adminAuth, '10.0.2.2', 704);
			strictEqual(b1.json.result.isError, undefined, `different IP should have independent bucket: ${b1.text}`);

			// DIFFERENT user (qa_user2), SAME IP (10.0.2.1): independent bucket -> succeeds!
			const u2_1 = await callEcho(user2Auth, '10.0.2.1', 705);
			const u2_2 = await callEcho(user2Auth, '10.0.2.1', 706);
			const u2_3 = await callEcho(user2Auth, '10.0.2.1', 707);
			strictEqual(
				u2_1.json.result.isError,
				undefined,
				`different principal on same IP should have independent bucket: ${u2_1.text}`
			);
			strictEqual(parseToolJson(u2_1.json).username, 'qa_user2');
			strictEqual(u2_2.json.result.isError, undefined, u2_2.text);
			strictEqual(u2_3.json.result.isError, true, u2_3.text);
			strictEqual(parseToolJson(u2_3.json).scope, 'per_tool');

			// 4. Audit log (hdb.log): inspect exact multi-line mcp.audit entries written to disk
			await sleep(300); // give async log writer a tick to flush
			const candidateDirs = [(started.harper as any).logDir, join(started.harper.dataRootDir, 'log')].filter(
				(d): d is string => typeof d === 'string' && existsSync(d)
			);
			let hdbLogPath: string | undefined;
			for (const dir of candidateDirs) {
				const files = readdirSync(dir);
				if (files.includes('hdb.log')) {
					hdbLogPath = join(dir, 'hdb.log');
					break;
				}
			}
			ok(hdbLogPath, `expected hdb.log in ${candidateDirs.join(', ')}`);
			const logContent = readFileSync(hdbLogPath, 'utf8');
			const auditBlocks = logContent.match(/\{\n\s+category: 'mcp\.audit',[\s\S]*?\n\}/g) ?? [];
			ok(auditBlocks.length >= 4, `expected >= 4 mcp.audit blocks in ${hdbLogPath}, got ${auditBlocks.length}`);
			console.log(
				`[mcp-stateless-boundaries][audit] total mcp.audit blocks=${auditBlocks.length}; sample block:\n${auditBlocks[0]}`
			);
			// Verify we logged ok, rate_limited, and quota_exceeded statuses without crashing or stringifying "undefined"
			ok(
				auditBlocks.some((b) => b.includes("tool: 'qa_echo'") && b.includes("status: 'ok'")),
				'expected ok audit block for qa_echo'
			);
			ok(
				auditBlocks.some((b) => b.includes("status: 'rate_limited'")),
				'expected rate_limited audit block'
			);
			ok(
				auditBlocks.some((b) => b.includes("status: 'quota_exceeded'")),
				'expected quota_exceeded audit block'
			);
			for (const block of auditBlocks) {
				strictEqual(block.includes('"sessionId":"undefined"'), false, `must not log string "undefined": ${block}`);
				strictEqual(block.includes("sessionId: 'undefined'"), false, `must not log string 'undefined': ${block}`);
				strictEqual(
					/sessionId:\s*'[^']+'/.test(block),
					false,
					`stateless audit block must not carry a minted sessionId string: ${block}`
				);
			}
			console.log(
				`[mcp-stateless-boundaries][audit] blocks containing literal "sessionId: undefined,": ${auditBlocks.filter((b) => b.includes('sessionId: undefined,')).length}/${auditBlocks.length}`
			);
		});
	}
);

// ---------------------------------------------------------------------------
// 5. Config validation & env-var boundaries
// ---------------------------------------------------------------------------
suite('MCP stateless boundaries [5] Config validation & env-var boundaries', () => {
	test('configValidator rejects invalid stateless, unknown mcp.* keys, empty/oversized instructions, and invalid serverCard', async () => {
		const { configValidator } = await import('../../dist/validation/configValidator.js');
		const baseConfig = () => ({
			rootPath: join(tmpdir(), 'qa-fake-root'),
			http: { port: 9926 },
			localStudio: { enabled: false },
			logging: {
				file: true,
				level: 'info',
				stdStreams: false,
				auditLog: false,
				rotation: { enabled: false },
			},
			operationsApi: { network: { port: 9925 } },
			storage: { writeAsync: false },
		});

		const invalidCases: Array<[string, Record<string, unknown>, RegExp]> = [
			[
				'quoted stateless string',
				{ application: { stateless: 'true' } },
				/'mcp\.application\.stateless' must be a boolean/,
			],
			[
				'unknown key in mcp.application',
				{ application: { bogusKey: 1 } },
				/'mcp\.application\.bogusKey' is not allowed/,
			],
			[
				'unknown key in mcp.operations',
				{ operations: { stateless: true } },
				/'mcp\.operations\.stateless' is not allowed/,
			],
			[
				'unknown key in mcp.application.rateLimit',
				{ application: { rateLimit: { bogus: 1 } } },
				/'mcp\.application\.rateLimit\.bogus' is not allowed/,
			],
			['unknown key in mcp.session', { session: { bogus: 1 } }, /'mcp\.session\.bogus' is not allowed/],
			['unknown key in mcp root', { extraProfile: {} }, /'mcp\.extraProfile' is not allowed/],
			['empty instructions', { application: { instructions: '' } }, /'mcp\.application\.instructions'/],
			[
				'oversized instructions (16385)',
				{ application: { instructions: 'a'.repeat(16_385) } },
				/'mcp\.application\.instructions'/,
			],
			[
				'serverCard bad name (no slash)',
				{ application: { serverCard: { name: 'noslash' } } },
				/'mcp\.application\.serverCard'.*name/,
			],
			[
				'serverCard non-loopback http url',
				{ application: { serverCard: { url: 'http://example.com/mcp' } } },
				/'mcp\.application\.serverCard'.*url/,
			],
			[
				'serverCard version range',
				{ application: { serverCard: { version: '^1.2.3' } } },
				/'mcp\.application\.serverCard'.*version/,
			],
			[
				'serverCard unknown field',
				{ application: { serverCard: { unknownField: 'x' } } },
				/'mcp\.application\.serverCard'.*unknownField/,
			],
			[
				'serverCard bad icon src',
				{ application: { serverCard: { icons: [{ src: 'ftp://bad' }] } } },
				/'mcp\.application\.serverCard'.*icons/,
			],
		];

		for (const [label, mcp, expectedPattern] of invalidCases) {
			const res = configValidator({ ...baseConfig(), mcp }, true);
			ok(res.error, `expected validation error for ${label}`);
			match(res.error.message, expectedPattern, `${label}: ${res.error.message}`);
		}
	});

	test('real Harper boot with invalid YAML config (stateless: "true") fails startup cleanly', async () => {
		const badNode: HarperTestContext = createHarperContext('mcp-stateless-bad-config');
		let bootErr: unknown;
		try {
			await setupHarperWithFixture(badNode, FIXTURE_PATH, {
				startupTimeoutMs: 25_000,
				startupMaxMs: 30_000,
				config: {
					threads: { count: 1 },
					mcp: {
						application: {
							stateless: 'true',
						},
					},
				},
			});
		} catch (err) {
			bootErr = err;
		} finally {
			if (badNode.harper) await teardownHarper(badNode as StartedHarperTestContext);
		}
		ok(bootErr, 'expected Harper startup to fail when mcp.application.stateless is string "true"');
		console.log(
			`[mcp-stateless-boundaries][bad-config] startup error: ${bootErr instanceof Error ? bootErr.message : String(bootErr)}`
		);
	});

	test('real Harper boot with MCP_APPLICATION_STATELESS / INSTRUCTIONS / SERVERCARD_* env vars (no YAML mcp block)', async () => {
		const envNode: HarperTestContext = createHarperContext('mcp-stateless-env-vars');
		let bootErr: unknown;
		try {
			await setupHarperWithFixture(envNode, FIXTURE_PATH, {
				startupTimeoutMs: 35_000,
				startupMaxMs: 45_000,
				config: {
					threads: { count: 1 },
					authentication: { authorizeLocal: false },
				},
				env: {
					AUTHENTICATION_AUTHORIZELOCAL: 'false',
					MCP_APPLICATION_STATELESS: 'true',
					MCP_APPLICATION_INSTRUCTIONS: 'Instructions from env var',
					MCP_APPLICATION_SERVERCARD_NAME: 'com.qa/env-server',
					MCP_APPLICATION_SERVERCARD_DESCRIPTION: 'Server card from env vars',
					MCP_APPLICATION_SERVERCARD_ICONS: JSON.stringify([
						{ src: 'https://qa.example/icon.png', sizes: ['64x64'], theme: 'dark' },
					]),
				},
			});
			const started = envNode as StartedHarperTestContext;
			const auth = basicAuth(started.harper.admin.username, started.harper.admin.password);
			await waitForHealth(started.harper.httpURL, auth);

			// Read generated harper-config.yaml to see exactly what env vars wrote
			const cfgPath = join(started.harper.dataRootDir, 'harper-config.yaml');
			const cfgYaml = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '<missing>';
			console.log(
				`[mcp-stateless-boundaries][env-vars] harper-config.yaml mcp snippet:\n${cfgYaml
					.split('\n')
					.filter((l) => /mcp|stateless|instructions|serverCard/i.test(l))
					.join('\n')}`
			);

			const init = await mcpPost(
				`${started.harper.httpURL}/mcp`,
				{
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'qa-env', version: '1' } },
				},
				{ authorization: auth }
			);
			const cardRes = await fetch(`${started.harper.httpURL}/mcp/server-card`);
			const cardBody = await cardRes.text();
			console.log(
				`[mcp-stateless-boundaries][env-vars] initialize status=${init.status}, mcp-session-id=${init.headers.get('mcp-session-id')}, instructions=${JSON.stringify(init.json?.result?.instructions)}; server-card status=${cardRes.status}, body=${cardBody}`
			);

			strictEqual(init.status, 200, init.text);
			strictEqual(
				init.headers.get('mcp-session-id'),
				null,
				'MCP_APPLICATION_STATELESS=true should enable stateless mode'
			);
			strictEqual(init.json.result.instructions, 'Instructions from env var');
			strictEqual(cardRes.status, 200, cardBody);
			const cardJson = JSON.parse(cardBody);
			strictEqual(cardJson.name, 'com.qa/env-server');
			strictEqual(cardJson.description, 'Server card from env vars');
			deepStrictEqual(cardJson.icons, [{ src: 'https://qa.example/icon.png', sizes: ['64x64'], theme: 'dark' }]);
		} catch (err) {
			bootErr = err;
		} finally {
			if (envNode.harper) await teardownHarper(envNode as StartedHarperTestContext);
		}
		if (bootErr) throw bootErr;
	});

	test('root ("/") and relative ("relmcp") mountPath server-card URL derivation and OPTIONS CORS behavior', async () => {
		const relNode: HarperTestContext = createHarperContext('mcp-stateless-rel-mount');
		try {
			await setupHarperWithFixture(relNode, FIXTURE_PATH, {
				config: {
					threads: { count: 1 },
					authentication: { authorizeLocal: false },
					http: { cors: false },
					mcp: {
						application: {
							mountPath: 'relmcp',
							stateless: true,
							serverCard: { name: 'com.qa/rel', description: 'Relative mount path' },
						},
					},
				},
				env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
			});
			const s = relNode as StartedHarperTestContext;
			const auth = basicAuth(s.harper.admin.username, s.harper.admin.password);
			await waitForHealth(s.harper.httpURL, auth);

			const cardRes = await fetch(`${s.harper.httpURL}/relmcp/server-card`);
			const cardJson = JSON.parse(await cardRes.text());
			strictEqual(cardRes.status, 200);
			strictEqual(cardJson.remotes?.[0]?.url, `${s.harper.httpURL}/relmcp`);

			const optRes = await fetch(`${s.harper.httpURL}/relmcp`, {
				method: 'OPTIONS',
				headers: { Origin: 'https://any.example' },
			});
			await optRes.text();
			strictEqual(optRes.status, 405);
			strictEqual(optRes.headers.get('allow'), 'POST');
		} finally {
			if (relNode.harper) await teardownHarper(relNode as StartedHarperTestContext);
		}

		const rootNode: HarperTestContext = createHarperContext('mcp-stateless-root-mount');
		try {
			await setupHarperWithFixture(rootNode, FIXTURE_PATH, {
				config: {
					threads: { count: 1 },
					authentication: { authorizeLocal: false },
					http: { cors: true, corsAccessList: ['https://allowed.example'] },
					mcp: {
						application: {
							mountPath: '/',
							stateless: true,
							authentication: { required: true },
							serverCard: { name: 'com.qa/root', description: 'Root mount path' },
						},
					},
				},
				env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
			});
			const s = rootNode as StartedHarperTestContext;
			const auth = basicAuth(s.harper.admin.username, s.harper.admin.password);
			// Poll /server-card since / is mounted to MCP
			const dl = Date.now() + 30_000;
			let ready = false;
			while (Date.now() < dl) {
				try {
					const r = await fetch(`${s.harper.httpURL}/server-card`);
					await r.text();
					if (r.status === 200) {
						ready = true;
						break;
					}
				} catch {
					// retry
				}
				await sleep(200);
			}
			ok(ready, 'root /server-card did not become ready');

			const cardRes = await fetch(`${s.harper.httpURL}/server-card`);
			const cardJson = JSON.parse(await cardRes.text());
			strictEqual(cardRes.status, 200);
			strictEqual(cardJson.remotes?.[0]?.url, `${s.harper.httpURL}/`);

			const initRes = await mcpPost(
				`${s.harper.httpURL}/`,
				{
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: {
						protocolVersion: PROTOCOL_VERSION,
						capabilities: {},
						clientInfo: { name: 'qa-root', version: '1' },
					},
				},
				{ authorization: auth }
			);
			strictEqual(initRes.status, 200, initRes.text);
			strictEqual(initRes.headers.get('mcp-session-id'), null);

			const optAllowed = await fetch(`${s.harper.httpURL}/`, {
				method: 'OPTIONS',
				headers: { 'Origin': 'https://allowed.example', 'Access-Control-Request-Method': 'POST' },
			});
			await optAllowed.text();
			strictEqual(optAllowed.status, 200);
			strictEqual(optAllowed.headers.get('access-control-allow-origin'), 'https://allowed.example');

			const optDisallowed = await fetch(`${s.harper.httpURL}/`, {
				method: 'OPTIONS',
				headers: { 'Origin': 'https://disallowed.example', 'Access-Control-Request-Method': 'POST' },
			});
			const optDisBody = await optDisallowed.text();
			strictEqual(optDisallowed.status, 403, optDisBody);
		} finally {
			if (rootNode.harper) await teardownHarper(rootNode as StartedHarperTestContext);
		}
	});
});
