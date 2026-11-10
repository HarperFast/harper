/**
 * With `logging.auditAuthEvents.logFailed: true`, failed-credential audit deduplication must not
 * write markers into `authorizationCache`, where a subsequent bare `Authorization: <X>` header
 * would resolve the string `<X>` as `request.user` and pass presence-based gates (`allowRead`,
 * `allowCreate`, open resources checking `if (!user)`, and `WhoAmI`).
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/auth-failed-marker-principal-cache');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const SEEDED_ID = 'seeded-secret-1';
const SEEDED_ROW = { id: SEEDED_ID, title: 'classified' };

interface HttpResponse {
	status: number;
	text: string;
	body: any;
	localPort: number | undefined;
}

function sendWithAgent(
	agent: HttpAgent,
	baseUrl: string,
	method: 'GET' | 'POST',
	pathname: string,
	authorization?: string,
	jsonBody?: unknown
): Promise<HttpResponse> {
	const url = new URL(pathname, baseUrl);
	const payload = jsonBody !== undefined ? Buffer.from(JSON.stringify(jsonBody), 'utf8') : undefined;
	const headers: Record<string, string> = {
		Accept: 'application/json',
		Connection: 'keep-alive',
	};
	if (authorization !== undefined) headers.Authorization = authorization;
	if (payload !== undefined) {
		headers['Content-Type'] = 'application/json';
		headers['Content-Length'] = String(payload.byteLength);
	}
	return new Promise((resolvePromise, rejectPromise) => {
		const req = httpRequest(
			url,
			{
				method,
				agent,
				headers,
			},
			(res) => {
				const localPort = res.socket?.localPort;
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					let body: any;
					try {
						body = JSON.parse(text);
					} catch {
						body = text;
					}
					resolvePromise({ status: res.statusCode ?? 0, text, body, localPort });
				});
			}
		);
		req.on('error', rejectPromise);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

for (const logFailed of [true, false]) {
	for (const threads of [1, 4]) {
		suite(
			`failed-credential audit dedupe does not pollute authorizationCache (logFailed=${logFailed}, threads=${threads})`,
			{ skip: skipSuite },
			(ctx: ContextWithHarper) => {
				let client: ReturnType<typeof createApiClient>;
				let restURL = '';
				let adminAuthorization = '';
				let logPath = '';
				let agent: HttpAgent;
				let pinnedLocalPort: number | undefined;

				async function send(
					method: 'GET' | 'POST',
					pathname: string,
					authorization?: string,
					jsonBody?: unknown
				): Promise<HttpResponse> {
					const res = await sendWithAgent(agent, restURL, method, pathname, authorization, jsonBody);
					ok(res.localPort !== undefined, 'expected response socket to report a localPort');
					if (pinnedLocalPort === undefined) {
						pinnedLocalPort = res.localPort;
					} else {
						strictEqual(
							res.localPort,
							pinnedLocalPort,
							'expected all requests in the suite to reuse the same keep-alive socket and worker'
						);
					}
					return res;
				}

				function readAuthAuditEntries(): string[] {
					if (!existsSync(logPath)) return [];
					return readFileSync(logPath, 'utf8')
						.split(/(?=^\d{4}-\d{2}-\d{2}T)/m)
						.filter((entry) => entry.includes('[auth-event]'));
				}

				async function waitForAuditEntry(predicate: (entry: string) => boolean, timeoutMs = 10_000): Promise<void> {
					const deadline = Date.now() + timeoutMs;
					while (Date.now() < deadline) {
						if (readAuthAuditEntries().some(predicate)) return;
						await sleep(50);
					}
					ok(
						readAuthAuditEntries().some(predicate),
						`expected matching [auth-event] entry in ${logPath}:\n${readAuthAuditEntries().join('\n')}`
					);
				}

				// Workers forward log lines to the main thread in order, so waiting on a fresh marker
				// rejection on the same keep-alive socket guarantees earlier lines from that worker have
				// already reached hdb.log without a timing sleep.
				async function flushWorkerAuditLog(markerTag: string): Promise<void> {
					const markerUser = `audit-flush-${markerTag}-${logFailed}-${threads}`;
					const markerCred = Buffer.from(`${markerUser}:flush`).toString('base64');
					const res = await send('GET', '/AnyPrincipalSecret/', `Basic ${markerCred}`);
					strictEqual(res.status, 401, res.text);
					await waitForAuditEntry(
						(entry) => entry.includes(`username: '${markerUser}'`) && entry.includes("status: 'failure'")
					);
				}

				async function assertBareHeaderRejectedOnAllSurfaces(bareX: string, attemptedRowId: string): Promise<void> {
					const readRes = await send('GET', '/AnyPrincipalSecret/', bareX);
					strictEqual(
						readRes.status,
						401,
						`GET /AnyPrincipalSecret/ with bare header must be 401, got ${readRes.status}: ${readRes.text}`
					);

					const createRes = await send('POST', '/AnyPrincipalSecret/', bareX, {
						id: attemptedRowId,
						title: 'unauthenticated-write',
					});
					strictEqual(
						createRes.status,
						401,
						`POST /AnyPrincipalSecret/ with bare header must be 401, got ${createRes.status}: ${createRes.text}`
					);

					const checkPersisted = await send('GET', `/AnyPrincipalSecret/${attemptedRowId}`, adminAuthorization);
					strictEqual(
						checkPersisted.status,
						404,
						`rejected POST /AnyPrincipalSecret/ must not persist row ${attemptedRowId}: ${checkPersisted.text}`
					);

					const staticGateRes = await send('GET', '/StaticGateSecret/', bareX);
					strictEqual(
						staticGateRes.status,
						401,
						`GET /StaticGateSecret/ with bare header must be 401, got ${staticGateRes.status}: ${staticGateRes.text}`
					);

					const whoAmIRes = await send('GET', '/WhoAmI/x', bareX);
					strictEqual(
						whoAmIRes.status,
						401,
						`GET /WhoAmI/x with bare header must be 401, got ${whoAmIRes.status}: ${whoAmIRes.text}`
					);
				}

				before(async () => {
					// Pin a single keep-alive socket so the rejected first credential and the following bare
					// `<X>` probes always land on the same HTTP worker even when SO_REUSEPORT is active.
					agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
					await setupHarperWithFixture(ctx, FIXTURE_PATH, {
						config: {
							threads: { count: threads },
							authentication: { authorizeLocal: false },
							logging: { auditAuthEvents: { logFailed } },
						},
					});
					client = createApiClient(ctx.harper);
					restURL = ctx.harper.httpURL;
					adminAuthorization = client.headers.Authorization;
					logPath = join(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'), 'hdb.log');

					const deadline = Date.now() + 30_000;
					while (Date.now() < deadline) {
						const probe = await sendWithAgent(agent, restURL, 'GET', '/AnyPrincipalSecret/', adminAuthorization);
						if (probe.status === 200) {
							pinnedLocalPort = probe.localPort;
							break;
						}
						await sleep(200);
					}
					ok(pinnedLocalPort !== undefined, 'expected readiness probe to establish pinnedLocalPort');

					await client
						.req()
						.send({
							operation: 'insert',
							database: 'data',
							table: 'Secret',
							records: [SEEDED_ROW],
						})
						.expect(200);
				});

				after(async () => {
					agent?.destroy();
					await teardownHarper(ctx);
				});

				test('positive control and cold bare header before any rejection', async () => {
					const coldRead = await send('GET', '/AnyPrincipalSecret/', `cold-bare-read-${logFailed}-${threads}`);
					strictEqual(coldRead.status, 401, coldRead.text);

					const coldRowId = `cold-row-${logFailed}-${threads}`;
					const coldCreate = await send('POST', '/AnyPrincipalSecret/', `cold-bare-create-${logFailed}-${threads}`, {
						id: coldRowId,
						title: 'unauthenticated-write',
					});
					strictEqual(coldCreate.status, 401, coldCreate.text);
					const coldCheckPersisted = await send('GET', `/AnyPrincipalSecret/${coldRowId}`, adminAuthorization);
					strictEqual(coldCheckPersisted.status, 404, coldCheckPersisted.text);

					const coldStatic = await send('GET', '/StaticGateSecret/', `cold-bare-static-${logFailed}-${threads}`);
					strictEqual(coldStatic.status, 401, coldStatic.text);

					const coldWhoAmI = await send('GET', '/WhoAmI/x', `cold-bare-whoami-${logFailed}-${threads}`);
					strictEqual(coldWhoAmI.status, 401, coldWhoAmI.text);

					const adminRead = await send('GET', '/AnyPrincipalSecret/', adminAuthorization);
					strictEqual(adminRead.status, 200, adminRead.text);
					deepStrictEqual(adminRead.body, [SEEDED_ROW]);

					const adminStatic = await send('GET', '/StaticGateSecret/', adminAuthorization);
					strictEqual(adminStatic.status, 200, adminStatic.text);
					strictEqual(adminStatic.body.username, ctx.harper.admin.username);

					const adminWhoAmI = await send('GET', '/WhoAmI/x', adminAuthorization);
					strictEqual(adminWhoAmI.status, 200, adminWhoAmI.text);
					strictEqual(adminWhoAmI.body.type, 'object');
					strictEqual(adminWhoAmI.body.username, ctx.harper.admin.username);
				});

				test('first credential Basic <X> followed by bare <X> is 401 across all surfaces and audited once', async () => {
					const failedUser = `ghost-basic-${logFailed}-${threads}`;
					const bareX = Buffer.from(`${failedUser}:wrong-password`).toString('base64');

					const first = await send('GET', '/AnyPrincipalSecret/', `Basic ${bareX}`);
					strictEqual(first.status, 401, first.text);

					await assertBareHeaderRejectedOnAllSurfaces(bareX, `basic-row-${logFailed}-${threads}`);

					const repeatBasic = await send('GET', '/AnyPrincipalSecret/', `Basic ${bareX}`);
					strictEqual(repeatBasic.status, 401, repeatBasic.text);

					const preBareUser = `ghost-prebare-${logFailed}-${threads}`;
					const bareY = Buffer.from(`${preBareUser}:wrong-password`).toString('base64');
					const bareFirst = await send('GET', '/AnyPrincipalSecret/', bareY);
					strictEqual(bareFirst.status, 401, bareFirst.text);
					const basicAfterBare = await send('GET', '/AnyPrincipalSecret/', `Basic ${bareY}`);
					strictEqual(basicAfterBare.status, 401, basicAfterBare.text);

					if (logFailed) {
						await flushWorkerAuditLog('basic');
						const matching = readAuthAuditEntries().filter(
							(entry) => entry.includes(`username: '${failedUser}'`) && entry.includes("status: 'failure'")
						);
						strictEqual(
							matching.length,
							1,
							`expected failed Basic credential for ${failedUser} to be audited once within cacheTTL:\n${matching.join('\n')}`
						);
						const preBareMatching = readAuthAuditEntries().filter(
							(entry) => entry.includes(`username: '${preBareUser}'`) && entry.includes("status: 'failure'")
						);
						strictEqual(
							preBareMatching.length,
							1,
							`expected prior bare <X> not to suppress username audit entry for Basic <X> (${preBareUser}):\n${preBareMatching.join('\n')}`
						);
					} else {
						const matching = readAuthAuditEntries().filter(
							(entry) => entry.includes(`username: '${failedUser}'`) || entry.includes(`username: '${preBareUser}'`)
						);
						strictEqual(matching.length, 0, `expected no audit entry when logFailed is false:\n${matching.join('\n')}`);
					}
				});

				test('first credential Bearer <X> (no validator) followed by bare <X> is 401 across all surfaces and audited once', async () => {
					const bareX = `eyJhbGciOiJIUzI1NiJ9.d29vLXNlc3Npb24.not-a-harper-token-${logFailed}-${threads}`;
					const bearerBefore = readAuthAuditEntries().filter(
						(entry) => entry.includes("auth_strategy: 'Bearer'") && entry.includes("status: 'failure'")
					).length;

					const first = await send('GET', '/AnyPrincipalSecret/', `Bearer ${bareX}`);
					strictEqual(first.status, 401, first.text);

					await assertBareHeaderRejectedOnAllSurfaces(bareX, `bearer-row-${logFailed}-${threads}`);

					const repeatBearer = await send('GET', '/AnyPrincipalSecret/', `Bearer ${bareX}`);
					strictEqual(repeatBearer.status, 401, repeatBearer.text);

					if (logFailed) {
						await flushWorkerAuditLog('bearer');
						const bearerAfter = readAuthAuditEntries().filter(
							(entry) => entry.includes("auth_strategy: 'Bearer'") && entry.includes("status: 'failure'")
						);
						strictEqual(
							bearerAfter.length - bearerBefore,
							1,
							`expected failed Bearer credential to be audited once within cacheTTL:\n${bearerAfter.join('\n')}`
						);
					} else {
						const bearerAfter = readAuthAuditEntries().filter((entry) => entry.includes("auth_strategy: 'Bearer'"));
						strictEqual(bearerAfter.length, 0, `expected no Bearer audit entry when logFailed is false`);
					}
				});

				test('first credential with <X> containing a space followed by bare <X> is 401 across all surfaces and audited once', async () => {
					const failedUser = `ghost-space-${logFailed}-${threads}`;
					const encoded = Buffer.from(`${failedUser}:wrong-password`).toString('base64');
					const bareX = `${encoded.slice(0, 8)} ${encoded.slice(8)}`;

					const first = await send('GET', '/AnyPrincipalSecret/', `Basic ${bareX}`);
					strictEqual(first.status, 401, first.text);

					await assertBareHeaderRejectedOnAllSurfaces(bareX, `space-row-${logFailed}-${threads}`);

					const repeatBasic = await send('GET', '/AnyPrincipalSecret/', `Basic ${bareX}`);
					strictEqual(repeatBasic.status, 401, repeatBasic.text);

					if (logFailed) {
						await flushWorkerAuditLog('space');
						const matching = readAuthAuditEntries().filter(
							(entry) => entry.includes(`username: '${failedUser}'`) && entry.includes("status: 'failure'")
						);
						strictEqual(
							matching.length,
							1,
							`expected failed space-bearing Basic credential for ${failedUser} to be audited once:\n${matching.join('\n')}`
						);
					} else {
						const matching = readAuthAuditEntries().filter((entry) => entry.includes(`username: '${failedUser}'`));
						strictEqual(matching.length, 0, `expected no audit entry when logFailed is false:\n${matching.join('\n')}`);
					}
				});

				test('the same bare header sent twice is 401 across all surfaces and audited once', async () => {
					const bareX = `bare-twice-token-${logFailed}-${threads}`;
					const failuresBefore = readAuthAuditEntries().filter((entry) => entry.includes("status: 'failure'")).length;

					const first = await send('GET', '/AnyPrincipalSecret/', bareX);
					strictEqual(first.status, 401, first.text);

					await assertBareHeaderRejectedOnAllSurfaces(bareX, `bare-twice-row-${logFailed}-${threads}`);

					if (logFailed) {
						await flushWorkerAuditLog('bare-twice');
						const failuresAfter = readAuthAuditEntries().filter((entry) => entry.includes("status: 'failure'")).length;
						strictEqual(
							failuresAfter - failuresBefore - 1,
							1,
							`expected repeated bare header to produce exactly 1 failure audit entry before flush marker`
						);
					} else {
						const failuresAfter = readAuthAuditEntries().filter((entry) => entry.includes("status: 'failure'")).length;
						strictEqual(failuresAfter - failuresBefore, 0, `expected no failure audit entry when logFailed is false`);
					}
				});
			}
		);
	}
}
