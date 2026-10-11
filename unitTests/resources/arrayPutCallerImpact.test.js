// Caller impact of the built-in array PUT change: e13ff3e17 (harper#2097), first released in v5.3.0 and in
// no v5.2.x release. A `v5.2.15:` comment gives that release's result for a shape that differed; v5.3.0, v5.3.2
// and main agree on every shape.
// The change reaches only classes whose `loadAsInstance` is not `false`: static-mode classes, which include
// every `Resource.withSchema` and `defineResource` class, are unchanged in every shape.
// On LMDB, v5.2.15 also handed the request or context, as the target, to any element whose record read resolved
// asynchronously. Every instance-mode Table fan-out (REST, Table.put(array), Table.put(target, array),
// Table.put(null, array)) therefore intermittently answered 500 "Cannot encode a promise", sometimes after
// committing earlier elements, or resolved successfully having stored the context object as an element's record.
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { RequestTarget } = require('#src/resources/RequestTarget');
const Resources = require('#src/resources/Resources');
const { transaction } = require('#src/resources/transaction');
const { handleApplication: handleRest } = require('#src/server/REST');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
require('#src/server/serverHelpers/serverUtilities');

const superUser = { role: { permission: { super_user: true } } };

function collectionTarget() {
	const target = new RequestTarget();
	target.id = null;
	target.isCollection = true;
	return target;
}

function targetShape(target) {
	assert.ok(target instanceof RequestTarget, 'put() received a RequestTarget');
	return { id: target.id, isCollection: target.isCollection };
}

describe('Array PUT: caller impact', () => {
	let Docs;
	let StaticDocs;
	let restHttp;
	let pathCounter = 0;
	const mounted = [];

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
		Docs = table({
			table: 'ArrayPutCallerImpact',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'kind', indexed: true }, { name: 'label' }],
		});
		StaticDocs = class extends Docs {
			static loadAsInstance = false;
		};
		handleRest({
			resources: Resources.resources,
			options: { getAll: () => ({ webSocket: false }) },
			// REST dedupes mounts by route for the life of the process, so a repeated setup needs a fresh one
			routeFor: () => ({ host: undefined, urlPath: `/array-put-caller-impact-${randomUUID()}` }),
			server: { http: (listener) => (restHttp = listener), ws: () => [] },
		});
	});

	after(() => {
		for (const path of mounted) Resources.resources.delete(path);
	});

	function mount(ResourceClass) {
		const path = `ArrayPutCallerImpact${pathCounter++}`;
		Resources.resources.set(path, ResourceClass);
		mounted.push(path);
		return path;
	}

	async function restPut(url, body) {
		const json = Buffer.from(JSON.stringify(body));
		const headerObject = { 'content-type': 'application/json', 'content-length': String(json.length) };
		const response = await restHttp(
			{
				method: 'PUT',
				url,
				pathname: url.split('?')[0],
				ip: '127.0.0.1',
				user: superUser,
				headers: { asObject: headerObject, get: (name) => headerObject[name.toLowerCase()] },
				body: Readable.from([json]),
			},
			() => assert.fail(`no resource matched ${url}`)
		);
		const chunks = [];
		for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
		const text = Buffer.concat(chunks).toString();
		return { status: response.status, body: text ? JSON.parse(text) : undefined };
	}

	async function storedOf(kind) {
		const stored = [];
		for await (const record of Docs.search(new RequestTarget(`?kind=${kind}`), {})) stored.push({ ...record });
		return stored.sort((a, b) => (a.id < b.id ? -1 : 1));
	}

	describe('REST PUT /Class/ with a JSON array body', () => {
		// v5.2.15 matched on RocksDB; on LMDB see the header.
		it('instance-mode Table: writes every element and answers 200', async function () {
			const response = await restPut(`/${mount(Docs)}/`, [
				{ id: 'rest-a', kind: 'rest', label: 'one' },
				{ id: 'rest-b', kind: 'rest', label: 'two' },
				{ id: 'rest-c', kind: 'rest', label: 'three' },
			]);
			assert.strictEqual(response.status, 200);
			assert.deepStrictEqual(response.body, [null, null, null]);
			assert.deepStrictEqual(await storedOf('rest'), [
				{ id: 'rest-a', kind: 'rest', label: 'one' },
				{ id: 'rest-b', kind: 'rest', label: 'two' },
				{ id: 'rest-c', kind: 'rest', label: 'three' },
			]);
		});

		it('instance-mode Table with existing records: replaces each record', async function () {
			await Docs.put({ id: 'replace-a', kind: 'replace', label: 'old' });
			await Docs.put({ id: 'replace-b', kind: 'replace', label: 'old' });
			const response = await restPut(`/${mount(Docs)}/`, [
				{ id: 'replace-a', kind: 'replace' },
				{ id: 'replace-b', kind: 'replace', label: 'new' },
			]);
			assert.strictEqual(response.status, 200);
			assert.deepStrictEqual(await storedOf('replace'), [
				{ id: 'replace-a', kind: 'replace' },
				{ id: 'replace-b', kind: 'replace', label: 'new' },
			]);
		});

		// v5.2.15: the asynchronous branch passed the request as the target, so Table staged the request itself as
		// the element's record: 500 (RangeError on RocksDB, "Cannot encode a promise" on LMDB), nothing written.
		it('instance-mode Table whose getResource() is async: writes each element with its own data', async function () {
			class AsyncResolve extends Docs {
				static getResource(target, context, options) {
					return Promise.resolve(super.getResource(target, context, options));
				}
			}
			const response = await restPut(`/${mount(AsyncResolve)}/`, [
				{ id: 'async-a', kind: 'rest-async', label: 'one' },
				{ id: 'async-b', kind: 'rest-async', label: 'two' },
			]);
			assert.strictEqual(response.status, 200);
			assert.deepStrictEqual(await storedOf('rest-async'), [
				{ id: 'async-a', kind: 'rest-async', label: 'one' },
				{ id: 'async-b', kind: 'rest-async', label: 'two' },
			]);
		});

		it('static-mode Table: Table.put(target, array) writes every element', async function () {
			const response = await restPut(`/${mount(StaticDocs)}/`, [
				{ id: 'static-a', kind: 'rest-static' },
				{ id: 'static-b', kind: 'rest-static' },
			]);
			assert.strictEqual(response.status, 200);
			assert.deepStrictEqual(await storedOf('rest-static'), [
				{ id: 'static-a', kind: 'rest-static' },
				{ id: 'static-b', kind: 'rest-static' },
			]);
		});

		it('static-mode Table with a put(target, data) override: the override receives the whole array once', async function () {
			const calls = [];
			class StaticOverride extends StaticDocs {
				put(target, data) {
					calls.push({ target: targetShape(target), length: data.length });
					return super.put(target, data);
				}
			}
			const response = await restPut(`/${mount(StaticOverride)}/`, [
				{ id: 'static-override-a', kind: 'rest-static-override' },
				{ id: 'static-override-b', kind: 'rest-static-override' },
			]);
			assert.strictEqual(response.status, 200);
			assert.deepStrictEqual(calls, [{ target: { id: null, isCollection: true }, length: 2 }]);
			assert.strictEqual((await storedOf('rest-static-override')).length, 2);
		});

		// v5.2.15: each call's target was the request's collection target, `{ id: null, isCollection: true }`.
		it("instance-mode custom Resource with put(): called once per element with that element's target", async function () {
			const calls = [];
			class Custom extends Resource {
				put(data, target) {
					calls.push({ data, target: targetShape(target), flag: target.get('flag') });
					return { stored: data.id };
				}
			}
			const response = await restPut(`/${mount(Custom)}/?flag=1`, [{ id: 'custom-a' }, { id: 'custom-b' }]);
			assert.strictEqual(response.status, 200);
			assert.deepStrictEqual(response.body, [{ stored: 'custom-a' }, { stored: 'custom-b' }]);
			assert.deepStrictEqual(calls, [
				{ data: { id: 'custom-a' }, target: { id: undefined, isCollection: false }, flag: '1' },
				{ data: { id: 'custom-b' }, target: { id: undefined, isCollection: false }, flag: '1' },
			]);
		});

		it('instance-mode custom Resource with static primaryKey: each element target carries that id', async function () {
			const targets = [];
			class Keyed extends Resource {
				static primaryKey = 'id';
				put(data, target) {
					targets.push(targetShape(target));
					return { stored: data.id };
				}
			}
			const response = await restPut(`/${mount(Keyed)}/`, [{ id: 'keyed-a' }, { id: 'keyed-b' }]);
			assert.strictEqual(response.status, 200);
			assert.deepStrictEqual(targets, [
				{ id: 'keyed-a', isCollection: false },
				{ id: 'keyed-b', isCollection: false },
			]);
		});

		// v5.2.15: the override saw `target.isCollection === true` on every element call.
		it('instance-mode put() override that branches on target.isCollection: takes the single-record branch', async function () {
			class Branching extends Resource {
				put(data, target) {
					return target.isCollection ? 'collection branch' : 'record branch';
				}
			}
			const response = await restPut(`/${mount(Branching)}/`, [{ id: 'branch-a' }, { id: 'branch-b' }]);
			assert.strictEqual(response.status, 200);
			assert.deepStrictEqual(response.body, ['record branch', 'record branch']);
		});

		it('instance-mode put() override that only handles an array: 500 TypeError, as before', async function () {
			class ArrayOnly extends Resource {
				put(batch) {
					return batch.map((record) => record.id);
				}
			}
			const response = await restPut(`/${mount(ArrayOnly)}/`, [{ id: 'array-only-a' }]);
			assert.strictEqual(response.status, 500);
			assert.strictEqual(response.body.code, 'TypeError');
		});

		// v5.2.15: 500 TypeError "elementResource.put is not a function".
		it('instance-mode custom Resource without put(): 405', async function () {
			class GetOnly extends Resource {
				get() {
					return { ok: true };
				}
			}
			const response = await restPut(`/${mount(GetOnly)}/`, [{ id: 'no-put-a' }]);
			assert.strictEqual(response.status, 405);
			assert.match(response.body.title, /does not have a put method implemented/);
		});

		it('static-mode custom Resource with put(target, data): receives the whole array once', async function () {
			const calls = [];
			class StaticCustom extends Resource {
				static loadAsInstance = false;
				put(target, data) {
					calls.push({ target: targetShape(target), length: data.length });
					return { received: data.length };
				}
			}
			const response = await restPut(`/${mount(StaticCustom)}/`, [{ id: 'sc-a' }, { id: 'sc-b' }]);
			assert.strictEqual(response.status, 200);
			assert.deepStrictEqual(response.body, { received: 2 });
			assert.deepStrictEqual(calls, [{ target: { id: null, isCollection: true }, length: 2 }]);
		});

		it('static-mode custom Resource without put(): 405', async function () {
			class StaticGetOnly extends Resource {
				static loadAsInstance = false;
				get() {
					return { ok: true };
				}
			}
			const response = await restPut(`/${mount(StaticGetOnly)}/`, [{ id: 'static-no-put' }]);
			assert.strictEqual(response.status, 405);
		});

		it('Resource.withSchema class: static mode, so put(target, data) receives the whole array', async function () {
			const lengths = [];
			class Contracted extends Resource.withSchema({}) {
				put(target, data) {
					lengths.push(data.length);
					return { received: data.length };
				}
			}
			assert.strictEqual(Contracted.loadAsInstance, false);
			const response = await restPut(`/${mount(Contracted)}/`, [{ id: 'ws-a' }, { id: 'ws-b' }]);
			assert.strictEqual(response.status, 200);
			assert.deepStrictEqual(lengths, [2]);
		});

		it('static put() override: REST calls it directly with the target and the unresolved body', async function () {
			const calls = [];
			class StaticPut extends Resource {
				static async put(target, data) {
					calls.push({ target: targetShape(target), bodyIsPromise: typeof data?.then === 'function' });
					return { received: (await data).length };
				}
			}
			const response = await restPut(`/${mount(StaticPut)}/`, [{ id: 'sp-a' }, { id: 'sp-b' }]);
			assert.strictEqual(response.status, 200);
			assert.deepStrictEqual(response.body, { received: 2 });
			assert.deepStrictEqual(calls, [{ target: { id: null, isCollection: true }, bodyIsPromise: true }]);
		});

		it('no trailing slash: 400 Invalid primary key of null, nothing written', async function () {
			const response = await restPut(`/${mount(Docs)}`, [{ id: 'no-slash-a', kind: 'no-slash' }]);
			assert.strictEqual(response.status, 400);
			assert.strictEqual(response.body.title, 'Invalid primary key of null');
			assert.deepStrictEqual(await storedOf('no-slash'), []);
		});

		it('empty array: 200 with an empty result', async function () {
			const response = await restPut(`/${mount(Docs)}/`, []);
			assert.strictEqual(response.status, 200);
			assert.deepStrictEqual(response.body, []);
		});

		it('one allowCreate verdict for the batch, none per element', async function () {
			const calls = [];
			class Counting extends Docs {
				allowCreate() {
					calls.push('allowCreate');
					return true;
				}
				allowUpdate() {
					calls.push('allowUpdate');
					return true;
				}
			}
			const response = await restPut(`/${mount(Counting)}/`, [
				{ id: 'allow-a', kind: 'allow' },
				{ id: 'allow-b', kind: 'allow' },
			]);
			assert.strictEqual(response.status, 200);
			assert.deepStrictEqual(calls, ['allowCreate']);
		});
	});

	describe('in-process Table.put() argument forms (instance mode)', () => {
		it('Table.put(array): writes every element', async function () {
			assert.deepStrictEqual(
				await Docs.put([
					{ id: 'one-arg-a', kind: 'one-arg' },
					{ id: 'one-arg-b', kind: 'one-arg' },
				]),
				[undefined, undefined]
			);
			assert.strictEqual((await storedOf('one-arg')).length, 2);
		});

		// v5.2.15: ClientError 400 "Invalid primary key of null", nothing written (harper#2000).
		it('Table.put(array, context): writes every element', async function () {
			await Docs.put(
				[
					{ id: 'with-context-a', kind: 'with-context' },
					{ id: 'with-context-b', kind: 'with-context' },
				],
				{}
			);
			assert.deepStrictEqual(await storedOf('with-context'), [
				{ id: 'with-context-a', kind: 'with-context' },
				{ id: 'with-context-b', kind: 'with-context' },
			]);
		});

		// v5.2.15: ClientError 400 "Invalid primary key of null", nothing written.
		it('Table.put(array, transaction) inside transaction(): writes every element', async function () {
			await transaction({}, (txn) =>
				Docs.put(
					[
						{ id: 'with-txn-a', kind: 'with-txn' },
						{ id: 'with-txn-b', kind: 'with-txn' },
					],
					txn
				)
			);
			assert.strictEqual((await storedOf('with-txn')).length, 2);
		});

		it('Table.put(collectionTarget, array) and Table.put(new RequestTarget("/"), array): write every element', async function () {
			await Docs.put(collectionTarget(), [{ id: 'target-a', kind: 'target' }]);
			await Docs.put(new RequestTarget('/'), [{ id: 'target-b', kind: 'target' }], {});
			assert.deepStrictEqual(
				(await storedOf('target')).map((record) => record.id),
				['target-a', 'target-b']
			);
		});

		it('Table.put(null, array): writes every element', async function () {
			await Docs.put(null, [{ id: 'null-id-a', kind: 'null-id' }]);
			await Docs.put(null, [{ id: 'null-id-b', kind: 'null-id' }], {});
			assert.strictEqual((await storedOf('null-id')).length, 2);
		});

		it('Table.put(new RequestTarget(), array): not a collection target, 400', async function () {
			await assert.rejects(async () => Docs.put(new RequestTarget(), [{ id: 'bare-target', kind: 'bare-target' }]), {
				statusCode: 400,
				message: 'Invalid primary key type: undefined',
			});
			assert.deepStrictEqual(await storedOf('bare-target'), []);
		});

		// Array PUT never generates ids, in either version. v5.2.15's (array, context) form failed earlier, with
		// "Invalid primary key of null".
		it('records without ids: 400 Invalid primary key type: undefined, nothing written', async function () {
			for (const attempt of [
				() => Docs.put([{ kind: 'no-id' }, { kind: 'no-id' }]),
				() => Docs.put([{ kind: 'no-id' }, { kind: 'no-id' }], {}),
				() => StaticDocs.put([{ kind: 'no-id' }], {}),
			])
				await assert.rejects(async () => attempt(), {
					statusCode: 400,
					message: 'Invalid primary key type: undefined',
				});
			const response = await restPut(`/${mount(Docs)}/`, [{ id: 'no-id-a', kind: 'no-id' }, { kind: 'no-id' }]);
			assert.strictEqual(response.status, 400);
			assert.deepStrictEqual(await storedOf('no-id'), []);
		});

		it('static-mode Table: Table.put(array) and Table.put(array, context) write every element', async function () {
			await StaticDocs.put([{ id: 'static-inproc-a', kind: 'static-inproc' }]);
			await StaticDocs.put([{ id: 'static-inproc-b', kind: 'static-inproc' }], {});
			assert.strictEqual((await storedOf('static-inproc')).length, 2);
		});
	});

	describe('instance put() override on a Table subclass', () => {
		// v5.2.15: over REST and for Table.put(array) each call got the request's collection target; for
		// Table.put(array, context) the override got the whole array once, with a `{ id: null }` target, and
		// delegating it to super.put() failed 400 "Invalid primary key of null".
		it("is called once per element with that element's target, in every call form", async function () {
			const calls = [];
			class Watching extends Docs {
				put(data, target) {
					calls.push({ id: data.id, target: targetShape(target) });
					return super.put(data, target);
				}
			}
			await restPut(`/${mount(Watching)}/`, [{ id: 'watch-rest', kind: 'watch' }]);
			await Watching.put([{ id: 'watch-array', kind: 'watch' }]);
			await Watching.put([{ id: 'watch-context', kind: 'watch' }], {});
			await Watching.put(collectionTarget(), [{ id: 'watch-target', kind: 'watch' }]);
			assert.deepStrictEqual(calls, [
				{ id: 'watch-rest', target: { id: 'watch-rest', isCollection: false } },
				{ id: 'watch-array', target: { id: 'watch-array', isCollection: false } },
				{ id: 'watch-context', target: { id: 'watch-context', isCollection: false } },
				{ id: 'watch-target', target: { id: 'watch-target', isCollection: false } },
			]);
			assert.strictEqual((await storedOf('watch')).length, 4);
		});

		// v5.2.15: Table.put(array, context) handed this override the whole array once; it wrote both records
		// through its array branch.
		it('an override with its own array branch now only ever takes the single-record branch', async function () {
			const received = [];
			class Bulk extends Docs {
				put(data, target) {
					received.push(Array.isArray(data) ? 'array' : 'record');
					if (Array.isArray(data)) return Promise.all(data.map((element) => Docs.put(element)));
					return super.put(data, target);
				}
			}
			await Bulk.put(
				[
					{ id: 'bulk-a', kind: 'bulk' },
					{ id: 'bulk-b', kind: 'bulk' },
				],
				{}
			);
			assert.deepStrictEqual(received, ['record', 'record']);
			assert.strictEqual((await storedOf('bulk')).length, 2);
		});
	});

	describe('custom Resource (not a table), in-process', () => {
		// v5.2.15: put() was called once with the whole array and `{ id: null }`, and Resource.put resolved to its
		// return value, `{ bulk: 2 }`.
		it('instance put(): Resource.put(array, context) dispatches once per element', async function () {
			const calls = [];
			class Custom extends Resource {
				put(data, target) {
					calls.push({ data, target: targetShape(target) });
					return Array.isArray(data) ? { bulk: data.length } : { single: data.id };
				}
			}
			const result = await Custom.put([{ id: 'k-a' }, { id: 'k-b' }], {});
			assert.deepStrictEqual(result, [{ single: 'k-a' }, { single: 'k-b' }]);
			assert.deepStrictEqual(calls, [
				{ data: { id: 'k-a' }, target: { id: undefined, isCollection: false } },
				{ data: { id: 'k-b' }, target: { id: undefined, isCollection: false } },
			]);
		});

		// v5.2.15: resolved ['k-a', 'k-b']. Breaks only through the (array, context) form; over REST and through
		// Resource.put(array) this override already threw.
		it('instance put() that only handles an array: Resource.put(array, context) now throws', async function () {
			class ArrayOnly extends Resource {
				put(batch) {
					return batch.map((record) => record.id);
				}
			}
			await assert.rejects(async () => ArrayOnly.put([{ id: 'k-a' }, { id: 'k-b' }], {}), TypeError);
		});

		// v5.2.15: per element too, but each target was `{ id: undefined, isCollection: true }`.
		it('instance put(): Resource.put(array) dispatches once per element', async function () {
			const targets = [];
			class Custom extends Resource {
				put(data, target) {
					targets.push(targetShape(target));
					return data.id;
				}
			}
			assert.deepStrictEqual(await Custom.put([{ id: 'k-a' }, { id: 'k-b' }]), ['k-a', 'k-b']);
			assert.deepStrictEqual(targets, [
				{ id: undefined, isCollection: false },
				{ id: undefined, isCollection: false },
			]);
		});

		// v5.2.15: Resource.put(array) threw a bare TypeError "elementResource.put is not a function";
		// Resource.put(array, context) already answered 405.
		it('no put(): Resource.put(array) and Resource.put(array, context) answer 405', async function () {
			class GetOnly extends Resource {
				get() {
					return { ok: true };
				}
			}
			await assert.rejects(async () => GetOnly.put([{ id: 'k-a' }]), { statusCode: 405 });
			await assert.rejects(async () => GetOnly.put([{ id: 'k-a' }], {}), { statusCode: 405 });
		});

		it('static-mode put(target, data): receives the whole array once, in both call forms', async function () {
			const calls = [];
			class StaticCustom extends Resource {
				static loadAsInstance = false;
				put(target, data) {
					calls.push({ target: targetShape(target), length: data.length });
					return { received: data.length };
				}
			}
			assert.deepStrictEqual(await StaticCustom.put([{ id: 'k-a' }, { id: 'k-b' }], {}), { received: 2 });
			assert.deepStrictEqual(await StaticCustom.put([{ id: 'k-a' }]), { received: 1 });
			assert.deepStrictEqual(calls, [
				{ target: { id: null, isCollection: true }, length: 2 },
				{ target: { id: undefined, isCollection: true }, length: 1 },
			]);
		});

		it('static put() override: called directly with the arguments as given', async function () {
			const calls = [];
			class StaticPut extends Resource {
				static put(...args) {
					calls.push(args.length);
					return Array.isArray(args[0]) ? { received: args[0].length } : 'not an array';
				}
			}
			assert.deepStrictEqual(await StaticPut.put([{ id: 'k-a' }, { id: 'k-b' }], {}), { received: 2 });
			assert.deepStrictEqual(calls, [2]);
		});
	});

	describe('malformed elements', () => {
		// v5.2.15: 500 TypeError "Cannot read properties of null (reading 'id')"; nothing written either way.
		it('instance-mode Table, null element: 400 naming the index, nothing written', async function () {
			const response = await restPut(`/${mount(Docs)}/`, [{ id: 'null-element-a', kind: 'null-element' }, null]);
			assert.strictEqual(response.status, 400);
			assert.strictEqual(response.body.title, 'Array element at index 1 is null, expected a record');
			assert.deepStrictEqual(await storedOf('null-element'), []);
		});

		// v5.2.15: also 400, with "Invalid primary key type: undefined".
		it('instance-mode Table, primitive element: 400 naming the index', async function () {
			const response = await restPut(`/${mount(Docs)}/`, [{ id: 'primitive-a', kind: 'primitive' }, 42]);
			assert.strictEqual(response.status, 400);
			assert.strictEqual(response.body.title, 'Array element at index 1 is number, expected a record');
			assert.deepStrictEqual(await storedOf('primitive'), []);
		});

		// v5.2.15: 200, and put() was handed 42.
		it('instance-mode custom Resource, primitive element: 400 and put() is never called', async function () {
			let calls = 0;
			class Custom extends Resource {
				put(data) {
					calls++;
					return data;
				}
			}
			const response = await restPut(`/${mount(Custom)}/`, [{ id: 'k-a' }, 42]);
			assert.strictEqual(response.status, 400);
			assert.strictEqual(calls, 0);
		});

		// A known gap, not the contract: the pre-dispatch element guard is instance-mode only, so this still breaks the
		// malformed-body rule in resources/DESIGN.md. Same on v5.2.15.
		it('static-mode Table, null element: still a 500 TypeError (known gap), nothing written', async function () {
			const response = await restPut(`/${mount(StaticDocs)}/`, [{ id: 'static-null-a', kind: 'static-null' }, null]);
			assert.strictEqual(response.status, 500);
			assert.strictEqual(response.body.code, 'TypeError');
			assert.deepStrictEqual(await storedOf('static-null'), []);
		});
	});

	describe('failure and atomicity', () => {
		function rejectingFor(failures) {
			return class Rejecting extends Docs {
				put(data, target) {
					const failure = failures[data.id];
					if (failure)
						return new Promise((_, reject) => setTimeout(() => reject(new Error(failure.message)), failure.delay));
					return super.put(data, target);
				}
			};
		}

		it('an element that rejects mid-array: the batch fails and no element is written, as before', async function () {
			const Rejecting = rejectingFor({ 'mid-b': { message: 'element b failed', delay: 20 } });
			const response = await restPut(`/${mount(Rejecting)}/`, [
				{ id: 'mid-a', kind: 'mid' },
				{ id: 'mid-b', kind: 'mid' },
				{ id: 'mid-c', kind: 'mid' },
			]);
			assert.strictEqual(response.status, 500);
			assert.strictEqual(response.body.title, 'element b failed');
			assert.deepStrictEqual(await storedOf('mid'), []);
		});

		// v5.2.15 (Promise.all): the first failure in time, "index 1 failed first".
		it('several elements fail: the earliest index is reported, not the first in time', async function () {
			let laterIndexRejected;
			// bounded, so a regression that never dispatches index 1 fails here instead of hanging (mocha timeout is 0)
			const afterLaterIndex = new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('index 1 was never dispatched')), 5000);
				laterIndexRejected = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			class Rejecting extends Docs {
				put(data, target) {
					// index 0 rejects only once index 1 has, whatever order their resources resolved in
					if (data.id === 'two-a') return afterLaterIndex.then(() => Promise.reject(new Error('index 0 failed last')));
					if (data.id === 'two-b') {
						setImmediate(laterIndexRejected);
						return Promise.reject(new Error('index 1 failed first'));
					}
					return super.put(data, target);
				}
			}
			await assert.rejects(
				async () =>
					Rejecting.put(collectionTarget(), [
						{ id: 'two-a', kind: 'two' },
						{ id: 'two-b', kind: 'two' },
						{ id: 'two-c', kind: 'two' },
					]),
				{ message: 'index 0 failed last' }
			);
			assert.deepStrictEqual(await storedOf('two'), []);
		});

		// v5.2.15: the batch reported the later element's synchronous 400, and the earlier rejection was
		// abandoned as an unhandled rejection.
		it('a synchronous failure while an earlier element is still pending: earliest index, no unhandled rejection', async function () {
			const unhandled = [];
			const listener = (reason) => unhandled.push(reason);
			process.on('unhandledRejection', listener);
			try {
				const Rejecting = rejectingFor({ 'sync-a': { message: 'element a failed', delay: 0 } });
				await assert.rejects(
					async () => Rejecting.put(collectionTarget(), [{ id: 'sync-a', kind: 'sync' }, { kind: 'sync' }]),
					{
						message: 'element a failed',
					}
				);
				for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
				await new Promise((resolve) => setTimeout(resolve, 50));
			} finally {
				process.off('unhandledRejection', listener);
			}
			assert.deepStrictEqual(unhandled, []);
			assert.deepStrictEqual(await storedOf('sync'), []);
		});

		it('static-mode Table, an element the store rejects: nothing written, as before', async function () {
			await assert.rejects(async () =>
				StaticDocs.put(
					[
						{ id: 'static-fail-a', kind: 'static-fail' },
						{ id: { nested: true }, kind: 'static-fail' },
					],
					{}
				)
			);
			assert.deepStrictEqual(await storedOf('static-fail'), []);
		});
	});

	describe('single-record PUT whose body is an array', () => {
		it('REST PUT /Table/id with an array body: 400, as before', async function () {
			const response = await restPut(`/${mount(Docs)}/array-body`, [{ id: 'x', kind: 'array-body' }, 'b']);
			assert.strictEqual(response.status, 400);
			assert.match(response.body.title, /^A record must be an object/);
			assert.ok((await Docs.get('array-body')) == null);
		});

		it('Table.put(id, array): 400, as before', async function () {
			await assert.rejects(async () => Docs.put('array-value', [{ id: 'x' }]), {
				statusCode: 400,
				message: /^A record must be an object/,
			});
		});
	});
});
