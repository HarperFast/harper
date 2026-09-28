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
type EventStream = { events: Event[]; error?: Error; close: () => void };
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

function capture(raw: string): Event {
	try {
		return { raw, envelope: JSON.parse(raw) };
	} catch {
		return { raw, envelope: undefined };
	}
}

function openSse(url: string, authorization: string): Promise<EventStream> {
	const events: Event[] = [];
	const target = new URL(url);
	const transport = target.protocol === 'https:' ? https : http;
	return new Promise((resolvePromise, reject) => {
		let stream: EventStream | undefined;
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
				let closedByTest = false;
				const responseStream: EventStream = {
					events,
					close: () => {
						closedByTest = true;
						response.destroy();
						request.destroy();
					},
				};
				stream = responseStream;
				response.on('error', (error) => {
					responseStream.error = error;
				});
				response.on('aborted', () => {
					responseStream.error ??= new Error('SSE response aborted');
				});
				response.on('close', () => {
					if (!closedByTest) responseStream.error ??= new Error('SSE response closed before the next event');
				});
				response.setEncoding('utf8');
				response.on('data', (chunk: string) => {
					pending = (pending + chunk).replace(/\r\n/g, '\n');
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
				resolvePromise(responseStream);
			}
		);
		request.on('error', (error) => {
			if (stream) stream.error = error;
			reject(error);
		});
		request.setTimeout(8_000, () => request.destroy(new Error('SSE open timed out')));
		request.end();
	});
}

function openWebSocket(url: string, authorization: string): Promise<EventStream> {
	const events: Event[] = [];
	const socket = new WebSocket(url, {
		headers: { 'Authorization': authorization, 'Content-Type': 'application/json' },
		rejectUnauthorized: false,
	});
	socket.on('message', (data: Buffer) => events.push(capture(data.toString('utf8'))));
	let closedByTest = false;
	const stream: EventStream = {
		events,
		close: () => {
			closedByTest = true;
			socket.terminate();
		},
	};
	return new Promise((resolvePromise, reject) => {
		let opened = false;
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error('WebSocket open timed out'));
		}, 8_000);
		socket.once('open', () => {
			opened = true;
			clearTimeout(timer);
			resolvePromise(stream);
		});
		socket.on('error', (error) => {
			stream.error = error;
			if (!opened) {
				clearTimeout(timer);
				reject(error);
			}
		});
		socket.on('close', (code, reason) => {
			if (!closedByTest) stream.error ??= new Error(`WebSocket closed: ${code} ${reason.toString()}`);
		});
	});
}

async function waitForEvent(stream: EventStream, start: number, name: string): Promise<Event> {
	const deadline = Date.now() + 6_000;
	while (Date.now() < deadline && stream.events.length <= start && !stream.error) await sleep(25);
	if (stream.events.length > start) return stream.events[start];
	if (stream.error) throw new Error(`${name}: stream failed`, { cause: stream.error });
	assert.fail(`${name}: no event after index ${start}; events=${JSON.stringify(stream.events)}`);
}

suite('QA-675 REST delete discriminator', { skip: skipSuite }, (ctx: ContextWithHarper) => {
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
			let value;
			if (response.status === 200) value = (await response.json()).value;
			else await response.text();
			observed = { status: response.status, value };
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
				const initial = await waitForEvent(stream, 0, `${name} initial`);
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
				await waitForEvent(sse, ssePatchStart, 'SSE PATCH'),
				await waitForEvent(ws, wsPatchStart, 'WS PATCH'),
			];
			for (const [index, event] of patchEvents.entries()) {
				assert.strictEqual(event.envelope?.type, 'put', `PATCH transport ${index}: ${event.raw}`);
				assert.strictEqual(event.envelope?.value?.value, null, `PATCH transport ${index}: ${event.raw}`);
				assert.strictEqual(event.envelope?.value?.tag, 'retained', `PATCH transport ${index}: ${event.raw}`);
			}

			const sseDeleteStart = sse.events.length;
			const wsDeleteStart = ws.events.length;
			const deleted = await rest('DELETE');
			assert.strictEqual(deleted.status, 200);
			await deleted.text();
			await waitForRecord(404);
			const deleteEvents = [
				await waitForEvent(sse, sseDeleteStart, 'SSE DELETE'),
				await waitForEvent(ws, wsDeleteStart, 'WS DELETE'),
			];
			for (const [index, event] of deleteEvents.entries()) {
				assert.strictEqual(event.envelope?.type, 'delete', `DELETE transport ${index}: ${event.raw}`);
				assert.strictEqual(event.envelope?.value, null, `DELETE transport ${index}: ${event.raw}`);
			}
		} finally {
			sse?.close();
			ws?.close();
		}
	});
});
