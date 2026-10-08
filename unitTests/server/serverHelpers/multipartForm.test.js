'use strict';

const assert = require('node:assert');
const { Readable, PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { Request, BunRequest, UwsRequestBody } = require('#src/server/serverHelpers/Request');
const { getDeserializer, contentTypes } = require('#src/server/serverHelpers/contentTypes');
const { completeMultipartBody } = require('#src/server/serverHelpers/multipartForm');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../../waitFor.js');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { setupTestDBPath } = require('../../testUtils.js');

const boundary = '----=_HarperForm';
const contentType = `multipart/form-data; boundary="${boundary}"`;

function encodeForm(parts, closed = true) {
	const chunks = [];
	for (const part of parts) {
		let headers = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
		if (part.filename !== undefined) headers += `; filename="${part.filename}"`;
		headers += '\r\n';
		if (part.type) headers += `Content-Type: ${part.type}\r\n`;
		chunks.push(Buffer.from(headers + '\r\n'), Buffer.from(part.value), Buffer.from('\r\n'));
	}
	if (closed) chunks.push(Buffer.from(`--${boundary}--\r\n`));
	return Buffer.concat(chunks);
}

function decode(parts, header = contentType) {
	const bytes = encodeForm(parts);
	return getDeserializer(header, true)(Readable.from([bytes]));
}

async function collect(body) {
	const parts = [];
	for await (const part of body) parts.push(part);
	return parts;
}

describe('REST multipart form decoding', function () {
	this.timeout(10000);
	let Uploads;
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Uploads = table({
			database: 'multipart_forms',
			table: 'Uploads',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'file', type: 'Blob' },
			],
		});
	});

	it('registers buffered and streaming deserializers', function () {
		const handler = contentTypes.get('multipart/form-data');
		assert.equal(typeof handler.deserialize, 'function');
		assert.equal(typeof handler.deserializeStream, 'function');
	});

	it('keeps text values and repeated names, including inherited object property names', async function () {
		const form = await decode([
			{ name: 'title', value: 'café' },
			{ name: 'tag', value: '123' },
			{ name: 'tag', value: 'true' },
			{ name: 'toString', value: 'literal' },
			{ name: 'hasOwnProperty', value: '' },
		]);
		assert.deepStrictEqual(form, { title: 'café', tag: ['123', 'true'], toString: 'literal', hasOwnProperty: '' });
	});

	it('decodes multiple and empty files as Blobs, preserving order, MIME types and Unicode filenames', async function () {
		const form = await decode([
			{ name: 'file', value: '\x00\x01\x02', filename: 'café.bin', type: 'application/octet-stream' },
			{ name: 'after', value: 'after the file' },
			{ name: 'file', value: '', filename: 'empty.txt', type: 'text/plain' },
			{ name: 'file', value: 'text' },
		]);
		assert.equal(form.after, 'after the file');
		assert.equal(form.file.length, 3);
		assert(form.file[0] instanceof Blob);
		assert.equal(form.file[0].name, 'café.bin');
		assert.equal(form.file[0].type, 'application/octet-stream');
		assert.deepStrictEqual(Buffer.from(await form.file[0].arrayBuffer()), Buffer.from([0, 1, 2]));
		assert.equal(form.file[1].size, 0);
		assert.equal(form.file[2], 'text');
	});

	it('handles boundaries split across chunks and case-insensitive media types', async function () {
		const bytes = encodeForm([{ name: 'title', value: 'value' }]);
		const chunks = Array.from(bytes, (byte) => Buffer.from([byte]));
		const form = await getDeserializer(
			contentType.replace('multipart/form-data', 'Multipart/Form-Data'),
			true
		)(Readable.from(chunks));
		assert.deepStrictEqual(form, { title: 'value' });
	});

	it('decodes an empty form', async function () {
		assert.deepStrictEqual(await decode([]), {});
	});

	it('persists decoded Blob contents and metadata', async function () {
		const form = await decode([{ name: 'file', filename: 'saved.txt', type: 'text/plain', value: 'saved bytes' }]);
		await Uploads.put({ id: 'buffered', file: form.file });
		const record = await Uploads.get('buffered');
		assert.equal(await record.file.text(), 'saved bytes');
		assert.equal(record.file.name, 'saved.txt');
		assert.equal(record.file.type, 'text/plain');
	});

	it('delivers a Blob before the upload ends and saves it before advancing', async function () {
		const input = new PassThrough();
		const body = getDeserializer(contentType, true, true)(input);
		input.write(
			encodeForm([{ name: 'file', filename: 'streamed.txt', type: 'text/plain', value: 'first bytes' }], false)
		);
		const first = await body.next();
		assert.equal(first.done, false);
		assert(first.value.file instanceof Blob);
		assert.equal(input.writableEnded, false);
		const saving = Uploads.put({ id: 'streamed', file: first.value.file });
		input.end(Buffer.from(`--${boundary}--\r\n`));
		await saving;
		assert.equal((await body.next()).done, true);
		const record = await Uploads.get('streamed');
		assert.equal(await record.file.text(), 'first bytes');
		assert.equal(record.file.name, 'streamed.txt');
	});

	it('fails when advancing past an unread Blob instead of truncating it', async function () {
		const body = getDeserializer(
			contentType,
			true,
			true
		)(Readable.from([encodeForm([{ name: 'file', filename: 'unread.txt', value: 'important contents' }])]));
		const first = await body.next();
		await assert.rejects(body.next(), /Consume each multipart Blob/);
		await assert.rejects(Uploads.put({ id: 'unread', file: first.value.file }), /Consume each multipart Blob/);
		assert.equal(await Uploads.get('unread'), undefined);
	});

	it('propagates source failures into both the iterator and a Blob save', async function () {
		const input = new PassThrough();
		const body = getDeserializer(contentType, true, true)(input);
		input.write(encodeForm([{ name: 'file', filename: 'failed.txt', value: 'partial' }], false));
		const first = await body.next();
		const saving = Uploads.put({ id: 'failed', file: first.value.file });
		const failedSave = assert.rejects(saving, /source failed/);
		input.destroy(new Error('source failed'));
		await failedSave;
		await assert.rejects(body.next(), /source failed/);
		assert.equal(await Uploads.get('failed'), undefined);
	});

	it('cancels on request abortion even before iteration starts', async function () {
		const controller = new AbortController();
		const input = new PassThrough();
		const body = getDeserializer(contentType, true, true)(input, controller.signal);
		controller.abort();
		input.end();
		await assert.rejects(body.next(), /Multipart request aborted/);
	});

	it('settles a pending next when a handler returns without consuming its body', async function () {
		const input = new PassThrough();
		const body = getDeserializer(contentType, true, true)(input);
		const next = body.next();
		const rejected = assert.rejects(next, /Premature close|AbortError/);
		assert.equal(await completeMultipartBody(body, 'early response'), 'early response');
		input.end();
		await rejected;
	});

	it('releases an upload on an early iterator return', async function () {
		const input = new PassThrough();
		const body = getDeserializer(contentType, true, true)(input);
		input.write(
			Buffer.concat([encodeForm([{ name: 'title', value: 'first' }], false), Buffer.from(`--${boundary}\r\n`)])
		);
		assert.deepStrictEqual((await body.next()).value, { title: 'first' });
		await body.return();
		input.end(encodeForm([{ name: 'file', filename: 'ignored.bin', value: Buffer.alloc(65536) }]));
		await waitFor(() => input.readableEnded);
	});

	for (const streaming of [false, true]) {
		it(`rejects a malformed trailer (${streaming ? 'streaming' : 'buffered'})`, async function () {
			const input = Readable.from([encodeForm([{ name: 'title', value: 'incomplete' }], false)]);
			const body = getDeserializer(contentType, true, streaming)(input);
			await assert.rejects(streaming ? collect(body) : body, (error) => error.statusCode === 400);
		});

		for (const name of ['__proto__', 'constructor', 'prototype']) {
			it(`rejects unsafe field ${name} (${streaming ? 'streaming' : 'buffered'})`, async function () {
				for (const filename of [undefined, 'unsafe.txt']) {
					const input = Readable.from([encodeForm([{ name, filename, value: 'unsafe' }])]);
					const body = getDeserializer(contentType, true, streaming)(input);
					await assert.rejects(streaming ? collect(body) : body, (error) => error.statusCode === 400);
				}
			});
		}

		it(`rejects truncated fields and excess parts (${streaming ? 'streaming' : 'buffered'})`, async function () {
			for (const parts of [
				[{ name: 'large', value: 'a'.repeat(1024 * 1024 + 1) }],
				Array.from({ length: 65 }, (_, index) => ({ name: `field${index}`, value: 'a' })),
				Array.from({ length: 65 }, (_, index) => ({ name: `file${index}`, filename: `${index}.txt`, value: '' })),
			]) {
				const input = Readable.from([encodeForm(parts)]);
				const body = getDeserializer(contentType, true, streaming)(input);
				await assert.rejects(streaming ? collect(body) : body, (error) => error.statusCode === 413);
			}
		});

		it(`enforces the configured whole-body limit (${streaming ? 'streaming' : 'buffered'})`, async function () {
			const previous = env.get(CONFIG_PARAMS.HTTP_MAXREQUESTBODYSIZE);
			env.setProperty(CONFIG_PARAMS.HTTP_MAXREQUESTBODYSIZE, 100);
			try {
				const input = Readable.from([encodeForm([{ name: 'large', value: 'a'.repeat(1000) }])]);
				const body = getDeserializer(contentType, true, streaming)(input);
				await assert.rejects(streaming ? collect(body) : body, (error) => error.statusCode === 413);
			} finally {
				env.setProperty(CONFIG_PARAMS.HTTP_MAXREQUESTBODYSIZE, previous);
			}
		});
	}

	it('rejects missing or malformed boundaries', function () {
		for (const header of ['multipart/form-data', 'multipart/form-data; boundary="']) {
			assert.throws(
				() => getDeserializer(header, true, true)(Readable.from([])),
				(error) => error.statusCode === 400
			);
		}
	});

	it('decodes bodies through Node, Bun and uWS request adapters', async function () {
		const bytes = encodeForm([{ name: 'title', value: 'adapter' }]);
		const nodeInput = Readable.from([bytes]);
		Object.assign(nodeInput, { method: 'POST', url: '/', headers: {}, socket: new EventEmitter() });
		const nodeBody = new Request(nodeInput).body;
		const bunBody = new BunRequest(
			new globalThis.Request('http://localhost/', { method: 'POST', body: bytes }),
			null,
			false
		).body;
		const uwsBody = new UwsRequestBody();
		uwsBody.push(bytes);
		uwsBody.push(null);
		for (const input of [nodeBody, bunBody, uwsBody]) {
			assert.deepStrictEqual(await collect(getDeserializer(contentType, true, true)(input)), [{ title: 'adapter' }]);
		}
	});

	it('bounds discarding through the Node request wrapper when the sender never finishes', async function () {
		const input = new PassThrough();
		Object.assign(input, { method: 'POST', url: '/', headers: {}, socket: new EventEmitter() });
		const request = new Request(input);
		const body = getDeserializer(contentType, true, true)(request.body, request.signal);
		assert.equal(await completeMultipartBody(body, 'ignored'), 'ignored');
		await waitFor(() => input.destroyed, { timeout: 3000 });
	});

	it('keeps ordinary JSON bodies as promises for opted-in methods', async function () {
		const body = getDeserializer('application/json', true, true)(Readable.from([Buffer.from('{"value":1}')]));
		assert.equal(typeof body.then, 'function');
		assert.deepStrictEqual(await body, { value: 1 });
	});

	it('keeps headerless request bodies in their binary envelope', async function () {
		const bytes = Buffer.from([1, 2, 3]);
		for (const streaming of [false, true]) {
			assert.deepStrictEqual(await getDeserializer('', true, streaming)(Readable.from([bytes])), {
				contentType: 'application/octet-stream',
				data: bytes,
			});
		}
	});

	it('keeps synchronous protocol messages opaque instead of returning multipart promises', function () {
		const bytes = Buffer.from('not a complete form');
		const decoded = getDeserializer(contentType, false)(bytes);
		assert.deepStrictEqual(decoded, { contentType: 'multipart/form-data', data: bytes });
	});

	it('does not present parser state as record fields to authorization', async function () {
		const body = getDeserializer(contentType, true, true)(Readable.from([encodeForm([])]));
		const fields = [];
		for (const name in body) fields.push(name);
		assert.deepStrictEqual(fields, []);
		await collect(body);
	});
});
