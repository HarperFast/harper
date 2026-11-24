/**
 * A table's event stream over real HTTP (harper#515): the stream issues ids, a reconnect that sends the last
 * one in Last-Event-ID receives what was committed in between, the stream issues a checkpoint token as a
 * harper-checkpoint event and resumes from it, and an id the table did not issue is refused before the stream starts.
 * The checkpoint semantics themselves (a transaction that commits below the token, the refusals) are pinned
 * against the same REST handler in unitTests/server/eventStreamResume.test.js, where the test controls
 * certification; this suite covers the wire and the server's own certification.
 *
 *   npm run test:integration -- "integrationTests/server/sse-resume.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual, match } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { parseSseBlocks } from '../utils/sseStream.ts';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'sse-resume');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const TOKEN_ID = /^[A-Za-z0-9_-]{40,}$/;

interface Stream {
	status: number;
	frames(): Array<Record<string, string>>;
	values(): string[];
	/** What an EventSource would send on its next reconnect. */
	lastEventId(): string | undefined;
	close(): void;
}

suite(
	'SSE table stream resumes from Last-Event-ID',
	{ skip: process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let restBase = '';
		let headers: Record<string, string> = {};
		const open: Stream[] = [];

		async function waitFor<T>(condition: () => T | Promise<T>, what: string, timeout = 30_000): Promise<T> {
			const deadline = Date.now() + timeout;
			for (;;) {
				const result = await condition();
				if (result) return result;
				if (Date.now() > deadline) throw new Error(`Timed out after ${timeout}ms waiting for ${what}`);
				await sleep(50);
			}
		}

		function connect(path: string, lastEventId?: string): Promise<Stream> {
			const url = new URL(`${restBase}${path}`);
			const lib = url.protocol === 'https:' ? https : http;
			return new Promise((resolveStream, reject) => {
				let raw = '';
				const request = lib.request(
					url,
					{
						method: 'GET',
						headers: {
							...headers,
							Accept: 'text/event-stream',
							...(lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId }),
						},
						rejectUnauthorized: false,
					} as any,
					(response) => {
						request.setTimeout(0);
						response.setEncoding('utf8');
						response.on('data', (chunk: string) => (raw += chunk));
						response.on('error', () => {});
						const frames = () => parseSseBlocks(raw.slice(0, Math.max(0, raw.lastIndexOf('\n\n'))));
						const stream: Stream = {
							status: response.statusCode ?? 0,
							frames,
							values: () =>
								frames()
									.filter((frame) => frame.data && !frame.event)
									.map((frame) => JSON.parse(frame.data).value?.value)
									.filter((value) => value !== undefined),
							lastEventId: () => frames().findLast((frame) => frame.id !== undefined)?.id,
							close: () => request.destroy(),
						};
						open.push(stream);
						resolveStream(stream);
					}
				);
				request.on('error', reject);
				// a stream that never writes never sends its headers
				request.setTimeout(30_000, () => request.destroy(new Error(`No response from ${path} within 30s`)));
				request.end();
			});
		}

		async function put(id: string) {
			const response = await fetch(`${restBase}/ResumeFeed/${id}`, {
				method: 'PUT',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: id }),
			});
			ok(response.ok, `PUT ${id} answered ${response.status}`);
		}

		const frameOf = (stream: Stream, value: string) =>
			stream.frames().find((frame) => frame.data && !frame.event && JSON.parse(frame.data).value?.value === value);

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: { threads: { count: 1 } }, env: {} });
			const client = createApiClient(ctx.harper);
			restBase = client.restURL;
			headers = { Authorization: client.headers.Authorization as string };
			await waitFor(
				async () => (await fetch(`${restBase}/ResumeFeed/`, { headers })).status === 200,
				'the fixture table route'
			);
			// a stream's response starts with its first frame, which a snapshot row supplies at once
			await put('seed');
		});

		after(async () => {
			for (const stream of open) stream.close();
			await teardownHarper(ctx);
		});

		test('a reconnect with the last event id receives what was committed in between', async () => {
			const first = await connect('/ResumeFeed/');
			strictEqual(first.status, 200);
			await put('first');
			await waitFor(() => frameOf(first, 'first'), 'the first live event');
			strictEqual(frameOf(first, 'seed')!.id, undefined, 'a snapshot row is state, not a position');
			// a log position, or a checkpoint token when the server had already certified one
			const id = await waitFor(() => first.lastEventId(), 'an event id');
			match(id, isLMDB ? /^\d+(\.\d+)?$/ : /^(\d+(\.\d+)?@[0-9a-f]{32}\.[0-9a-f]{16}|[A-Za-z0-9_-]{40,})$/);
			first.close();
			await put('missed-1');
			await put('missed-2');

			const resumed = await connect('/ResumeFeed/', id);
			strictEqual(resumed.status, 200);
			await waitFor(() => frameOf(resumed, 'missed-2'), 'the events committed while disconnected');
			deepStrictEqual(resumed.values().slice(-2), ['missed-1', 'missed-2']);
			ok(!resumed.values().includes('seed'), 'a resume replays the log and takes no snapshot');
			resumed.close();
		});

		test('an id the table did not issue is refused before the stream starts', async () => {
			for (const id of ['not-an-id', 'e30']) {
				const refused = await connect('/ResumeFeed/', id);
				strictEqual(refused.status, 400, id);
				refused.close();
			}
		});

		test('a custom resource reads the header as request.lastEventId', async () => {
			const stream = await connect('/Cursor/', 'application-cursor-7');
			strictEqual(stream.status, 200);
			const frame = await waitFor(() => stream.frames().find((candidate) => candidate.event === 'cursor'), 'its event');
			deepStrictEqual(JSON.parse(frame.data), { lastEventId: 'application-cursor-7' });
			strictEqual(frame.id, 'cursor-1');
			stream.close();
		});

		test('the stream issues a token as a harper-checkpoint event and resumes from it', { skip: isLMDB }, async () => {
			const first = await connect('/ResumeFeed/');
			await put('before-token');
			await waitFor(() => frameOf(first, 'before-token'), 'a live event');
			// the server certifies its own log position on its maintenance cadence
			const token = await waitFor(
				() => first.frames().find((frame) => frame.event === 'harper-checkpoint' && frame.data === '{}')?.id,
				'a checkpoint token',
				60_000
			);
			match(token, TOKEN_ID);
			strictEqual(JSON.parse(Buffer.from(token, 'base64url').toString()).v, 1);
			await put('after-token');
			await waitFor(() => frameOf(first, 'after-token'), 'an event after the token');
			strictEqual(frameOf(first, 'after-token')!.id, undefined, 'no scalar id once the client holds a token');
			first.close();
			await put('missed-after-token');

			const resumed = await connect('/ResumeFeed/', token);
			strictEqual(resumed.status, 200);
			await waitFor(() => frameOf(resumed, 'missed-after-token'), 'the event committed while disconnected');
			// a server that ignored the token would answer 200 too, with a snapshot
			ok(!resumed.values().includes('seed'), 'a resume replays the log and takes no snapshot');
			resumed.close();
		});
	}
);
