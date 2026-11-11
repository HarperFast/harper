/**
 * The primary key of a table under non-empty `attribute_permissions`, across the NoSQL operations, SQL, REST
 * and GraphQL (docs/reference/users-and-roles/overview.md "Attribute-level"): an unlisted key receives the access
 * its listed attributes have; a key listed with `read`/`insert`/`update: false` is denied on every surface.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/attribute-permissions-primary-key.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';

import request from 'supertest';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';
// @ts-expect-error lifecycle.mjs has no type declarations; runtime resolves fine
import { waitForRouteReady } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/attribute-permissions-primary-key');

type Who = 'unlisted' | 'listed' | 'denied';
const WHO: Who[] = ['unlisted', 'listed', 'denied'];
const KEY_ACCESS: Record<Who, boolean> = { unlisted: true, listed: true, denied: false };
const USERS: Record<Who | 'order', { username: string; password: string }> = {
	unlisted: { username: 'pk_unlisted_user', password: 'Pk-unlisted-1!' },
	listed: { username: 'pk_listed_user', password: 'Pk-listed-1!' },
	denied: { username: 'pk_denied_user', password: 'Pk-denied-1!' },
	order: { username: 'pk_order_user', password: 'Pk-order-1!' },
};
const ROLE = (who: string) => `pk_${who}_role`;

interface Cell {
	status: number;
	text: string;
	rows: any[] | null;
}
const toRows = (body: any): any[] | null =>
	Array.isArray(body) ? body : body && typeof body === 'object' && !body.error ? [body] : null;
const everyRowHas = (cell: Cell, key: string) =>
	cell.rows !== null && cell.rows.length > 0 && cell.rows.every((row) => row && typeof row === 'object' && key in row);
const anyRowHas = (cell: Cell, key: string) =>
	cell.rows !== null && cell.rows.some((row) => row && typeof row === 'object' && key in row);

suite('Primary key under attribute permissions', (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let restURL: string;
	const headers: Record<string, Record<string, string>> = {};

	const ops = async (who: Who | 'order', body: object): Promise<Cell> => {
		const res = await client.reqAs(headers[who]).send(body);
		return { status: res.status, text: res.text, rows: res.status === 200 ? toRows(res.body) : null };
	};
	const restGet = async (who: Who | 'order', path: string): Promise<Cell> => {
		const res = await request(restURL).get(path).set(headers[who]);
		return { status: res.status, text: res.text, rows: res.status === 200 ? toRows(res.body) : null };
	};
	const restWrite = async (who: Who | 'order', method: 'post' | 'put' | 'patch', path: string, body: object) => {
		const res = await request(restURL)[method](path).set(headers[who]).send(body);
		return { status: res.status, text: res.text };
	};
	const graphql = async (who: Who, query: string): Promise<Cell> => {
		const res = await request(restURL).post('/graphql').set(headers[who]).send({ query });
		return { status: res.status, text: res.text, rows: res.status === 200 ? toRows(res.body?.data?.Doc) : null };
	};
	const stored = async (table: string, id: string): Promise<any | null> => {
		const res = await client
			.req()
			.send({ operation: 'search_by_id', database: 'data', table, ids: [id], get_attributes: ['*'] });
		strictEqual(res.status, 200, res.text);
		return res.body.length > 0 ? res.body[0] : null;
	};
	const seed = async (table: string, records: object[]) => {
		const res = await client.req().send({ operation: 'upsert', database: 'data', table, records });
		strictEqual(res.status, 200, res.text);
	};

	/** With key access the key is on every row; without it, the operations API and SQL refuse a projection naming it and the other surfaces omit it. */
	function checkRead(
		label: string,
		who: Who,
		cell: Cell,
		options: { key?: string; namesKey?: 'refused' | 'omitted' } = {}
	) {
		const { key = 'id', namesKey } = options;
		if (!KEY_ACCESS[who] && namesKey === 'refused') {
			strictEqual(cell.status, 403, `${label} ${who}: ${cell.status} ${cell.text}`);
			return;
		}
		strictEqual(cell.status, 200, `${label} ${who}: ${cell.status} ${cell.text}`);
		if (KEY_ACCESS[who]) ok(everyRowHas(cell, key), `${label} ${who}: key missing from ${cell.text}`);
		else {
			ok(everyRowHas(cell, 'title'), `${label} ${who}: listed attribute missing from ${cell.text}`);
			ok(!anyRowHas(cell, key), `${label} ${who}: key returned in ${cell.text}`);
		}
	}

	async function checkKeyWrite(
		label: string,
		who: Who,
		table: string,
		id: string,
		call: () => Promise<{ status: number; text: string }>,
		expectedRow: (before: any) => object
	) {
		const before = await stored(table, id);
		const res = await call();
		const after = await stored(table, id);
		if (KEY_ACCESS[who]) {
			ok(res.status >= 200 && res.status < 300, `${label} ${who}: ${res.status} ${res.text}`);
			deepStrictEqual(after, expectedRow(before), `${label} ${who}: stored row`);
		} else {
			strictEqual(res.status, 403, `${label} ${who}: ${res.status} ${res.text}`);
			deepStrictEqual(after, before, `${label} ${who}: the refused write changed the row`);
		}
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: 1 } },
			env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
		});
		client = createApiClient(ctx.harper);
		restURL = ctx.harper.httpURL;
		await waitForRouteReady(client, '/Doc/', 120_000);

		const attribute = (attribute_name: string, allow: boolean) => ({
			attribute_name,
			read: allow,
			insert: allow,
			update: allow,
		});
		const table = (extra: object[]) => ({
			read: true,
			insert: true,
			update: true,
			delete: false,
			attribute_permissions: [attribute('title', true), attribute('owner', true), ...extra],
		});
		const permission = (docExtra: object[], itemExtra: object[]) => ({
			super_user: false,
			data: { tables: { Doc: table(docExtra), Item: table(itemExtra) } },
		});
		const roles: Array<[Who | 'order', object]> = [
			['unlisted', permission([], [])],
			['order', permission([], [])],
			['listed', permission([attribute('id', true)], [attribute('code', true)])],
			['denied', permission([attribute('id', false)], [attribute('code', false)])],
		];
		for (const [who, perm] of roles) {
			const role = await client.req().send({ operation: 'add_role', role: ROLE(who), permission: perm });
			strictEqual(role.status, 200, role.text);
			const user = await client.req().send({ operation: 'add_user', role: ROLE(who), ...USERS[who], active: true });
			strictEqual(user.status, 200, user.text);
			headers[who] = createHeaders(USERS[who].username, USERS[who].password);
		}
		const listed = await client.req().send({ operation: 'list_roles' });
		strictEqual(listed.status, 200, listed.text);
		const docAttributes = (who: Who) =>
			listed.body.find((role: any) => role.role === ROLE(who)).permission.data.tables.Doc.attribute_permissions;
		deepStrictEqual(
			docAttributes('denied').find((entry: any) => entry.attribute_name === 'id'),
			{ attribute_name: 'id', read: false, insert: false, update: false }
		);
		strictEqual(
			docAttributes('unlisted').some((entry: any) => entry.attribute_name === 'id'),
			false
		);

		await seed('Doc', [
			{ id: '1', title: 'T1', owner: 'ownerA', secret: 'S-1' },
			{ id: '2', title: 'T2', owner: 'ownerA', secret: 'S-2' },
			{ id: '3', title: 'T3', owner: 'ownerA', secret: 'S-3' },
		]);
		await seed('Item', [{ code: 'a1', title: 'A1', owner: 'ownerA' }]);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('NoSQL searches grant the unlisted key and honour an explicit denial', async () => {
		for (const who of WHO) {
			for (const get_attributes of [['*'], ['id', 'title']]) {
				const label = `get_attributes=${get_attributes.join(',')}`;
				const options = { namesKey: get_attributes.includes('id') ? ('refused' as const) : undefined };
				checkRead(
					`search_by_id ${label}`,
					who,
					await ops(who, {
						operation: 'search_by_id',
						database: 'data',
						table: 'Doc',
						ids: ['1', '2', '3'],
						get_attributes,
					}),
					options
				);
				checkRead(
					`search_by_value ${label}`,
					who,
					await ops(who, {
						operation: 'search_by_value',
						database: 'data',
						table: 'Doc',
						search_attribute: 'owner',
						search_value: 'ownerA',
						get_attributes,
					}),
					options
				);
				checkRead(
					`search_by_conditions ${label}`,
					who,
					await ops(who, {
						operation: 'search_by_conditions',
						database: 'data',
						table: 'Doc',
						conditions: [{ search_attribute: 'owner', search_type: 'equals', search_value: 'ownerA' }],
						get_attributes,
					}),
					options
				);
			}
		}
	});

	test('SQL SELECT grants the unlisted key and honours an explicit denial', async () => {
		for (const who of WHO) {
			checkRead('SELECT *', who, await ops(who, { operation: 'sql', sql: 'SELECT * FROM data.Doc' }));
			checkRead('SELECT id, title', who, await ops(who, { operation: 'sql', sql: 'SELECT id, title FROM data.Doc' }), {
				namesKey: 'refused',
			});
		}
	});

	test('REST and GraphQL reads return the rows without an explicitly denied key', async () => {
		for (const who of ['unlisted', 'denied'] as const) {
			checkRead('GET /Doc/1', who, await restGet(who, '/Doc/1'));
			checkRead('GET /Doc/', who, await restGet(who, '/Doc/'));
			checkRead('GET /Doc/?select(id,title)', who, await restGet(who, '/Doc/?select(id,title)'), {
				namesKey: 'omitted',
			});
			checkRead('GraphQL { Doc { id title } }', who, await graphql(who, '{ Doc { id title } }'), {
				namesKey: 'omitted',
			});
		}
	});

	test('the resource path keeps reading the stored role after an operations call by the same user', async () => {
		const first = await restGet('order', '/Doc/1');
		strictEqual(first.status, 200, first.text);
		ok(everyRowHas(first, 'id'), first.text);
		const translated = await ops('order', {
			operation: 'search_by_id',
			database: 'data',
			table: 'Doc',
			ids: ['1'],
			get_attributes: ['*'],
		});
		strictEqual(translated.status, 200, translated.text);
		ok(everyRowHas(translated, 'id'), translated.text);
		const second = await restGet('order', '/Doc/1');
		deepStrictEqual(second.rows, first.rows, 'the REST read changed after the operations call');
		const collection = await restGet('order', '/Doc/');
		ok(everyRowHas(collection, 'id'), collection.text);

		const inserted = await ops('order', {
			operation: 'insert',
			database: 'data',
			table: 'Doc',
			records: [{ id: 'order-ops', title: 'T', owner: 'ownerA' }],
		});
		strictEqual(inserted.status, 200, inserted.text);
		const posted = await restWrite('order', 'post', '/Doc/', { id: 'order-rest', title: 'T', owner: 'ownerA' });
		ok(posted.status >= 200 && posted.status < 300, `${posted.status} ${posted.text}`);
		deepStrictEqual(await stored('Doc', 'order-rest'), { id: 'order-rest', title: 'T', owner: 'ownerA' });
	});

	test('REST writes carrying the key are granted for an unlisted key and refused for a denied one', async () => {
		for (const who of WHO) {
			await checkKeyWrite(
				'POST /Doc/',
				who,
				'Doc',
				`post-${who}`,
				() => restWrite(who, 'post', '/Doc/', { id: `post-${who}`, title: 'posted', owner: 'ownerA' }),
				() => ({ id: `post-${who}`, title: 'posted', owner: 'ownerA' })
			);
			await checkKeyWrite(
				'PUT /Doc/<new id> with the key in the body',
				who,
				'Doc',
				`put-${who}`,
				() => restWrite(who, 'put', `/Doc/put-${who}`, { id: `put-${who}`, title: 'put', owner: 'ownerA' }),
				() => ({ id: `put-${who}`, title: 'put', owner: 'ownerA' })
			);
			await checkKeyWrite(
				'PATCH /Doc/1 with the key in the body',
				who,
				'Doc',
				'1',
				() => restWrite(who, 'patch', '/Doc/1', { id: '1', title: `patched by ${who}` }),
				(before) => ({ ...before, title: `patched by ${who}` })
			);
		}
	});

	test('REST writes with the key only in the path are accepted by every role', async () => {
		for (const who of WHO) {
			const put = await restWrite(who, 'put', `/Doc/path-${who}`, { title: 'put', owner: 'ownerA' });
			ok(put.status >= 200 && put.status < 300, `PUT ${who}: ${put.status} ${put.text}`);
			deepStrictEqual(await stored('Doc', `path-${who}`), { id: `path-${who}`, title: 'put', owner: 'ownerA' });

			const before = await stored('Doc', '2');
			const patch = await restWrite(who, 'patch', '/Doc/2', { title: `patched by ${who}` });
			ok(patch.status >= 200 && patch.status < 300, `PATCH ${who}: ${patch.status} ${patch.text}`);
			deepStrictEqual(await stored('Doc', '2'), { ...before, title: `patched by ${who}` });
		}
	});

	test('operations insert and update apply the same rule', async () => {
		for (const who of WHO) {
			await checkKeyWrite(
				'insert',
				who,
				'Doc',
				`ops-${who}`,
				() =>
					ops(who, {
						operation: 'insert',
						database: 'data',
						table: 'Doc',
						records: [{ id: `ops-${who}`, title: 'inserted', owner: 'ownerA' }],
					}),
				() => ({ id: `ops-${who}`, title: 'inserted', owner: 'ownerA' })
			);
			await checkKeyWrite(
				'update',
				who,
				'Doc',
				'3',
				() =>
					ops(who, {
						operation: 'update',
						database: 'data',
						table: 'Doc',
						records: [{ id: '3', title: `updated by ${who}` }],
					}),
				(before) => ({ ...before, title: `updated by ${who}` })
			);
		}
	});

	test('a key that is not named id follows the same rule', async () => {
		for (const who of WHO) {
			checkRead('GET /Item/a1', who, await restGet(who, '/Item/a1'), { key: 'code' });
			checkRead(
				'search_by_id Item',
				who,
				await ops(who, {
					operation: 'search_by_id',
					database: 'data',
					table: 'Item',
					ids: ['a1'],
					get_attributes: ['*'],
				}),
				{ key: 'code' }
			);
			await checkKeyWrite(
				'POST /Item/',
				who,
				'Item',
				`rest-${who}`,
				() => restWrite(who, 'post', '/Item/', { code: `rest-${who}`, title: 'posted', owner: 'ownerA' }),
				() => ({ code: `rest-${who}`, title: 'posted', owner: 'ownerA' })
			);
			await checkKeyWrite(
				'insert Item',
				who,
				'Item',
				`ops-${who}`,
				() =>
					ops(who, {
						operation: 'insert',
						database: 'data',
						table: 'Item',
						records: [{ code: `ops-${who}`, title: 'inserted', owner: 'ownerA' }],
					}),
				() => ({ code: `ops-${who}`, title: 'inserted', owner: 'ownerA' })
			);
		}
	});
});
