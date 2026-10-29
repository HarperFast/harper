const assert = require('node:assert');
const { waitFor } = require('../waitFor.js');
const { setupTestDBPath } = require('../testUtils.js');
const { Resource } = require('#src/resources/Resource');
const { ClientError } = require('#src/utility/errors/hdbError');
const { Resources } = require('#src/resources/Resources');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { handleApplication } = require('#src/server/REST');
const { Headers } = require('#src/server/serverHelpers/Headers');
const { versionToEtag } = require('#src/server/serverHelpers/preconditions');
require('#src/server/serverHelpers/serverUtilities');

const admin = { role: { permission: { super_user: true } } };
const BEFORE_SERIALIZATION = Date.UTC(2026, 0, 1);
const AT_STARTUP = Date.UTC(2026, 0, 2);
let mount = 0;

function rest(resources, options = {}) {
	let handler;
	handleApplication({
		resources,
		options: { getAll: () => ({ webSocket: false, lastModified: true, ...options }) },
		routeFor: () => ({ urlPath: `/deferred-reads-${mount++}` }),
		server: { http: (listener) => (handler = listener) },
	});
	return (method, url, headers = {}) => {
		const request = { method, url, user: admin, headers: new Headers(headers) };
		request.headers.asObject = headers;
		return handler(request, () => ({ status: 404 }));
	};
}

async function bodyOf(response) {
	if (typeof response.body === 'string' || Buffer.isBuffer(response.body)) return response.body.toString();
	if (!response.body) return '';
	const chunks = [];
	for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString();
}

function versionedAtStartup(context) {
	context.lastModified = BEFORE_SERIALIZATION;
	return (async function* () {
		context.lastModified = AT_STARTUP;
		yield { id: 1 };
	})();
}

describe('REST deferred reads', () => {
	let resources, request;
	const ndjson = { accept: 'application/x-ndjson' };
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		resources = new Resources();
		resources.set(
			'Startup',
			class extends Resource {
				static get(_target, context) {
					return versionedAtStartup(context);
				}
			},
			{ rest: true }
		);
		resources.set(
			'StartupEnvelope',
			class extends Resource {
				static get(_target, context) {
					return { headers: new Headers({ 'X-Envelope': 'true' }), data: versionedAtStartup(context) };
				}
			},
			{ rest: true }
		);
		request = rest(resources);
	});

	it('takes validators from the version stream startup set, the same on GET and HEAD', async () => {
		for (const name of ['Startup', 'StartupEnvelope']) {
			for (const method of ['GET', 'HEAD']) {
				const response = await request(method, `/${name}/`, ndjson);
				assert.strictEqual(response.status, 200, `${method} ${name}`);
				assert.strictEqual(response.headers.get('ETag'), versionToEtag(AT_STARTUP), `${method} ${name}`);
				assert.strictEqual(response.headers.get('Last-Modified'), new Date(AT_STARTUP).toUTCString());
				assert.strictEqual(await bodyOf(response), method === 'GET' ? '{"id":1}\n' : '');
			}
		}
	});

	it('keeps the pre-serialization version for formats whose stream starts after headers', async () => {
		const response = await request('GET', '/Startup/', { accept: 'application/json' });
		assert.strictEqual(response.headers.get('ETag'), versionToEtag(BEFORE_SERIALIZATION));
		assert.strictEqual(await bodyOf(response), '[{"id":1}]');
	});

	it('keeps validators the resource supplied', async () => {
		resources.set(
			'OwnValidators',
			class extends Resource {
				static get(_target, context) {
					context.responseHeaders.set('ETag', '"own"');
					context.responseHeaders.set('Last-Modified', new Date(BEFORE_SERIALIZATION).toUTCString());
					return versionedAtStartup(context);
				}
			},
			{ rest: true }
		);
		resources.set(
			'OwnEnvelopeValidators',
			class extends Resource {
				static get(_target, context) {
					return { headers: new Headers({ ETag: '"own"' }), data: versionedAtStartup(context) };
				}
			},
			{ rest: true }
		);
		resources.set(
			'OwnStartupEnvelopeValidators',
			class extends Resource {
				static get(_target, context) {
					const data = (async function* () {
						context.responseHeaders.set('ETag', '"own"');
						context.lastModified = AT_STARTUP;
						yield { id: 1 };
					})();
					return { headers: new Headers({ 'X-Envelope': 'true' }), data };
				}
			},
			{ rest: true }
		);
		for (const name of ['OwnValidators', 'OwnEnvelopeValidators', 'OwnStartupEnvelopeValidators']) {
			for (const method of ['GET', 'HEAD']) {
				const response = await request(method, `/${name}/`, ndjson);
				assert.strictEqual(response.headers.get('ETag'), '"own"', `${method} ${name}`);
				await bodyOf(response);
				const cached = await request(method, `/${name}/`, { ...ndjson, 'if-none-match': '"own"' });
				assert.strictEqual(cached.status, 304, `${method} ${name}`);
				const stale = await request(method, `/${name}/`, { ...ndjson, 'if-none-match': versionToEtag(AT_STARTUP) });
				assert.strictEqual(stale.status, 200, `${method} ${name}`);
				await bodyOf(stale);
			}
		}
		const own = await request('GET', '/OwnValidators/', ndjson);
		assert.strictEqual(own.headers.get('Last-Modified'), new Date(BEFORE_SERIALIZATION).toUTCString());
		await bodyOf(own);
	});

	it('stamps validators but leaves conditions to the application when preconditions are off', async () => {
		const unconditional = rest(resources, { preconditions: false });
		for (const method of ['GET', 'HEAD']) {
			const response = await unconditional(method, '/Startup/', {
				...ndjson,
				'if-none-match': versionToEtag(AT_STARTUP),
			});
			assert.strictEqual(response.status, 200, method);
			assert.strictEqual(response.headers.get('ETag'), versionToEtag(AT_STARTUP));
			await bodyOf(response);
		}
	});

	it('answers a startup failure on HEAD with the status GET answers', async () => {
		let closed = 0;
		resources.set(
			'FailsAtStartup',
			class extends Resource {
				static get() {
					return (async function* () {
						try {
							yield* [];
							throw new ClientError('conflict at startup', 409);
						} finally {
							closed++;
						}
					})();
				}
			},
			{ rest: true }
		);
		for (const method of ['GET', 'HEAD']) {
			const response = await request(method, '/FailsAtStartup/', ndjson);
			assert.strictEqual(response.status, 409, method);
			assert.strictEqual(response.headers.get('ETag'), undefined);
		}
		assert.strictEqual(closed, 2);
	});

	it('closes a HEAD producer whose first step is still pending once that step settles', async () => {
		const pending = Promise.withResolvers();
		let closed = false;
		resources.set(
			'PendingFirstStep',
			class extends Resource {
				static get() {
					return (async function* () {
						try {
							yield await pending.promise;
						} finally {
							closed = true;
						}
					})();
				}
			},
			{ rest: true }
		);
		const response = await request('HEAD', '/PendingFirstStep/', ndjson);
		assert.strictEqual(response.status, 200);
		assert.strictEqual(response.body, undefined);
		assert.strictEqual(closed, false, 'an async generator runs return() only after its pending step');
		pending.resolve({ id: 1 });
		await waitFor(() => closed);
	});

	it('disposes a discarded source once, through onDone or an unstepped iterator', async () => {
		let onDone = 0;
		let stepped = 0;
		let returned = 0;
		resources.set(
			'DisposedOnce',
			class extends Resource {
				static get(_target, context) {
					const source = versionedAtStartup(context);
					source.onDone = () => onDone++;
					return source;
				}
			},
			{ rest: true }
		);
		resources.set(
			'ClosedUnstepped',
			class extends Resource {
				static get() {
					return {
						[Symbol.asyncIterator]() {
							return {
								next() {
									stepped++;
									return Promise.resolve({ done: true, value: undefined });
								},
								return() {
									returned++;
									return Promise.resolve({ done: true, value: undefined });
								},
							};
						},
					};
				}
			},
			{ rest: true }
		);
		const notModified = await request('HEAD', '/DisposedOnce/', {
			...ndjson,
			'if-none-match': versionToEtag(AT_STARTUP),
		});
		assert.strictEqual(notModified.status, 304);
		assert.strictEqual(onDone, 1, 'the HEAD discard and the 304 discard close the source once');
		const head = await request('HEAD', '/ClosedUnstepped/', { accept: 'application/json' });
		assert.strictEqual(head.status, 200);
		assert.deepStrictEqual({ stepped, returned }, { stepped: 0, returned: 1 });
	});

	it('answers a discarded read even when closing its source fails', async () => {
		resources.set(
			'FailsToClose',
			class extends Resource {
				static get(_target, context) {
					context.responseHeaders.set('ETag', '"own"');
					const source = versionedAtStartup(context);
					source.onDone = () => {
						throw new Error('close failed');
					};
					return source;
				}
			},
			{ rest: true }
		);
		resources.set(
			'RejectsOnClose',
			class extends Resource {
				static get() {
					return {
						[Symbol.asyncIterator]() {
							return {
								next: () => Promise.resolve({ done: true, value: undefined }),
								return: () => Promise.reject(new Error('close failed')),
							};
						},
					};
				}
			},
			{ rest: true }
		);
		for (const method of ['GET', 'HEAD']) {
			const cached = await request(method, '/FailsToClose/', {
				'accept': 'application/json',
				'if-none-match': '"own"',
			});
			assert.strictEqual(cached.status, 304, method);
		}
		assert.strictEqual((await request('HEAD', '/FailsToClose/', { accept: 'application/json' })).status, 200);
		assert.strictEqual((await request('HEAD', '/RejectsOnClose/', { accept: 'application/json' })).status, 200);
		await new Promise((resolve) => setImmediate(resolve));
	});
});
