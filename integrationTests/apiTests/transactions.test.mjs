/**
 * Transactions / audit-log integration tests.
 *
 * Ported from legacy `apiTests/tests/9_transactions.mjs`. Verifies that
 * `read_audit_log` reflects insert/update/delete/upsert mutations and supports
 * filtering by timestamp / username / hash_value, plus that the deprecated
 * `delete_audit_logs_before` still returns the deprecation hint.
 *
 * Self-contained: each suite creates its own `test_delete_before.testerama`
 * and `test_delete_before.test_read` tables. Audit logging must be enabled
 * for `read_audit_log` to surface entries; the legacy run flipped this on
 * via the runtime `8a_restartHdbToUpdateConfig` step. In the new framework
 * we just pass `logging.auditLog: true` to `startHarper` at boot.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';
import { awaitJob, getJobId } from './utils/operations.mjs';

const SCHEMA = 'test_delete_before';
const TABLE_DEPRECATED = 'testerama';
const TABLE_AUDIT = 'test_read';

suite('Transactions / audit log', (ctx) => {
	let client;
	let username;
	let insertTimestamp;

	before(async () => {
		await startHarper(ctx, {
			config: { logging: { auditLog: true } },
			env: {},
		});
		client = createApiClient(ctx.harper);
		username = ctx.harper.admin.username;
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('create testerama table', async () => {
		await client
			.req()
			.send({ operation: 'create_table', schema: SCHEMA, table: TABLE_DEPRECATED, primary_key: 'id' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
		await setTimeout(500);
	});

	test('Insert first batch into testerama', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: SCHEMA,
				table: TABLE_DEPRECATED,
				records: [
					{ id: 1, address: '24 South st' },
					{ id: 2, address: '6 Truck Lane' },
					{ id: 3, address: '19 Broadway' },
					{ id: 4, address: '34A Mountain View' },
					{ id: 5, address: '234 Curtis St' },
					{ id: 6, address: '115 Way Rd' },
				],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 6, r.text))
			.expect(200);
		await setTimeout(1000);
	});

	test('Insert second batch into testerama (capture pre-insert timestamp)', async () => {
		insertTimestamp = Date.now();
		await client
			.req()
			.send({
				operation: 'insert',
				schema: SCHEMA,
				table: TABLE_DEPRECATED,
				records: [
					{ id: 11, address: '24 South st' },
					{ id: 12, address: '6 Truck Lane' },
					{ id: 13, address: '19 Broadway' },
				],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 3, r.text))
			.expect(200);
	});

	test('delete_audit_logs_before returns deprecation hint', async () => {
		const response = await client
			.req()
			.send({
				operation: 'delete_audit_logs_before',
				timestamp: `${insertTimestamp}`,
				schema: SCHEMA,
				table: TABLE_DEPRECATED,
			})
			.expect(200);

		const jobId = getJobId(response.body);
		const jobResponse = await awaitJob(client, jobId, 15);
		assert.ok(jobResponse.body[0].message.includes('Successfully completed'), jobResponse.text);
		assert.equal(
			jobResponse.body[0].result?.deprecated,
			'Please use delete_transaction_logs_before instead',
			jobResponse.text
		);
	});

	test('create test_read table', async () => {
		await client
			.req()
			.send({ operation: 'create_table', schema: SCHEMA, table: TABLE_AUDIT, primary_key: 'id' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
		await setTimeout(500);
	});

	test('Insert two records into test_read', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: SCHEMA,
				table: TABLE_AUDIT,
				records: [
					{ id: 1, name: 'Penny' },
					{ id: 2, name: 'Kato', age: 6 },
				],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 2, r.text))
			.expect(200);
		await setTimeout(100);
	});

	test('Insert one more record into test_read', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: SCHEMA,
				table: TABLE_AUDIT,
				records: [{ id: 3, name: 'Riley', age: 7 }],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 1, r.text))
			.expect(200);
		await setTimeout(100);
	});

	test('Update two records', async () => {
		await client
			.req()
			.send({
				operation: 'update',
				schema: SCHEMA,
				table: TABLE_AUDIT,
				records: [
					{ id: 1, name: 'Penny B', age: 8 },
					{ id: 2, name: 'Kato B' },
				],
			})
			.expect((r) => assert.equal(r.body.update_hashes.length, 2, r.text))
			.expect(200);
		await setTimeout(100);
	});

	test('Insert record with string id', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: SCHEMA,
				table: TABLE_AUDIT,
				records: [{ id: 'blerrrrr', name: 'Rosco' }],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 1, r.text))
			.expect(200);
		await setTimeout(100);
	});

	test('Update string-id record', async () => {
		await client
			.req()
			.send({
				operation: 'update',
				schema: SCHEMA,
				table: TABLE_AUDIT,
				records: [{ id: 'blerrrrr', breed: 'Mutt' }],
			})
			.expect((r) => assert.equal(r.body.update_hashes.length, 1, r.text))
			.expect(200);
		await setTimeout(100);
	});

	test('Delete two records', async () => {
		await client
			.req()
			.send({ operation: 'delete', schema: SCHEMA, table: TABLE_AUDIT, hash_values: [3, 1] })
			.expect((r) => assert.equal(r.body.deleted_hashes.length, 2, r.text))
			.expect(200);
		await setTimeout(100);
	});

	test('Insert id=4 record', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: SCHEMA,
				table: TABLE_AUDIT,
				records: [{ id: 4, name: 'Griff' }],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 1, r.text))
			.expect(200);
		await setTimeout(100);
	});

	test('Upsert records (one with no id)', async () => {
		await client
			.req()
			.send({
				operation: 'upsert',
				schema: SCHEMA,
				table: TABLE_AUDIT,
				records: [
					{ id: 4, name: 'Griffy Jr.' },
					{ id: 5, name: 'Gizmo', age: 10 },
					{ name: 'Moe', age: 11 },
				],
			})
			.expect((r) => assert.equal(r.body.upserted_hashes.length, 3, r.text))
			.expect(200);
		await setTimeout(100);
	});

	test('read_audit_log records upsert transaction by hash_value=5', async () => {
		await client
			.req()
			.send({
				operation: 'read_audit_log',
				schema: SCHEMA,
				table: TABLE_AUDIT,
				search_type: 'hash_value',
				search_values: [5],
			})
			.expect((r) => {
				assert.equal(r.body['5'].length, 1, r.text);
				const transaction = r.body['5'][0];
				assert.equal(transaction.operation, 'upsert', r.text);
				assert.equal(transaction.records.length, 1, r.text);
				for (const key of Object.keys(transaction.records[0])) {
					assert.ok(['id', 'name', 'age', '__updatedtime__', '__createdtime__'].includes(key), r.text);
				}
			})
			.expect(200);
	});

	test('read_audit_log returns all 8 transactions in order', async () => {
		await client
			.req()
			.send({ operation: 'read_audit_log', schema: SCHEMA, table: TABLE_AUDIT })
			.expect((r) => {
				assert.equal(r.body.length, 8, r.text);

				const expectedAttrs = ['id', 'name', '__updatedtime__'];
				const otherAttrs = ['age', '__createdtime__'];

				const upsertTrans = r.body[7];
				assert.equal(upsertTrans.operation, 'upsert', r.text);
				assert.equal(upsertTrans.records.length, 3, r.text);

				assert.equal(upsertTrans.records[0].id, 4, r.text);
				assert.equal(upsertTrans.records[1].id, 5, r.text);
				assert.equal(typeof upsertTrans.records[2].id, 'number', r.text);

				for (const record of upsertTrans.records) {
					for (const key of Object.keys(record)) {
						assert.ok([...expectedAttrs, ...otherAttrs].includes(key), r.text);
					}
				}
			})
			.expect(200);
	});

	test('read_audit_log by timestamp returns 8 transactions', async () => {
		await client
			.req()
			.send({
				operation: 'read_audit_log',
				schema: SCHEMA,
				table: TABLE_AUDIT,
				search_type: 'timestamp',
				search_values: [],
			})
			.expect((r) => assert.equal(r.body.length, 8, r.text))
			.expect(200);
	});

	test('read_audit_log by username returns 8 transactions for admin', async () => {
		await client
			.req()
			.send({
				operation: 'read_audit_log',
				schema: SCHEMA,
				table: TABLE_AUDIT,
				search_type: 'username',
				search_values: [username],
			})
			.expect((r) => assert.equal(r.body[username].length, 8, r.text))
			.expect(200);
	});

	test('read_audit_log by hash_value returns history per record', async () => {
		await client
			.req()
			.send({
				operation: 'read_audit_log',
				schema: SCHEMA,
				table: TABLE_AUDIT,
				search_type: 'hash_value',
				search_values: [1, 'blerrrrr'],
			})
			.expect((r) => {
				assert.equal(r.body['1'].length, 3, r.text);
				assert.equal(r.body['blerrrrr'].length, 2, r.text);
			})
			.expect(200);
	});

	test('drop test_read table', async () => {
		await client.req().send({ operation: 'drop_table', schema: SCHEMA, table: TABLE_AUDIT }).expect(200);
	});
});
