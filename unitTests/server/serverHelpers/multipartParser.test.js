'use strict';

const assert = require('node:assert');
const { Readable, PassThrough, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const { parseMultipartRequest, releaseUnreadUpload } = require('#src/server/serverHelpers/multipartParser');
const { buildMultipartBody } = require('#src/bin/multipartBuilder');
const { waitFor } = require('../../waitFor.js');

function parse(contentType, stream) {
	return new Promise((resolve, reject) => {
		const fakeRequest = { headers: { 'content-type': contentType } };
		parseMultipartRequest(fakeRequest, stream, (err, body) => {
			if (err) reject(err);
			else resolve(body);
		});
	});
}

function collect(stream) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		stream.on('data', (c) => chunks.push(c));
		stream.on('end', () => resolve(Buffer.concat(chunks)));
		stream.on('error', reject);
	});
}

describe('multipartParser', () => {
	it('decodes string and JSON-valued fields', async () => {
		const built = buildMultipartBody({
			operation: 'deploy_component',
			project: 'demo',
			restart: true,
			install_timeout: 60,
		});
		const body = await parse(built.contentType, built.stream);
		assert.strictEqual(body.operation, 'deploy_component');
		assert.strictEqual(body.project, 'demo');
		assert.strictEqual(body.restart, true);
		assert.strictEqual(body.install_timeout, 60);
		assert.strictEqual(body.payload, undefined);
	});

	for (const unsafeName of ['__proto__', 'constructor', 'prototype']) {
		it(`rejects the prototype-mutating field name "${unsafeName}"`, async () => {
			const fields = { operation: 'add_user' };
			Object.defineProperty(fields, unsafeName, {
				value: { bypass_auth: true },
				enumerable: true,
			});
			const built = buildMultipartBody(fields);

			await assert.rejects(parse(built.contentType, built.stream), /is not allowed/);
			assert.strictEqual(built.stream.destroyed, true, 'malicious request stream should be destroyed');
		});
	}

	it('exposes the file part as a Readable on body.payload and streams its contents intact', async () => {
		const expected = Buffer.alloc(64 * 1024).fill(0xab); // 64 KB so we cross at least one busboy chunk boundary
		const built = buildMultipartBody(
			{ operation: 'deploy_component', project: 'demo' },
			{
				name: 'payload',
				filename: 'package.tar.gz',
				contentType: 'application/gzip',
				stream: Readable.from(expected),
			}
		);
		const body = await parse(built.contentType, built.stream);
		assert.strictEqual(body.operation, 'deploy_component');
		assert.ok(body.payload && typeof body.payload.pipe === 'function', 'payload should be a Readable');
		const actual = await collect(body.payload);
		assert.deepStrictEqual(actual, expected);
	});

	it('returns done before the file body has been fully consumed (streaming, not buffered)', async () => {
		// Verifies that the parser hands the handler control as soon as the file part starts,
		// rather than waiting for the whole file to arrive. This is what enables payloads larger
		// than memory to flow through.
		const partial = new PassThrough();
		const built = buildMultipartBody(
			{ operation: 'deploy_component', project: 'demo' },
			{ name: 'payload', filename: 'package.tar.gz', stream: partial }
		);
		// Don't end `partial` yet — the parser should still resolve with a body whose payload is a Readable.
		const bodyPromise = parse(built.contentType, built.stream);
		partial.write(Buffer.from('first-chunk'));
		const body = await bodyPromise;
		assert.strictEqual(body.operation, 'deploy_component');
		assert.ok(body.payload, 'payload Readable must exist before the file part has finished');
		// Now finish the file part so the collector can complete.
		partial.end();
		const contents = await collect(body.payload);
		assert.strictEqual(contents.toString(), 'first-chunk');
	});

	it('rejects multipart bodies whose file part is not named "payload"', async () => {
		const built = buildMultipartBody(
			{ operation: 'deploy_component' },
			{ name: 'something_else', filename: 'package.tar.gz', stream: Readable.from(Buffer.from('x')) }
		);
		await assert.rejects(parse(built.contentType, built.stream), /Unexpected file field/);
	});

	it('ignores fields that arrive after the file part (CLI always sends fields first)', async () => {
		const boundary = '----HarperMultipartTest1234';
		const body = [
			`--${boundary}`,
			'Content-Disposition: form-data; name="operation"',
			'',
			'deploy_component',
			`--${boundary}`,
			'Content-Disposition: form-data; name="payload"; filename="package.tar.gz"',
			'Content-Type: application/gzip',
			'',
			'<file-bytes>',
			`--${boundary}`,
			'Content-Disposition: form-data; name="late_field"',
			'',
			'oops',
			`--${boundary}--`,
			'',
		].join('\r\n');
		const parsed = await parse(`multipart/form-data; boundary=${boundary}`, Readable.from(Buffer.from(body)));
		assert.strictEqual(parsed.operation, 'deploy_component');
		assert.strictEqual(parsed.late_field, undefined, 'fields after the file part must not be applied to body');
		await collect(parsed.payload); // ensure we drain the stream so the test doesn't leak it
	});

	it('returns an empty body for a multipart request with no parts', async () => {
		const built = buildMultipartBody({});
		const body = await parse(built.contentType, built.stream);
		assert.deepStrictEqual(body, {});
	});

	it('errors on missing Content-Type', async () => {
		const stream = Readable.from(Buffer.from(''));
		await assert.rejects(parse(undefined, stream), /Missing Content-Type/);
	});

	it('propagates rawStream errors', async () => {
		const stream = new PassThrough();
		const built = buildMultipartBody({ operation: 'deploy_component' });
		// Race a stream error against the parser
		const promise = parse(built.contentType, stream);
		queueMicrotask(() => stream.destroy(new Error('socket reset')));
		await assert.rejects(promise, /socket reset/);
	});

	it('propagates a rawStream error mid-file by destroying body.payload so consumers do not hang', function (testDone) {
		// Reproduces the leak fixed at server/serverHelpers/multipartParser.ts:106 —
		// a socket reset mid-upload (after the file part has started, i.e. after `done` has
		// already fired) used to leave busboy and the file Readable open forever, so a
		// downstream `pipeline(payload, gunzip(), extract(...))` would hang indefinitely.
		this.timeout(5000);
		const boundary = '----HarperMultipartLeakTest';
		const headerThroughFileStart =
			`--${boundary}\r\n` +
			`Content-Disposition: form-data; name="operation"\r\n` +
			`\r\n` +
			`deploy_component\r\n` +
			`--${boundary}\r\n` +
			`Content-Disposition: form-data; name="payload"; filename="package.tar.gz"\r\n` +
			`Content-Type: application/gzip\r\n` +
			`\r\n` +
			`first-chunk-of-file-bytes`;
		const raw = new PassThrough();
		raw.on('error', () => {}); // we deliberately destroy raw with an error below
		parse(`multipart/form-data; boundary=${boundary}`, raw)
			.then((body) => {
				assert.ok(body.payload, 'file part should have been dispatched');
				let errored = false;
				body.payload.on('error', (err) => {
					errored = true;
					assert.match(err.message, /(socket reset|Request stream error)/);
				});
				body.payload.on('close', () => {
					if (!errored) return testDone(new Error('body.payload closed without an error event'));
					testDone();
				});
				body.payload.resume();
				// Simulate a socket reset mid-upload.
				raw.destroy(new Error('socket reset'));
			})
			.catch(testDone);
		raw.write(headerThroughFileStart);
	});
});

describe('multipartParser – an upload its response left unread', () => {
	const BOUNDARY = '----HarperUnreadUploadTest';
	const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;
	const CHUNK = Buffer.alloc(64 * 1024, 7);
	const partHead = (fileName) =>
		`--${BOUNDARY}\r\nContent-Disposition: form-data; name="operation"\r\n\r\ndeploy_component\r\n` +
		`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${fileName}"; filename="package.tar.gz"\r\n` +
		`Content-Type: application/gzip\r\n\r\n`;
	const closing = `\r\n--${BOUNDARY}--\r\n`;
	const malformedTail = `\r\n--${BOUNDARY}\r\nthis header has no colon\r\n\r\n`;

	async function* body({ fileName = 'payload', fileBytes = 4 * 1024 * 1024, tail = closing } = {}) {
		yield Buffer.from(partHead(fileName));
		for (let sent = 0; sent < fileBytes; sent += CHUNK.length) yield CHUNK;
		yield Buffer.from(tail);
	}

	function start(options) {
		const request = { headers: { 'content-type': CONTENT_TYPE } };
		const raw = new PassThrough();
		raw.on('error', () => {});
		const source = Readable.from(body(options));
		source.pipe(raw);
		const parsed = new Promise((resolve, reject) =>
			parseMultipartRequest(request, raw, (error, parsedBody) => (error ? reject(error) : resolve(parsedBody)))
		);
		return { request, raw, source, parsed };
	}

	const respond = (request) => new Promise((resolve) => releaseUnreadUpload(request, undefined, resolve));

	it('discards the rest of a part the route never read, and only once', async () => {
		const { request, raw, parsed } = start();
		const { payload } = await parsed;
		await sleep(50);
		assert.strictEqual(raw.readableEnded, false, 'the unread part holds the upload back');
		await respond(request);
		await respond(request);
		await waitFor(() => raw.readableEnded, 5000);
		assert.strictEqual(payload.destroyed, true);
	});

	it('closes a request whose body is still arriving a second after its response', async () => {
		const request = { headers: { 'content-type': CONTENT_TYPE } };
		const raw = new PassThrough();
		raw.write(partHead('payload'));
		raw.write(CHUNK);
		await new Promise((resolve, reject) =>
			parseMultipartRequest(request, raw, (error, parsedBody) => (error ? reject(error) : resolve(parsedBody)))
		);
		await respond(request);
		assert.strictEqual(raw.destroyed, false, 'the client gets a moment to read the response');
		await waitFor(() => raw.destroyed, 3000);
	});

	it('leaves a request alone at the end of its grace period once its body has fully arrived', async () => {
		const raw = new PassThrough();
		const request = { headers: { 'content-type': CONTENT_TYPE }, raw };
		raw.write(partHead('payload'));
		raw.write(CHUNK);
		await new Promise((resolve, reject) =>
			parseMultipartRequest(request, raw, (error, parsedBody) => (error ? reject(error) : resolve(parsedBody)))
		);
		await respond(request);
		// Every byte has arrived, though the stream has not ended: the connection may already carry another request.
		raw.complete = true;
		await sleep(1200);
		assert.strictEqual(raw.destroyed, false);
	});

	for (const [description, hold] of [
		['a flowing part', (payload) => payload.resume()],
		[
			'a paused data consumer',
			(payload) => {
				payload.on('data', () => {});
				payload.pause();
			},
		],
		['a readable consumer', (payload) => payload.on('readable', () => {})],
	]) {
		it(`leaves ${description} to its consumer`, async () => {
			const { request, parsed } = start();
			const { payload } = await parsed;
			const errors = [];
			payload.on('error', (error) => errors.push(error));
			hold(payload);
			await respond(request);
			await sleep(50);
			assert.deepStrictEqual(errors, [], 'a discard would have ended the part with an error');
		});
	}

	it('leaves a part whose iterator is paused between reads to its consumer', async () => {
		const fileBytes = 4 * 1024 * 1024;
		const { request, raw, parsed } = start({ fileBytes });
		const { payload } = await parsed;
		const iterator = payload[Symbol.asyncIterator]();
		let read = (await iterator.next()).value.length;
		await sleep(50);
		assert.strictEqual(raw.readableEnded, false, 'the rest of the upload is still held back by the paused iterator');
		await respond(request);
		await sleep(50);
		for (let step = await iterator.next(); !step.done; step = await iterator.next()) read += step.value.length;
		assert.strictEqual(read, fileBytes, 'every byte still reached the consumer');
	});

	it('discards a part the route took an iterator for but had not started reading', async () => {
		const { request, raw, parsed } = start();
		const { payload } = await parsed;
		payload[Symbol.asyncIterator]();
		await respond(request);
		await waitFor(() => raw.readableEnded, 5000);
	});

	for (const [description, change] of [
		['replaced', (parsedBody) => (parsedBody.payload = new PassThrough())],
		['deleted', (parsedBody) => delete parsedBody.payload],
	]) {
		it(`discards the part the parser handed out when the route ${description} body.payload`, async () => {
			const { request, raw, parsed } = start();
			const parsedBody = await parsed;
			const original = parsedBody.payload;
			change(parsedBody);
			await respond(request);
			await waitFor(() => raw.readableEnded, 5000);
			assert.strictEqual(original.destroyed, true);
			if (parsedBody.payload) assert.strictEqual(parsedBody.payload.destroyed, false, 'the replacement is not touched');
		});
	}

	it('does nothing for a part read to its end while the rest of the body is still arriving', async () => {
		const request = { headers: { 'content-type': CONTENT_TYPE } };
		const raw = new PassThrough();
		raw.write(partHead('payload'));
		raw.write('file-bytes');
		raw.write(closing);
		const { payload } = await new Promise((resolve, reject) =>
			parseMultipartRequest(request, raw, (error, parsedBody) => (error ? reject(error) : resolve(parsedBody)))
		);
		assert.strictEqual((await collect(payload)).toString(), 'file-bytes');
		await respond(request);
		await sleep(1200);
		assert.strictEqual(raw.destroyed, false, 'a request whose part was read is not cut off');
		raw.end();
		await waitFor(() => raw.readableEnded, 5000);
	});

	it('discards the rest when a consumer lets the part go after the response', async () => {
		const { request, raw, parsed } = start();
		const { payload } = await parsed;
		payload.on('data', () => {});
		payload.pause();
		await respond(request);
		await sleep(50);
		assert.strictEqual(raw.readableEnded, false, 'a held part is left to its consumer');
		payload.destroy();
		await waitFor(() => raw.readableEnded, 5000);
	});

	it('discards the rest when a consumer let the part go before its end', async () => {
		const { request, raw, parsed } = start();
		const { payload } = await parsed;
		payload.once('data', () => payload.destroy());
		await once(payload, 'close');
		await respond(request);
		await waitFor(() => raw.readableEnded, 5000);
	});

	it('discards the rest of a body whose framing breaks after an unexpected-name part was refused', async () => {
		const { request, raw, parsed } = start({ fileName: 'other', tail: malformedTail + 'x'.repeat(256 * 1024) });
		await assert.rejects(parsed, { statusCode: 400 });
		await respond(request);
		await waitFor(() => raw.readableEnded, 5000);
	});

	it('discards the rest of a body whose framing breaks after its part was read', async () => {
		const { request, raw, parsed } = start({
			fileBytes: 256 * 1024,
			tail: malformedTail + 'x'.repeat(256 * 1024),
		});
		const { payload } = await parsed;
		await collect(payload);
		await respond(request);
		await waitFor(() => raw.readableEnded, 5000);
	});

	it('raises no uncaught error when the request aborts after the hand-off, while a consumer still sees it', async () => {
		const uncaught = [];
		const onUncaught = (error) => uncaught.push(error);
		process.on('uncaughtException', onUncaught);
		try {
			const unread = start();
			const { payload } = await unread.parsed;
			const closed = new Promise((resolve) => payload.once('close', resolve));
			unread.raw.destroy(new Error('socket reset'));
			await closed;

			const refused = start({ fileName: 'other' });
			await assert.rejects(refused.parsed, { statusCode: 400 });
			refused.raw.destroy(new Error('socket reset'));

			const consumed = start();
			const consumedBody = await consumed.parsed;
			const reading = pipeline(consumedBody.payload, new Writable({ write: (chunk, encoding, next) => next() }));
			consumed.raw.destroy(new Error('socket reset'));
			await assert.rejects(reading, /socket reset/);
			await sleep(10);
		} finally {
			process.removeListener('uncaughtException', onUncaught);
		}
		assert.deepStrictEqual(uncaught, []);
	});
});

// Quiet eslint about unused `once`
void once;
