const assert = require('node:assert');
const { createServer } = require('node:http');
const { setupTestDBPath } = require('../testUtils.js');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { Resources } = require('#src/resources/Resources');
const { handleApplication } = require('#src/server/REST');
const { Request } = require('#src/server/serverHelpers/Request');
const { getWorkerIndex, setMainIsWorker } = require('#src/server/threads/manageThreads');
require('#src/server/serverHelpers/serverUtilities');

function indexedKeys(Table, id) {
	return Array.from(Table.indices.a.getRange({ start: null }))
		.filter((entry) => entry.value === id)
		.map((entry) => entry.key);
}

async function nullIds(Table) {
	const ids = [];
	for await (const row of Table.search({ conditions: [{ attribute: 'a', comparator: 'equals', value: null }] }))
		ids.push(row.id);
	return ids.sort();
}

describe('null indexes over tombstones', function () {
	this.timeout(15000);
	let Plain, server, base, previousMainIsWorker;
	const caches = [];

	before(async () => {
		setupTestDBPath();
		previousMainIsWorker = getWorkerIndex() === 0;
		setMainIsWorker(true);
		function makeTable(name, audit) {
			return table({
				database: 'index_null_tombstone',
				table: name,
				audit,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'a', indexed: true, indexNulls: true },
				],
			});
		}
		Plain = makeTable('Plain', true);
		const resources = new Resources();
		for (const audit of [true, false]) {
			const name = audit ? 'AuditedCache' : 'UnauditedCache';
			const Cache = makeTable(name, audit);
			const calls = [];
			const origin = { available: true };
			const source = {
				get(id) {
					calls.push(id);
					if (!origin.available) return undefined;
					return { id, a: null };
				},
			};
			Cache.sourcedFrom(
				audit
					? source
					: class extends Resource {
							get() {
								return source.get(this.getId());
							}
							delete() {
								origin.available = false;
							}
						}
			);
			resources.set(`null-tombstone/${name}`, Cache);
			caches.push({ Cache, name, calls, origin });
		}
		let rest;
		handleApplication({
			resources,
			options: { getAll: () => ({ webSocket: false }) },
			routeFor: () => ({ urlPath: '/null-tombstone' }),
			server: { http: (handler) => (rest = handler), ws: () => [] },
		});
		server = createServer(async (input, output) => {
			try {
				const request = new Request(input, output);
				request.user = { role: { permission: { super_user: true } } };
				const response = await rest(request, () => assert.fail(`no route for ${input.url}`));
				output.writeHead(response.status, Object.fromEntries(response.headers));
				if (typeof response.body === 'string' || Buffer.isBuffer(response.body)) output.end(response.body);
				else {
					for await (const chunk of response.body || []) output.write(chunk);
					output.end();
				}
			} catch (error) {
				output.writeHead(error.statusCode || 500);
				output.end(error.message);
			}
		});
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${server.address().port}/null-tombstone`;
	});

	after(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (previousMainIsWorker !== undefined) setMainIsWorker(previousMainIsWorker);
	});

	it('re-inserting an explicit null indexes it after deleting the same value', async () => {
		await Plain.put({ id: 'restored', a: null });
		assert.deepStrictEqual(indexedKeys(Plain, 'restored'), [null]);
		await Plain.delete('restored');
		assert.strictEqual(Plain.primaryStore.getEntry('restored').value, null, 'premise: a stored tombstone');
		assert.deepStrictEqual(indexedKeys(Plain, 'restored'), []);
		await Plain.put({ id: 'restored', a: null });
		assert.strictEqual((await Plain.get('restored')).a, null);
		assert.deepStrictEqual(indexedKeys(Plain, 'restored'), [null], 'the restored null must have an index entry');
		assert.deepStrictEqual(await nullIds(Plain), ['restored']);

		await Plain.delete('restored');
		await Plain.put({ id: 'restored' });
		assert.deepStrictEqual(indexedKeys(Plain, 'restored'), [], 'an omitted field has no null index entry');
		assert.deepStrictEqual(await nullIds(Plain), []);
	});

	it('re-inserting an array keeps both its null and non-null index entries', async () => {
		await Plain.put({ id: 'array', a: ['old'] });
		await Plain.delete('array');
		assert.strictEqual(Plain.primaryStore.getEntry('array').value, null);
		await Plain.put({ id: 'array', a: [null, 'x'] });
		assert.deepStrictEqual(indexedKeys(Plain, 'array'), [null, 'x']);
		assert.deepStrictEqual(await nullIds(Plain), ['array']);
	});

	for (const name of ['AuditedCache', 'UnauditedCache']) {
		it(`${name}: REST DELETE then GET reload restores the null index`, async () => {
			const { Cache, calls, origin } = caches.find((cache) => cache.name === name);
			async function request(path, method = 'GET') {
				const response = await fetch(`${base}/${name}/${path}`, { method });
				const text = await response.text();
				assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
				return text ? JSON.parse(text) : undefined;
			}
			assert.deepStrictEqual(await request('restored'), { id: 'restored', a: null });
			await waitFor(() => !Cache.primaryStore.hasLock('restored'));
			assert.deepStrictEqual(indexedKeys(Cache, 'restored'), [null]);
			await request('restored', 'DELETE');
			if (name === 'UnauditedCache') assert.strictEqual(origin.available, false, 'DELETE reached the Resource source');
			assert.strictEqual(Cache.primaryStore.getEntry('restored').value, null, 'premise: DELETE left a tombstone');
			assert.deepStrictEqual(indexedKeys(Cache, 'restored'), []);
			origin.available = true;
			assert.deepStrictEqual(await request('restored'), { id: 'restored', a: null });
			await waitFor(() => !Cache.primaryStore.hasLock('restored'));
			assert.deepStrictEqual(calls, ['restored', 'restored'], 'the GET after DELETE must reload from the source');
			assert.deepStrictEqual(await request('?a==null&select(id,)'), [{ id: 'restored' }]);
			assert.deepStrictEqual(await nullIds(Cache), ['restored']);
			assert.deepStrictEqual(indexedKeys(Cache, 'restored'), [null], 'the reloaded null must have an index entry');
		});
	}
});
