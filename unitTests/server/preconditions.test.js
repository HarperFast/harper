const assert = require('node:assert');
const { Readable, PassThrough } = require('node:stream');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { waitFor } = require('../waitFor.js');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { Resource, WRITE_CONDITION } = require('#src/resources/Resource');
const { ClientError } = require('#src/utility/errors/hdbError');
const { Resources } = require('#src/resources/Resources');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { handleApplication } = require('#src/server/REST');
const { Headers } = require('#src/server/serverHelpers/Headers');
const { evaluatePreconditions, parseHttpDate, versionToEtag } = require('#src/server/serverHelpers/preconditions');
const {
	registerClusterLockTransport,
	unregisterClusterLockTransport,
} = require('#src/resources/recordLockCoordinator');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { clearThisNodeName, getThisNodeName } = require('#src/server/nodeName');
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

	it('accepts empty lists and empty elements required by RFC 9110 list parsing', () => {
		for (const value of ['', ' , , ', '"current",,']) {
			assert.strictEqual(check({ 'if-match': value }), value.includes('current') ? undefined : 412);
			assert.strictEqual(check({ 'if-none-match': value }), value.includes('current') ? 304 : undefined);
		}
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

	it('interprets an obsolete two-digit date beyond the full fifty-year boundary in the past', () => {
		const future = new Date();
		future.setUTCFullYear(future.getUTCFullYear() + 50);
		future.setUTCDate(future.getUTCDate() + 2);
		future.setUTCMilliseconds(0);
		const [, day, month, year, time] = future.toUTCString().split(' ');
		const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][future.getUTCDay()];
		const header = `${weekday}, ${day}-${month}-${year.slice(-2)} ${time} GMT`;
		future.setUTCFullYear(future.getUTCFullYear() - 100);
		assert.strictEqual(parseHttpDate(header), future.getTime());
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
		const body = new Readable({
			read() {
				this.destroy(failure);
			},
		});
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

	it('does not lock a record while a request body is pending or permission is denied', async function () {
		if (isLMDB) return this.skip();
		await Row.put('slow-body', { n: 1 });
		for (const name of ['Row', 'Modern']) {
			for (const user of [admin, { role: { permission: {} } }]) {
				const body = new PassThrough();
				const pending = request(
					'PATCH',
					`/${name}/slow-body`,
					body,
					{ 'if-match': '*', 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
					user
				);
				let held;
				try {
					await nextTurn();
					held = await Row.lock('slow-body', { hold: true, timeout: 100 });
				} finally {
					if (held) await held.unlock();
					body.end('{"n":2}');
					const response = await pending;
					assert.ok(user === admin ? response.status < 300 : response.status === 403, await bodyOf(response));
				}
			}
		}
	});

	it('releases a newly acquired hold if constructing the locked target fails', async function () {
		if (isLMDB) return this.skip();
		let rejectConstruction = false;
		class RejectConstruction extends Row {
			constructor(...args) {
				super(...args);
				if (rejectConstruction) throw new Error('locked-target construction failed');
			}
		}
		const receiver = new RejectConstruction('own-key', {});
		rejectConstruction = true;
		await assert.rejects(receiver.lock('other-key', { hold: true }), /locked-target construction failed/);
		const held = await Row.lock('other-key', { hold: true, timeout: 100 });
		await held.unlock();
	});

	it('treats an expired record as absent for mutation conditions', async () => {
		await Row.put('expired', { n: 1 }, { expiresAt: Date.now() - 1_000 });
		const response = await request('PATCH', '/Row/expired', { n: 2 }, { 'if-match': '*' });
		assert.strictEqual(response.status, 412, await bodyOf(response));
	});

	it('serializes 16-way concurrent If-Match and If-None-Match races when locks are enabled by default or explicitly', async function () {
		if (isLMDB) return this.skip();
		for (const options of [{}, { preconditionLocks: true }]) {
			const tag = options.preconditionLocks === true ? 'explicit' : 'default';
			const client = rest(resources, options);
			const matchId = `race-match-${tag}`;
			await Row.put(matchId, { n: 0 });
			const etag = versionToEtag(Row.primaryStore.getEntry(matchId).version);
			const matchAttempts = await Promise.all(
				Array.from({ length: 16 }, (_, index) =>
					client('PATCH', `/Row/${matchId}`, { n: index + 1 }, { 'if-match': etag }).then((res) => ({
						status: res.status,
						n: index + 1,
					}))
				)
			);
			const matchWinners = matchAttempts.filter(({ status }) => status >= 200 && status < 300);
			assert.strictEqual(matchWinners.length, 1);
			assert.strictEqual(matchAttempts.filter(({ status }) => status === 412).length, 15);
			assert.strictEqual((await Row.get(matchId)).n, matchWinners[0].n);

			const createId = `race-create-${tag}`;
			const createAttempts = await Promise.all(
				Array.from({ length: 16 }, (_, index) =>
					client('PUT', `/Row/${createId}`, { n: index + 1 }, { 'if-none-match': '*' }).then((res) => ({
						status: res.status,
						n: index + 1,
					}))
				)
			);
			const createWinners = createAttempts.filter(({ status }) => status >= 200 && status < 300);
			assert.strictEqual(createWinners.length, 1);
			assert.strictEqual(createAttempts.filter(({ status }) => status === 412).length, 15);
			assert.strictEqual((await Row.get(createId)).n, createWinners[0].n);
		}
	});

	it('performs a single best-effort pre-check when locks are disabled or on LMDB', async () => {
		const unlocked = rest(resources, { preconditionLocks: false });
		await Row.put('optimistic', { n: 1 });
		assert.strictEqual((await unlocked('PATCH', '/Row/optimistic', { n: 2 }, { 'if-match': '"stale"' })).status, 412);
		assert.ok((await unlocked('PATCH', '/Row/optimistic', { n: 3 })).status < 300);
		assert.strictEqual((await Row.get('optimistic')).n, 3);

		const firstChecked = Promise.withResolvers();
		const secondChecked = Promise.withResolvers();
		const releaseBoth = Promise.withResolvers();
		class ConcurrentBestEffort extends Row {
			async patch(data, target) {
				const result = await super.patch(data, target);
				(data.n === 10 ? firstChecked : secondChecked).resolve();
				await releaseBoth.promise;
				return result;
			}
		}
		resources.set('ConcurrentBestEffort', ConcurrentBestEffort, { rest: true });
		const bestEffort = rest(resources, { preconditionLocks: false });
		await Row.put('best-effort-race', { n: 1 });
		const etag = versionToEtag(Row.primaryStore.getEntry('best-effort-race').version);
		const first = bestEffort('PATCH', '/ConcurrentBestEffort/best-effort-race', { n: 10 }, { 'if-match': etag });
		const second = bestEffort('PATCH', '/ConcurrentBestEffort/best-effort-race', { n: 20 }, { 'if-match': etag });
		await Promise.all([firstChecked.promise, secondChecked.promise]);
		releaseBoth.resolve();
		const [res1, res2] = await Promise.all([first, second]);
		assert.ok(res1.status >= 200 && res1.status < 300, await bodyOf(res1));
		assert.ok(res2.status >= 200 && res2.status < 300, await bodyOf(res2));
		const stored = (await Row.get('best-effort-race')).n;
		assert.ok(stored === 10 || stored === 20, `expected 10 or 20, got ${stored}`);
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

	it('does not mark an asynchronous model-hook write consumed before staging', async () => {
		const Embedded = table({
			table: 'ConditionEmbed',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'content', type: 'String' },
				{ name: 'embedding', type: 'Array', embed: { source: 'content', model: 'default' } },
			],
		});
		let gate, pending;
		Embedded.setEmbedAttribute('embedding', async () => {
			if (gate) await gate;
			return [1];
		});
		class Unawaited extends Embedded {
			patch(data, target) {
				pending = super.patch(data, target);
				pending.catch(() => {});
			}
		}
		await Embedded.put('deferred', { content: 'before' });
		let release;
		gate = new Promise((resolve) => {
			release = resolve;
		});
		resources.set('Unawaited', Unawaited, { rest: true });
		const response = await rest(resources, { preconditionLocks: false })(
			'PATCH',
			'/Unawaited/deferred',
			{ content: 'after' },
			{ 'if-match': '*' }
		);
		release();
		const lateError = await pending.then(
			() => undefined,
			(error) => error
		);
		assert.strictEqual(lateError?.statusCode, 409);
		assert.strictEqual(response.status, 501, await bodyOf(response));
		assert.strictEqual((await Embedded.get('deferred')).content, 'before');
	});

	it('refuses target writes started after their conditional request has finished', async () => {
		let pending;
		const schedule = (write) => {
			pending = new Promise((resolve, reject) => {
				setImmediate(() => {
					try {
						resolve(write());
					} catch (error) {
						reject(error);
					}
				});
			});
			pending.catch(() => {});
		};
		class Deferred extends Row {
			put(data, target) {
				schedule(() => super.put(data, target));
			}
			patch(data, target) {
				schedule(() => super.patch(data, target));
			}
			delete(target) {
				schedule(() => super.delete(target));
			}
		}
		resources.set('Deferred', Deferred, { rest: true });
		for (const preconditionLocks of [true, false]) {
			for (const method of ['PUT', 'PATCH', 'DELETE']) {
				const id = `deferred-${method}-${preconditionLocks}`;
				await Row.put(id, { n: 1 });
				const response = await rest(resources, { preconditionLocks })(
					method,
					`/Deferred/${id}`,
					method === 'DELETE' ? undefined : { n: 2 },
					{ 'if-match': '"stale"' }
				);
				await assert.rejects(pending, (error) => error.statusCode === 409);
				assert.strictEqual(response.status, 501, await bodyOf(response));
				assert.strictEqual((await Row.get(id)).n, 1);
			}
		}
	});

	it('releases a hold delivered after its request has already finished', async function () {
		if (isLMDB) this.skip();
		let delivered, release, pending;
		const acquired = new Promise((resolve) => {
			delivered = resolve;
		});
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		class LateHold extends Row {
			async lock(...args) {
				const held = await super.lock(...args);
				delivered();
				await gate;
				return held;
			}
			patch(data, target) {
				pending = super.patch(data, target);
				pending.catch(() => {});
			}
		}
		resources.set('LateHold', LateHold, { rest: true });
		await Row.put('late-hold', { n: 1 });
		const response = await rest(resources)('PATCH', '/LateHold/late-hold', { n: 2 }, { 'if-match': '*' });
		await acquired;
		release();
		await pending.catch(() => {});
		assert.strictEqual(response.status, 501, await bodyOf(response));
		const held = await Row.lock('late-hold', { hold: true, timeout: 100 });
		await held.unlock();
		assert.strictEqual((await Row.get('late-hold')).n, 1);
	});

	it('does not ask replication to confirm a predicate-only empty patch', async () => {
		await Row.put('confirm-noop', { n: 1 });
		const before = Row.primaryStore.getEntry('confirm-noop');
		const response = await request(
			'PATCH',
			'/Row/confirm-noop',
			{},
			{ 'if-match': versionToEtag(before.version), 'x-replicate-to': '0;confirm=1' }
		);
		assert.ok(response.status < 300, await bodyOf(response));
		assert.strictEqual(Row.primaryStore.getEntry('confirm-noop').version, before.version);
	});

	it('checks the target database before committing cross-database siblings', async () => {
		const Other = table({
			table: 'OtherConditions',
			database: 'httpConditionOther',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		class CrossDatabase extends Modern {
			async patch(target, data) {
				await Other.put(target.id, { n: 8 });
				return super.patch(target, data);
			}
		}
		resources.set('CrossDatabase', CrossDatabase, { rest: true });
		for (const preconditionLocks of [true, false]) {
			const id = `cross-${preconditionLocks}`;
			await Row.put(id, { n: 1 });
			const response = await rest(resources, { preconditionLocks })(
				'PATCH',
				`/CrossDatabase/${id}`,
				{ n: 2 },
				{ 'if-match': '"stale"' }
			);
			assert.strictEqual(response.status, 412, await bodyOf(response));
			await Other.put(`barrier-${id}`, { n: 0 });
			assert.strictEqual(Other.primaryStore.getEntry(id)?.value ?? null, null);
			assert.strictEqual((await Row.get(id)).n, 1);
			const accepted = await rest(resources)('PATCH', `/CrossDatabase/${id}`, { n: 3 });
			assert.ok(accepted.status < 300, await bodyOf(accepted));
			await Other.put(`accepted-barrier-${id}`, { n: 0 });
			assert.strictEqual(Other.primaryStore.getEntry(id)?.value?.n, 8);
		}
	});

	it('rejects conditional array PUT bodies before staging batch writes', async () => {
		for (const path of ['Modern', 'Row']) {
			for (const preconditionLocks of [true, false]) {
				const id = `array-${path}-${preconditionLocks}`;
				await Row.put(id, { n: 1 });
				const response = await rest(resources, { preconditionLocks })('PUT', `/${path}/${id}`, [{ id, n: 2 }], {
					'if-match': '*',
				});
				assert.strictEqual(response.status, path === 'Row' ? 400 : 501, await bodyOf(response));
				assert.strictEqual((await Row.get(id)).n, 1);
			}
		}
	});

	it('allows array writes to an unrelated table within a conditional mutation', async () => {
		const Lines = table({
			table: 'ConditionLines',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		Lines.loadAsInstance = false;
		class WithLines extends Modern {
			async put(target, data) {
				await Lines.put(target.id, [{ id: target.id, n: 8 }]);
				return super.put(target, data);
			}
		}
		resources.set('WithLines', WithLines, { rest: true });
		for (const preconditionLocks of [true, false]) {
			for (const accepted of [false, true]) {
				const id = `lines-${accepted}-${preconditionLocks}`;
				await Row.put(id, { n: 1 });
				const etag = versionToEtag(Row.primaryStore.getEntry(id).version);
				const response = await rest(resources, { preconditionLocks })(
					'PUT',
					`/WithLines/${id}`,
					{ n: 2 },
					{ 'if-match': accepted ? etag : '"stale"' }
				);
				if (accepted) assert.ok(response.status < 300, await bodyOf(response));
				else assert.strictEqual(response.status, 412, await bodyOf(response));
				await Lines.put(`barrier-${id}`, { n: 0 });
				assert.strictEqual((await Row.get(id)).n, accepted ? 2 : 1);
				assert.strictEqual(Lines.primaryStore.getEntry(id)?.value?.n, accepted ? 8 : undefined);
			}
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

	it('binds conditions to normalized numeric primary keys, including conditional create at zero', async () => {
		const Numeric = table({
			table: 'HttpNumericConditions',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true, type: 'Int' }, { name: 'n' }],
		});
		resources.set('Numeric', Numeric, { rest: true });
		for (const id of [0, 42]) {
			await Numeric.put(id, { n: 1 });
			const response = await request(
				'PATCH',
				`/Numeric/${id}`,
				{ n: 2 },
				{ 'if-match': versionToEtag(Numeric.primaryStore.getEntry(id).version) }
			);
			assert.ok(response.status < 300, await bodyOf(response));
			assert.strictEqual((await Numeric.get(id)).n, 2);
		}
		await Numeric.delete(0);
		if (!isLMDB) {
			const attempts = await Promise.all(
				Array.from({ length: 8 }, (_, n) => request('PUT', '/Numeric/0', { n }, { 'if-none-match': '*' }))
			);
			assert.strictEqual(attempts.filter(({ status }) => status >= 200 && status < 300).length, 1);
			assert.strictEqual(attempts.filter(({ status }) => status === 412).length, 7);
		} else {
			assert.ok((await request('PUT', '/Numeric/0', { n: 1 }, { 'if-none-match': '*' })).status < 300);
			assert.strictEqual((await request('PUT', '/Numeric/0', { n: 2 }, { 'if-none-match': '*' })).status, 412);
		}
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
		class ThrownSuccess extends Row {
			patch() {
				throw new Response('ok', { status: 200 });
			}
		}
		resources.set('CustomStatic', CustomStatic, { rest: true });
		resources.set('Noop', Noop, { rest: true });
		resources.set('ThrownSuccess', ThrownSuccess, { rest: true });
		assert.strictEqual((await request('PUT', '/CustomStatic/read', { n: 2 }, { 'if-match': '*' })).status, 501);
		assert.strictEqual((await request('PATCH', '/Noop/read', { n: 2 }, { 'if-match': '*' })).status, 501);
		assert.strictEqual((await request('PATCH', '/ThrownSuccess/read', { n: 2 }, { 'if-match': '*' })).status, 501);
		assert.strictEqual((await Row.get('read')).n, 1);
	});

	it('fails closed for every non-error reply shape from a handler that skipped the condition', async () => {
		await Row.put('reply-shape', { n: 1 });
		await Row.put('reply-sibling', { n: 1 });
		const ids = ['reply-shape', 'reply-sibling'];
		const snapshot = () =>
			ids.map((id) => [
				Row.primaryStore.getEntry(id).version,
				[...Row.auditStore.getRange({ start: 1 })].filter(
					(entry) => entry.tableId === Row.tableId && entry.recordId === id
				).length,
			]);
		const before = snapshot();
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		let cancelled = 0;
		const streamingBody = (cancelError) =>
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('chunk'));
					controller.close();
				},
				cancel() {
					cancelled++;
					if (cancelError) throw cancelError;
				},
			});
		const cases = [
			['thrown plain status', 501, () => Promise.reject({ status: 200, message: 'ok' })],
			['thrown statusCode', 501, () => Promise.reject(Object.assign(new Error('accepted'), { statusCode: 202 }))],
			[
				'reply status then error',
				501,
				(resource) => {
					resource.getContext().response.status = 201;
					throw new Error('late failure');
				},
			],
			['thrown redirect', 501, () => Promise.reject(new Response(null, { status: 302 }))],
			['thrown streaming success', 501, () => Promise.reject(new Response(streamingBody(), { status: 200 }))],
			['returned streaming success', 501, () => new Response(streamingBody(), { status: 200 })],
			[
				'thrown success whose cancel fails',
				501,
				() => Promise.reject(new Response(streamingBody(new Error('cancel failed')), { status: 200 })),
			],
			[
				'success Response carrying an error statusCode',
				501,
				() => Promise.reject(Object.assign(new Response('ok', { status: 200 }), { statusCode: 503 })),
			],
			[
				'error Response carrying a success statusCode',
				403,
				() => Promise.reject(Object.assign(new Response('no', { status: 403 }), { statusCode: 202 })),
			],
			['thrown plain error', 500, () => Promise.reject(new Error('plain'))],
			[
				'sibling write then thrown success',
				501,
				async (resource) => {
					await Row.put('reply-sibling', { n: 2 }, resource.getContext());
					throw new Response('ok', { status: 200 });
				},
			],
			['thrown forbidden', 403, () => Promise.reject(new Response('no', { status: 403 }))],
			['thrown unavailable', 503, () => Promise.reject(new ClientError('busy', 503))],
		];
		for (const [name, expected, handler] of cases) {
			const className = `Reply${name.replace(/\W/g, '')}`;
			const Handler = {
				[className]: class extends Row {
					patch() {
						return handler(this);
					}
				},
			}[className];
			resources.set(className, Handler, { rest: true });
			const response = await request('PATCH', `/${className}/reply-shape`, { n: 2 }, { 'if-match': '*' });
			assert.strictEqual(response.status, expected, name);
		}
		await nextTurn();
		process.off('unhandledRejection', onUnhandled);
		assert.deepStrictEqual(unhandled, []);
		assert.strictEqual(cancelled, 3, 'a rejected streaming reply must be cancelled');
		assert.deepStrictEqual(
			snapshot(),
			before,
			'rejected replies, and their sibling writes, must leave no version or audit entry'
		);

		class Unconditional extends Row {
			patch() {
				throw new Response('ok', { status: 200 });
			}
		}
		resources.set('Unconditional', Unconditional, { rest: true });
		assert.strictEqual((await request('PATCH', '/Unconditional/reply-shape', { n: 2 })).status, 200);
		const optedOut = rest(resources, { preconditions: false });
		assert.strictEqual(
			(await optedOut('PATCH', '/Unconditional/reply-shape', { n: 2 }, { 'if-match': '*' })).status,
			200
		);
	});

	it('checks a multi-write operation against its original entry, including a no-op first write', async () => {
		class Replace extends Row {
			async put(data, target) {
				await super.delete(target);
				return super.put(data, target);
			}
		}
		class NoopThenPatch extends Row {
			async patch(data, target) {
				await super.patch({}, target);
				return super.patch(data, target);
			}
		}
		resources.set('Replace', Replace, { rest: true });
		resources.set('NoopThenPatch', NoopThenPatch, { rest: true });
		for (const preconditionLocks of [true, false]) {
			for (const [name, method] of [
				['Replace', 'PUT'],
				['NoopThenPatch', 'PATCH'],
			]) {
				const id = `${name}-${preconditionLocks}`;
				await Row.put(id, { n: 1 });
				const response = await rest(resources, { preconditionLocks })(
					method,
					`/${name}/${id}`,
					{ n: 2 },
					{ 'if-match': versionToEtag(Row.primaryStore.getEntry(id).version) }
				);
				assert.ok(response.status < 300, await bodyOf(response));
				assert.strictEqual((await Row.get(id)).n, 2);
			}
		}
	});

	it('rolls back sibling writes in optimistic and exclusive batches when a condition fails', async () => {
		for (const count of [1, 105]) {
			const Isolated = table({
				table: 'Rows',
				database: `conditionalAtomicity${count}`,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
			});
			class WithSibling extends Isolated {
				async patch(data, target) {
					for (let index = 0; index < count; index++) await Isolated.put(`sibling-${index}`, { n: 8 });
					return super.patch(data, target);
				}
			}
			resources.set(`WithSibling${count}`, WithSibling, { rest: true });
			await Isolated.put('target', { n: 1 });
			const response = await request('PATCH', `/WithSibling${count}/target`, { n: 2 }, { 'if-match': '"stale"' });
			assert.strictEqual(response.status, 412, await bodyOf(response));
			await Isolated.put('commit-barrier', { n: 0 });
			for (let index = 0; index < count; index++) assert.equal(await Isolated.get(`sibling-${index}`), null);
			assert.strictEqual((await Isolated.get('target')).n, 1);
		}
	});

	it('rejects composite read representations and permits explicit application handling', async () => {
		class Composite extends Row {
			async get(target) {
				await Row.get('read');
				return super.get(target);
			}
		}
		resources.set('Composite', Composite, { rest: true });
		const rejected = await request('PATCH', '/Composite/read', { n: 2 }, { 'if-match': '*' });
		assert.strictEqual(rejected.status, 501);
		assert.strictEqual((await Row.get('read')).n, 1);
		const own = rest(resources, { preconditions: false });
		const accepted = await own('PATCH', '/Composite/read', { n: 1 }, { 'if-match': 'application-validator' });
		assert.ok(accepted.status < 300, await bodyOf(accepted));
		assert.strictEqual((await own('GET', '/Row/read', undefined, { 'if-none-match': '*' })).status, 200);
	});

	it('short-circuits cached reads before serialization and closes their producer', async () => {
		let serialized = 0,
			closed = 0;
		class CountSerialization extends Resource {
			static get(_target, context) {
				context.lastModified = 42;
				return {
					toJSON() {
						serialized++;
						return { n: 1 };
					},
					onDone() {
						closed++;
					},
				};
			}
		}
		resources.set('CountSerialization', CountSerialization, { rest: true });
		const cached = await request('GET', '/CountSerialization/', undefined, { 'if-none-match': versionToEtag(42) });
		assert.strictEqual(cached.status, 304);
		assert.strictEqual(serialized, 0);
		assert.strictEqual(closed, 1);
		assert.ok(cached.headers.get('vary').includes('Accept'));
		await bodyOf(await request('GET', '/CountSerialization/'));
		assert.strictEqual(serialized, 1);
		await assert.rejects(
			request('GET', '/CountSerialization/', undefined, {
				'if-none-match': '*',
				'accept': 'application/x-unsupported',
			}),
			{ statusCode: 406 }
		);
		assert.strictEqual(serialized, 1);
		assert.strictEqual(closed, 2);
		const malformed = await request('GET', '/CountSerialization/', undefined, { 'if-match': 'invalid' });
		assert.strictEqual(malformed.status, 400, await bodyOf(malformed));
		assert.strictEqual(closed, 3);
		assert.strictEqual(serialized, 1);
	});

	it('settles deferred read authorization before returning a conditional stream response', async () => {
		const denied = () => ({
			[Symbol.asyncIterator]() {
				return this;
			},
			next() {
				return Promise.reject(new ClientError('deferred access denied', 403));
			},
		});
		class LazyRead extends Resource {
			static get(_target, context) {
				context.lastModified = 42;
				return denied();
			}
		}
		class LazyEnvelope extends Resource {
			static get() {
				return { headers: new Headers({ ETag: '"lazy"' }), data: denied() };
			}
		}
		resources.set('LazyRead', LazyRead, { rest: true });
		resources.set('LazyEnvelope', LazyEnvelope, { rest: true });
		for (const name of ['LazyRead', 'LazyEnvelope']) {
			const response = await request('GET', `/${name}/`, undefined, {
				'if-none-match': '*',
				'accept': 'application/x-ndjson',
			});
			assert.strictEqual(response.status, 403, await bodyOf(response));
		}
	});

	it('observes a rejected body promise discarded by a cached response', async () => {
		const failure = new Error('discarded conditional response failure');
		const unhandled = [];
		const onRejected = (error) => {
			if (error === failure) unhandled.push(error);
		};
		class PromisedBody extends Resource {
			static get() {
				return { headers: new Headers({ ETag: '"promised"' }), body: Promise.reject(failure) };
			}
		}
		resources.set('PromisedBody', PromisedBody, { rest: true });
		process.on('unhandledRejection', onRejected);
		try {
			const response = await request('GET', '/PromisedBody/', undefined, { 'if-none-match': '"promised"' });
			assert.strictEqual(response.status, 304);
			await nextTurn();
			assert.deepStrictEqual(unhandled, []);
		} finally {
			process.off('unhandledRejection', onRejected);
		}
	});

	it('copies immutable upstream headers for 304 responses', async () => {
		const upstream = await fetch('data:text/plain,upstream');
		assert.throws(() => upstream.headers.delete('content-type'), TypeError);
		class Upstream extends Resource {
			static get() {
				return upstream;
			}
		}
		resources.set('Upstream', Upstream, { rest: true });
		const response = await request('GET', '/Upstream/', undefined, { 'if-none-match': '*' });
		assert.strictEqual(response.status, 304, await bodyOf(response));
		assert.ok(upstream.headers.get('content-type'));
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
		const query = await request('QUERY', '/Row/', {}, { 'if-none-match': '*' });
		assert.strictEqual(query.status, 200, await bodyOf(query));
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

describe('conditional write durability', () => {
	it('leaves the stored record equal to the 204 winner after replayLogs when locks are enabled', async function () {
		if (isLMDB) this.skip();
		this.timeout(30000);
		const Row = table({
			database: 'conditionalReplayLocked',
			table: 'Row',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		const firstStaged = Promise.withResolvers();
		const releaseFirst = Promise.withResolvers();
		class Controlled extends Row {
			async patch(data, target) {
				await super.patch(data, target);
				if (data.n === 2) {
					firstStaged.resolve();
					await releaseFirst.promise;
				}
			}
		}
		const resources = new Resources();
		resources.set('Controlled', Controlled, { rest: true });
		const request = rest(resources);
		await Row.put('target', { n: 1 });
		const etag = versionToEtag(Row.primaryStore.getEntry('target').version);
		const first = request('PATCH', '/Controlled/target', { n: 2 }, { 'if-match': etag });
		await firstStaged.promise;
		const second = request('PATCH', '/Controlled/target', { n: 3 }, { 'if-match': etag });
		await nextTurn();
		releaseFirst.resolve();
		const [accepted, rejected] = await Promise.all([first, second]);
		assert.strictEqual(accepted.status, 204, await bodyOf(accepted));
		assert.strictEqual(rejected.status, 412, await bodyOf(rejected));
		assert.strictEqual((await Row.get('target')).n, 2);
		const { replayLogs } = require('#src/resources/replayLogs');
		await replayLogs(Row.primaryStore.rootStore, { Row }, true);
		assert.strictEqual((await Row.get('target')).n, 2, 'replay must preserve the locked 204 winner');
	});

	it('converges to the LWW winner after replayLogs when locks are disabled', async function () {
		if (isLMDB) this.skip();
		this.timeout(30000);
		const Row = table({
			database: 'conditionalReplayBestEffort',
			table: 'Row',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		const firstStaged = Promise.withResolvers();
		const secondStaged = Promise.withResolvers();
		const releaseFirst = Promise.withResolvers();
		const releaseSecond = Promise.withResolvers();
		class Controlled extends Row {
			async patch(data, target) {
				await super.patch(data, target);
				(data.n === 2 ? firstStaged : secondStaged).resolve();
				await (data.n === 2 ? releaseFirst : releaseSecond).promise;
			}
		}
		const resources = new Resources();
		resources.set('Controlled', Controlled, { rest: true });
		const request = rest(resources, { preconditionLocks: false });
		await Row.put('target', { n: 1 });
		const etag = versionToEtag(Row.primaryStore.getEntry('target').version);
		const first = request('PATCH', '/Controlled/target', { n: 2 }, { 'if-match': etag });
		await firstStaged.promise;
		const second = request('PATCH', '/Controlled/target', { n: 3 }, { 'if-match': etag });
		await secondStaged.promise;
		releaseFirst.resolve();
		const firstResponse = await first;
		releaseSecond.resolve();
		const secondResponse = await second;
		assert.strictEqual(firstResponse.status, 204, await bodyOf(firstResponse));
		assert.strictEqual(secondResponse.status, 204, await bodyOf(secondResponse));
		assert.strictEqual((await Row.get('target')).n, 3);
		const { replayLogs } = require('#src/resources/replayLogs');
		await replayLogs(Row.primaryStore.rootStore, { Row }, true);
		assert.strictEqual((await Row.get('target')).n, 3, 'replay must converge to the LWW winner');
	});

	it('commits a conditional write across a native commit conflict retry without re-evaluating the precondition', async function () {
		if (isLMDB) this.skip();
		const Row = table({
			database: 'conditionalReplayLocked',
			table: 'RetryOnceRow',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		await Row.put('target', { n: 1 });
		const etag = versionToEtag(Row.primaryStore.getEntry('target').version);
		let checks = 0;
		class RetryCounted extends Row {
			async patch(data, target) {
				const condition = this.getContext()[WRITE_CONDITION];
				const check = condition.check;
				condition.check = function (entry) {
					checks++;
					return check.call(this, entry);
				};
				return super.patch(data, target);
			}
		}
		const resources = new Resources();
		resources.set('RetryCounted', RetryCounted, { rest: true });
		const request = rest(resources);
		const { Transaction, constants } = require('@harperfast/rocksdb-js');
		const commit = Transaction.prototype.commit;
		const targetDb = Row.primaryStore.store.db;
		let commits = 0;
		Transaction.prototype.commit = function (...args) {
			if (this.store?.db !== targetDb || commits++) return commit.apply(this, args);
			return Promise.resolve(constants.RETRY_NOW_VALUE);
		};
		let response;
		try {
			response = await request('PATCH', '/RetryCounted/target', { n: 2 }, { 'if-match': etag });
		} finally {
			Transaction.prototype.commit = commit;
		}
		assert.strictEqual(response.status, 204, await bodyOf(response));
		assert.strictEqual(commits, 2, 'the forced conflict must retry the commit once');
		assert.strictEqual(checks, 1, 'precondition must be evaluated once before staging and never on retry');
		assert.strictEqual((await Row.get('target')).n, 2);
	});
});

describe('conditional write lock scope', () => {
	const NODE_NAME = 'precondition-lock-node';
	const DISABLED_MESSAGE = 'cluster record locks are not enabled on this node';
	let previousHostname;
	let Row;
	let request;
	let unlockedRequest;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		previousHostname = env.get(CONFIG_PARAMS.NODE_HOSTNAME);
		// The coordinator refuses a loopback identity, and a bare test box resolves to one.
		env.setProperty(CONFIG_PARAMS.NODE_HOSTNAME, NODE_NAME);
		clearThisNodeName();
		Row = table({
			database: 'conditionalLockScope',
			table: 'ScopeRow',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		const resources = new Resources();
		resources.set('ScopeRow', Row, { rest: true });
		request = rest(resources);
		unlockedRequest = rest(resources, { preconditionLocks: false });
	});
	afterEach(() => unregisterClusterLockTransport('conditionalLockScope', true));
	after(() => {
		env.setProperty(CONFIG_PARAMS.NODE_HOSTNAME, previousHostname);
		clearThisNodeName();
	});

	const etagOf = (id) => versionToEtag(Row.primaryStore.getEntry(id).version);
	const auditEntries = (id) =>
		[...Row.auditStore.getRange({ start: 1 })].filter((entry) => entry.tableId === Row.tableId && entry.recordId === id)
			.length;

	it('locks node-locally when no cluster transport is registered (core-only)', async function () {
		if (isLMDB) this.skip();
		await Row.put('local', { n: 1 });
		const response = await request('PATCH', '/ScopeRow/local', { n: 2 }, { 'if-match': etagOf('local') });
		assert.strictEqual(response.status, 204, await bodyOf(response));
		assert.strictEqual((await Row.get('local')).n, 2);
	});

	it('takes the cluster lock through a registered transport, because the lock uses the default scope', async function () {
		if (isLMDB) this.skip();
		await Row.put('clustered', { n: 1 });
		let homeMapCalls = 0;
		registerClusterLockTransport('conditionalLockScope', {
			coordinationIncarnation: () => 1,
			homeMap: () => {
				homeMapCalls++;
				return { generation: 1, homes: [getThisNodeName()], homeIncarnation: 1 };
			},
			grantableAfterMono: -Infinity,
			ownsCoordination: () => true,
			requestDelegation: () => Promise.reject(new Error('no peer transport')),
			recallDelegation: () => Promise.resolve(),
			establishLockFreshness: async (_database, _table, _key, dependencies) => dependencies ?? [],
		});
		const response = await request('PATCH', '/ScopeRow/clustered', { n: 2 }, { 'if-match': etagOf('clustered') });
		assert.strictEqual(response.status, 204, await bodyOf(response));
		assert.strictEqual((await Row.get('clustered')).n, 2);
		assert.ok(homeMapCalls > 0, 'the precondition lock must run the cluster round');
		const stale = await request('PATCH', '/ScopeRow/clustered', { n: 3 }, { 'if-match': versionToEtag(1) });
		assert.strictEqual(stale.status, 412, await bodyOf(stale));
	});

	it('fails with 503 and stages nothing when cluster record locks are unavailable, unless preconditionLocks is false', async function () {
		if (isLMDB) this.skip();
		await Row.put('unavailable', { n: 1 });
		const version = Row.primaryStore.getEntry('unavailable').version;
		const before = auditEntries('unavailable');
		// Mirrors harper-pro's createDisabledRecordLockTransport(), registered while replication.recordLocks is off.
		const disabled = () => Promise.reject(new ClientError(DISABLED_MESSAGE, 503));
		registerClusterLockTransport('conditionalLockScope', {
			homeMap() {
				throw new ClientError(DISABLED_MESSAGE, 503);
			},
			ownsCoordination: () => true,
			requestDelegation: disabled,
			recallDelegation: disabled,
			establishLockFreshness: disabled,
		});
		const rejected = await request('PATCH', '/ScopeRow/unavailable', { n: 2 }, { 'if-match': etagOf('unavailable') });
		const body = await bodyOf(rejected);
		assert.strictEqual(rejected.status, 503, body);
		assert.match(body, /not enabled on this node/);
		assert.strictEqual(Row.primaryStore.getEntry('unavailable').version, version);
		assert.strictEqual(auditEntries('unavailable'), before, 'a refused lock must stage no write');

		const optedOut = await unlockedRequest(
			'PATCH',
			'/ScopeRow/unavailable',
			{ n: 2 },
			{ 'if-match': etagOf('unavailable') }
		);
		assert.strictEqual(optedOut.status, 204, await bodyOf(optedOut));
		assert.strictEqual((await Row.get('unavailable')).n, 2);
	});
});
