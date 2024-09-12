'use strict';

const { evaluateSQL } = require('../../sqlTranslator');
const promisify = require('util').promisify;
const sql_test_utils = require('../sqlTestUtils');
const { setupCSVSqlData, cleanupCSVData, sqlIntegrationData } = sql_test_utils;
const TEST_SCHEMA_NORTHWND = 'northwnd';
const assert = require('assert');
const executeSQL = promisify(evaluateSQL);

describe('Test SQL Update/Insert/Delete', function () {
	describe('SQL UPDATE', function () {
		before(async function () {
			await setupCSVSqlData();
		});
		after(async function () {
			await cleanupCSVData();
		});

		it('should update entries via SQL UPDATE', async function () {
			const { data, hash } = sqlIntegrationData.customers;
			const test_row = data[5];
			const test_update_statement = `UPDATE ${TEST_SCHEMA_NORTHWND}.customers SET city = 'Portland' WHERE ${hash} = '${test_row[hash]}'`;
			let search_results = await executeSQL({
				sql: test_update_statement,
				bypass_auth: true,
			});
			const test_sql_statement = `SELECT * FROM ${TEST_SCHEMA_NORTHWND}.customers WHERE ${hash} = '${test_row[hash]}'`;
			search_results = await executeSQL({
				sql: test_sql_statement,
				bypass_auth: true,
			});
			assert.strictEqual(search_results[0].city, 'Portland');
		});

		it('should increment postcode twice concurrently via SQL UPDATE with correct isolation/serialization', async function () {
			const { data, hash } = sqlIntegrationData.customers;
			const test_row = data[5];
			const test_update_statement = `UPDATE ${TEST_SCHEMA_NORTHWND}.customers SET postalcode = postalcode + 1 WHERE ${hash} = '${test_row[hash]}'`;
			// attempt to execute two UPDATES concurrently to ensure they are actually properly serialized
			let search_results = await Promise.all(
				[1, 2].map(() =>
					executeSQL({
						sql: test_update_statement,
						bypass_auth: true,
					})
				)
			);
			const test_sql_statement = `SELECT * FROM ${TEST_SCHEMA_NORTHWND}.customers WHERE ${hash} = '${test_row[hash]}'`;
			search_results = await executeSQL({
				sql: test_sql_statement,
				bypass_auth: true,
			});
			// if both transactions read from the same state, postalcode will only by one.
			assert.strictEqual(search_results[0].postalcode, test_row.postalcode + 2);
		});
		it('SQL DELETE', async function () {
			const { data, hash } = sqlIntegrationData.customers;
			const test_row = data[4];
			const test_update_statement = `DELETE FROM ${TEST_SCHEMA_NORTHWND}.customers WHERE ${hash} = '${test_row[hash]}'`;
			let sql_results = await executeSQL({
				sql: test_update_statement,
				bypass_auth: true,
			});
			const test_sql_statement = `SELECT * FROM ${TEST_SCHEMA_NORTHWND}.customers WHERE ${hash} = '${test_row[hash]}'`;
			sql_results = await executeSQL({
				sql: test_sql_statement,
				bypass_auth: true,
			});
			// should be deleted now
			assert.strictEqual(sql_results.length, 0);
		});
		it('SQL DELETE concurrently', async function () {
			const { data, hash } = sqlIntegrationData.customers;
			const test_row = data[3];
			const test_update_statement = `DELETE FROM ${TEST_SCHEMA_NORTHWND}.customers WHERE ${hash} = '${test_row[hash]}'`;
			// attempt to execute two DELETE concurrently to ensure they are actually properly serialized
			let sql_results = await Promise.all(
				[1, 2].map(() =>
					executeSQL({
						sql: test_update_statement,
						bypass_auth: true,
					})
				)
			);
			// the important here is that the first succeeds and that the second MUST not delete anything
			assert.strictEqual(sql_results[0].deleted_hashes.length, 1);
			assert.strictEqual(sql_results[0].skipped_hashes.length, 0);
			assert.strictEqual(sql_results[1].deleted_hashes.length, 0);
			const test_sql_statement = `SELECT * FROM ${TEST_SCHEMA_NORTHWND}.customers WHERE ${hash} = '${test_row[hash]}'`;
			sql_results = await executeSQL({
				sql: test_sql_statement,
				bypass_auth: true,
			});
			// should be deleted now
			assert.strictEqual(sql_results.length, 0);
		});
		it('SQL INSERT', async function () {
			const { data, hash } = sqlIntegrationData.customers;
			const test_update_statement = `INSERT INTO ${TEST_SCHEMA_NORTHWND}.customers (customerid, customername) VALUES ('new-id', 'new-name')`;
			let sql_results = await executeSQL({
				sql: test_update_statement,
				bypass_auth: true,
			});
			const test_sql_statement = `SELECT * FROM ${TEST_SCHEMA_NORTHWND}.customers WHERE ${hash} = 'new-id'`;
			sql_results = await executeSQL({
				sql: test_sql_statement,
				bypass_auth: true,
			});
			// should be deleted now
			assert.strictEqual(sql_results.length, 1);
		});

		it('SQL INSERT concurrently', async function () {
			const { data, hash } = sqlIntegrationData.customers;
			const test_row = data[4];
			const test_update_statement = `INSERT INTO ${TEST_SCHEMA_NORTHWND}.customers (customerid, customername) VALUES ('new-id2', 'new-name')`;
			// attempt to execute two UPDATES concurrently to ensure they are actually properly serialized
			let sql_results = await Promise.all(
				[1, 2].map(() =>
					executeSQL({
						sql: test_update_statement,
						bypass_auth: true,
					})
				)
			);
			// the important here is that the first succeeds and that the second MUST fail
			assert.strictEqual(sql_results[0].inserted_hashes.length, 1);
			assert.strictEqual(sql_results[0].skipped_hashes.length, 0);
			assert.strictEqual(sql_results[1].inserted_hashes.length, 0);
			assert.strictEqual(sql_results[1].skipped_hashes.length, 1);

			const test_sql_statement = `SELECT * FROM ${TEST_SCHEMA_NORTHWND}.customers WHERE ${hash} = 'new-id2'`;
			sql_results = await executeSQL({
				sql: test_sql_statement,
				bypass_auth: true,
			});
			// should be deleted now
			assert.strictEqual(sql_results.length, 1);
		});
	});
});
