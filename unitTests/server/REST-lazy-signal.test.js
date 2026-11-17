const assert = require('node:assert');
const { Readable } = require('node:stream');
const { setupTestDBPath } = require('../testUtils');
const { Resource } = require('#src/resources/Resource');
const { Resources } = require('#src/resources/Resources');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { handleApplication } = require('#src/server/REST');
const { Headers } = require('#src/server/serverHelpers/Headers');
require('#src/server/serverHelpers/serverUtilities');

const admin = { role: { permission: { super_user: true } } };
let mount = 0;

function rest(resources) {
	let handler;
	const path = `/lazy-signal-${mount++}`;
	handleApplication({
		resources,
		options: { getAll: () => ({ webSocket: false }) },
		routeFor: () => ({ urlPath: path }),
		server: { http: (listener) => (handler = listener) },
	});
	return (method, url, headers, body) => {
		const request = {
			method,
			url,
			user: admin,
			headers: new Headers(headers),
			body: Readable.from([Buffer.from(body)]),
			signalReads: 0,
			get signal() {
				request.signalReads++;
				return new AbortController().signal;
			},
		};
		request.headers.asObject = headers;
		return handler(request, () => ({ status: 404 })).then((response) => ({ request, response }));
	};
}

describe('REST request body decoding', () => {
	let post;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		const resources = new Resources();
		resources.set(
			'Echo',
			class extends Resource {
				static async post(_target, data) {
					return { received: await data };
				}
			},
			{ rest: true }
		);
		post = rest(resources);
	});

	it('does not read the request signal for a JSON body that writes nothing', async () => {
		const body = JSON.stringify({ title: 'plain' });
		const { request, response } = await post(
			'POST',
			'/Echo/',
			{ 'content-type': 'application/json', 'content-length': String(body.length) },
			body
		);
		assert.strictEqual(response.status, 200);
		assert.deepStrictEqual(JSON.parse(response.body), { received: { title: 'plain' } });
		assert.strictEqual(request.signalReads, 0);
	});
});
