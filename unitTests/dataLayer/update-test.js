'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const alasql = require('alasql');
const rewire = require('rewire');
const sql = require('../../sqlTranslator/index');
const update = rewire('../../dataLayer/update');
const insert = require('../../dataLayer/insert');
const test_utils = require('../test_utils');
const transact_to_clustering_utilities = require('../../utility/clustering/transactToClusteringUtilities');

describe('Test update module', () => {
	const sandbox = sinon.createSandbox();

	const hdb_user = {
		role: {
			role: 'super_user',
		},
		username: 'admin',
	};

	after(() => {
		sandbox.restore();
		rewire('../../dataLayer/update');
	});

	describe('Tests update function', () => {
		const p_search_stub = sandbox.stub();
		const transaction_stub = {
			writeTransaction: (schema, table, callback) => callback(),
		};
		const write_stub = {
			flush: () => {},
		};
		const update_records_stub = sandbox.stub().resolves();
		let p_get_table_schema_rw;
		let p_search_rw;
		let update_records_rw;
		let alasql_parse_spy;
		let transaction_rw;
		let write_rw;

		const fake_table_info = {
			hash_attribute: 'id',
			id: 'b582c9f4-cc10-492a-9a2d-10f142410f97',
			name: 'dog',
			schema: 'dev',
			attributes: [
				{
					attribute: 'owner_name',
				},
				{
					attribute: 'age',
				},
				{
					attribute: 'adorable',
				},
				{
					attribute: '__updatedtime__',
				},
				{
					attribute: 'id',
				},
				{
					attribute: 'dog_name',
				},
				{
					attribute: '__createdtime__',
				},
				{
					attribute: 'weight_lbs',
				},
				{
					attribute: 'breed_id',
				},
			],
		};

		const p_get_table_schema_stub = sandbox.stub().resolves(fake_table_info);

		before(() => {
			transaction_rw = update.__set__('transaction', transaction_stub);
			p_get_table_schema_rw = update.__set__('pGetTableSchema', p_get_table_schema_stub);
			p_search_rw = update.__set__('pSearch', p_search_stub);
			update_records_rw = update.__set__('updateRecords', update_records_stub);
			write_rw = update.__set__('write', write_stub);
			alasql_parse_spy = sandbox.spy(alasql, 'parse');
		});

		after(() => {
			p_get_table_schema_rw();
			p_search_rw();
			update_records_rw();
			write_rw();
			transaction_rw();
		});

		afterEach(() => {
			sinon.resetHistory();
		});

		it('Tests update function with simple where query', async () => {
			const sql_update_qry = "UPDATE dev.dog SET name = 'Gary' WHERE id = 1";
			const test_ast_statement = sql.convertSQLToAST(sql_update_qry).ast.statements[0];

			const records_fake = [
				{
					id: 1,
				},
			];
			p_search_stub.resolves(records_fake);

			const expected_select_string = 'SELECT id FROM `dev`.`dog`  WHERE `id` = 1';
			const expected_search_statement = alasql.parse(expected_select_string).statements[0];
			const expected_new_records = [
				{
					id: 1,
					name: 'Gary',
				},
			];

			sandbox.resetHistory();
			await update.update({ statement: test_ast_statement, hdb_user });

			expect(alasql_parse_spy.firstCall.args[0]).to.equal(expected_select_string);
			expect(p_search_stub.firstCall.args[0]).to.eql(expected_search_statement);
			expect(update_records_stub.firstCall.args[1]).to.eql(expected_new_records);
		});

		it('Tests update function WITHOUT where query', async () => {
			const sql_update_qry = "UPDATE dev.dog SET dog_name = 'Flor'";
			const test_ast_statement = sql.convertSQLToAST(sql_update_qry).ast.statements[0];

			const records_fake = [
				{
					id: 1,
				},
				{
					id: 2,
				},
				{
					id: 3,
				},
				{
					id: 4,
				},
				{
					id: 5,
				},
			];
			p_search_stub.resolves(records_fake);

			const expected_select_string = 'SELECT id FROM `dev`.`dog` ';
			const expected_search_statement = alasql.parse(expected_select_string).statements[0];
			const expected_new_records = [
				{
					id: 1,
					dog_name: 'Flor',
				},
				{
					id: 2,
					dog_name: 'Flor',
				},
				{
					id: 3,
					dog_name: 'Flor',
				},
				{
					id: 4,
					dog_name: 'Flor',
				},
				{
					id: 5,
					dog_name: 'Flor',
				},
			];

			sandbox.resetHistory();
			await update.update({ statement: test_ast_statement, hdb_user });

			expect(alasql_parse_spy.firstCall.args[0]).to.equal(expected_select_string);
			expect(p_search_stub.firstCall.args[0]).to.eql(expected_search_statement);
			expect(update_records_stub.firstCall.args[1]).to.eql(expected_new_records);
		});

		it('Tests update function with where query, but value does not exist', async () => {
			const sql_update_qry = "UPDATE dev.dog SET name = 'Barb' WHERE id = 0";
			const test_ast_statement = sql.convertSQLToAST(sql_update_qry).ast.statements[0];

			const records_fake = [];
			p_search_stub.resolves(records_fake);

			const expected_select_string = 'SELECT id FROM `dev`.`dog`  WHERE `id` = 0';
			const expected_search_statement = alasql.parse(expected_select_string).statements[0];
			const expected_new_records = [];

			sandbox.resetHistory();
			await update.update({ statement: test_ast_statement, hdb_user });

			expect(alasql_parse_spy.firstCall.args[0]).to.equal(expected_select_string);
			expect(p_search_stub.firstCall.args[0]).to.eql(expected_search_statement);
			expect(update_records_stub.firstCall.args[1]).to.eql(expected_new_records);
		});

		it('Tests update function updating multiple columns with multiple wheres.', async () => {
			const sql_update_qry = 'UPDATE dev.dog SET dog_name = "Richard", height = 1 WHERE id = 1 AND dog_name = "Bob"';
			const test_ast_statement = sql.convertSQLToAST(sql_update_qry).ast.statements[0];

			const records_fake = [
				{
					id: 1,
				},
			];
			p_search_stub.resolves(records_fake);

			const expected_select_string = "SELECT id FROM `dev`.`dog`  WHERE `id` = 1 AND `dog_name` = 'Bob'";
			const expected_search_statement = alasql.parse(expected_select_string).statements[0];
			const expected_new_records = [
				{
					id: 1,
					dog_name: 'Richard',
					height: 1,
				},
			];

			sandbox.resetHistory();
			await update.update({ statement: test_ast_statement, hdb_user });

			expect(alasql_parse_spy.firstCall.args[0]).to.equal(expected_select_string);
			expect(p_search_stub.firstCall.args[0]).to.eql(expected_search_statement);
			expect(update_records_stub.firstCall.args[1]).to.eql(expected_new_records);
		});

		it('Tests update function with != where query', async () => {
			const sql_update_qry = "UPDATE dev.dog SET name = 'Gary' WHERE id != 1";
			const test_ast_statement = sql.convertSQLToAST(sql_update_qry).ast.statements[0];

			const records_fake = [
				{
					id: 2,
				},
				{
					id: 3,
				},
				{
					id: 4,
				},
			];
			p_search_stub.resolves(records_fake);

			const expected_select_string = 'SELECT id FROM `dev`.`dog`  WHERE `id` != 1';
			const expected_search_statement = alasql.parse(expected_select_string).statements[0];
			const expected_new_records = [
				{
					id: 2,
					name: 'Gary',
				},
				{
					id: 3,
					name: 'Gary',
				},
				{
					id: 4,
					name: 'Gary',
				},
			];

			sandbox.resetHistory();
			await update.update({ statement: test_ast_statement, hdb_user });

			expect(alasql_parse_spy.firstCall.args[0]).to.equal(expected_select_string);
			expect(p_search_stub.firstCall.args[0]).to.eql(expected_search_statement);
			expect(update_records_stub.firstCall.args[1]).to.eql(expected_new_records);
		});

		it('Tests update function with null where query', async () => {
			const sql_update_qry = 'UPDATE dev.dog SET friendly = false WHERE friendly is null';
			const test_ast_statement = sql.convertSQLToAST(sql_update_qry).ast.statements[0];

			const records_fake = [
				{
					id: 1,
					name: 'Hambone',
				},
				{
					id: 2,
					name: 'Frank',
				},
				{
					id: 3,
					name: 'Sansa',
				},
			];
			p_search_stub.resolves(records_fake);

			const expected_select_string = 'SELECT id FROM `dev`.`dog`  WHERE `friendly` IS NULL';
			const expected_search_statement = alasql.parse(expected_select_string).statements[0];
			const expected_new_records = [
				{
					id: 1,
					name: 'Hambone',
					friendly: false,
				},
				{
					id: 2,
					name: 'Frank',
					friendly: false,
				},
				{
					id: 3,
					name: 'Sansa',
					friendly: false,
				},
			];

			sandbox.resetHistory();
			await update.update({ statement: test_ast_statement, hdb_user });

			expect(alasql_parse_spy.firstCall.args[0]).to.equal(expected_select_string);
			expect(p_search_stub.firstCall.args[0]).to.eql(expected_search_statement);
			expect(update_records_stub.firstCall.args[1]).to.eql(expected_new_records);
		});

		it('Tests update function throws error', async () => {
			const sql_update_qry = 'UPDATE dev.dog SET dog_name = "Garfield" WHERE id = 1';
			const test_ast_statement = sql.convertSQLToAST(sql_update_qry).ast.statements[0];

			const test_error = new Error('fake error');
			p_get_table_schema_stub.throws(test_error);

			await test_utils.assertErrorAsync(update.update, [{ statement: test_ast_statement, hdb_user }], test_error);
		});
	});

	describe('Test createUpdateRecord function', () => {
		let create_update_record_rw;
		const fake_columns = [
			{
				column: {
					columnid: 'dog_name',
				},
			},
		];

		const fake_columns_missing_value = [
			{
				column: {
					columnid: 'dog_name',
				},
				expression: {},
			},
		];

		before(() => {
			create_update_record_rw = update.__get__('createUpdateRecord');
		});

		it("NOMINAL - should assign value from column expression to record's columnid", () => {
			let column_obj = test_utils.deepClone(fake_columns);
			column_obj[0].expression = { value: 'Hank' };
			const result = create_update_record_rw(column_obj);
			expect(result.dog_name).to.equal('Hank');
		});

		it('Tests that an error is thrown', () => {
			test_utils.assertErrorSync(
				create_update_record_rw,
				[fake_columns],
				new Error('There was a problem performing this update. Please check the logs and try again.')
			);
		});

		it('Tests alasql compile called if value not in column expression', () => {
			const result = create_update_record_rw(fake_columns_missing_value);
			expect(result.dog_name.name).to.equal('statement');
		});
	});

	describe('Test updateRecords function', async () => {
		let update_records_rw;
		let post_operation_handler_stub;
		let write_update_stub;

		const fake_records = [
			{
				id: 1,
				dog_name: 'Frank',
			},
		];

		const fake_table = {
			databaseid: '`dev`',
			tableid: '`dog`',
			tableid_orig: 'dog',
			databaseid_orig: 'dev',
		};

		let args = { table: fake_table, records: fake_records, hdb_user };

		before(() => {
			update_records_rw = update.__get__('updateRecords');
			write_update_stub = sandbox.stub(insert, 'update');
		});

		after(() => {
			sandbox.restore();
		});

		it('NOMINAL - should return update response', async () => {
			const write_update_response = {
				message: 'updated 1 of 1 records',
				new_attributes: [],
				txn_time: 1639163364624.878,
				update_hashes: [1],
				skipped_hashes: [],
			};

			const expected_result = {
				message: 'updated 1 of 1 records',
				update_hashes: [1],
				skipped_hashes: [],
			};

			write_update_stub.resolves(write_update_response);

			const results = await update_records_rw(fake_table, fake_records, hdb_user);
			expect(results).to.eql(expected_result);
		});
	});
});
