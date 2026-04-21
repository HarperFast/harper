import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkJob, getJobId } from '../utils/jobs.mjs';
import { setTimeout } from 'node:timers/promises';
import { req } from '../utils/request.mjs';
import { timestamp } from '../utils/timestamp.mjs';

describe('28. Transaction Logs', () => {
	beforeEach(timestamp);

	const beforeTimestamp = Date.now();

	it('create test table', async () => {
		await req()
			.send({
				operation: 'create_table',
				schema: 'test_delete_before',
				table: 'test_logs',
				primary_key: 'id',
			})
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
		await setTimeout(500);
	});

	it('Read transaction logs before inserts', async () => {
		await req()
			.send({ operation: 'read_transaction_log', schema: 'test_delete_before', table: 'test_logs' })
			.expect((r) => assert.equal(r.body.length, 0, r.text))
			.expect(200);
		await setTimeout(100);
	});

	it('Insert new records', async () => {
		await req()
			.send({
				operation: 'insert',
				schema: 'test_delete_before',
				table: 'test_logs',
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
		await setTimeout(1000);
	});

	it('Read transaction logs after inserts', async () => {
		await req()
			.send({ operation: 'read_transaction_log', schema: 'test_delete_before', table: 'test_logs' })
			.expect((r) => {
				assert.equal(r.body.length, 1, r.text);
				assert.equal(r.body[0].operation, 'insert', r.text);
				assert.equal(r.body[0].records.length, 6, r.text);
			});
		await setTimeout(100);
	});

	it('Insert additional new records', async () => {
		await req()
			.send({
				operation: 'insert',
				schema: 'test_delete_before',
				table: 'test_logs',
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

	it('Read transaction logs after additional inserts', async () => {
		await req()
			.send({ operation: 'read_transaction_log', schema: 'test_delete_before', table: 'test_logs' })
			.expect((r) => {
				assert.equal(r.body.length, 2, r.text);
				assert.equal(r.body[1].operation, 'insert', r.text);
				assert.equal(r.body[1].records.length, 3, r.text);
			});
		await setTimeout(100);
	});

	it('Delete transaction logs before inserts', async () => {
		const response = await req()
			.send({
				operation: 'delete_transaction_logs_before',
				timestamp: `${beforeTimestamp}`,
				schema: 'test_delete_before',
				table: 'test_logs',
			})
			.expect(200);

		const id = await getJobId(response.body);
		const jobResponse = await checkJob(id, 15);
		assert.equal(jobResponse.body[0].result.log_files_deleted, 0, jobResponse.text);
	});

	// TODO: This test fails because we need the all transactions to be flushed so the log file
	// can be deleted, however something starts a transaction and writes a log entry, but doesn't
	// flush before `rocksdb-js` purges the logs. Harper will likely need a way to force the logs
	// to be flushed.
	//
	// it('Delete records after additional inserts', async () => {
	// 	const response = await req()
	// 		.send({
	// 			operation: 'delete_transaction_logs_before',
	// 			timestamp: `${Date.now()}`,
	// 			schema: 'test_delete_before',
	// 			table: 'test_logs',
	// 		})
	// 		.expect(200);

	// 	const id = await getJobId(response.body);
	// 	const jobResponse = await checkJob(id, 15);
	// 	assert.equal(jobResponse.body[0].result.log_files_deleted, 1, jobResponse.text);
	// });

	it('drop test_logs table', async () => {
		await req().send({ operation: 'drop_table', schema: 'test_delete_before', table: 'test_logs' }).expect(200);
		await setTimeout(500);
	});
});
