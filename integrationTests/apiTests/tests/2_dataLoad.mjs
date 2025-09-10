import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testData, getCsvPath, headers } from '../config/envConfig.mjs';
import { createTable } from '../utils/table.mjs';
import { csvDataLoad, csvFileUpload, csvUrlLoad } from '../utils/csv.mjs';
import { insert } from '../utils/insert.mjs';
import longTextJson from '../json/longText.json' with { type: 'json' };
import dataBulkJson from '../json/dataBulk.json' with { type: 'json' };
import remarksJson from '../json/remarks.json' with { type: 'json' };
import dogJson from '../json/dog.json' with { type: 'json' };
import breedJson from '../json/breed.json' with { type: 'json' };
import ownerJson from '../json/owner.json' with { type: 'json' };
import ownerOnlyJson from '../json/ownerOnly.json' with { type: 'json' };
import { searchByHash } from '../utils/search.mjs';
import { checkJobCompleted, getJobId } from '../utils/jobs.mjs';
import { req } from '../utils/request.mjs';
import { timestamp } from '../utils/timestamp.mjs';

describe('2. Data Load', () => {
	beforeEach(timestamp);

	//CSV Folder

	it('1 Upload Suppliers.csv', () => {
		return csvFileUpload(testData.schema, testData.supp_tb, getCsvPath() + 'Suppliers.csv');
	});

	it('2 Upload Region.csv', () => {
		return csvFileUpload(testData.schema, testData.regi_tb, getCsvPath() + 'Region.csv');
	});

	it('3 Upload Territories.csv', () => {
		return csvFileUpload(testData.schema, testData.terr_tb, getCsvPath() + 'Territories.csv');
	});

	it('4 Upload EmployeeTerritories.csv', () => {
		return csvFileUpload(testData.schema, testData.empt_tb, getCsvPath() + 'EmployeeTerritories.csv');
	});

	it('5 Upload Shippers.csv', () => {
		return csvFileUpload(testData.schema, testData.ship_tb, getCsvPath() + 'Shippers.csv');
	});

	it('6 Upload Categories.csv', () => {
		return csvFileUpload(testData.schema, testData.cate_tb, getCsvPath() + 'Categories.csv');
	});

	it('7 Upload Employees.csv', () => {
		return csvFileUpload(testData.schema, testData.emps_tb, getCsvPath() + 'Employees.csv');
	});

	it('8 Upload Customers.csv', () => {
		return csvFileUpload(testData.schema, testData.cust_tb, getCsvPath() + 'Customers.csv');
	});

	it('9 Upload Products.csv', () => {
		return csvFileUpload(testData.schema, testData.prod_tb, getCsvPath() + 'Products.csv');
	});

	it('10 Upload Orderdetails.csv', () => {
		return csvFileUpload(testData.schema, testData.ordd_tb, getCsvPath() + 'Orderdetails.csv');
	});

	it('11 Upload Orders.csv', () => {
		return csvFileUpload(testData.schema, testData.ords_tb, getCsvPath() + 'Orders.csv');
	});

	it('12 Upload Books.csv', () => {
		return csvFileUpload(testData.schema_dev, 'books', getCsvPath() + 'Books.csv');
	});

	it('13 Upload BooksRatings.csv', () => {
		return csvFileUpload(testData.schema_dev, 'ratings', getCsvPath() + 'BooksRatings.csv');
	});

	it('14 Upload movies.csv', () => {
		return csvFileUpload(testData.schema_dev, 'movie', getCsvPath() + 'movies.csv');
	});

	it('15 Upload credits.csv', () => {
		return csvFileUpload(testData.schema_dev, 'credits', getCsvPath() + 'credits.csv');
	});

	//CSV URL Load Folder

	it('Create CSV data table', () => {
		return createTable(testData.schema, testData.csv_tb, 'id');
	});

	it('CSV url load', () => {
		return csvUrlLoad(
			testData.schema,
			testData.csv_tb,
			'https://harperdb-integration-test-data.s3.us-east-2.amazonaws.com/breeds.csv',
			'',
			'successfully loaded 350 of 350 records'
		);
	});

	it('Confirm all CSV records loaded', () => {
		return req()
			.send({
				operation: 'sql',
				sql: `select count(*)
                      from ${testData.schema}.${testData.csv_tb}`,
			})
			.expect((r) => {
				assert.equal(r.body[0]['COUNT(*)'], 350, `${testData.csv_tb} count was not 350`);
			})
			.expect(200);
	});

	it('Create CSV data table empty', () => {
		return createTable(testData.schema, testData.csv_tb_empty, 'id');
	});

	it('CSV url load empty file', () => {
		return csvUrlLoad(
			testData.schema,
			testData.csv_tb_empty,
			'https://s3.amazonaws.com/complimentarydata/breedsEmpty.csv'
		);
	});

	it('Confirm 0 CSV records loaded', () => {
		return req()
			.send({
				operation: 'sql',
				sql: `select count(*)
                      from ${testData.schema}.${testData.csv_tb_empty}`,
			})
			.expect((r) => {
				assert.equal(r.body[0]['COUNT(*)'], 0, `${testData.csv_tb_empty} count was not 0`);
			})
			.expect(200);
	});

	it('CSV file load bad attribute', () => {
		return csvUrlLoad(
			testData.schema,
			testData.csv_tb_empty,
			'https://s3.amazonaws.com/complimentarydata/breeds-bad-column-name.csv',
			`Invalid column name 'id/', cancelling load operation`
		);
	});

	//JSON Folder

	it('Import data bulk insert into dev.long_text table', () => {
		return insert(testData.schema_dev, 'long_text', longTextJson.records, 'inserted 25');
	});

	it('Import data bulk confirm specific value exists', () => {
		return searchByHash(
			testData.schema_dev,
			'long_text',
			'id',
			[10],
			['id', 'remarks'],
			'"id":10,"remarks":"Lovely updated home'
		);
	});

	it('Import data bulk insert into call.aggr', () => {
		return insert(testData.schema_call, 'aggr', dataBulkJson.records, 'inserted 10');
	});

	it('Insert dot & double dot data', () => {
		return insert(
			testData.schema_call,
			'aggr',
			[
				{
					all: 11,
					dog_name: '.',
					owner_name: '..',
				},
			],
			'inserted 1'
		);
	});

	it('Insert confirm dot & double data', () => {
		return searchByHash(
			testData.schema_call,
			'aggr',
			'all',
			[11],
			['all', 'dog_name', 'owner_name'],
			'"all":11,"dog_name":".","owner_name":".."'
		);
	});

	it('Insert attributes into DropAttributeTest', () => {
		return insert(
			testData.schema_dev,
			'AttributeDropTest',
			[
				{
					hashid: 1,
					some_attribute: 'some_att1',
					another_attribute: '1',
				},
				{
					hashid: 2,
					some_attribute: 'some_att2',
					another_attribute: '1',
				},
			],
			'inserted 2'
		);
	});

	it('Insert confirm attributes added', () => {
		return searchByHash(
			testData.schema_dev,
			'AttributeDropTest',
			'hashid',
			[1, 2],
			['hashid', 'some_attribute', 'another_attribute'],
			'{"hashid":1,"some_attribute":"some_att1","another_attribute":"1"},' +
				'{"hashid":2,"some_attribute":"some_att2","another_attribute":"1"}'
		);
	});

	it('Import data bulk insert into dev.remarks_blob table', () => {
		return insert(testData.schema_dev, 'remarks_blob', remarksJson.records, 'inserted 11');
	});

	it('Insert data into dev.dog', () => {
		return insert(testData.schema_dev, 'dog', dogJson.records, 'inserted 9');
	});

	it('Insert data into dev.breed', () => {
		return insert(testData.schema_dev, 'breed', breedJson.records, 'inserted 350');
	});

	it('Insert data into dev.owner', () => {
		return insert(testData.schema_dev, 'owner', ownerJson.records, 'inserted 4');
	});

	it('Insert data into other.owner', () => {
		return insert(testData.schema_other, 'owner', ownerOnlyJson.records, 'inserted 4');
	});

	it('Insert data into another.breed', () => {
		return insert(testData.schema_another, 'breed', breedJson.records, 'inserted 350');
	});

	//CSV Bulk Load Tests Folder

	it('csv_data_load with invalid attribute', () => {
		return csvDataLoad(
			headers,
			'insert',
			'dev',
			'invalid_attribute',
			'id,s/ome=attribute\n1,cheeseburger\n2,hamburger with cheese\n3,veggie burger\n',
			"Invalid column name 's/ome=attribute'"
		);
	});

	it('csv_file_load with invalid attributes', () => {
		return csvFileUpload(
			testData.schema_dev,
			'invalid_attribute',
			getCsvPath() + 'InvalidAttributes.csv',
			'Invalid column name'
		);
	});

	it('search for specific value from CSV load', () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: `${testData.schema}`,
				table: `${testData.supp_tb}`,
				hash_attribute: `${testData.supp_id}`,
				hash_values: [10],
				get_attributes: ['supplierid', 'companyname', 'contactname'],
			})
			.expect((r) => {
				assert.equal(r.body[0].companyname, 'Refrescos Americanas LTDA', r.text);
				assert.equal(r.body[0].supplierid, 10, r.text);
				assert.equal(r.body[0].contactname, 'Carlos Diaz', r.text);
			})
			.expect(200);
	});

	it('search for random value from CSV load', () => {
		return req()
			.send({
				operation: 'sql',
				sql: `SELECT *
                              FROM ${testData.schema}.${testData.supp_tb}`,
			})
			.expect((r) => {
				let randomNumber = Math.floor(Math.random() * 29);
				assert.notEqual(r.body[randomNumber], null, r.text);
				assert.equal(r.body.length, 29, r.text);
				let keys = Object.keys(r.body[randomNumber]);
				if (keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1) {
					assert.equal(keys.length, 14, r.text);
				} else {
					assert.equal(keys.length, 12, r.text);
				}
			})
			.expect(200);
	});

	it('check error on invalid file', () => {
		return req()
			.send({
				operation: 'csv_file_load',
				action: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.supp_tb}`,
				file_path: `${getCsvPath()}Suppliers_wrong.csv`,
			})
			.expect((r) => assert.ok(r.body.error.includes('No such file or directory'), r.text))
			.expect(400);
	});

	it('csv bulk load update', async () => {
		const response = await req()
			.send({
				operation: 'csv_data_load',
				action: 'update',
				schema: `${testData.schema}`,
				table: `${testData.supp_tb}`,
				data: 'supplierid,companyname\n19,The Chum Bucket\n',
			})
			.expect((r) =>
				assert.equal(r.body.message.indexOf('Starting job'), 0, 'Expected to find "Starting job" in the response')
			);

		const id = await getJobId(response.body);
		await checkJobCompleted(id);
	});

	it('csv bulk load update confirm', () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: `${testData.schema}`,
				table: `${testData.supp_tb}`,
				hash_attribute: `${testData.supp_id}`,
				hash_values: [19],
				get_attributes: ['supplierid', 'companyname', 'contactname'],
			})
			.expect((r) => {
				assert.equal(r.body[0].supplierid, 19, r.text);
				assert.equal(r.body[0].contactname, 'Robb Merchant', r.text);
				assert.equal(r.body[0].companyname, 'The Chum Bucket', r.text);
			})
			.expect(200);
	});

	//Data Load Main Folder

	it('Insert object into table', () => {
		return req()
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.cust_tb}`,
				records: [{ postalcode: { house: 30, street: 'South St' }, customerid: 'TEST1' }],
			})
			.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
			.expect((r) => assert.equal(r.body.inserted_hashes[0], 'TEST1', r.text))
			.expect(200);
	});

	it('Insert object confirm ', () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: `${testData.schema}`,
				table: `${testData.cust_tb}`,
				hash_attribute: `${testData.supp_id}`,
				hash_values: ['TEST1'],
				get_attributes: ['postalcode', 'customerid'],
			})
			.expect((r) => assert.deepEqual(r.body[0].postalcode, { house: 30, street: 'South St' }, r.text))
			.expect((r) => assert.equal(r.body[0].customerid, 'TEST1', r.text))
			.expect(200);
	});

	it('Insert array into table', () => {
		return req()
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.cust_tb}`,
				records: [{ postalcode: [1, 2, 3], customerid: 'TEST2' }],
			})
			.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
			.expect((r) => assert.equal(r.body.inserted_hashes[0], 'TEST2', r.text))
			.expect(200);
	});

	it('Insert array confirm ', () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: `${testData.schema}`,
				table: `${testData.cust_tb}`,
				hash_attribute: `${testData.supp_id}`,
				hash_values: ['TEST2'],
				get_attributes: ['postalcode', 'customerid'],
			})
			.expect((r) => assert.deepEqual(r.body[0].postalcode, [1, 2, 3], r.text))
			.expect((r) => assert.equal(r.body[0].customerid, 'TEST2', r.text))
			.expect(200);
	});

	it('Insert value into schema that doesnt exist', () => {
		return req()
			.send({
				operation: 'insert',
				schema: 'not_a_schema',
				table: `${testData.cust_tb}`,
				records: [{ name: 'Harper', customerid: 1 }],
			})
			.expect((r) => assert.equal(r.body.error, "database 'not_a_schema' does not exist", r.text))
			.expect(400);
	});

	it('Insert value into table that doesnt exist', () => {
		return req()
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: 'not_a_table',
				records: [{ name: 'Harper', customerid: 1 }],
			})
			.expect((r) => assert.equal(r.body.error, "Table 'northnwd.not_a_table' does not exist", r.text))
			.expect(400);
	});

	it("Update value in schema that doesn't exist", () => {
		return req()
			.send({
				operation: 'update',
				schema: 'not_a_schema',
				table: `${testData.cust_tb}`,
				records: [{ name: 'Harper', customerid: 1 }],
			})
			.expect((r) => assert.equal(r.body.error, "database 'not_a_schema' does not exist", r.text))
			.expect(400);
	});

	it("Update value in table that doesn't exist", () => {
		return req()
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: 'not_a_table',
				records: [{ name: 'Harper', customerid: 1 }],
			})
			.expect((r) => assert.equal(r.body.error, "Table 'northnwd.not_a_table' does not exist", r.text))
			.expect(400);
	});

	it('Set attribute to number', () => {
		return req()
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				records: [{ 4289: 'Mutt', firstname: 'Test for number attribute', employeeid: 25 }],
			})
			.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
			.expect((r) => assert.equal(r.body.inserted_hashes[0], 25, r.text))
			.expect(200);
	});

	it('Set attribute to number confirm', () => {
		return req()
			.send({ operation: 'describe_table', table: `${testData.emps_tb}`, schema: `${testData.schema}` })
			.expect((r) => {
				let found = false;
				r.body.attributes.forEach((obj) => {
					if (Object.values(obj)[0] === '4289') found = true;
				});
				assert.ok(found, r.text);
			})
			.expect(200);
	});

	it('Set attribute name greater than 250 bytes', () => {
		return req()
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				records: [
					{
						4289: 'Mutt',
						firstname: 'Test for number attribute',
						employeeid: 31,
						IIetmyLabradorcomeoutsidewithmewhenIwastakingthebinsoutonemorningIlethimgoforawanderthinkinghewasjustgoingtopeeonthetelegraphpoleattheendofourdrivewaylikehealwaysdoesInsteadhesawhisopportunityandseizeditHekeptwalkingpastthetelegraphpolepasttheborderofour:
							'a story about a dog',
					},
				],
			})
			.expect((r) => {
				let longAttribute =
					'transaction aborted due to attribute name IIetmyLabradorcomeoutsidewithmewhenIwastakingthebinsoutonemorningIlethimgoforawanderthinkinghewasjustgoingtopeeonthetelegraphpoleattheendofourdrivewaylikehealwaysdoesInsteadhesawhisopportunityandseizeditHekeptwalkingpastthetelegraphpolepasttheborderofour being too long. Attribute names cannot be longer than 250 bytes.';
				assert.equal(r.body.error, longAttribute, r.text);
			})
			.expect(400);
	});

	it('insert valid records into dev.invalid_attributes', () => {
		return req()
			.send({
				operation: 'insert',
				schema: 'dev',
				table: 'invalid_attribute',
				records: [
					{ id: 100, some_attribute: 'some_att1', another_attribute: 'another_1' },
					{
						id: 101,
						some_attribute: 'some_att2',
						another_attribute: 'another_2',
					},
				],
			})
			.expect((r) => assert.ok(r.body.message.includes('inserted 2'), r.text))
			.expect(200);
	});

	it('insert records into dev.leading_zero', () => {
		return req()
			.send({
				operation: 'insert',
				schema: 'dev',
				table: 'leading_zero',
				records: [
					{ id: 0, some_attribute: 'some_att1', another_attribute: 'another_1' },
					{ id: '011', some_attribute: 'some_att2', another_attribute: 'another_2' },
					{ id: '00011', some_attribute: 'some_att3', another_attribute: 'another_3' },
				],
			})
			.expect((r) => assert.ok(r.body.message.includes('inserted 3'), r.text))
			.expect((r) => assert.deepEqual(r.body.inserted_hashes, [0, '011', '00011'], r.text))
			.expect(200);
	});

	it('insert test records into dev.rando', () => {
		return req()
			.send({
				operation: 'insert',
				schema: 'dev',
				table: 'rando',
				records: [
					{ id: 987654321, name: 'Cool Dawg' },
					{
						id: 987654322,
						name: 'The Coolest Dawg',
					},
					{ id: 987654323, name: 'Sup Dawg' },
					{ id: 987654324, name: 'Snoop Dawg' },
				],
			})
			.expect((r) => assert.ok(r.body.message.includes('inserted 4'), r.text))
			.expect(200);
	});

	it('test SQL updating with numeric hash in single quotes', () => {
		return req()
			.send({
				operation: 'sql',
				sql: "UPDATE dev.rando set active = true WHERE id IN ('987654321', '987654322')",
			})
			.expect((r) => assert.ok(r.body.message.includes('updated 2'), r.text))
			.expect((r) =>
				assert.ok(r.body.update_hashes.includes(987654321) && r.body.update_hashes.includes(987654322), r.text)
			)
			.expect(200);
	});

	it('Upsert dog data for conditions search tests', () => {
		return req()
			.send({
				operation: 'upsert',
				schema: 'dev',
				table: 'dog_conditions',
				records: [
					{
						id: 1,
						breed_id: 154,
						weight_lbs: 35,
						dog_name: 'Penny',
						age: 5,
						adorable: true,
						owner_id: 2,
						group: 'A',
						location: 'Denver, NC',
					},
					{
						id: 2,
						breed_id: 346,
						weight_lbs: 55,
						dog_name: 'Harper',
						age: 5,
						adorable: true,
						owner_id: 3,
						group: 'A',
						location: 'Denver, CO',
					},
					{
						id: 3,
						breed_id: 348,
						weight_lbs: 84,
						dog_name: 'Alby',
						age: 8,
						adorable: true,
						owner_id: 4,
						group: 'A',
						location: 'Portland, OR',
					},
					{
						id: 4,
						breed_id: 347,
						weight_lbs: 60,
						dog_name: 'Billy',
						age: 4,
						adorable: true,
						owner_id: 1,
						group: 'B',
						location: 'Evergreen, CO',
					},
					{
						id: 5,
						breed_id: 348,
						weight_lbs: 15,
						dog_name: 'Rose Merry',
						age: 6,
						adorable: true,
						owner_id: 2,
						group: 'B',
						location: 'Denver, CO',
					},
					{
						id: 6,
						breed_id: 351,
						weight_lbs: 28,
						dog_name: 'Kato',
						age: 4,
						adorable: true,
						owner_id: 3,
						group: 'A',
						location: 'Charlotte, NC',
					},
					{
						id: 7,
						breed_id: 349,
						weight_lbs: 35,
						dog_name: 'Simon',
						age: 1,
						adorable: true,
						owner_id: 4,
						group: 'C',
						location: 'Denver, CO',
					},
					{
						id: 8,
						breed_id: 250,
						weight_lbs: 55,
						dog_name: 'Gemma',
						age: 3,
						adorable: true,
						owner_id: 1,
						group: 'A',
						location: 'Denver, NC',
					},
					{
						id: 9,
						breed_id: 104,
						weight_lbs: 75,
						dog_name: 'Bode',
						age: 9,
						adorable: true,
						owner_id: null,
						group: 'C',
						location: 'Boulder, CO',
					},
					{
						id: 10,
						breed_id: null,
						weight_lbs: null,
						dog_name: null,
						age: 7,
						adorable: null,
						owner_id: null,
						group: 'D',
						location: 'Boulder, CO',
					},
					{
						id: 11,
						breed_id: null,
						weight_lbs: null,
						dog_name: null,
						age: null,
						adorable: null,
						owner_id: null,
						group: 'C',
						location: 'Denver, CO',
					},
				],
			})
			.expect((r) => {
				assert.equal(r.body.upserted_hashes.length, 11, r.text);
				assert.ok(!r.body.skipped_hashes, r.text);
				assert.equal(r.body.message, 'upserted 11 of 11 records', r.text);
			})
			.expect(200);
	});

	it('Insert test records into 123.4', () => {
		return req()
			.send({
				operation: 'insert',
				schema: '123',
				table: '4',
				records: [
					{ id: 987654321, name: 'Cool Dawg' },
					{
						id: 987654322,
						name: 'The Coolest Dawg',
					},
					{ id: 987654323, name: 'Sup Dawg' },
					{ id: 987654324, name: 'Snoop Dawg' },
				],
			})
			.expect((r) => assert.ok(r.body.message.includes('inserted 4'), r.text))
			.expect(200);
	});

	it('Insert records into 123.4 number schema table', () => {
		return req()
			.send({ operation: 'insert', schema: 123, table: 4, records: [{ name: 'Hot Dawg' }] })
			.expect((r) => assert.ok(r.body.message.includes('inserted 1'), r.text))
			.expect(200);
	});

	it('Update test records in 123.4', () => {
		return req()
			.send({
				operation: 'update',
				schema: '123',
				table: '4',
				records: [{ id: 987654321, name: 'Hot Dawg' }],
			})
			.expect((r) => assert.ok(r.body.message.includes('updated 1'), r.text))
			.expect(200);
	});

	it('Update records in 123.4 number schema table', () => {
		return req()
			.send({
				operation: 'update',
				schema: 123,
				table: 4,
				records: [{ id: 987654321, name: 'Hot Diddy Dawg' }],
			})
			.expect((r) => assert.ok(r.body.message.includes('updated 1'), r.text))
			.expect(200);
	});

	it('Insert records missing table', () => {
		return req()
			.send({
				operation: 'insert',
				schema: '123',
				records: [
					{ id: 987654321, name: 'Cool Dawg' },
					{
						id: 987654322,
						name: 'The Coolest Dawg',
					},
					{ id: 987654323, name: 'Sup Dawg' },
					{ id: 987654324, name: 'Snoop Dawg' },
				],
			})
			.expect((r) => assert.equal(r.body.error, "'table' is required", r.text))
			.expect(400);
	});

	it('Insert records missing records', () => {
		return req()
			.send({ operation: 'insert', schema: '123', table: '4' })
			.expect((r) => assert.equal(r.body.error, "'records' is required", r.text))
			.expect(400);
	});

	it('Upsert records missing table', () => {
		return req()
			.send({
				operation: 'upsert',
				schema: '123',
				records: [
					{ id: 987654321, name: 'Cool Dawg' },
					{
						id: 987654322,
						name: 'The Coolest Dawg',
					},
					{ id: 987654323, name: 'Sup Dawg' },
					{ id: 987654324, name: 'Snoop Dawg' },
				],
			})
			.expect((r) => assert.equal(r.body.error, "'table' is required", r.text))
			.expect(400);
	});

	it('Upsert records missing records', () => {
		return req()
			.send({ operation: 'upsert', schema: '123', table: '4' })
			.expect((r) => assert.equal(r.body.error, "'records' is required", r.text))
			.expect(400);
	});

	it('Update records missing table', () => {
		return req()
			.send({
				operation: 'update',
				schema: '123',
				records: [
					{ id: 987654321, name: 'Cool Dawg' },
					{
						id: 987654322,
						name: 'The Coolest Dawg',
					},
					{ id: 987654323, name: 'Sup Dawg' },
					{ id: 987654324, name: 'Snoop Dawg' },
				],
			})
			.expect((r) => assert.equal(r.body.error, "'table' is required", r.text))
			.expect(400);
	});

	it('Update records missing records', () => {
		return req()
			.send({ operation: 'upsert', schema: '123', table: '4' })
			.expect((r) => assert.equal(r.body.error, "'records' is required", r.text))
			.expect(400);
	});
});
