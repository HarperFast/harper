'use strict';

const assert = require('node:assert');
const { Readable, PassThrough } = require('node:stream');
const { once } = require('node:events');
const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const { parseMultipartRequest } = require('#src/server/serverHelpers/multipartParser');
const { buildMultipartBody } = require('#src/bin/multipartBuilder');

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

// Quiet eslint about unused `once`
void once;
