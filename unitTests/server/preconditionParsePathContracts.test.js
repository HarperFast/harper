const assert = require('node:assert');
const { Readable } = require('node:stream');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { Resources } = require('#src/resources/Resources');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { handleApplication } = require('#src/server/REST');
const { Headers } = require('#src/server/serverHelpers/Headers');
const { versionToEtag } = require('#src/server/serverHelpers/preconditions');
require('#src/server/serverHelpers/serverUtilities');

const admin = { tenant: 't1', role: { permission: { super_user: true } } };
let mount = 0;

function rest(resources, options = {}) {
	let handler;
	handleApplication({
		resources,
		options: { getAll: () => ({ webSocket: false, lastModified: true, ...options }) },
		routeFor: () => ({ urlPath: `/parsepath-conditions-${mount++}` }),
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

describe('write preconditions resolve the record id as parsePath does for the verb', () => {
	let BaseTable, IntTable, resources, request;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		BaseTable = table({
			table: 'PPBase',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }, { name: 'prev' }],
		});
		IntTable = table({
			table: 'PPInt',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true, type: 'Int' }, { name: 'n' }],
		});
		resources = new Resources();
		resources.set('BaseTable', BaseTable, { rest: true });
		resources.set('IntTable', IntTable, { rest: true });
		request = rest(resources);
	});

	describe('controls: tables, delegating verbs and 2-argument parsePath', () => {
		it('enforces If-Match and If-None-Match through a table, a delegating verb and a 2-argument parsePath, and leaves a verb that writes nothing unevaluated', async () => {
			class Delegating extends BaseTable {
				static put(target, data, context) {
					return super.put(target, data, context);
				}
			}
			class Tenanted2Arg extends BaseTable {
				static parsePath(path, context) {
					return `${context.user.tenant}:${path}`;
				}
				static put(target, data, context) {
					return super.put(target, data, context);
				}
			}
			class Ignored extends BaseTable {
				static put(_target, _data, _context) {
					return undefined;
				}
			}
			resources.set('Delegating', Delegating, { rest: true });
			resources.set('Tenanted2Arg', Tenanted2Arg, { rest: true });
			resources.set('Ignored', Ignored, { rest: true });

			// 1a. Standard Table
			await BaseTable.put('std', { n: 1 });
			const stdEtag = versionToEtag(BaseTable.primaryStore.getEntry('std').version);
			assert.strictEqual((await request('PUT', '/BaseTable/std', { n: 2 }, { 'if-match': '"999"' })).status, 412);
			assert.strictEqual((await request('PUT', '/BaseTable/std', { n: 2 }, { 'if-none-match': '*' })).status, 412);
			assert.strictEqual((await BaseTable.get('std')).n, 1);
			assert.strictEqual((await request('PUT', '/BaseTable/std', { n: 2 }, { 'if-match': stdEtag })).status, 204);
			assert.strictEqual((await BaseTable.get('std')).n, 2);

			// 1b. Delegating.put
			await BaseTable.put('del', { n: 1 });
			const delEtag = versionToEtag(BaseTable.primaryStore.getEntry('del').version);
			assert.strictEqual((await request('PUT', '/Delegating/del', { n: 2 }, { 'if-match': '"999"' })).status, 412);
			assert.strictEqual((await request('PUT', '/Delegating/del', { n: 2 }, { 'if-none-match': '*' })).status, 412);
			assert.strictEqual((await BaseTable.get('del')).n, 1);
			assert.strictEqual((await request('PUT', '/Delegating/del', { n: 2 }, { 'if-match': delEtag })).status, 204);
			assert.strictEqual((await BaseTable.get('del')).n, 2);

			// 1c. Tenanted2Arg.put (2-arg parsePath(path, context))
			await BaseTable.put('t1:item', { n: 1 });
			const tenEtag = versionToEtag(BaseTable.primaryStore.getEntry('t1:item').version);
			assert.strictEqual((await request('PUT', '/Tenanted2Arg/item', { n: 2 }, { 'if-match': '"999"' })).status, 412);
			assert.strictEqual((await request('PUT', '/Tenanted2Arg/item', { n: 2 }, { 'if-none-match': '*' })).status, 412);
			assert.strictEqual((await BaseTable.get('t1:item')).n, 1);
			assert.strictEqual((await request('PUT', '/Tenanted2Arg/item', { n: 2 }, { 'if-match': tenEtag })).status, 204);
			assert.strictEqual((await BaseTable.get('t1:item')).n, 2);

			// 1d. Ignored.put (own static verb that returns without writing)
			await BaseTable.put('ign', { n: 1 });
			assert.strictEqual((await request('PUT', '/Ignored/ign', { n: 2 }, { 'if-match': '"999"' })).status, 204);
			assert.strictEqual((await BaseTable.get('ign')).n, 1);
		});
	});

	describe('3-argument parsePath(path, context, query)', () => {
		it('enforces preconditions for a 3-argument parsePath on a class that keeps the table verbs', async () => {
			class QueryTenantStandard extends BaseTable {
				static parsePath(path, _context, query) {
					return `${query.get('tenant')}:${path}`;
				}
			}
			resources.set('QueryTenantStandard', QueryTenantStandard, { rest: true });

			await BaseTable.put('t1:std-q', { n: 1 });
			assert.strictEqual(
				(await request('PUT', '/QueryTenantStandard/std-q?tenant=t1', { n: 2 }, { 'if-match': '"999"' })).status,
				412
			);
			assert.strictEqual(
				(await request('PUT', '/QueryTenantStandard/std-q?tenant=t1', { n: 2 }, { 'if-none-match': '*' })).status,
				412
			);
			assert.strictEqual(
				(await request('PATCH', '/QueryTenantStandard/std-q?tenant=t1', { n: 2 }, { 'if-match': '"999"' })).status,
				412
			);
			assert.strictEqual(
				(await request('DELETE', '/QueryTenantStandard/std-q?tenant=t1', undefined, { 'if-match': '"999"' })).status,
				412
			);
			assert.strictEqual((await BaseTable.get('t1:std-q')).n, 1);
		});

		it('enforces preconditions when an own verb sits on a 3-argument parsePath that reads the query', async () => {
			class QueryTenantThrows extends BaseTable {
				static parsePath(path, _context, query) {
					return `${query.get('tenant')}:${path}`;
				}
				static put(target, data, context) {
					return super.put(target, data, context);
				}
				static patch(target, data, context) {
					return super.patch(target, data, context);
				}
				static delete(target, context) {
					return super.delete(target, context);
				}
			}
			resources.set('QueryTenantThrows', QueryTenantThrows, { rest: true });

			await BaseTable.put('t1:v2a', { n: 1 });
			const putStale = await request('PUT', '/QueryTenantThrows/v2a?tenant=t1', { n: 2 }, { 'if-match': '"999"' });
			const afterPutStale = (await BaseTable.get('t1:v2a'))?.n;

			await BaseTable.put('t1:v2a', { n: 1 });
			const putNoMatch = await request('PUT', '/QueryTenantThrows/v2a?tenant=t1', { n: 3 }, { 'if-none-match': '*' });
			const afterPutNoMatch = (await BaseTable.get('t1:v2a'))?.n;

			await BaseTable.put('t1:v2a', { n: 1 });
			const patchStale = await request('PATCH', '/QueryTenantThrows/v2a?tenant=t1', { n: 4 }, { 'if-match': '"999"' });
			const afterPatchStale = (await BaseTable.get('t1:v2a'))?.n;

			await BaseTable.put('t1:v2a', { n: 1 });
			const delStale = await request('DELETE', '/QueryTenantThrows/v2a?tenant=t1', undefined, { 'if-match': '"999"' });
			const afterDelStale = (await BaseTable.get('t1:v2a'))?.n ?? null;

			assert.deepStrictEqual(
				{
					putStale: { status: putStale.status, n: afterPutStale },
					putNoMatch: { status: putNoMatch.status, n: afterPutNoMatch },
					patchStale: { status: patchStale.status, n: afterPatchStale },
					delStale: { status: delStale.status, n: afterDelStale },
				},
				{
					putStale: { status: 412, n: 1 },
					putNoMatch: { status: 412, n: 1 },
					patchStale: { status: 412, n: 1 },
					delStale: { status: 412, n: 1 },
				}
			);
		});

		it('enforces preconditions when a 3-argument parsePath falls back to a default for a missing query', async () => {
			class QueryTenantDefault extends BaseTable {
				static parsePath(path, _context, query) {
					return `${query?.get?.('tenant') ?? 'default'}:${path}`;
				}
				static put(target, data, context) {
					return super.put(target, data, context);
				}
				static patch(target, data, context) {
					return super.patch(target, data, context);
				}
				static delete(target, context) {
					return super.delete(target, context);
				}
			}
			resources.set('QueryTenantDefault', QueryTenantDefault, { rest: true });

			await BaseTable.put('t1:v2b', { n: 1 });
			const putStale = await request('PUT', '/QueryTenantDefault/v2b?tenant=t1', { n: 2 }, { 'if-match': '"999"' });
			const afterPutStale = (await BaseTable.get('t1:v2b'))?.n;

			await BaseTable.put('t1:v2b', { n: 1 });
			const putNoMatch = await request('PUT', '/QueryTenantDefault/v2b?tenant=t1', { n: 3 }, { 'if-none-match': '*' });
			const afterPutNoMatch = (await BaseTable.get('t1:v2b'))?.n;

			await BaseTable.put('t1:v2b', { n: 1 });
			const patchStale = await request('PATCH', '/QueryTenantDefault/v2b?tenant=t1', { n: 4 }, { 'if-match': '"999"' });
			const afterPatchStale = (await BaseTable.get('t1:v2b'))?.n;

			await BaseTable.put('t1:v2b', { n: 1 });
			const delStale = await request('DELETE', '/QueryTenantDefault/v2b?tenant=t1', undefined, { 'if-match': '"999"' });
			const afterDelStale = (await BaseTable.get('t1:v2b'))?.n ?? null;

			assert.deepStrictEqual(
				{
					putStale: { status: putStale.status, n: afterPutStale },
					putNoMatch: { status: putNoMatch.status, n: afterPutNoMatch },
					patchStale: { status: patchStale.status, n: afterPatchStale },
					delStale: { status: delStale.status, n: afterDelStale },
				},
				{
					putStale: { status: 412, n: 1 },
					putNoMatch: { status: 412, n: 1 },
					patchStale: { status: 412, n: 1 },
					delStale: { status: 412, n: 1 },
				}
			);
		});
	});

	describe('numeric primary key 0', () => {
		it('resolves a parsePath result of 0 to the Int key instead of keeping the raw path', async () => {
			class ZeroAlias extends IntTable {
				static parsePath(path) {
					return path === 'root' ? 0 : Number(path);
				}
			}
			resources.set('ZeroAlias', ZeroAlias, { rest: true });

			await IntTable.put(0, { n: 100 });
			await IntTable.put(1, { n: 101 });
			await IntTable.delete('root');

			// Control: /ZeroAlias/1 resolves to id=1
			const get1 = await request('GET', '/ZeroAlias/1');
			assert.strictEqual(get1.status, 200);
			assert.strictEqual(JSON.parse(await bodyOf(get1)).n, 101);
			assert.strictEqual((await request('PUT', '/ZeroAlias/1', { n: 201 }, { 'if-match': '"999"' })).status, 412);

			// parsePath('root') is 0: the id must still be coerced and bound, not left as the raw path
			const getRoot = await request('GET', '/ZeroAlias/root');
			const putRootNoMatch = await request('PUT', '/ZeroAlias/root', { n: 200 }, { 'if-none-match': '*' });
			const rec0After = await IntTable.get(0);
			const recRootAfter = await IntTable.get('root');

			assert.deepStrictEqual(
				{
					getRootStatus: getRoot.status,
					getRootBody: getRoot.status === 200 ? JSON.parse(await bodyOf(getRoot)) : null,
					putRootNoMatchStatus: putRootNoMatch.status,
					rec0N: rec0After?.n,
					recRoot: recRootAfter ?? null,
				},
				{
					getRootStatus: 200,
					getRootBody: { id: 0, n: 100 },
					putRootNoMatchStatus: 412,
					rec0N: 100,
					recRoot: null,
				}
			);
		});

		it('enforces preconditions on key 0 for a verb that passes its own parsed id', async () => {
			class ZeroVerb extends IntTable {
				static parsePath(path) {
					return Number(path);
				}
				static put(target, data, context) {
					return super.put(Number(target.id), data, context);
				}
				static patch(target, data, context) {
					return super.patch(Number(target.id), data, context);
				}
				static delete(target, context) {
					return super.delete(Number(target.id), context);
				}
			}
			resources.set('ZeroVerb', ZeroVerb, { rest: true });

			await IntTable.put(0, { n: 10 });
			await IntTable.put(1, { n: 20 });

			// Control: record 1 enforces preconditions (412)
			assert.strictEqual((await request('PUT', '/ZeroVerb/1', { n: 21 }, { 'if-match': '"999"' })).status, 412);
			assert.strictEqual((await request('PUT', '/ZeroVerb/1', { n: 21 }, { 'if-none-match': '*' })).status, 412);
			assert.strictEqual((await request('PATCH', '/ZeroVerb/1', { n: 21 }, { 'if-match': '"999"' })).status, 412);
			assert.strictEqual((await request('DELETE', '/ZeroVerb/1', undefined, { 'if-match': '"999"' })).status, 412);
			assert.strictEqual((await IntTable.get(1)).n, 20);

			// Record 0 must be bound to the condition like any other key
			await IntTable.put(0, { n: 10 });
			const put0Stale = await request('PUT', '/ZeroVerb/0', { n: 99 }, { 'if-match': '"999"' });
			const afterPut0Stale = (await IntTable.get(0))?.n;

			await IntTable.put(0, { n: 10 });
			const put0NoMatch = await request('PUT', '/ZeroVerb/0', { n: 98 }, { 'if-none-match': '*' });
			const afterPut0NoMatch = (await IntTable.get(0))?.n;

			await IntTable.put(0, { n: 10 });
			const patch0Stale = await request('PATCH', '/ZeroVerb/0', { n: 97 }, { 'if-match': '"999"' });
			const afterPatch0Stale = (await IntTable.get(0))?.n;

			await IntTable.put(0, { n: 10 });
			const del0Stale = await request('DELETE', '/ZeroVerb/0', undefined, { 'if-match': '"999"' });
			const afterDel0Stale = (await IntTable.get(0))?.n ?? null;

			assert.deepStrictEqual(
				{
					put0Stale: { status: put0Stale.status, n: afterPut0Stale },
					put0NoMatch: { status: put0NoMatch.status, n: afterPut0NoMatch },
					patch0Stale: { status: patch0Stale.status, n: afterPatch0Stale },
					del0Stale: { status: del0Stale.status, n: afterDel0Stale },
				},
				{
					put0Stale: { status: 412, n: 10 },
					put0NoMatch: { status: 412, n: 10 },
					patch0Stale: { status: 412, n: 10 },
					del0Stale: { status: 412, n: 10 },
				}
			);
		});

		it('enforces preconditions on key 0 for a verb that passes the target on', async () => {
			class ZeroVerbTarget extends IntTable {
				static parsePath(path) {
					return Number(path);
				}
				static put(target, data, context) {
					return super.put(target, data, context);
				}
				static patch(target, data, context) {
					return super.patch(target, data, context);
				}
				static delete(target, context) {
					return super.delete(target, context);
				}
			}
			resources.set('ZeroVerbTarget', ZeroVerbTarget, { rest: true });

			await IntTable.put(0, { n: 10 });
			await IntTable.delete('0');

			const putRes = await request('PUT', '/ZeroVerbTarget/0', { n: 55 }, { 'if-match': '"999"' });
			const recNum0 = await IntTable.get(0);
			const recStr0 = (await IntTable.get('0')) ?? null;

			assert.deepStrictEqual(
				{
					putStatus: putRes.status,
					recNum0: recNum0 ? { id: recNum0.id, n: recNum0.n } : null,
					recStr0: recStr0 ? { id: recStr0.id, n: recStr0.n } : null,
				},
				{
					putStatus: 412,
					recNum0: { id: 0, n: 10 },
					recStr0: null,
				}
			);
		});
	});

	describe('what the record id parse may do to the request', () => {
		const stale = { 'if-match': '"999"' };

		it('accepts the current validator through a 3-argument parsePath on an own verb', async () => {
			class QueryTenantAccepts extends BaseTable {
				static parsePath(path, _context, query) {
					return `${query.get('tenant')}:${path}`;
				}
				static put(target, data, context) {
					return super.put(target, data, context);
				}
			}
			resources.set('QueryTenantAccepts', QueryTenantAccepts, { rest: true });

			await BaseTable.put('t1:ok', { n: 1 });
			const etag = versionToEtag(BaseTable.primaryStore.getEntry('t1:ok').version);
			assert.strictEqual(
				(await request('PUT', '/QueryTenantAccepts/ok?tenant=t1', { n: 2 }, { 'if-match': etag })).status,
				204
			);
			assert.strictEqual((await BaseTable.get('t1:ok')).n, 2);
			assert.strictEqual((await BaseTable.get('ok')) ?? null, null);
		});

		it('writes the verb to the record its parsePath names when parsePath also assigns query.id', async () => {
			class IdAssigning extends BaseTable {
				static parsePath(path, _context, query) {
					const id = `t:${path}`;
					if (query) query.id = id;
					return id;
				}
				static put(target, data, context) {
					return super.put(target, data, context);
				}
			}
			resources.set('IdAssigning', IdAssigning, { rest: true });

			await BaseTable.put('t:assigned', { n: 1 });
			assert.strictEqual((await request('PUT', '/IdAssigning/assigned', { n: 2 }, stale)).status, 412);
			assert.strictEqual((await BaseTable.get('t:assigned')).n, 1);
			assert.strictEqual((await BaseTable.get('t:t:assigned')) ?? null, null);

			const etag = versionToEtag(BaseTable.primaryStore.getEntry('t:assigned').version);
			assert.strictEqual((await request('PUT', '/IdAssigning/assigned', { n: 3 }, { 'if-match': etag })).status, 204);
			assert.strictEqual((await BaseTable.get('t:assigned')).n, 3);
			assert.strictEqual((await BaseTable.get('t:t:assigned')) ?? null, null);
		});

		it('leaves the verb a target with its raw id when the first parse mutates the target and throws', async () => {
			let calls = 0;
			class MutatesThenThrows extends BaseTable {
				static parsePath(path, _context, query) {
					if (query) query.id = 'mutated';
					if (calls++ === 0) throw new Error('first parse fails');
					return `t:${path}`;
				}
				static put(target, data, context) {
					return super.put(target, data, context);
				}
			}
			resources.set('MutatesThenThrows', MutatesThenThrows, { rest: true });

			await BaseTable.put('t:thrown', { n: 1 });
			assert.strictEqual((await request('PUT', '/MutatesThenThrows/thrown', { n: 2 }, stale)).status, 204);
			assert.strictEqual((await BaseTable.get('t:thrown')).n, 2);
			assert.strictEqual((await BaseTable.get('t:mutated')) ?? null, null);
		});

		it('unwraps a structured { id } parse result like the verb does, including key 0', async () => {
			class ZeroStructured extends IntTable {
				static parsePath(path) {
					return { id: Number(path) };
				}
				static put(target, data, context) {
					return super.put(target, data, context);
				}
			}
			resources.set('ZeroStructured', ZeroStructured, { rest: true });

			await IntTable.put(0, { n: 10 });
			await IntTable.delete('0');
			await IntTable.put(0, { n: 10 });
			assert.strictEqual((await request('PUT', '/ZeroStructured/0', { n: 99 }, stale)).status, 412);
			assert.strictEqual((await IntTable.get(0)).n, 10);
			assert.strictEqual((await IntTable.get('0')) ?? null, null);

			const etag = versionToEtag(IntTable.primaryStore.getEntry(0).version);
			assert.strictEqual((await request('PUT', '/ZeroStructured/0', { n: 11 }, { 'if-match': etag })).status, 204);
			assert.strictEqual((await IntTable.get(0)).n, 11);
			assert.strictEqual((await IntTable.get('0')) ?? null, null);
		});

		it('resolves a `.json` content-type suffix to the record for an own verb', async () => {
			class JsonSuffix extends BaseTable {
				static put(target, data, context) {
					return super.put(target, data, context);
				}
			}
			resources.set('JsonSuffix', JsonSuffix, { rest: true });

			await BaseTable.put('suffixed', { n: 1 });
			assert.strictEqual((await request('PUT', '/JsonSuffix/suffixed.json', { n: 2 }, stale)).status, 412);
			assert.strictEqual((await BaseTable.get('suffixed')).n, 1);
			const etag = versionToEtag(BaseTable.primaryStore.getEntry('suffixed').version);
			assert.strictEqual(
				(await request('PUT', '/JsonSuffix/suffixed.json', { n: 3 }, { 'if-match': etag })).status,
				204
			);
			assert.strictEqual((await BaseTable.get('suffixed')).n, 3);
		});
	});

	describe('chained super.get(target) then super.put(target)', () => {
		it.skip('keeps the parsed id when a verb reads then writes the same target (open design question: parse-once marker, see the PR)', async () => {
			class ChainedTenanted extends BaseTable {
				static parsePath(path, context) {
					return `${context.user.tenant}:${path}`;
				}
				static async put(target, data, context) {
					const existing = await super.get(target, context);
					return super.put(target, { ...data, prev: existing?.n ?? null }, context);
				}
				static async patch(target, data, context) {
					const existing = await super.get(target, context);
					return super.patch(target, { ...data, prev: existing?.n ?? null }, context);
				}
				static async delete(target, context) {
					await super.get(target, context);
					return super.delete(target, context);
				}
			}
			resources.set('ChainedTenanted', ChainedTenanted, { rest: true });

			// 1. Stale If-Match: "999" on PUT /ChainedTenanted/scoped
			await BaseTable.put('t1:scoped', { n: 1, prev: null });
			await BaseTable.delete('t1:t1:scoped');
			const stalePut = await request('PUT', '/ChainedTenanted/scoped', { n: 2 }, { 'if-match': '"999"' });
			const afterStalePutOrig = await BaseTable.get('t1:scoped');
			const afterStalePutDouble = (await BaseTable.get('t1:t1:scoped')) ?? null;

			// 2. If-None-Match: "*" on PUT /ChainedTenanted/scoped when t1:scoped exists
			await BaseTable.put('t1:scoped', { n: 1, prev: null });
			await BaseTable.delete('t1:t1:scoped');
			const noMatchPut = await request('PUT', '/ChainedTenanted/scoped', { n: 3 }, { 'if-none-match': '*' });
			const afterNoMatchOrig = await BaseTable.get('t1:scoped');
			const afterNoMatchDouble = (await BaseTable.get('t1:t1:scoped')) ?? null;

			// 3. Stale If-Match: "999" on PATCH /ChainedTenanted/scoped
			await BaseTable.put('t1:scoped', { n: 1, prev: null });
			await BaseTable.delete('t1:t1:scoped');
			const stalePatch = await request('PATCH', '/ChainedTenanted/scoped', { n: 4 }, { 'if-match': '"999"' });
			const afterStalePatchOrig = await BaseTable.get('t1:scoped');
			const afterStalePatchDouble = (await BaseTable.get('t1:t1:scoped')) ?? null;

			// 4. Stale If-Match: "999" on DELETE /ChainedTenanted/scoped
			await BaseTable.put('t1:scoped', { n: 1, prev: null });
			await BaseTable.put('t1:t1:scoped', { n: 99, prev: null });
			const staleDel = await request('DELETE', '/ChainedTenanted/scoped', undefined, { 'if-match': '"999"' });
			const afterStaleDelOrig = (await BaseTable.get('t1:scoped')) ?? null;
			const afterStaleDelDouble = (await BaseTable.get('t1:t1:scoped')) ?? null;
			await BaseTable.delete('t1:t1:scoped');

			// 5. Matching ETag on PUT /ChainedTenanted/scoped should update t1:scoped (not t1:t1:scoped)
			await BaseTable.put('t1:scoped', { n: 1, prev: null });
			await BaseTable.delete('t1:t1:scoped');
			const etag = versionToEtag(BaseTable.primaryStore.getEntry('t1:scoped').version);
			const validPut = await request('PUT', '/ChainedTenanted/scoped', { n: 5 }, { 'if-match': etag });
			const afterValidPutOrig = await BaseTable.get('t1:scoped');
			const afterValidPutDouble = (await BaseTable.get('t1:t1:scoped')) ?? null;

			assert.deepStrictEqual(
				{
					stalePut: {
						status: stalePut.status,
						origN: afterStalePutOrig?.n,
						doubleKey: afterStalePutDouble
							? { id: afterStalePutDouble.id, n: afterStalePutDouble.n, prev: afterStalePutDouble.prev }
							: null,
					},
					noMatchPut: {
						status: noMatchPut.status,
						origN: afterNoMatchOrig?.n,
						doubleKey: afterNoMatchDouble
							? { id: afterNoMatchDouble.id, n: afterNoMatchDouble.n, prev: afterNoMatchDouble.prev }
							: null,
					},
					stalePatch: {
						status: stalePatch.status,
						origN: afterStalePatchOrig?.n,
						doubleKey: afterStalePatchDouble
							? { id: afterStalePatchDouble.id, n: afterStalePatchDouble.n, prev: afterStalePatchDouble.prev }
							: null,
					},
					staleDel: {
						status: staleDel.status,
						origN: afterStaleDelOrig?.n ?? null,
						doubleKeyN: afterStaleDelDouble?.n ?? null,
					},
					validPut: {
						status: validPut.status,
						orig: afterValidPutOrig
							? { id: afterValidPutOrig.id, n: afterValidPutOrig.n, prev: afterValidPutOrig.prev }
							: null,
						doubleKey: afterValidPutDouble
							? { id: afterValidPutDouble.id, n: afterValidPutDouble.n, prev: afterValidPutDouble.prev }
							: null,
					},
				},
				{
					stalePut: { status: 412, origN: 1, doubleKey: null },
					noMatchPut: { status: 412, origN: 1, doubleKey: null },
					stalePatch: { status: 412, origN: 1, doubleKey: null },
					staleDel: { status: 412, origN: 1, doubleKeyN: 99 },
					validPut: {
						status: 204,
						orig: { id: 't1:scoped', n: 5, prev: 1 },
						doubleKey: null,
					},
				}
			);
		});
	});
});
