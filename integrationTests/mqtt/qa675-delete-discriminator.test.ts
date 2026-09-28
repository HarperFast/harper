/**
 * QA-675 / P-453: an explicit REST DELETE and a null-field PATCH must have
 * distinguishable live events on both SSE and the REST WebSocket path.
 */
import assert from 'node:assert';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, suite, test } from 'node:test';
import { URL } from 'node:url';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import WebSocket from 'ws';
// @ts-expect-error utils/client.mjs has no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations
import { waitForRouteReady } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa675-delete-discriminator');
const RECORD_PATH = '/Widget/record-1';
type Event = { raw: string; envelope: any };

function capture(raw: string): Event {
	let envelope;
	try {
		envelope = JSON.parse(raw);
	} catch {
		// Keep invalid wire data visible in a failed assertion.
	}
	return { raw, envelope };
}

function openSse(url: string, authorization: string): Promise<{ events: Event[]; close: () => void }> {
	const events: Event[] = [];
	const target = new URL(url);
	const transport = target.protocol === 'https:' ? https : http;
	return new Promise((resolvePromise, reject) => {
		const request = transport.request(
			target,
			{
				method: 'GET',
				headers: { Accept: 'text/event-stream', Authorization: authorization },
				rejectUnauthorized: false,
			},
			(response) => {
				request.setTimeout(0);
				if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('text/event-stream')) {
					response.destroy();
					reject(new Error(`SSE response: ${response.statusCode} ${response.headers['content-type']}`));
					return;
				}
				let pending = '';
				response.setEncoding('utf8');
				response.on('data', (chunk: string) => {
					pending += chunk.replace(/\r\n/g, '\n');
					let boundary;
					while ((boundary = pending.indexOf('\n\n')) >= 0) {
						const frame = pending.slice(0, boundary);
						pending = pending.slice(boundary + 2);
						const data = frame
							.split('\n')
							.filter((line) => line.startsWith('data:'))
							.map((line) => line.slice(5).trimStart())
							.join('\n');
						if (data) events.push(capture(data));
					}
				});
				resolvePromise({
					events,
					close: () => {
						response.destroy();
						request.destroy();
					},
				});
			}
		);
		request.on('error', reject);
		request.setTimeout(8_000, () => request.destroy(new Error('SSE open timed out')));
		request.end();
	});
}

function openWebSocket(url: string, authorization: string): Promise<{ events: Event[]; close: () => void }> {
	const events: Event[] = [];
	const socket = new WebSocket(url, {
		headers: { 'Authorization': authorization, 'Content-Type': 'application/json' },
		rejectUnauthorized: false,
	});
	socket.on('message', (data: Buffer) => events.push(capture(data.toString('utf8'))));
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error('WebSocket open timed out'));
		}, 8_000);
		socket.once('open', () => {
			clearTimeout(timer);
			resolvePromise({ events, close: () => socket.terminate() });
		});
		socket.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

async function waitForEvent(events: Event[], start: number, name: string): Promise<Event> {
	const deadline = Date.now() + 6_000;
	while (Date.now() < deadline && events.length === start) await sleep(25);
	assert.ok(events.length > start, `${name}: no event after index ${start}; events=${JSON.stringify(events)}`);
	return events[start];
}

suite('QA-675 REST delete discriminator', (ctx: ContextWithHarper) => {
	let httpURL: string;
	let authorization: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		const client = createApiClient(ctx.harper);
		await waitForRouteReady(client, '/Widget/', 120_000);
		httpURL = ctx.harper.httpURL;
		authorization = client.headers.Authorization;
	});

	after(async () => teardownHarper(ctx));

	async function rest(method: string, body?: unknown): Promise<Response> {
		return fetch(`${httpURL}${RECORD_PATH}`, {
			method,
			headers: { 'Authorization': authorization, 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(8_000),
		});
	}

	async function waitForRecord(expectedStatus: number, expectedValue?: number | null): Promise<void> {
		const deadline = Date.now() + 6_000;
		let observed: { status: number; value?: unknown } | undefined;
		do {
			const response = await rest('GET');
			observed = {
				status: response.status,
				value: response.status === 200 ? (await response.json()).value : undefined,
			};
			if (observed.status === expectedStatus && (expectedStatus !== 200 || observed.value === expectedValue)) return;
			await sleep(25);
		} while (Date.now() < deadline);
		assert.fail(
			`REST state did not converge to status=${expectedStatus}, value=${expectedValue}; observed=${JSON.stringify(observed)}`
		);
	}

	test('SSE and REST WebSocket distinguish null-field PATCH from DELETE', { timeout: 45_000 }, async () => {
		assert.strictEqual((await rest('PUT', { id: 'record-1', value: 1, tag: 'retained' })).status, 204);
		await waitForRecord(200, 1);
		let sse: Awaited<ReturnType<typeof openSse>> | undefined;
		let ws: Awaited<ReturnType<typeof openWebSocket>> | undefined;
		try {
			sse = await openSse(`${httpURL}${RECORD_PATH}`, authorization);
			ws = await openWebSocket(`${httpURL.replace(/^http/, 'ws')}${RECORD_PATH}`, authorization);
			for (const [name, stream] of [
				['SSE', sse],
				['WS', ws],
			] as const) {
				const initial = await waitForEvent(stream.events, 0, `${name} initial`);
				assert.strictEqual(initial.envelope?.type, 'put', `${name} initial: ${initial.raw}`);
				assert.strictEqual(initial.envelope?.value?.value, 1, `${name} initial: ${initial.raw}`);
			}

			const ssePatchStart = sse.events.length;
			const wsPatchStart = ws.events.length;
			assert.strictEqual((await rest('PATCH', { value: null })).status, 204);
			await waitForRecord(200, null);
			const patched = await rest('GET');
			assert.strictEqual(patched.status, 200);
			const patchedRecord = await patched.json();
			assert.strictEqual(patchedRecord.value, null);
			assert.strictEqual(patchedRecord.tag, 'retained');
			const patchEvents = [
				await waitForEvent(sse.events, ssePatchStart, 'SSE PATCH'),
				await waitForEvent(ws.events, wsPatchStart, 'WS PATCH'),
			];
			for (const [index, event] of patchEvents.entries()) {
				assert.strictEqual(event.envelope?.type, 'put', `PATCH transport ${index}: ${event.raw}`);
				assert.strictEqual(event.envelope?.value?.value, null, `PATCH transport ${index}: ${event.raw}`);
				assert.strictEqual(event.envelope?.value?.tag, 'retained', `PATCH transport ${index}: ${event.raw}`);
			}

			const sseDeleteStart = sse.events.length;
			const wsDeleteStart = ws.events.length;
			assert.strictEqual((await rest('DELETE')).status, 200);
			await waitForRecord(404);
			const deleteEvents = [
				await waitForEvent(sse.events, sseDeleteStart, 'SSE DELETE'),
				await waitForEvent(ws.events, wsDeleteStart, 'WS DELETE'),
			];
			for (const [index, event] of deleteEvents.entries()) {
				assert.strictEqual(event.envelope?.type, 'delete', `DELETE transport ${index}: ${event.raw}`);
				assert.strictEqual(event.envelope?.value, null, `DELETE transport ${index}: ${event.raw}`);
			}
			console.log(
				`QA-675 observed: SSE=${JSON.stringify({ count: sse.events.length, patch: patchEvents[0].envelope, delete: deleteEvents[0].envelope })} WS=${JSON.stringify({ count: ws.events.length, patch: patchEvents[1].envelope, delete: deleteEvents[1].envelope })}`
			);
		} finally {
			sse?.close();
			ws?.close();
		}
	});
});
