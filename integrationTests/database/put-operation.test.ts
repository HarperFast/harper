/**
 * The `put` operation: create-or-replace over the operations API.
 *
 * Background: `update` and `upsert` both land on `Table.patch` for a record that already exists
 * (`dataLayer/harperBridge/ResourceBridge.ts` `upsertRecords`), which merges the submitted
 * attributes onto the stored record. An attribute the request omits keeps its stored value, and
 * `null` stores a null — so before `put` there was no way to REMOVE an attribute through the
 * operations API. Clients worked around it by deleting the record and inserting it again, which
 * leaves the record absent between two writes, resets `__createdtime__`, and shows subscribers a
 * delete followed by an insert (HarperFast/studio#1643).
 *
 * `put` is `Table.put` — the same write REST `PUT /Table/id` performs, so the same audit type,
 * replication shape and retained `__createdtime__`. It creates a missing record and replaces an
 * existing one. The merge semantics of `update`/`upsert` are deliberately untouched: that is the
 * v4-compatible behaviour existing clients depend on.
 *
 * The authorization probes at the end cover the target-database resolution shared with the handlers,
 * which is a separate fix on this branch.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/put-operation.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/put-operation.test.ts"
 */
import { suite, test, describe, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'put-operation');

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

const ctx: ContextWithHarper = {} as any;

// Password for the scoped roles the authorization probes create.
const SCOPED_PASSWORD = 'Abc12345!';

suite('put: create-or-replace over the operations API', { skip: skipSuite }, () => {
	let client: ReturnType<typeof createApiClient>;

	async function ops(body: Record<string, unknown>) {
		const r = await client.req().send(body).timeout(8_000);
		return { status: r.status as number, body: r.body };
	}

	async function insert(table: string, records: Record<string, unknown>[]) {
		const r = await ops({ operation: 'insert', table, records });
		strictEqual(r.status, 200, `seed insert should 200; got ${r.status} ${JSON.stringify(r.body)}`);
		return r;
	}

	/** The stored record, read back by id through search_by_id. */
	async function read(table: string, id: string) {
		const r = await ops({ operation: 'search_by_id', table, ids: [id], get_attributes: ['*'] });
		strictEqual(r.status, 200, `search_by_id should 200; got ${r.status} ${JSON.stringify(r.body)}`);
		return r.body?.[0];
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const r = await client.reqRest('/Dog/').timeout(3_000);
				if (r.status !== 404) break;
			} catch {
				// not ready yet
			}
			await sleep(300);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// The defect the flag exists to fix. Without it this same request leaves `color` in place.

	// Role fixtures for the authorization probes. Created once per probe that needs one.
	async function addScopedRole(role: string, permission: Record<string, unknown>, username: string) {
		const r = await ops({ operation: 'add_role', role, permission });
		strictEqual(r.status, 200, `add_role should 200; got ${r.status} ${JSON.stringify(r.body)}`);
		const u = await ops({ operation: 'add_user', role, username, password: SCOPED_PASSWORD, active: true });
		strictEqual(u.status, 200, `add_user should 200; got ${u.status} ${JSON.stringify(u.body)}`);
		return {
			...client.headers,
			Authorization: `Basic ${Buffer.from(`${username}:${SCOPED_PASSWORD}`).toString('base64')}`,
		};
	}

	function asUser(headers: Record<string, string>, body: Record<string, unknown>) {
		return client.reqAs(headers).send(body).timeout(8_000);
	}

	// The gap `put` exists to close. The same request as an `update` leaves `color` in place.
	test('put replaces the record, removing an attribute the request omits', async () => {
		await insert('Dog', [{ id: 'p-1', name: 'Penny', breed: 'Mutt', color: 'black' }]);

		const r = await ops({ operation: 'put', table: 'Dog', records: [{ id: 'p-1', name: 'Penny', breed: 'Mutt' }] });
		strictEqual(r.status, 200, `put should 200; got ${r.status} ${JSON.stringify(r.body)}`);

		const stored = await read('Dog', 'p-1');
		ok(!('color' in stored), `color should be gone, not nulled; stored=${JSON.stringify(stored)}`);
		strictEqual(stored.name, 'Penny');
		strictEqual(stored.breed, 'Mutt');
	});

	// The control: the merge default must be untouched. This is the v4-compatible behaviour every
	// existing client depends on, and 5bd363946 / b302a16e7 made it deliberate.
	test('update still merges, keeping an omitted attribute', async () => {
		await insert('Dog', [{ id: 'p-2', name: 'Penny', breed: 'Mutt', color: 'black' }]);

		const r = await ops({ operation: 'update', table: 'Dog', records: [{ id: 'p-2', name: 'Pen' }] });
		strictEqual(r.status, 200, `update should 200; got ${r.status} ${JSON.stringify(r.body)}`);

		const stored = await read('Dog', 'p-2');
		strictEqual(stored.color, 'black', 'an omitted attribute must survive a merge');
		strictEqual(stored.breed, 'Mutt');
		strictEqual(stored.name, 'Pen');
	});

	test('upsert still merges too', async () => {
		await insert('Dog', [{ id: 'p-2b', name: 'Penny', breed: 'Mutt', color: 'black' }]);

		await ops({ operation: 'upsert', table: 'Dog', records: [{ id: 'p-2b', name: 'Pen' }] });

		strictEqual((await read('Dog', 'p-2b')).color, 'black', 'upsert must keep merging');
	});

	// `null` is a value Harper stores. A replace keeps it as a stored null — omission is the only
	// thing that removes, which is exactly the distinction studio#1643 turned on.
	test('put keeps an explicit null as a stored null', async () => {
		await insert('Dog', [{ id: 'p-3', name: 'Penny', breed: 'Mutt', color: 'black' }]);

		await ops({ operation: 'put', table: 'Dog', records: [{ id: 'p-3', name: 'Penny', breed: null }] });

		const stored = await read('Dog', 'p-3');
		ok('breed' in stored, `an explicit null must remain a stored attribute; stored=${JSON.stringify(stored)}`);
		strictEqual(stored.breed, null);
		ok(!('color' in stored), 'the omitted attribute is the one that goes');
	});

	// What a delete-then-insert cannot do: `Table._writeUpdate` retains the stored created time on a
	// full update, and only stamps a fresh one for a genuinely new entry.
	test('put preserves @createdTime and re-stamps @updatedTime', async () => {
		await insert('Dog', [{ id: 'p-4', name: 'Penny', breed: 'Mutt', color: 'black' }]);
		const before = await read('Dog', 'p-4');
		ok(typeof before.createdAt === 'number', `seed should carry a createdAt; got ${JSON.stringify(before)}`);
		await sleep(10);

		await ops({ operation: 'put', table: 'Dog', records: [{ id: 'p-4', name: 'Penny' }] });

		const after = await read('Dog', 'p-4');
		strictEqual(after.createdAt, before.createdAt, '@createdTime must survive a replace');
		ok(after.updatedAt > before.updatedAt, `@updatedTime should advance; ${before.updatedAt} -> ${after.updatedAt}`);
	});

	// Create-or-replace, like REST PUT — no `requires_existing`, so a missing record is created
	// rather than skipped.
	test('put creates a missing record and replaces an existing one', async () => {
		const created = await ops({
			operation: 'put',
			table: 'Dog',
			records: [{ id: 'p-5', name: 'New', color: 'brown' }],
		});
		strictEqual(created.status, 200, `put should 200; got ${created.status} ${JSON.stringify(created.body)}`);
		strictEqual((await read('Dog', 'p-5')).name, 'New');

		await ops({ operation: 'put', table: 'Dog', records: [{ id: 'p-5', name: 'Replaced' }] });

		const stored = await read('Dog', 'p-5');
		strictEqual(stored.name, 'Replaced');
		ok(!('color' in stored), `the replace should have dropped color; stored=${JSON.stringify(stored)}`);
	});

	test('put reports the records it wrote', async () => {
		const r = await ops({
			operation: 'put',
			table: 'Dog',
			records: [
				{ id: 'p-5b', name: 'A' },
				{ id: 'p-5c', name: 'B' },
			],
		});
		strictEqual(r.status, 200, `put should 200; got ${JSON.stringify(r.body)}`);
		deepStrictEqual(r.body.put_hashes?.sort(), ['p-5b', 'p-5c'], `expected both ids; got ${JSON.stringify(r.body)}`);
	});

	// Parity: the two doors to a full replace must agree, since REST PUT is the behaviour `put` is
	// named after and implemented on.
	test('put matches REST PUT', async () => {
		await insert('Dog', [{ id: 'p-rest', name: 'Penny', breed: 'Mutt', color: 'black' }]);
		await insert('Dog', [{ id: 'p-ops', name: 'Penny', breed: 'Mutt', color: 'black' }]);

		const rest = await request(client.restURL)
			.put('/Dog/p-rest')
			.set(client.headers)
			.send({ id: 'p-rest', name: 'Penny', breed: 'Mutt' })
			.timeout(8_000);
		ok(rest.status === 200 || rest.status === 204, `REST PUT should succeed; got ${rest.status}`);

		await ops({ operation: 'put', table: 'Dog', records: [{ id: 'p-ops', name: 'Penny', breed: 'Mutt' }] });

		const viaRest = await read('Dog', 'p-rest');
		const viaOps = await read('Dog', 'p-ops');
		deepStrictEqual(
			Object.keys(viaOps).sort(),
			Object.keys(viaRest).sort(),
			`the two surfaces should store the same attributes; rest=${JSON.stringify(viaRest)} ops=${JSON.stringify(viaOps)}`
		);
	});

	// A replace that carries the foreign key keeps the relationship resolvable throughout — the
	// property a delete-then-insert gives up, since the record is absent between its two writes.
	test('put keeps a relationship foreign key resolvable', async () => {
		await insert('Owner', [{ id: 'p-own', name: 'Ada' }]);
		await insert('OwnedDog', [{ id: 'p-od', name: 'Penny', ownerId: 'p-own', nickname: 'Pen' }]);

		await ops({ operation: 'put', table: 'OwnedDog', records: [{ id: 'p-od', name: 'Penny', ownerId: 'p-own' }] });

		const stored = await read('OwnedDog', 'p-od');
		ok(!('nickname' in stored), `nickname should be gone; stored=${JSON.stringify(stored)}`);
		strictEqual(stored.ownerId, 'p-own', 'the foreign key must survive the replace');

		const owner = await request(client.restURL).get('/Owner/p-own?select(id,dogs{id})').set(client.headers);
		strictEqual(owner.status, 200, `owner GET should 200; got ${owner.status}`);
		const dogIds = (owner.body?.dogs ?? []).map((d: any) => d.id);
		ok(dogIds.includes('p-od'), `the relationship should still resolve; got ${JSON.stringify(owner.body)}`);
	});

	// `full_record` is the bridge's INTERNAL marker, set by `putRecords`. A client sending it must not
	// be able to turn an `update` into a replace — otherwise the operation name stops describing what
	// the request does, and the attribute-scoped denial below (keyed on the operation) is bypassable.
	test('a client-supplied full_record does not turn an update into a replace', async () => {
		await insert('Dog', [{ id: 'p-6', name: 'Penny', breed: 'Mutt', color: 'black' }]);

		const r = await ops({
			operation: 'update',
			table: 'Dog',
			full_record: true,
			records: [{ id: 'p-6', name: 'Penny' }],
		});
		strictEqual(r.status, 200, `update should still 200; got ${r.status} ${JSON.stringify(r.body)}`);

		const stored = await read('Dog', 'p-6');
		strictEqual(stored.color, 'black', 'the request must have merged, not replaced');
		strictEqual(stored.breed, 'Mutt');
	});

	// A replace removes the attributes the request omits, and attribute permissions are only checked
	// against the attributes it SUPPLIES — so an attribute-scoped role could otherwise erase an
	// attribute it has no permission to write. Refused in `verifyPerms`, since nothing has read the
	// stored record at that point.
	test('a role with attribute permissions may not use put', async () => {
		await insert('Dog', [{ id: 'p-perm', name: 'Penny', breed: 'Mutt', color: 'black' }]);
		const headers = await addScopedRole(
			'attr_scoped',
			{
				data: {
					tables: {
						Dog: {
							read: true,
							insert: true,
							update: true,
							delete: false,
							// read/insert/update are all required per entry (ATTR_CRU_KEYS).
							attribute_permissions: [
								{ attribute_name: 'id', read: true, insert: true, update: true },
								{ attribute_name: 'name', read: true, insert: true, update: true },
								{ attribute_name: 'color', read: true, insert: true, update: false },
							],
						},
					},
				},
			},
			'attr_scoped_user'
		);

		const denied = await asUser(headers, {
			operation: 'put',
			database: 'data',
			table: 'Dog',
			records: [{ id: 'p-perm', name: 'Penny' }],
		});
		strictEqual(denied.status, 403, `put should be refused; got ${denied.status} ${JSON.stringify(denied.body)}`);
		strictEqual((await read('Dog', 'p-perm')).color, 'black', 'the denied request must not have removed anything');

		// The denial is scoped to `put`: the same role can still merge the attributes it owns, and the
		// operations `put` does not name are unaffected.
		const merged = await asUser(headers, {
			operation: 'update',
			database: 'data',
			table: 'Dog',
			records: [{ id: 'p-perm', name: 'Pen' }],
		});
		strictEqual(merged.status, 200, `a merge should still work; got ${merged.status} ${JSON.stringify(merged.body)}`);

		const inserted = await asUser(headers, {
			operation: 'insert',
			database: 'data',
			table: 'Dog',
			records: [{ id: 'p-perm-2', name: 'Grace' }],
		});
		strictEqual(
			inserted.status,
			200,
			`insert should not be denied; got ${inserted.status} ${JSON.stringify(inserted.body)}`
		);
	});

	test('an absent attribute reads back as null on an open table (read-path projection)', async () => {
		await ops({ operation: 'create_table', database: 'data', table: 'OpenNull', primary_key: 'id' });
		// Registers `color` as a table attribute...
		await insert('OpenNull', [{ id: 'had-color', name: 'A', color: 'black' }]);
		// ...which this record never sets.
		await insert('OpenNull', [{ id: 'never-had', name: 'B' }]);

		const projected = await read('OpenNull', 'never-had');
		ok('color' in projected, `expected the projection to include color; got ${JSON.stringify(projected)}`);
		strictEqual(projected.color, null, 'an attribute the record never had projects as null');

		const rows = await ops({ operation: 'sql', sql: `SELECT * FROM data.OpenNull WHERE id = 'never-had'` });
		const row = rows.body?.[0];
		ok(row, `sql should have returned the row; got ${JSON.stringify(rows.body)}`);
		ok(!('color' in row), `nothing is stored for it; got ${JSON.stringify(row)}`);
	});

	test('a caller-supplied action does not skip the attribute-permission check', async () => {
		await insert('Dog', [{ id: 'act-1', name: 'Penny', breed: 'Mutt', color: 'black' }]);
		const headers = await addScopedRole(
			'action_scoped',
			{
				data: {
					tables: {
						Dog: {
							read: true,
							insert: true,
							update: true,
							delete: false,
							attribute_permissions: [
								{ attribute_name: 'id', read: true, insert: true, update: true },
								{ attribute_name: 'color', read: true, insert: true, update: false },
							],
						},
					},
				},
			},
			'action_scoped_user'
		);

		for (const body of [
			{ operation: 'update', database: 'data', table: 'Dog', records: [{ id: 'act-1', color: 'brown' }] },
			// The same request with the escape hatch attached. `action` is an unknown-but-accepted key on
			// this validator, so inferring the bulk-load opt-out from its presence let any direct request
			// skip every attribute check.
			{
				operation: 'update',
				database: 'data',
				table: 'Dog',
				action: 'update',
				records: [{ id: 'act-1', color: 'brown' }],
			},
		]) {
			const r = await asUser(headers, body);
			strictEqual(
				r.status,
				403,
				`expected a denial${body.action ? ' with action attached' : ''}; got ${r.status} ${JSON.stringify(r.body)}`
			);
		}

		strictEqual((await read('Dog', 'act-1')).color, 'black', 'no denied request may have altered the attribute');
	});

	// The refusal keys on whether there is a record to remove from, not on which operation asked.
	// Guarding the insert flag alone left this case reaching the same silent partial write one branch
	// over: `insertUpdateValidate` requires a primary key only for `update`, so an `upsert` without one
	// takes the auto-keyed `Table.create` path and stored the record with the named attributes stripped.

	test('a numeric table name is still authorized', async () => {
		strictEqual(
			(await ops({ operation: 'create_table', database: 'data', table: '0', primary_key: 'id' })).status,
			200
		);
		strictEqual(
			(await ops({ operation: 'insert', database: 'data', table: '0', records: [{ id: 'z-1', name: 'Keep' }] })).status,
			200
		);

		const headers = await addScopedRole(
			'no_numeric_table',
			{
				data: {
					tables: { '0': { read: true, insert: false, update: false, delete: false, attribute_permissions: [] } },
				},
			},
			'no_numeric_table_user'
		);

		// Sent as a JSON number, which is what makes the guard's falsy test bite.
		const denied = await asUser(headers, {
			operation: 'update',
			database: 'data',
			table: 0,
			records: [{ id: 'z-1', name: 'bypass' }],
		});
		strictEqual(
			denied.status,
			403,
			`a numeric table must be authorized; got ${denied.status} ${JSON.stringify(denied.body)}`
		);

		const stored = await ops({
			operation: 'search_by_id',
			database: 'data',
			table: '0',
			ids: ['z-1'],
			get_attributes: ['*'],
		});
		strictEqual(stored.body?.[0]?.name, 'Keep', 'the denied write must not have landed');
	});

	// Authorization resolves the target database with `commonUtils.resolveTargetDatabase`, the same
	// helper the handlers use via `transformReq`. Each case below was a working bypass against a
	// divergent copy of that logic: `hasPermissions` iterates `schemaTableMap`, so a target it fails
	// to resolve leaves the map empty and authorizes by vacuous truth, while the handler goes on to
	// write whatever the handlers' own resolution says.

	describe('target-database resolution is shared with the handlers', () => {
		let deniedHeaders: Record<string, string>;
		let dataOnlyHeaders: Record<string, string>;

		before(async () => {
			await insert('Dog', [{ id: 'authz-1', name: 'Penny', breed: 'Mutt' }]);
			deniedHeaders = await addScopedRole(
				'no_update_data',
				{
					data: {
						tables: {
							Dog: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
						},
					},
				},
				'no_update_data_user'
			);
			// Full rights on `data` and none anywhere else.
			dataOnlyHeaders = await addScopedRole(
				'data_only',
				{
					data: {
						tables: {
							Dog: { read: true, insert: true, update: true, delete: true, attribute_permissions: [] },
						},
					},
				},
				'data_only_user'
			);
		});

		// The original finding: no database key at all.
		test('an omitted database does not skip the table permission check', async () => {
			const r = await asUser(deniedHeaders, {
				operation: 'update',
				table: 'Dog',
				records: [{ id: 'authz-1', name: 'bypass' }],
			});
			strictEqual(r.status, 403, `expected a denial; got ${r.status} ${JSON.stringify(r.body)}`);
			strictEqual((await read('Dog', 'authz-1')).name, 'Penny', 'nothing may have been written');
		});

		test('the same request is denied when it does name the database', async () => {
			const r = await asUser(deniedHeaders, {
				operation: 'update',
				database: 'data',
				table: 'Dog',
				records: [{ id: 'authz-1', name: 'bypass' }],
			});
			strictEqual(r.status, 403, `expected a denial; got ${r.status} ${JSON.stringify(r.body)}`);
		});

		// A falsy-but-present database. `??` kept the `0`, which is not a database and left the map
		// empty; `transformReq` tests falsy and so defaulted to `data` and wrote there. `Joi.number()`
		// is an accepted type for the field, so `0` arrives validated.
		//
		// Both directions, because "denied" alone does not prove resolution: the fail-closed backstop
		// also denies an unresolved target, so a nullish-coalescing resolver would pass a
		// denial-only assertion while still not agreeing with the handlers. The role that HAS rights on
		// `data` must be allowed, and the write must land in `data` — which only holds if authorization
		// resolved `database: 0` to the default database exactly as `transformReq` does.
		test('a falsy database value resolves to the default database, not to nothing', async () => {
			for (const database of [0, -0]) {
				const denied = await asUser(deniedHeaders, {
					operation: 'update',
					database,
					table: 'Dog',
					records: [{ id: 'authz-1', name: 'bypass' }],
				});
				strictEqual(
					denied.status,
					403,
					`database: ${JSON.stringify(database)} must be denied for a role without update; got ${denied.status} ${JSON.stringify(denied.body)}`
				);
			}
			strictEqual((await read('Dog', 'authz-1')).name, 'Penny', 'nothing may have been written');

			const allowed = await asUser(dataOnlyHeaders, {
				operation: 'update',
				database: 0,
				table: 'Dog',
				records: [{ id: 'authz-1', name: 'resolved to data' }],
			});
			strictEqual(
				allowed.status,
				200,
				`a role with rights on the default database must be allowed; got ${allowed.status} ${JSON.stringify(allowed.body)}`
			);
			strictEqual((await read('Dog', 'authz-1')).name, 'resolved to data', 'the write must land in `data`');
		});

		// The worst of the three, because it reaches any named database rather than just the default:
		// authorization preferred `schema` while the handlers prefer `database`, so a role with rights
		// on `data` could be authorized against `data` and have the write land in another database.
		test('a request cannot be authorized against one database and written to another', async () => {
			strictEqual((await ops({ operation: 'create_database', database: 'elsewhere' })).status, 200);
			strictEqual(
				(await ops({ operation: 'create_table', database: 'elsewhere', table: 'Dog', primary_key: 'id' })).status,
				200
			);
			strictEqual(
				(
					await ops({
						operation: 'insert',
						database: 'elsewhere',
						table: 'Dog',
						records: [{ id: 'e-1', name: 'Keep' }],
					})
				).status,
				200
			);

			const r = await asUser(dataOnlyHeaders, {
				operation: 'update',
				schema: 'data',
				database: 'elsewhere',
				table: 'Dog',
				records: [{ id: 'e-1', name: 'crossed over' }],
			});
			strictEqual(
				r.status,
				403,
				`the write targets 'elsewhere', which this role has no rights to; got ${r.status} ${JSON.stringify(r.body)}`
			);

			const stored = await ops({
				operation: 'search_by_id',
				database: 'elsewhere',
				table: 'Dog',
				ids: ['e-1'],
				get_attributes: ['*'],
			});
			strictEqual(stored.body?.[0]?.name, 'Keep', `the record in 'elsewhere' must be untouched`);
		});
	});
});
