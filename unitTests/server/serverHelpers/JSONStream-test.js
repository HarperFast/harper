'use strict';

const test_utils = require('../../test_utils');
const { streamAsJSON } = require('../../../server/serverHelpers/JSONStream');
test_utils.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
function streamToJSON(stream) {
	return new Promise((resolve, reject) => {
		let buffers = [];
		stream.on('data', function (d) {
			buffers.push(d);
		});
		stream.on('end', function () {
			try {
				resolve(JSON.parse(Buffer.concat(buffers)));
			} catch (error) {
				reject(error);
			}
		});
		stream.on('error', reject);
	});
}
describe('Test JSONStream module ', () => {
	describe(`Streaming`, function () {
		it('Streams object', async function () {
			let input = { foo: 'bar' };
			let stream = streamAsJSON(input);
			assert.deepStrictEqual(await streamToJSON(stream), input);
		});
		it('Streams array', async function () {
			let input = [{ foo: 'bar' }, { foo: 'bar2' }];
			let stream = streamAsJSON(input);
			assert.deepStrictEqual(await streamToJSON(stream), input);
		});
		it('Streams generator', async function () {
			let expected = [{ foo: 'bar' }, { foo: 'bar2' }];
			function* generateObjects() {
				yield { foo: 'bar' };
				yield { foo: 'bar2' };
			}
			let stream = streamAsJSON(generateObjects());
			assert.deepStrictEqual(await streamToJSON(stream), expected);
		});
		it('Streams async generator', async function () {
			let expected = [{ foo: 'bar' }, { foo: 'bar2' }];
			async function* generateObjects() {
				await delay(1);
				yield { foo: 'bar' };
				await delay(1);
				yield { foo: 'bar2' };
				await delay(1);
			}
			let stream = streamAsJSON(generateObjects());
			assert.deepStrictEqual(await streamToJSON(stream), expected);
		});
	});
});

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
