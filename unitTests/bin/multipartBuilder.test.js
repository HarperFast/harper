'use strict';

const assert = require('node:assert');
const { Readable } = require('node:stream');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { buildMultipartBody } = require('#src/bin/multipartBuilder');

function collect(stream) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		stream.on('data', (c) => chunks.push(c));
		stream.on('end', () => resolve(Buffer.concat(chunks)));
		stream.on('error', reject);
	});
}

describe('buildMultipartBody', () => {
	it('emits fields in insertion order followed by the file part and a closing delimiter', async () => {
		const result = buildMultipartBody(
			{ operation: 'deploy_component', project: 'demo', restart: true },
			{
				name: 'payload',
				filename: 'package.tar.gz',
				contentType: 'application/gzip',
				stream: Readable.from(Buffer.from('hello')),
			}
		);
		const body = await collect(result.stream);
		const text = body.toString();
		assert.match(text, /^--[-A-Za-z0-9]+\r\n/);
		const opIdx = text.indexOf('name="operation"');
		const projIdx = text.indexOf('name="project"');
		const restartIdx = text.indexOf('name="restart"');
		const fileIdx = text.indexOf('name="payload"');
		assert.ok(opIdx < projIdx && projIdx < restartIdx && restartIdx < fileIdx, 'expected field-then-file order');
		assert.match(text, /Content-Type: application\/gzip/);
		assert.match(text, /\r\n--[-A-Za-z0-9]+--\r\n$/, 'must end with the closing boundary');
	});

	it('JSON-stringifies non-string field values so the server-side parser can reverse it', async () => {
		const result = buildMultipartBody({ restart: true, install_timeout: 60, ids: ['a', 'b'] });
		const body = (await collect(result.stream)).toString();
		assert.match(body, /name="restart"\r\n\r\ntrue\r\n/);
		assert.match(body, /name="install_timeout"\r\n\r\n60\r\n/);
		assert.match(body, /name="ids"\r\n\r\n\["a","b"\]\r\n/);
	});

	it('omits undefined field values entirely', async () => {
		const result = buildMultipartBody({ operation: 'x', missing: undefined });
		const body = (await collect(result.stream)).toString();
		assert.match(body, /name="operation"/);
		assert.doesNotMatch(body, /name="missing"/);
	});

	it('omits the file part when none is supplied', async () => {
		const result = buildMultipartBody({ operation: 'restart_service' });
		const body = (await collect(result.stream)).toString();
		assert.doesNotMatch(body, /filename=/);
		assert.match(body, /--[-A-Za-z0-9]+--\r\n$/);
	});

	it('uses a unique boundary per invocation', () => {
		const a = buildMultipartBody({});
		const b = buildMultipartBody({});
		assert.notStrictEqual(a.boundary, b.boundary);
		assert.match(a.contentType, /^multipart\/form-data; boundary=/);
	});

	it('strips CR/LF and quote characters from field and file names', async () => {
		const result = buildMultipartBody(
			{ 'evil\r\nname': 'value' },
			{ name: 'payload"', filename: '"hax\r\n.tar.gz', stream: Readable.from(Buffer.from('x')) }
		);
		const body = (await collect(result.stream)).toString();
		assert.match(body, /name="evilname"/);
		assert.match(body, /name="payload"/);
		assert.match(body, /filename="hax\.tar\.gz"/);
		assert.doesNotMatch(body, /\r\nname/);
	});
});
