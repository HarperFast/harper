/**
 * Removing an attribute over the operations API: `full_record: true` (full replace) and
 * `__unset__: ["attr"]` (merge, minus named attributes).
 *
 * Background: `update` and `upsert` both land on `Table.patch` for a record that already exists
 * (`dataLayer/harperBridge/ResourceBridge.ts` `upsertRecords`), which merges the submitted
 * attributes onto the stored record. An attribute the request omits keeps its stored value, and
 * `null` stores a null — so before this flag there was no way to REMOVE an attribute through the
 * operations API. Clients worked around it by deleting the record and inserting it again, which
 * leaves the record absent between two writes, resets `__createdtime__`, and shows subscribers a
 * delete followed by an insert (HarperFast/studio#1643).
 *
 * The flag is orthogonal to each operation's create rule, and these probes pin both halves:
 *   update + full_record → full replace, still refuses a record that isn't there
 *   upsert + full_record → full replace, still creates one — i.e. exactly REST `PUT /Table/id`
 *
 * `__unset__` is the narrower tool: it keeps merge semantics for everything the request does send,
 * so the caller doesn't have to resend (and therefore risk clobbering) attributes it never meant to
 * touch, and the removals are visible to the attribute-permission check by name.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/full-record-write.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/full-record-write.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'full-record-write');

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

const ctx: ContextWithHarper = {} as any;

// Password for the scoped roles the authorization probes create.
const SCOPED_PASSWORD = 'Abc12345!';

suite('full_record: full replace over the operations API', { skip: skipSuite }, () => {
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
	test('update + full_record removes an attribute the request omits', async () => {
		await insert('Dog', [{ id: 'fr-1', name: 'Penny', breed: 'Mutt', color: 'black' }]);

		const r = await ops({
			operation: 'update',
			table: 'Dog',
			full_record: true,
			records: [{ id: 'fr-1', name: 'Penny', breed: 'Mutt' }],
		});
		strictEqual(r.status, 200, `update should 200; got ${r.status} ${JSON.stringify(r.body)}`);

		const stored = await read('Dog', 'fr-1');
		ok(!('color' in stored), `color should be gone, not nulled; stored=${JSON.stringify(stored)}`);
		strictEqual(stored.name, 'Penny');
		strictEqual(stored.breed, 'Mutt');
	});

	// The control: the default merge must be untouched by this change. This is the v4-compatible
	// behaviour every existing client depends on.
	test('update without the flag still merges, keeping an omitted attribute', async () => {
		await insert('Dog', [{ id: 'fr-2', name: 'Penny', breed: 'Mutt', color: 'black' }]);

		const r = await ops({ operation: 'update', table: 'Dog', records: [{ id: 'fr-2', name: 'Pen' }] });
		strictEqual(r.status, 200, `update should 200; got ${r.status} ${JSON.stringify(r.body)}`);

		const stored = await read('Dog', 'fr-2');
		strictEqual(stored.color, 'black', 'an omitted attribute must survive a merge');
		strictEqual(stored.breed, 'Mutt');
		strictEqual(stored.name, 'Pen');
	});

	// `null` is a value Harper stores. A full replace must keep it as a stored null rather than
	// treating it as a removal — omission is the only thing that removes.
	test('full_record keeps an explicit null as a stored null', async () => {
		await insert('Dog', [{ id: 'fr-3', name: 'Penny', breed: 'Mutt', color: 'black' }]);

		await ops({
			operation: 'update',
			table: 'Dog',
			full_record: true,
			records: [{ id: 'fr-3', name: 'Penny', breed: null }],
		});

		const stored = await read('Dog', 'fr-3');
		ok('breed' in stored, `an explicit null must remain a stored attribute; stored=${JSON.stringify(stored)}`);
		strictEqual(stored.breed, null);
		ok(!('color' in stored), 'the omitted attribute is the one that goes');
	});

	// What a delete-then-insert cannot do: `Table._writeUpdate` retains the stored created time on a
	// full update, and only stamps a fresh one for a genuinely new entry.
	test('full_record preserves @createdTime and re-stamps @updatedTime', async () => {
		await insert('Dog', [{ id: 'fr-4', name: 'Penny', breed: 'Mutt', color: 'black' }]);
		const before = await read('Dog', 'fr-4');
		ok(typeof before.createdAt === 'number', `seed should carry a createdAt; got ${JSON.stringify(before)}`);
		await sleep(10);

		await ops({
			operation: 'update',
			table: 'Dog',
			full_record: true,
			records: [{ id: 'fr-4', name: 'Penny' }],
		});

		const after = await read('Dog', 'fr-4');
		strictEqual(after.createdAt, before.createdAt, '@createdTime must survive a full replace');
		ok(
			after.updatedAt > before.updatedAt,
			`@updatedTime should advance; before=${before.updatedAt} after=${after.updatedAt}`
		);
	});

	// The flag does not change which records an operation is willing to write: `update` still
	// requires an existing one, so a typo'd primary key is skipped rather than silently created.
	test('update + full_record still skips a record that does not exist', async () => {
		const r = await ops({
			operation: 'update',
			table: 'Dog',
			full_record: true,
			records: [{ id: 'fr-absent', name: 'Nobody' }],
		});
		strictEqual(r.status, 200, `update should 200; got ${r.status} ${JSON.stringify(r.body)}`);
		deepStrictEqual(r.body.skipped_hashes, ['fr-absent'], `expected a skip; got ${JSON.stringify(r.body)}`);

		const stored = await read('Dog', 'fr-absent');
		ok(stored == null, `nothing should have been created; got ${JSON.stringify(stored)}`);
	});

	// ...while `upsert` still creates one, which makes upsert + full_record the operations-API
	// equivalent of REST PUT.
	test('upsert + full_record creates a missing record and replaces an existing one', async () => {
		const created = await ops({
			operation: 'upsert',
			table: 'Dog',
			full_record: true,
			records: [{ id: 'fr-5', name: 'New', color: 'brown' }],
		});
		strictEqual(created.status, 200, `upsert should 200; got ${created.status} ${JSON.stringify(created.body)}`);
		strictEqual((await read('Dog', 'fr-5')).name, 'New');

		await ops({
			operation: 'upsert',
			table: 'Dog',
			full_record: true,
			records: [{ id: 'fr-5', name: 'Replaced' }],
		});

		const stored = await read('Dog', 'fr-5');
		strictEqual(stored.name, 'Replaced');
		ok(!('color' in stored), `the replace should have dropped color; stored=${JSON.stringify(stored)}`);
	});

	// Parity: the two doors to a full replace must agree, since REST PUT is the behaviour this
	// operation is mirroring.
	test('upsert + full_record matches REST PUT', async () => {
		await insert('Dog', [{ id: 'fr-rest', name: 'Penny', breed: 'Mutt', color: 'black' }]);
		await insert('Dog', [{ id: 'fr-ops', name: 'Penny', breed: 'Mutt', color: 'black' }]);

		const put = await request(client.restURL)
			.put('/Dog/fr-rest')
			.set(client.headers)
			.send({ id: 'fr-rest', name: 'Penny', breed: 'Mutt' })
			.timeout(8_000);
		ok(put.status === 200 || put.status === 204, `REST PUT should succeed; got ${put.status}`);

		await ops({
			operation: 'upsert',
			table: 'Dog',
			full_record: true,
			records: [{ id: 'fr-ops', name: 'Penny', breed: 'Mutt' }],
		});

		const viaRest = await read('Dog', 'fr-rest');
		const viaOps = await read('Dog', 'fr-ops');
		deepStrictEqual(
			Object.keys(viaOps).sort(),
			Object.keys(viaRest).sort(),
			`the two surfaces should store the same attributes; rest=${JSON.stringify(viaRest)} ops=${JSON.stringify(viaOps)}`
		);
	});

	// A full replace that carries the foreign key keeps the relationship resolvable throughout —
	// the property a delete-then-insert gives up, since the record is absent between its two writes.
	test('full_record keeps a relationship foreign key resolvable', async () => {
		await insert('Owner', [{ id: 'own-1', name: 'Ada' }]);
		await insert('OwnedDog', [{ id: 'od-1', name: 'Penny', ownerId: 'own-1', nickname: 'Pen' }]);

		await ops({
			operation: 'update',
			table: 'OwnedDog',
			full_record: true,
			records: [{ id: 'od-1', name: 'Penny', ownerId: 'own-1' }],
		});

		const stored = await read('OwnedDog', 'od-1');
		ok(!('nickname' in stored), `nickname should be gone; stored=${JSON.stringify(stored)}`);
		strictEqual(stored.ownerId, 'own-1', 'the foreign key must survive the replace');

		// Resolve from the far side: the to-many relationship still finds the record.
		const owner = await request(client.restURL).get('/Owner/own-1?select(id,dogs{id})').set(client.headers);
		strictEqual(owner.status, 200, `owner GET should 200; got ${owner.status}`);
		const dogIds = (owner.body?.dogs ?? []).map((d: any) => d.id);
		ok(dogIds.includes('od-1'), `the relationship should still resolve; got ${JSON.stringify(owner.body)}`);
	});

	// A full replace removes the attributes the request omits, and attribute permissions are only
	// checked against the attributes it SUPPLIES — so an attribute-scoped role could otherwise erase
	// an attribute it has no permission to write. Refused in `verifyPerms` rather than silently
	// narrowed, since nothing has read the stored record at that point.
	// The role fixtures for the authorization probes below. Created once; both tests read them.
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

	// A full replace removes the attributes the request omits, and attribute permissions are only
	// checked against the attributes it SUPPLIES — so an attribute-scoped role could otherwise erase
	// an attribute it has no permission to write. Refused in `verifyPerms` rather than silently
	// narrowed, since nothing has read the stored record at that point.
	//
	test('a role with attribute permissions may not use full_record', async () => {
		await insert('Dog', [{ id: 'fr-perm', name: 'Penny', breed: 'Mutt', color: 'black' }]);
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
							// Once a table carries attribute_permissions they act as a per-attribute allowlist:
							// an attribute that isn't listed reads as absent. So list what the role may write
							// as well as the one it may not — `color` is the denial under test, and the
							// grants on id/name are what let the merge probe below still succeed.
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
			operation: 'update',
			database: 'data',
			table: 'Dog',
			full_record: true,
			records: [{ id: 'fr-perm', name: 'Penny' }],
		});
		strictEqual(
			denied.status,
			403,
			`full_record should be refused for an attribute-scoped role; got ${denied.status} ${JSON.stringify(denied.body)}`
		);

		// A refusal, not a partially-applied write.
		strictEqual((await read('Dog', 'fr-perm')).color, 'black', 'the denied request must not have removed anything');

		// The denial is scoped to the replace: the same role can still merge the attributes it owns.
		const merged = await asUser(headers, {
			operation: 'update',
			database: 'data',
			table: 'Dog',
			records: [{ id: 'fr-perm', name: 'Pen' }],
		});
		strictEqual(
			merged.status,
			200,
			`a plain merge should still work; got ${merged.status} ${JSON.stringify(merged.body)}`
		);
	});

	// `__unset__`: remove named attributes, merge everything else. The distinguishing property vs
	// full_record is that unsent attributes are KEPT, so a caller can drop one field without having
	// to resend (and risk clobbering) the rest of the record.
	test('__unset__ removes the named attributes and merges the rest', async () => {
		await insert('Dog', [{ id: 'us-1', name: 'Penny', breed: 'Mutt', color: 'black' }]);

		const r = await ops({
			operation: 'update',
			table: 'Dog',
			records: [{ id: 'us-1', name: 'Pen', __unset__: ['color'] }],
		});
		strictEqual(r.status, 200, `update should 200; got ${r.status} ${JSON.stringify(r.body)}`);

		const stored = await read('Dog', 'us-1');
		ok(!('color' in stored), `color should be gone; stored=${JSON.stringify(stored)}`);
		strictEqual(stored.name, 'Pen', 'a supplied attribute is still written');
		strictEqual(stored.breed, 'Mutt', 'an attribute the request never mentioned must survive');
		ok(!('__unset__' in stored), 'the directive itself must never be stored');
	});

	test('__unset__ removes several attributes at once', async () => {
		await insert('Dog', [{ id: 'us-2', name: 'Penny', breed: 'Mutt', color: 'black' }]);

		await ops({
			operation: 'update',
			table: 'Dog',
			records: [{ id: 'us-2', __unset__: ['color', 'breed'] }],
		});

		const stored = await read('Dog', 'us-2');
		ok(!('color' in stored) && !('breed' in stored), `both should be gone; stored=${JSON.stringify(stored)}`);
		strictEqual(stored.name, 'Penny');
	});

	// The directive is not data. `upsertRecords` collects the submitted keys and feeds any it doesn't
	// recognise to `Table.addAttributes` — but only when `!Table.schemaDefined`, so this needs a table
	// created WITHOUT a declared schema. The fixture's graphql tables are schema-defined and never
	// reach that branch, which is exactly why this probe creates its own open table: against a
	// schema-defined table the assertion passes whether or not the key is excluded.
	test('__unset__ does not become an attribute of an open table', async () => {
		const created = await ops({ operation: 'create_table', database: 'data', table: 'OpenDog', primary_key: 'id' });
		strictEqual(created.status, 200, `create_table should 200; got ${created.status} ${JSON.stringify(created.body)}`);
		await insert('OpenDog', [{ id: 'us-3', name: 'Penny', color: 'black' }]);

		const r = await ops({ operation: 'update', table: 'OpenDog', records: [{ id: 'us-3', __unset__: ['color'] }] });
		strictEqual(r.status, 200, `update should 200; got ${r.status} ${JSON.stringify(r.body)}`);

		const described = await ops({ operation: 'describe_table', database: 'data', table: 'OpenDog' });
		strictEqual(described.status, 200, `describe_table should 200; got ${described.status}`);
		const names = (described.body?.attributes ?? []).map((a: any) => a.attribute);
		ok(!names.includes('__unset__'), `__unset__ must not be an attribute; got ${JSON.stringify(names)}`);

		// ...and the removal still worked. Read with SQL rather than the `read()` helper: on a legacy
		// open table the operations-API attribute projection reports every REGISTERED attribute, filling
		// in `null` for one the record doesn't have (see the next test), so it cannot tell a removed
		// attribute from a present-and-null one. `SELECT *` reflects the stored record.
		const rows = await ops({ operation: 'sql', sql: `SELECT * FROM data.OpenDog WHERE id = 'us-3'` });
		strictEqual(rows.status, 200, `sql should 200; got ${rows.status} ${JSON.stringify(rows.body)}`);
		const stored = rows.body?.[0];
		ok(!('color' in stored), `color should be gone; stored=${JSON.stringify(stored)}`);
		strictEqual(stored.name, 'Penny');
	});

	// Not a property of this feature, but the reason the probe above can't use the usual read, and
	// worth pinning because it makes a successful removal LOOK like a failed one: on a legacy open
	// table the operations-API attribute projection is driven by the table's registered attributes, so
	// an attribute the record simply does not have comes back as `null`. A record that never had the
	// attribute reads identically to one it was removed from. Schema-defined tables omit it properly.
	// Consequence for clients: after removing an attribute from an open table, a `get_attributes` read
	// still shows the key with a null value even though nothing is stored.
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

	test('__unset__ preserves @createdTime, like any other merge', async () => {
		await insert('Dog', [{ id: 'us-4', name: 'Penny', color: 'black' }]);
		const before = await read('Dog', 'us-4');
		await sleep(10);

		await ops({ operation: 'update', table: 'Dog', records: [{ id: 'us-4', __unset__: ['color'] }] });

		const after = await read('Dog', 'us-4');
		strictEqual(after.createdAt, before.createdAt, '@createdTime must survive');
		ok(after.updatedAt > before.updatedAt, `@updatedTime should advance; ${before.updatedAt} -> ${after.updatedAt}`);
	});

	// Relationship attributes are resolved at read time from a stored foreign key. Resolving the
	// merge server-side reads the stored record back, so this pins that a relationship table survives
	// the round trip — a read that materialised a relationship property would fail the write, since
	// Harper rejects any record that assigns one.
	test('__unset__ works on a table with relationships, and keeps the foreign key', async () => {
		await insert('Owner', [{ id: 'us-own', name: 'Ada' }]);
		await insert('OwnedDog', [{ id: 'us-od', name: 'Penny', ownerId: 'us-own', nickname: 'Pen' }]);

		const r = await ops({
			operation: 'update',
			table: 'OwnedDog',
			records: [{ id: 'us-od', __unset__: ['nickname'] }],
		});
		strictEqual(r.status, 200, `update should 200; got ${r.status} ${JSON.stringify(r.body)}`);

		const stored = await read('OwnedDog', 'us-od');
		ok(!('nickname' in stored), `nickname should be gone; stored=${JSON.stringify(stored)}`);
		strictEqual(stored.ownerId, 'us-own', 'the foreign key must survive');

		const owner = await request(client.restURL).get('/Owner/us-own?select(id,dogs{id})').set(client.headers);
		strictEqual(owner.status, 200, `owner GET should 200; got ${owner.status}`);
		const dogIds = (owner.body?.dogs ?? []).map((d: any) => d.id);
		ok(dogIds.includes('us-od'), `the relationship should still resolve; got ${JSON.stringify(owner.body)}`);
	});

	test('__unset__ of an attribute the record does not have is a no-op', async () => {
		await insert('Dog', [{ id: 'us-5', name: 'Penny' }]);

		const r = await ops({
			operation: 'update',
			table: 'Dog',
			records: [{ id: 'us-5', __unset__: ['nonexistent'] }],
		});
		strictEqual(r.status, 200, `update should 200; got ${r.status} ${JSON.stringify(r.body)}`);
		strictEqual((await read('Dog', 'us-5')).name, 'Penny');
	});

	// A removal is a write to that attribute, so it needs the same `update` permission writing it
	// would — otherwise `__unset__` would be a way around attribute permissions, which is exactly
	// what the blanket `full_record` denial exists to prevent. Here the removals are named, so the
	// check can be precise instead: the role may unset what it can write, and nothing else.
	test('__unset__ is checked against attribute update permission', async () => {
		await insert('Dog', [{ id: 'us-perm', name: 'Penny', breed: 'Mutt', color: 'black' }]);
		const headers = await addScopedRole(
			'unset_scoped',
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
								{ attribute_name: 'breed', read: true, insert: true, update: true },
								{ attribute_name: 'color', read: true, insert: true, update: false },
							],
						},
					},
				},
			},
			'unset_scoped_user'
		);

		const denied = await asUser(headers, {
			operation: 'update',
			database: 'data',
			table: 'Dog',
			records: [{ id: 'us-perm', __unset__: ['color'] }],
		});
		strictEqual(
			denied.status,
			403,
			`unsetting an attribute the role can't update must be refused; got ${denied.status} ${JSON.stringify(denied.body)}`
		);
		strictEqual((await read('Dog', 'us-perm')).color, 'black', 'the denied request must not have removed anything');

		const allowed = await asUser(headers, {
			operation: 'update',
			database: 'data',
			table: 'Dog',
			records: [{ id: 'us-perm', __unset__: ['breed'] }],
		});
		strictEqual(
			allowed.status,
			200,
			`unsetting an attribute the role CAN update must work; got ${allowed.status} ${JSON.stringify(allowed.body)}`
		);
		ok(!('breed' in (await read('Dog', 'us-perm'))), 'breed should be gone');
	});

	test('__unset__ refuses the primary key rather than silently ignoring it', async () => {
		await insert('Dog', [{ id: 'us-6', name: 'Penny' }]);

		const r = await ops({ operation: 'update', table: 'Dog', records: [{ id: 'us-6', __unset__: ['id'] }] });
		ok(r.status >= 400, `unsetting the primary key should be refused; got ${r.status} ${JSON.stringify(r.body)}`);
		strictEqual((await read('Dog', 'us-6')).name, 'Penny', 'nothing should have changed');
	});

	test('__unset__ refuses a system timestamp', async () => {
		await insert('Dog', [{ id: 'us-7', name: 'Penny' }]);

		const r = await ops({
			operation: 'update',
			table: 'Dog',
			records: [{ id: 'us-7', __unset__: ['__createdtime__'] }],
		});
		ok(r.status >= 400, `unsetting a system timestamp should be refused; got ${r.status} ${JSON.stringify(r.body)}`);
	});

	test('a malformed __unset__ is rejected', async () => {
		await insert('Dog', [{ id: 'us-8', name: 'Penny', color: 'black' }]);

		for (const unset of ['color', { color: 1 }, [''], [42]]) {
			const r = await ops({ operation: 'update', table: 'Dog', records: [{ id: 'us-8', __unset__: unset }] });
			ok(r.status >= 400, `__unset__: ${JSON.stringify(unset)} should be refused; got ${r.status}`);
		}
		strictEqual((await read('Dog', 'us-8')).color, 'black', 'no rejected request may have written');
	});

	test('a non-boolean full_record is rejected rather than coerced', async () => {
		await insert('Dog', [{ id: 'fr-6', name: 'Penny', breed: 'Mutt', color: 'black' }]);

		const r = await ops({
			operation: 'update',
			table: 'Dog',
			full_record: 'false',
			records: [{ id: 'fr-6', name: 'Penny' }],
		});
		ok(r.status >= 400, `a string full_record should be rejected; got ${r.status} ${JSON.stringify(r.body)}`);

		const stored = await read('Dog', 'fr-6');
		strictEqual(stored.color, 'black', 'the rejected request must not have replaced anything');
	});
});
