const assert = require('node:assert');
const { Readable, PassThrough } = require('node:stream');
const { Resource } = require('#src/resources/Resource');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { getDeserializer } = require('#src/server/serverHelpers/contentTypes');
const { setupTestDBPath } = require('../testUtils.js');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

async function* parts(values) {
	yield* values;
}

describe('Resource request body resolution', function () {
	this.timeout(10000);
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	for (const method of ['post', 'put', 'patch']) {
		it(`resolves a promised ${method} body before authorization and dispatch`, async function () {
			const body = { title: 'resolved' };
			const seen = [];
			class Receiver extends Resource {
				allowCreate(_user, data) {
					seen.push(data);
					return data === body;
				}
				allowUpdate(_user, data) {
					return this.allowCreate(_user, data);
				}
				[method](data) {
					assert.strictEqual(data, body);
					return data;
				}
			}
			assert.strictEqual(
				await Receiver[method](new RequestTarget('/one'), Promise.resolve(body), { authorize: true }),
				body
			);
			assert.deepStrictEqual(seen, [body]);
		});
	}

	it('collects named parts through super.post and gives both hooks the same object', async function () {
		let authorized;
		class Receiver extends Resource {
			static post(target, data, context) {
				assert.equal(typeof data[Symbol.asyncIterator], 'function');
				return super.post(target, data, context);
			}
			allowCreate(_user, data) {
				assert.deepStrictEqual(data, { title: 'form', tag: ['one', 'two'], then: 'literal' });
				authorized = data;
				return true;
			}
			post(data) {
				assert.strictEqual(data, authorized);
				return data;
			}
		}
		await Receiver.post(
			new RequestTarget('/'),
			parts([
				{ name: 'title', value: 'form' },
				{ name: 'tag', value: 'one' },
				{ name: 'tag', value: 'two' },
				{ name: 'then', value: 'literal' },
			]),
			{ authorize: true }
		);
	});

	it('resolves a Promise of named parts', async function () {
		class Receiver extends Resource {
			post(data) {
				return data;
			}
		}
		assert.deepStrictEqual(
			await Receiver.post(new RequestTarget('/'), Promise.resolve(parts([{ name: 'title', value: 'promised form' }]))),
			{ title: 'promised form' }
		);
	});

	it('latches authorization before waiting on the body', async function () {
		const gate = Promise.withResolvers();
		let checked = 0;
		class Receiver extends Resource {
			allowCreate(_user, data) {
				checked++;
				return data.title === 'ready';
			}
			post(data) {
				return data;
			}
		}
		const context = { authorize: true };
		const posting = Receiver.post(new RequestTarget('/'), gate.promise, context);
		assert.equal(context.authorize, false);
		gate.resolve({ title: 'ready' });
		assert.deepStrictEqual(await posting, { title: 'ready' });
		assert.equal(checked, 1);
	});

	it('keeps live connect and publish iterators unconsumed', async function () {
		for (const method of ['connect', 'publish']) {
			let pulls = 0;
			const incoming = {
				async *[Symbol.asyncIterator]() {
					pulls++;
					yield { message: 'live' };
				},
			};
			class Receiver extends Resource {
				[method](data) {
					assert.strictEqual(data, incoming);
					return 'received';
				}
			}
			assert.equal(await Receiver[method](new RequestTarget('/one'), incoming), 'received');
			assert.equal(pulls, 0);
		}
	});

	it('delivers ordered name/value parts', async function () {
		const body = getDeserializer(
			'multipart/form-data; boundary=parts',
			true,
			true
		)(
			Readable.from([
				Buffer.from('--parts\r\nContent-Disposition: form-data; name="title"\r\n\r\nfirst\r\n--parts--\r\n'),
			])
		);
		assert.deepStrictEqual((await body.next()).value, { name: 'title', value: 'first' });
		assert.equal((await body.next()).done, true);
	});

	it('materializes streaming files before authorization without a commit', async function () {
		const input = new PassThrough();
		const body = getDeserializer('multipart/form-data; boundary=file', true, true)(input);
		let authorized;
		class Receiver extends Resource {
			async allowCreate(_user, data) {
				assert.equal(data.file.name, 'upload.txt');
				assert.equal(data.file.type, 'text/plain');
				assert.equal(await data.file.text(), 'first last');
				authorized = data;
				return true;
			}
			async post(data) {
				assert.strictEqual(data, authorized);
				assert.equal(await data.file.text(), 'first last');
				return data.after;
			}
		}
		const posting = Receiver.post(new RequestTarget('/'), body, { authorize: true });
		input.write(
			'--file\r\nContent-Disposition: form-data; name="file"; filename="upload.txt"\r\nContent-Type: text/plain\r\n\r\nfirst'
		);
		input.end(' last\r\n--file\r\nContent-Disposition: form-data; name="after"\r\n\r\nfinished\r\n--file--\r\n');
		assert.equal(await posting, 'finished');
	});
	it('preserves array values while collecting repeated names', async function () {
		class Receiver extends Resource {
			post(data) {
				return data;
			}
		}
		assert.deepStrictEqual(
			await Receiver.post(
				new RequestTarget('/'),
				parts([
					{ name: 'values', value: ['one'] },
					{ name: 'values', value: ['two'] },
				])
			),
			{ values: [['one'], ['two']] }
		);
	});

	for (const invalid of [null, { title: 'wrong shape' }, { name: '__proto__', value: 'unsafe' }]) {
		it(`rejects invalid named parts (${JSON.stringify(invalid)}) before either hook`, async function () {
			let called = false;
			let returned = false;
			class Receiver extends Resource {
				allowCreate() {
					called = true;
					return false;
				}
				post() {
					called = true;
				}
			}
			const body = {
				async *[Symbol.asyncIterator]() {
					try {
						yield invalid;
					} finally {
						returned = true;
					}
				},
			};
			await assert.rejects(Receiver.post(new RequestTarget('/'), body, { authorize: true }), { statusCode: 400 });
			assert.equal(called, false);
			assert.equal(returned, true);
		});
	}

	it('preserves decode errors before invoking an authorization hook', async function () {
		const { ClientError } = require('#src/utility/errors/hdbError');
		let called = false;
		class Receiver extends Resource {
			allowCreate() {
				called = true;
				return false;
			}
			post() {
				called = true;
			}
		}
		const error = new ClientError('Malformed body', 400);
		await assert.rejects(
			Receiver.post(new RequestTarget('/'), Promise.reject(error), { authorize: true }),
			(received) => received === error
		);
		assert.equal(called, false);
	});

	it('resolves named QUERY parts before projection authorization', async function () {
		let checked = false;
		class Receiver extends Resource {
			allowRead(_user, target) {
				assert.deepStrictEqual(target.select, ['title']);
				checked = true;
				return true;
			}
			search(target) {
				assert.deepStrictEqual(target.select, ['title']);
				return [];
			}
		}
		await Receiver.query(new RequestTarget('/'), parts([{ name: 'select', value: ['title'] }]), { authorize: true });
		assert.equal(checked, true);
	});

	it('resolves a custom decoder Promise of named parts', async function () {
		const { contentTypes } = require('#src/server/serverHelpers/contentTypes');
		const type = 'application/x-named-parts-test';
		contentTypes.set(type, { deserialize: () => Promise.resolve(parts([{ name: 'title', value: 'custom form' }])) });
		class Receiver extends Resource {
			post(data) {
				return data;
			}
		}
		try {
			const body = getDeserializer(type, true, true)(Readable.from([Buffer.from('custom')]));
			assert.deepStrictEqual(await Receiver.post(new RequestTarget('/'), body), { title: 'custom form' });
		} finally {
			contentTypes.delete(type);
		}
	});
});
