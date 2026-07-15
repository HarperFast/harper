/**
 * #1786 review (heskew) — a rejected thenable returned by a sync-declared `allowRead` must not
 * leak an `unhandledRejection`.
 *
 * The record-scoped `allowRead` guard (#1422 gap 2) denies a record when a SYNC-declared
 * override returns a thenable (it can't be awaited mid-traversal, so it fails closed and warns
 * once). Before the fix, that rejected thenable was discarded without a handler attached, so
 * every denied candidate reached Harper's global `unhandledRejection` logger — once per
 * candidate for the query-traversal guard, and once per dropped event for the parallel
 * subscription `allowsEvent` delivery filter.
 *
 * Fixture: `Rejecting` — a sync `allowRead` that grants the collection-scope entry check (no
 * loaded record) and a normal owner-match boolean per record, EXCEPT for a record owned by the
 * `REJECT_SENTINEL` marker, which always returns `Promise.reject(...)`. The marker keeps the
 * fixture from denying every record (a subscription with nothing ever deliverable never writes a
 * byte, so its response headers never flush — a client artifact, not the thing under test) while
 * still exercising the rejected-thenable path on both the query guard and the subscription filter.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/rejected-thenable-allowread-no-unhandled.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, deepStrictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import request from 'supertest';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/reject-thenable-allowread');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const USER = { username: 'reject_thenable_user', password: 'Reject-pw-1786!' };
const ROLE = 'reject_thenable_role';
const OWN_ROW = 'reject-own'; // owned by USER — a normal, allowed record (proves the guard isn't fail-open)
const TRIGGER_ROW = 'reject-trigger'; // owner is the REJECT_SENTINEL marker — always rejects

const UNHANDLED_REJECTION_LOG = /unhandledRejection/i;
const QUERY_DIAGNOSTIC_LOG = /allowRead on Rejecting returned a promise during per-record evaluation/;
const EVENT_DIAGNOSTIC_LOG = /allowRead on Rejecting returned a promise during subscription event evaluation/;

async function readLog(logDir: string): Promise<string> {
	try {
		return await readFile(join(logDir, 'hdb.log'), 'utf8');
	} catch {
		return '';
	}
}

async function waitForLogMatch(logDir: string, pattern: RegExp, timeoutMs = 10_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let contents = '';
	while (Date.now() < deadline) {
		contents = await readLog(logDir);
		if (pattern.test(contents)) return contents;
		await sleep(150);
	}
	return contents;
}

async function queryRejecting(restURL: string, headers: Record<string, string>, body: any): Promise<any[]> {
	const resp = await fetch(`${restURL}/Rejecting/`, {
		method: 'QUERY',
		headers: { ...headers, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const text = await resp.text();
	ok(resp.status === 200, `QUERY /Rejecting/ returned ${resp.status}: ${text}`);
	const data = JSON.parse(text);
	return Array.isArray(data) ? data : [];
}

interface SseStream {
	events: string[];
	status: number;
	destroy: () => void;
}

function openSse(urlStr: string, headers: Record<string, string>): Promise<SseStream> {
	const url = new URL(urlStr);
	const lib = url.protocol === 'https:' ? https : http;
	const events: string[] = [];
	let buffer = '';
	return new Promise<SseStream>((resolvePromise, reject) => {
		const req = lib.request(
			url,
			{ method: 'GET', headers: { ...headers, Accept: 'text/event-stream' }, rejectUnauthorized: false } as any,
			(res) => {
				const stream: SseStream = {
					events,
					status: res.statusCode ?? 0,
					destroy: () => {
						res.destroy();
						req.destroy();
					},
				};
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => {
					buffer += chunk;
					let sep: number;
					while ((sep = buffer.indexOf('\n\n')) >= 0) {
						events.push(buffer.slice(0, sep));
						buffer = buffer.slice(sep + 2);
					}
				});
				res.on('error', () => {});
				resolvePromise(stream);
			}
		);
		req.on('error', reject);
		req.end();
	});
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000, intervalMs = 50): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(intervalMs);
	}
	return predicate();
}

suite(
	'#1786 rejected thenable from allowRead is handled without leaking unhandledRejection',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let restURL = '';
		let logDir = '';
		let userHeaders: Record<string, string>;
		const openStreams = new Set<SseStream>();

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
			client = createApiClient(ctx.harper);
			restURL = ctx.harper.httpURL;
			logDir = ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log');

			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/Rejecting/').timeout(3000);
					if (probe.status !== 404) break;
				} catch {
					/* not ready */
				}
				await sleep(250);
			}

			await client
				.req()
				.send({
					operation: 'add_role',
					role: ROLE,
					permission: {
						super_user: false,
						data: {
							tables: {
								Rejecting: { read: true, insert: true, update: true, delete: true, attribute_permissions: [] },
							},
						},
					},
				})
				.expect(200);

			await client
				.req()
				.send({ operation: 'add_user', role: ROLE, username: USER.username, password: USER.password, active: true })
				.expect(200);

			await client
				.req()
				.send({
					operation: 'insert',
					schema: 'data',
					table: 'Rejecting',
					records: [
						{ id: OWN_ROW, owner: USER.username, secret: 'owner-secret' },
						{ id: TRIGGER_ROW, owner: 'REJECT_SENTINEL', secret: 'trigger-secret' },
					],
				})
				.expect(200);

			// SSE uses a bearer token (not the Basic-auth header) — same as subscription-row-allowread's
			// setup — for real per-connection auth rather than the header-less AUTHORIZELOCAL loopback.
			const tokenResp = await client
				.req()
				.send({ operation: 'create_authentication_tokens', username: USER.username, password: USER.password });
			const bearer =
				tokenResp.status === 200 && tokenResp.body?.operation_token
					? `Bearer ${tokenResp.body.operation_token}`
					: createHeaders(USER.username, USER.password).Authorization;
			userHeaders = { ...createHeaders(USER.username, USER.password), Authorization: bearer };
		});

		after(async () => {
			for (const s of openStreams) {
				try {
					s.destroy();
				} catch {
					/* ignore */
				}
			}
			openStreams.clear();
			await teardownHarper(ctx);
		});

		test('QUERY: a rejected thenable denies its record — others still return — without an unhandledRejection', async () => {
			const results = await queryRejecting(restURL, userHeaders, {});
			const ids = results.map((r: any) => r.id).sort();
			deepStrictEqual(
				ids,
				[OWN_ROW],
				'the rejected-thenable record must fail closed (deny) while the normal owned record still returns'
			);

			const withDiagnostic = await waitForLogMatch(logDir, QUERY_DIAGNOSTIC_LOG, 8000);
			ok(
				QUERY_DIAGNOSTIC_LOG.test(withDiagnostic),
				'expected the one-time "returned a promise during per-record evaluation" diagnostic to be logged'
			);

			// Give any unobserved rejection time to surface before asserting its absence.
			await sleep(1000);
			const contents = await readLog(logDir);
			ok(
				!UNHANDLED_REJECTION_LOG.test(contents),
				`UNHANDLED REJECTION LEAK (#1786): the query-traversal guard's rejected thenable reached the global logger:\n${contents.slice(-2000)}`
			);
		});

		test('SUBSCRIBE: a rejected thenable drops its event — others still deliver — without an unhandledRejection', async () => {
			const stream = await openSse(`${restURL}/Rejecting/`, { Authorization: userHeaders.Authorization });
			openStreams.add(stream);
			ok(
				stream.status >= 200 && stream.status < 300,
				`collection subscribe should open (entry grants), got ${stream.status}`
			);

			// Positive control: the normal owned record delivers (proves the connection is alive and
			// events flow at all, so a later absence of the trigger row is a real filter, not a hang).
			await request(restURL)
				.put(`/Rejecting/${OWN_ROW}`)
				.set(client.headers)
				.send({ id: OWN_ROW, owner: USER.username, secret: 'owner-secret-updated' })
				.expect(204);
			ok(
				await waitFor(() => stream.events.some((frame) => frame.includes('owner-secret-updated'))),
				'POSITIVE CONTROL FAILED: the normal owned record was not delivered on the subscription'
			);

			await request(restURL)
				.put(`/Rejecting/${TRIGGER_ROW}`)
				.set(client.headers)
				.send({ id: TRIGGER_ROW, owner: 'REJECT_SENTINEL', secret: 'trigger-secret-updated' })
				.expect(204);
			await sleep(1500); // give the (denied) event delivery a chance to arrive if it leaked

			const leaked = stream.events.some((frame) => frame.includes('trigger-secret-updated'));
			ok(!leaked, "ROW-LEVEL LEAK: the rejected-thenable-denied event's record was delivered to the subscriber");

			const withDiagnostic = await waitForLogMatch(logDir, EVENT_DIAGNOSTIC_LOG, 8000);
			ok(
				EVENT_DIAGNOSTIC_LOG.test(withDiagnostic),
				'expected the one-time "returned a promise during subscription event evaluation" diagnostic to be logged'
			);

			const contents = await readLog(logDir);
			ok(
				!UNHANDLED_REJECTION_LOG.test(contents),
				`UNHANDLED REJECTION LEAK (#1786): the subscription allowsEvent filter's rejected thenable reached the global logger:\n${contents.slice(-2000)}`
			);
		});
	}
);
