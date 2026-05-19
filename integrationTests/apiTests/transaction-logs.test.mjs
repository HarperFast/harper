/**
 * Transaction Logs integration tests.
 *
 * Ported from legacy `apiTests/tests/28_transactionLogs.mjs`. Verifies
 * `read_transaction_log` returns one entry per insert batch and that
 * `delete_transaction_logs_before` runs to completion as a job. Self-contained:
 * each suite owns its own `test_delete_before.test_logs` table on a throwaway
 * Harper instance.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';
import { awaitJob, getJobId } from './utils/operations.mjs';

const SCHEMA = 'test_delete_before';
const TABLE = 'test_logs';

suite('Transaction Logs', (ctx) => {
	let client;
	const suiteStart = Date.now();

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		await client
			.req()
			.send({ operation: 'create_table', schema: SCHEMA, table: TABLE, primary_key: 'id' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
		// Give the table time to settle before the first read_transaction_log.
		await setTimeout(500);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('Read transaction logs before any inserts is empty', async () => {
		await client
			.req()
			.send({ operation: 'read_transaction_log', schema: SCHEMA, table: TABLE })
			.expect((r) => assert.equal(r.body.length, 0, r.text))
			.expect(200);
	});

	test('Insert first batch of records', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: SCHEMA,
				table: TABLE,
				records: [
					{ id: 1, color: 'red' },
					{ id: 2, color: 'blue' },
					{ id: 3, color: 'green' },
					{ id: 4, color: 'yellow' },
					{ id: 5, color: 'purple' },
					{ id: 6, color: 'orange' },
				],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 6, r.text))
			.expect(200);
		// Allow the transaction log to flush so the subsequent read sees the batch.
		await setTimeout(1000);
	});

	test('Read transaction logs after first batch', async () => {
		await client
			.req()
			.send({ operation: 'read_transaction_log', schema: SCHEMA, table: TABLE })
			.expect((r) => {
				assert.equal(r.body.length, 1, r.text);
				assert.equal(r.body[0].operation, 'insert', r.text);
				assert.equal(r.body[0].records.length, 6, r.text);
			})
			.expect(200);
	});

	test('Insert second batch of records', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: SCHEMA,
				table: TABLE,
				records: [
					{ id: 11, color: 'brown' },
					{ id: 12, color: 'gray' },
					{ id: 13, color: 'black' },
				],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 3, r.text))
			.expect(200);
		await setTimeout(1000);
	});

	test('Read transaction logs after second batch', async () => {
		await client
			.req()
			.send({ operation: 'read_transaction_log', schema: SCHEMA, table: TABLE })
			.expect((r) => {
				assert.equal(r.body.length, 2, r.text);
				assert.equal(r.body[1].operation, 'insert', r.text);
				assert.equal(r.body[1].records.length, 3, r.text);
			})
			.expect(200);
	});

	test('delete_transaction_logs_before suiteStart deletes no files', async () => {
		// `suiteStart` is from before any inserts happened — no log files should
		// have been rotated out yet, so the job should run to completion with
		// `log_files_deleted: 0`.
		const response = await client
			.req()
			.send({
				operation: 'delete_transaction_logs_before',
				timestamp: `${suiteStart}`,
				schema: SCHEMA,
				table: TABLE,
			})
			.expect(200);

		const jobId = getJobId(response.body);
		const jobResponse = await awaitJob(client, jobId, 15);
		assert.equal(jobResponse.body[0].result.log_files_deleted, 0, jobResponse.text);
	});

	test('drop test_logs table', async () => {
		await client.req().send({ operation: 'drop_table', schema: SCHEMA, table: TABLE }).expect(200);
	});
});
