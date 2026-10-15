const assert = require('node:assert');
const { Readable } = require('node:stream');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { waitFor } = require('../waitFor.js');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { Resources } = require('#src/resources/Resources');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { handleApplication } = require('#src/server/REST');
const { Headers } = require('#src/server/serverHelpers/Headers');
const { evaluatePreconditions, parseHttpDate, versionToEtag } = require('#src/server/serverHelpers/preconditions');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const admin = { role: { permission: { super_user: true } } };
let mount = 0;

function rest(resources, options = {}) {
	let handler;
	handleApplication({
		resources,
		options: { getAll: () => ({ webSocket: false, lastModified: true, ...options }) },
		routeFor: () => ({ urlPath: `/conditions-${mount++}` }),
		server: { http: (listener) => (handler = listener) },
	});
	return async (method, url, data, headers = {}, user = admin) => {
		const request = {
			method,
			url,
			user,
			headers: new Headers(headers),
			data,
			body: data instanceof Readable ? data : undefined,
		};
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

describe('HTTP precondition evaluation', () => {
	const date = 'Wed, 21 Oct 2015 07:28:00 GMT';
	const version = Date.parse(date) + 999;
	const check = (headers, method = 'GET', exists = true, etag = '"current"', modified = version) =>
		evaluatePreconditions(headers, method, exists, etag, modified);

	it('keeps the established ETag bytes', () => {
		assert.strictEqual(versionToEtag(0), '"::::::::::"'.replaceAll(':', '>'));
		assert.strictEqual(versionToEtag(1_760_000_000_000), '">>>>JIFewG"');
	});

	it('uses strong If-Match and weak If-None-Match, including lists and opaque commas', () => {
		assert.strictEqual(check({ 'if-match': 'W/"current"' }), 412);
		assert.strictEqual(check({ 'if-match': '"other", "current"' }), undefined);
		assert.strictEqual(check({ 'if-match': '"current"' }, 'GET', true, 'W/"current"'), 412);
		assert.strictEqual(check({ 'if-none-match': ['"other"', 'W/"current"'] }), 304);
		assert.strictEqual(check({ 'if-match': '"a,b", "other"' }, 'GET', true, '"a,b"'), undefined);
		assert.strictEqual(check({ 'if-none-match': '"current"' }, 'PATCH'), 412);
		assert.throws(() => check({ 'if-match': '"current" garbage' }), { statusCode: 400 });
	});

	it('distinguishes existence from a validator and honors wildcard semantics', () => {
		for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
			assert.strictEqual(check({ 'if-match': '*' }, method, false), 412);
			assert.strictEqual(check({ 'if-none-match': '*' }, method, false), undefined);
			assert.strictEqual(check({ 'if-match': '*' }, method, true, undefined), undefined);
		}
		assert.strictEqual(check({ 'if-none-match': '*' }, 'HEAD'), 304);
	});

	it('follows precedence and compares dates at whole-second precision', () => {
		assert.strictEqual(check({ 'if-modified-since': date }), 304);
		assert.strictEqual(check({ 'if-unmodified-since': date }, 'PUT'), undefined);
		assert.strictEqual(check({ 'if-unmodified-since': date }, 'PUT', true, '"current"', version + 1), 412);
		assert.strictEqual(
			check({ 'if-match': '"current"', 'if-unmodified-since': 'Wed, 21 Oct 2015 07:27:00 GMT' }),
			undefined
		);
		assert.strictEqual(check({ 'if-none-match': '"other"', 'if-modified-since': date }), undefined);
		assert.strictEqual(check({ 'if-match': '"other"', 'if-none-match': '"current"' }), 412);
		assert.strictEqual(check({ 'if-modified-since': date }, 'PUT'), undefined);
	});

	it('ignores invalid and repeated date fields, while accepting HTTP date formats and epoch zero', () => {
		for (const value of [
			'invalid',
			'2015-10-21',
			'0',
			'Mon, 30 Feb 2026 07:28:00 GMT',
			'Wed, 21 Oct 2015 24:00:00 GMT',
			[date, date],
		]) {
			assert.strictEqual(check({ 'if-modified-since': value }), undefined);
			assert.strictEqual(check({ 'if-unmodified-since': value }), undefined);
		}
		assert.strictEqual(parseHttpDate('Sunday, 06-Nov-94 08:49:37 GMT'), 784111777000);
		assert.strictEqual(parseHttpDate('Sun Nov  6 08:49:37 1994'), 784111777000);
		assert.strictEqual(check({ 'if-modified-since': 'Thu, 01 Jan 1970 00:00:00 GMT' }, 'GET', true, '"zero"', 0), 304);
	});
});

describe('REST preconditions with real table transactions', () => {
	let Row, Modern, resources, request;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		Row = table({
			table: 'HttpConditions',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		Modern = class extends Row {
			static loadAsInstance = false;
		};
		resources = new Resources();
		resources.set('Row', Row, { rest: true });
		resources.set('Modern', Modern, { rest: true });
		request = rest(resources);
	});

	it('returns bodyless 304 with validators, and keeps 404 ahead of read conditions', async () => {
		await Row.put('read', { n: 1 });
		const first = await request('GET', '/Row/read');
		const etag = first.headers.get('etag');
		assert.ok(etag);
		for (const method of ['GET', 'HEAD']) {
			const response = await request(method, '/Row/read', undefined, { 'if-none-match': `"other", W/${etag}` });
			assert.strictEqual(response.status, 304);
			assert.strictEqual(await bodyOf(response), '');
			assert.strictEqual(response.headers.get('etag'), etag);
			assert.strictEqual(response.headers.get('last-modified'), first.headers.get('last-modified'));
		}
		assert.strictEqual((await request('GET', '/Row/absent', undefined, { 'if-match': '*' })).status, 404);
	});

	it('rejects stale PUT, PATCH and DELETE before changing a record or its version', async () => {
		for (const method of ['PUT', 'PATCH', 'DELETE']) {
			await Row.put(method, { n: 1 });
			const before = Row.primaryStore.getEntry(method);
			const response = await request(
				method,
				`/Row/${method}`,
				{ n: 2 },
				{ 'if-none-match': versionToEtag(before.version) }
			);
			assert.strictEqual(response.status, 412, await bodyOf(response));
			assert.strictEqual(Row.primaryStore.getEntry(method).version, before.version);
			assert.strictEqual((await Row.get(method)).n, 1);
			const after = await request(method, `/Row/${method}`, { n: 3 }, { 'if-match': versionToEtag(before.version) });
			assert.ok(after.status >= 200 && after.status < 300, await bodyOf(after));
		}
		assert.strictEqual(await Row.get('DELETE'), null);
	});

	it('allows one create, treats tombstones as absent, and releases rejected holds', async () => {
		for (const id of ['new', 'tombstone']) {
			if (id === 'tombstone') {
				await Row.put(id, { n: 0 });
				await Row.delete(id);
			}
			const first = await request('PUT', `/Row/${id}`, { n: 1 }, { 'if-none-match': '*' });
			assert.ok(first.status < 300, await bodyOf(first));
			const failed = await request('PUT', `/Row/${id}`, { n: 2 }, { 'if-none-match': '*' });
			assert.strictEqual(failed.status, 412, await bodyOf(failed));
			assert.strictEqual((await Row.get(id)).n, 1);
			if (!isLMDB) {
				const held = await Row.lock(id, { hold: true, timeout: 1 });
				await held.unlock();
			}
		}
	});

	it('handles a body rejection while waiting for another holder', async function () {
		if (isLMDB) return this.skip();
		await Row.put('body-wait', { n: 1 });
		const held = await Row.lock('body-wait', { hold: true });
		const failure = new Error('HTTP precondition body-wait failure');
		const body = Readable.from(
			(async function* () {
				throw failure;
			})()
		);
		const rejected = [];
		const onRejected = (error) => {
			if (error === failure) rejected.push(error);
		};
		process.on('unhandledRejection', onRejected);
		let pending;
		try {
			pending = request('PATCH', '/Row/body-wait', body, {
				'if-match': '*',
				'content-type': 'application/json',
				'transfer-encoding': 'chunked',
			});
			await waitFor(() => body.destroyed, 2_000);
			await nextTurn();
			assert.deepStrictEqual(rejected, []);
		} finally {
			await held.unlock();
			if (pending) assert.ok((await pending).status >= 400);
			process.off('unhandledRejection', onRejected);
		}
		assert.strictEqual((await Row.get('body-wait')).n, 1);
	});

	it('treats an expired record as absent for mutation conditions', async () => {
		await Row.put('expired', { n: 1 }, { expiresAt: Date.now() - 1_000 });
		const response = await request('PATCH', '/Row/expired', { n: 2 }, { 'if-match': '*' });
		assert.strictEqual(response.status, 412, await bodyOf(response));
	});

	it('enforces conditions with locks disabled and when LMDB has no lock capability', async () => {
		const unlocked = rest(resources, { preconditionLocks: false });
		await Row.put('optimistic', { n: 1 });
		assert.strictEqual((await unlocked('PATCH', '/Row/optimistic', { n: 2 }, { 'if-match': '"stale"' })).status, 412);
		assert.ok((await unlocked('PATCH', '/Row/optimistic', { n: 3 })).status < 300);
		assert.strictEqual((await Row.get('optimistic')).n, 3);
	});

	it('checks v1 and v2 authorization before revealing condition failures', async () => {
		await Row.put('private', { n: 1 });
		for (const name of ['Row', 'Modern']) {
			for (const method of ['PUT', 'PATCH', 'DELETE']) {
				const response = await request(
					method,
					`/${name}/private`,
					{ n: 2 },
					{ 'if-match': '"stale"' },
					{ role: { permission: {} } }
				);
				assert.strictEqual(response.status, 403, await bodyOf(response));
			}
		}
	});

	it('rechecks at commit when an unconditional writer bypasses the lock', async () => {
		class Interleaved extends Row {
			async patch(data, target) {
				await Row.put(this.getId(), { n: 9 }, {});
				return super.patch(data, target);
			}
		}
		resources.set('Interleaved', Interleaved, { rest: true });
		for (const preconditionLocks of [true, false]) {
			const id = `interleave-${preconditionLocks}`;
			await Row.put(id, { n: 1 });
			const etag = versionToEtag(Row.primaryStore.getEntry(id).version);
			const response = await rest(resources, { preconditionLocks })(
				'PATCH',
				`/Interleaved/${id}`,
				{ n: 2 },
				{ 'if-match': etag }
			);
			assert.strictEqual(response.status, 412, await bodyOf(response));
			assert.strictEqual((await Row.get(id)).n, 9);
		}
	});

	it('commits one audit entry per conditional mutation without a phantom lock write', async () => {
		const id = 'audit';
		await Row.put(id, { n: 1 });
		const entries = () =>
			[...Row.auditStore.getRange({ start: 1 })].filter(
				(entry) => entry.tableId === Row.tableId && entry.recordId === id
			).length;
		for (const method of ['PUT', 'PATCH', 'DELETE']) {
			const before = entries();
			const etag = versionToEtag(Row.primaryStore.getEntry(id).version);
			const response = await request(method, `/Row/${id}`, { n: 2 }, { 'if-match': etag });
			assert.ok(response.status < 300, await bodyOf(response));
			assert.strictEqual(entries(), before + 1);
		}
	});

	it('does not require read access to perform a permitted conditional update', async () => {
		await Row.put('write-only', { n: 1 });
		const user = { role: { permission: { test: { tables: { HttpConditions: { update: true } } } } } };
		const response = await request(
			'PATCH',
			'/Row/write-only',
			{ n: 2 },
			{ 'if-match': versionToEtag(Row.primaryStore.getEntry('write-only').version) },
			user
		);
		assert.ok(response.status < 300, await bodyOf(response));
		assert.strictEqual((await Row.get('write-only')).n, 2);
	});

	it('fails closed for collection and property conditions without dispatching writes', async () => {
		for (const path of ['/Row/', '/Row/read.n']) {
			assert.strictEqual((await request('PUT', path, { n: 8 }, { 'if-none-match': '*' })).status, 501);
		}
		assert.strictEqual((await Row.get('read')).n, 1);
	});

	it('binds the condition to the normalized numeric primary key', async () => {
		const Numeric = table({
			table: 'HttpNumericConditions',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true, type: 'Int' }, { name: 'n' }],
		});
		resources.set('Numeric', Numeric, { rest: true });
		await Numeric.put(42, { n: 1 });
		const response = await request(
			'PATCH',
			'/Numeric/42',
			{ n: 2 },
			{ 'if-match': versionToEtag(Numeric.primaryStore.getEntry(42).version) }
		);
		assert.ok(response.status < 300, await bodyOf(response));
		assert.strictEqual((await Numeric.get(42)).n, 2);
	});

	it('rejects custom statics and handlers that never consume the condition', async () => {
		class CustomStatic extends Row {
			static put() {
				throw new Error('must not dispatch');
			}
		}
		class Noop extends Row {
			patch() {}
		}
		resources.set('CustomStatic', CustomStatic, { rest: true });
		resources.set('Noop', Noop, { rest: true });
		assert.strictEqual((await request('PUT', '/CustomStatic/read', { n: 2 }, { 'if-match': '*' })).status, 501);
		assert.strictEqual((await request('PATCH', '/Noop/read', { n: 2 }, { 'if-match': '*' })).status, 501);
		assert.strictEqual((await Row.get('read')).n, 1);
	});

	it('checks empty PATCH without committing a phantom version', async () => {
		await Row.put('empty-patch', { n: 1 });
		const version = Row.primaryStore.getEntry('empty-patch').version;
		assert.strictEqual((await request('PATCH', '/Row/empty-patch', {}, { 'if-match': '"stale"' })).status, 412);
		assert.ok((await request('PATCH', '/Row/empty-patch', {}, { 'if-match': versionToEtag(version) })).status < 300);
		assert.strictEqual(Row.primaryStore.getEntry('empty-patch').version, version);
	});

	it('ignores invalid write dates and conditions on TRACE and OPTIONS', async () => {
		assert.ok(
			(await request('PUT', '/Row/', [{ id: 'invalid-date', n: 1 }], { 'if-unmodified-since': 'invalid' })).status < 300
		);
		assert.strictEqual((await Row.get('invalid-date')).n, 1);
		assert.strictEqual((await request('TRACE', '/Row/read', undefined, { 'if-match': '"stale"' })).status, 200);
		assert.strictEqual((await request('OPTIONS', '/Row/read', undefined, { 'if-match': '"stale"' })).status, 204);
	});

	it('cancels web response bodies, including thrown responses', async () => {
		let cancelled = 0;
		class WebResponse extends Resource {
			static get(_target, context) {
				const response = new Response(
					new ReadableStream({
						cancel() {
							cancelled++;
						},
					}),
					{ headers: { ETag: '"web"' } }
				);
				if (context.data?.throw) throw response;
				return response;
			}
		}
		resources.set('WebResponse', WebResponse, { rest: true });
		for (const data of [{}, { throw: true }]) {
			const response = await request('GET', '/WebResponse/', data, { 'if-none-match': '"web"' });
			assert.strictEqual(response.status, 304);
			assert.strictEqual(await bodyOf(response), '');
		}
		assert.strictEqual(cancelled, 2);
		const failed = await request('GET', '/WebResponse/', { throw: true }, { 'if-match': '"stale"' });
		assert.strictEqual(failed.status, 412, await bodyOf(failed));
	});

	it('uses explicit response validators and preserves error precedence', async () => {
		class Envelope extends Resource {
			static get(_target, context) {
				return {
					status: context.data?.error ? 403 : 200,
					headers: new Headers({ ETag: '"envelope"' }),
					body: Readable.from(['body']),
				};
			}
		}
		resources.set('Envelope', Envelope, { rest: true });
		const read = await request('GET', '/Envelope/', undefined, { 'if-none-match': '"envelope"' });
		assert.strictEqual(read.status, 304);
		assert.strictEqual(await bodyOf(read), '');
		const forbidden = await request('GET', '/Envelope/', { error: true }, { 'if-match': '"stale"' });
		assert.strictEqual(forbidden.status, 403);
	});
});
