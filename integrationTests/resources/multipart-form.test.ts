/**
 * REST multipart/form-data decoding and persistence, including opt-in delivery of streaming
 * Blobs before upload completion, inherited buffered methods, and refused/abandoned uploads.
 * Implements https://github.com/HarperFast/harper/issues/39.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { Readable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { createApiClient } from '../apiTests/utils/client.mjs';
import { waitFor } from '../../unitTests/waitFor.js';

suite('REST multipart forms', (ctx: ContextWithHarper) => {
	let authorization: string;
	before(async () => {
		await setupHarperWithFixture(ctx, resolve(import.meta.dirname, 'multipart-form'), {
			config: { threads: { count: 1 } },
		});
		authorization = createApiClient(ctx.harper).headers.Authorization;
	});
	after(async () => teardownHarper(ctx));

	async function read(path: string) {
		const response = await fetch(`${ctx.harper.httpURL}${path}`, {
			headers: { Authorization: authorization },
			signal: AbortSignal.timeout(10000),
		});
		assert.equal(response.status, 200);
		return response.json();
	}

	for (const route of ['StoredUpload', 'StreamingUpload']) {
		test(`uploads a form through the buffered ${route} PUT method`, async () => {
			const form = new FormData();
			form.append('title', 'a web form');
			form.append('file', new Blob(['default bytes'], { type: 'text/plain' }), 'café.txt');
			const response = await fetch(`${ctx.harper.httpURL}/${route}/buffered-${route}`, {
				method: 'PUT',
				headers: { Authorization: authorization },
				body: form,
				signal: AbortSignal.timeout(10000),
			});
			assert.equal(response.status, 204, await response.text());
			assert.deepStrictEqual(await read(`/ReadUpload/buffered-${route}`), {
				name: 'café.txt',
				type: 'text/plain',
				size: 13,
				text: 'default bytes',
			});
		});
	}

	test('delivers and persists streaming files before the client finishes sending', async () => {
		const boundary = '----=_IntegrationForm';
		const payload = Buffer.alloc(200000, 'x');
		const tail = Promise.withResolvers<void>();
		const body = Readable.from(
			(async function* () {
				yield Buffer.from(
					`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="stream.txt"\r\nContent-Type: text/plain\r\n\r\n`
				);
				yield payload.subarray(0, 32768);
				await tail.promise;
				yield payload.subarray(32768);
				yield Buffer.from(
					`\r\n--${boundary}\r\nContent-Disposition: form-data; name="after"\r\n\r\nlast field\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="second.txt"\r\nContent-Type: text/plain\r\n\r\nsecond file\r\n--${boundary}--\r\n`
				);
			})()
		);
		const uploading = fetch(`${ctx.harper.httpURL}/StreamingUpload/streamed`, {
			method: 'POST',
			headers: { 'Authorization': authorization, 'Content-Type': `multipart/form-data; boundary="${boundary}"` },
			body: body as any,
			duplex: 'half',
			signal: AbortSignal.timeout(20000),
		} as RequestInit);
		uploading.catch(() => {});
		try {
			await waitFor(async () => (await read('/UploadProgress/streamed')).received, {
				timeout: 10000,
				interval: 50,
				message: 'The resource must receive its Blob before the upload tail is sent',
			});
		} finally {
			tail.resolve();
		}
		const response = await uploading;
		assert.equal(response.status, 200, await response.clone().text());
		assert.deepStrictEqual(await response.json(), {
			fields: { after: 'last field' },
			saved: ['streamed-0', 'streamed-1'],
		});
		const first = await read('/ReadUpload/streamed-0');
		assert.equal(first.name, 'stream.txt');
		assert.equal(first.type, 'text/plain');
		assert.equal(first.size, payload.length);
		assert.equal(
			createHash('sha256').update(first.text).digest('hex'),
			createHash('sha256').update(payload).digest('hex')
		);
		assert.equal((await read('/ReadUpload/streamed-1')).text, 'second file');
	});

	test('settles a streaming Blob save when the client disconnects mid-file', async () => {
		const uploading = httpRequest(`${ctx.harper.httpURL}/StreamingUpload/disconnected`, {
			method: 'POST',
			headers: { 'Authorization': authorization, 'Content-Type': 'multipart/form-data; boundary=disconnect' },
		});
		uploading.on('error', () => {});
		uploading.write(
			'--disconnect\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\nContent-Type: text/plain\r\n\r\n'
		);
		uploading.write(Buffer.alloc(32768, 'x'));
		try {
			await waitFor(async () => (await read('/UploadProgress/disconnected')).received, {
				timeout: 10000,
				interval: 50,
			});
		} finally {
			uploading.destroy();
		}
		await waitFor(async () => (await read('/UploadProgress/disconnected')).failed, { timeout: 10000, interval: 50 });
		const record = await fetch(`${ctx.harper.httpURL}/StoredUpload/disconnected-0`, {
			headers: { Authorization: authorization },
			signal: AbortSignal.timeout(10000),
		});
		assert.equal(record.status, 404);
		await record.text();
	});

	test('rejects malformed forms without saving a partial record', async () => {
		const response = await fetch(`${ctx.harper.httpURL}/StoredUpload/malformed`, {
			method: 'PUT',
			headers: { 'Authorization': authorization, 'Content-Type': 'multipart/form-data; boundary=test' },
			body: '--test\r\nContent-Disposition: form-data; name="title"\r\n\r\nincomplete',
			signal: AbortSignal.timeout(10000),
		});
		assert.equal(response.status, 400, await response.text());
		const record = await fetch(`${ctx.harper.httpURL}/StoredUpload/malformed`, {
			headers: { Authorization: authorization },
			signal: AbortSignal.timeout(10000),
		});
		assert.equal(record.status, 404);
		await record.text();
	});

	for (const [route, status] of [
		['RefusedUpload', 403],
		['IgnoredUpload', 200],
	] as const) {
		test(`settles an upload that ${route} does not consume`, async () => {
			const form = new FormData();
			form.append('file', new Blob([Buffer.alloc(200000)]), 'ignored.bin');
			const response = await fetch(`${ctx.harper.httpURL}/${route}/ignored`, {
				method: 'POST',
				headers: { Authorization: authorization },
				body: form,
				signal: AbortSignal.timeout(10000),
			});
			assert.equal(response.status, status, await response.text());
		});
	}
});
