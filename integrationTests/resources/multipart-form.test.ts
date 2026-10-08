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
import { setTimeout as delay } from 'node:timers/promises';
import type { IncomingMessage } from 'node:http';
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

	test('accepts a browser form POST directly into an exported table', async () => {
		const form = new FormData();
		form.append('id', 'form-post');
		form.append('title', 'posted form');
		form.append('file', new Blob(['posted bytes'], { type: 'text/plain' }), 'posted.txt');
		const response = await fetch(`${ctx.harper.httpURL}/StoredUpload/`, {
			method: 'POST',
			headers: { Authorization: authorization },
			body: form,
			signal: AbortSignal.timeout(10000),
		});
		assert.equal(response.status, 201, await response.text());
		assert.deepStrictEqual(await read('/ReadUpload/form-post'), {
			name: 'posted.txt',
			type: 'text/plain',
			size: 12,
			text: 'posted bytes',
		});
	});

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

	test('settles a streaming body ignored by a DELETE method', async () => {
		const form = new FormData();
		form.append('file', new Blob([Buffer.alloc(200000)]), 'ignored.bin');
		const response = await fetch(`${ctx.harper.httpURL}/IgnoredUpload/ignored`, {
			method: 'DELETE',
			headers: { Authorization: authorization },
			body: form,
			signal: AbortSignal.timeout(10000),
		});
		assert.equal(response.status, 200, await response.text());
	});

	test('serves OpenAPI when a bodyless request explicitly declares a zero content length', async () => {
		const response = await fetch(`${ctx.harper.httpURL}/openapi`, {
			headers: { 'Authorization': authorization, 'Content-Length': '0' },
			signal: AbortSignal.timeout(10000),
		});
		assert.equal(response.status, 200, await response.text());
	});

	test('requires staged Blob writes to finish before advancing to another part', async () => {
		const form = new FormData();
		form.append('file', new Blob([Buffer.alloc(200000)]), 'uncommitted.bin');
		const response = await fetch(`${ctx.harper.httpURL}/UncommittedUpload/uncommitted`, {
			method: 'POST',
			headers: { Authorization: authorization },
			body: form,
			signal: AbortSignal.timeout(10000),
		});
		assert.equal(response.status, 400);
		assert.match(await response.text(), /commit staged Blob writes/);
		const record = await fetch(`${ctx.harper.httpURL}/StoredUpload/uncommitted`, {
			headers: { Authorization: authorization },
			signal: AbortSignal.timeout(10000),
		});
		assert.equal(record.status, 404);
		await record.text();
	});

	test('finishes a slow response before closing an ignored upload', { timeout: 15000 }, async () => {
		const uploading = httpRequest(`${ctx.harper.httpURL}/SlowResponseUpload/slow`, {
			method: 'POST',
			headers: {
				'Authorization': authorization,
				'Content-Type': 'multipart/form-data; boundary=slow',
				'Accept': 'application/x-ndjson',
			},
		});
		const receiving = new Promise<IncomingMessage>((resolve, reject) => {
			uploading.once('response', resolve);
			uploading.on('error', reject);
		});
		uploading.write('--slow\r\nContent-Disposition: form-data; name="file"; filename="slow.txt"\r\n\r\n');
		uploading.write(Buffer.alloc(32768));
		try {
			const response = await receiving;
			response.on('error', () => {});
			const iterator = response[Symbol.asyncIterator]();
			const first = await iterator.next();
			assert.equal(response.statusCode, 200);
			assert.match(first.value.toString(), /first/);
			await delay(1250);
			assert.equal(response.destroyed, false);
			await read('/ReleaseUpload/slow');
			let remaining = '';
			for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) remaining += chunk;
			assert.match(remaining, /last/);
		} finally {
			uploading.destroy();
		}
	});

	for (const allowFile of [true, false]) {
		test(`enforces file attribute permissions during a streaming save (${allowFile ? 'allowed' : 'denied'})`, async () => {
			const client = createApiClient(ctx.harper);
			const username = `multipart-${allowFile}`;
			const password = 'multipart-test-password';
			await client
				.req()
				.send({
					operation: 'add_role',
					role: username,
					permission: {
						super_user: false,
						data: {
							tables: {
								StoredUpload: {
									read: true,
									insert: true,
									update: true,
									delete: false,
									attribute_permissions: [
										{ attribute_name: 'id', read: true, insert: true, update: true },
										{ attribute_name: 'title', read: true, insert: false, update: false },
										{ attribute_name: 'file', read: true, insert: allowFile, update: allowFile },
									],
								},
							},
						},
					},
				})
				.expect(200);
			await client.req().send({ operation: 'add_user', role: username, username, password, active: true }).expect(200);
			const form = new FormData();
			form.append('file', new Blob(['permitted file']), 'permission.txt');
			const response = await fetch(`${ctx.harper.httpURL}/StreamingUpload/${username}`, {
				method: 'POST',
				headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` },
				body: form,
				signal: AbortSignal.timeout(10000),
			});
			assert.equal(response.status, allowFile ? 200 : 403, await response.text());
			if (allowFile) assert.equal((await read(`/ReadUpload/${username}-0`)).text, 'permitted file');
			else {
				const record = await fetch(`${ctx.harper.httpURL}/StoredUpload/${username}-0`, {
					headers: { Authorization: authorization },
					signal: AbortSignal.timeout(10000),
				});
				assert.equal(record.status, 404);
				await record.text();
			}
		});
	}
});
