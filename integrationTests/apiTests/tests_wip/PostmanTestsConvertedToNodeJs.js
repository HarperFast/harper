import { it, test } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { setTimeout } from 'node:timers/promises';
import { checkJobCompleted, getJobId } from '../utils/jobs.js';
import { envUrl, generic, headers } from '../config/envConfig.js';
import { csvFileUpload } from '../utils/csv.js';
import { setTimeout as sleep } from 'node:timers/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'url';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const myPath = path.resolve(__dirname + '/..' + generic.files_location) + '/';
// const myPath = path.resolve(process.cwd() + generic.files_location);


it('csv_data_load with invalid attribute', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'csv_data_load',
			'schema': 'dev',
			'action': 'insert',
			'table': 'invalid_attribute',
			'data': 'id,s/ome=attribute\n1,cheeseburger\n2,hamburger with cheese\n3,veggie burger\n',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'));
// Unmatched Postman assertion: eval(pm.globals.get("function:getJobId"))(jsonData, "csv_file_load with invalid attributes")
});

it('csv_file_load with invalid attributes', async () => {
	await csvFileUpload(generic.schema_dev, 'invalid_attribute',
		myPath + 'InvalidAttributes.csv', 'Invalid column name');
});

it('search for specific value from CSV load', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': '{{schema}}',
			'table': '{{supp_tb}}',
			'hash_attribute': '{{supp_id}}',
			'hash_values': [10],
			'get_attributes': ['supplierid', 'companyname', 'contactname'],
		})
		.expect(200)
		// Unmatched Postman assertion: pm.expect(jsonData[0].supplierid).to.eql(10)
		// Unmatched Postman assertion: pm.expect(jsonData[0].contactname).to.eql("Carlos Diaz")
		.expect((r) => assert.ok(r.body[0].companyname == 'Refrescos Americanas LTDA'));
});

it('search for random value from CSV load', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM {{schema}}.{{supp_tb}}' })
		.expect(200);
// Unmatched Postman assertion: var randomNumber = Math.floor(Math.random() * 29)
// Unmatched Postman assertion: pm.expect(jsonData[randomNumber]).to.not.eql(null)
// Unmatched Postman assertion: pm.expect(jsonData.length).to.eql(29)
// Unmatched Postman assertion: let keys = Object.keys(jsonData[randomNumber])
// Unmatched Postman assertion: //because helium has 2 extra keys we need to check for them
// Unmatched Postman assertion: if(keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1){
// Unmatched Postman assertion: pm.expect(keys.length).to.eql(14)
// Unmatched Postman assertion: } else{
// Unmatched Postman assertion: pm.expect(keys.length).to.eql(12)
// Unmatched Postman assertion: }
});

it('check error on invalid file', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'csv_file_load',
			'action': 'insert',
			'schema': '{{schema}}',
			'table': '{{supp_tb}}',
			'file_path': '{{files_location}}Suppliers_wrong.csv',
		})
		.expect(400);
// Unmatched Postman assertion: pm.expect(jsonData.error.includes("No such file or directory")).to.be.true;})
});

it('csv bulk load update', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'csv_data_load',
			'action': 'update',
			'schema': '{{schema}}',
			'table': '{{supp_tb}}',
			'data': 'supplierid,companyname\n19,The Chum Bucket\n',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'));
// Unmatched Postman assertion: need here a call to checkJobCompleted(job_id, expectedErrorMessage, expectedCompletedMessage);
});

it('wait for csv bulk load update to complete', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'get_job', 'id': '{{job_id}}' });
});

it('csv bulk load update confirm', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': '{{schema}}',
			'table': '{{supp_tb}}',
			'hash_attribute': '{{supp_id}}',
			'hash_values': [19],
			'get_attributes': ['supplierid', 'companyname', 'contactname'],
		})
		.expect(200)
		// Unmatched Postman assertion: pm.expect(jsonData[0].supplierid).to.eql(19)
		// Unmatched Postman assertion: pm.expect(jsonData[0].contactname).to.eql("Robb Merchant")
		.expect((r) => assert.ok(r.body[0].companyname == 'The Chum Bucket'));
});

it('Insert object into table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '{{schema}}',
			'table': '{{cust_tb}}',
			'records': [{ 'postalcode': { 'house': 30, 'street': 'South St' }, 'customerid': 'TEST1' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'));
// Unmatched Postman assertion: pm.expect(jsonData.inserted_hashes[0]).to.eql("TEST1"))
});

it('Insert object confirm ', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': '{{schema}}',
			'table': '{{cust_tb}}',
			'hash_attribute': '{{supp_id}}',
			'hash_values': ['TEST1'],
			'get_attributes': ['postalcode', 'customerid'],
		})
		.expect(200);
// Unmatched Postman assertion: pm.expect(jsonData[0].postalcode).to.eql({ "house": 30, "street": "South St"})
// Unmatched Postman assertion: pm.expect(jsonData[0].customerid).to.eql("TEST1"))
});

it('Insert array into table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '{{schema}}',
			'table': '{{cust_tb}}',
			'records': [{ 'postalcode': [1, 2, 3], 'customerid': 'TEST2' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'));
// Unmatched Postman assertion: pm.expect(jsonData.inserted_hashes[0]).to.eql("TEST2"))
});

it('Insert array confirm ', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': '{{schema}}',
			'table': '{{cust_tb}}',
			'hash_attribute': '{{supp_id}}',
			'hash_values': ['TEST2'],
			'get_attributes': ['postalcode', 'customerid'],
		})
		.expect(200);
// Unmatched Postman assertion: pm.expect(jsonData[0].postalcode).to.eql([1, 2, 3])
// Unmatched Postman assertion: pm.expect(jsonData[0].customerid).to.eql("TEST2"))
});

it('Insert value into schema that doesn\'t exist', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': 'not_a_schema',
			'table': '{{cust_tb}}',
			'records': [{ 'name': 'Harper', 'customerid': 1 }],
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'database \'not_a_schema\' does not exist'));
});

it('Insert value into table that doesn\'t exist', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '{{schema}}',
			'table': 'not_a_table',
			'records': [{ 'name': 'Harper', 'customerid': 1 }],
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'Table \'northnwd.not_a_table\' does not exist'));
});

it('Update value in schema that doesn\'t exist', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': 'not_a_schema',
			'table': '{{cust_tb}}',
			'records': [{ 'name': 'Harper', 'customerid': 1 }],
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'database \'not_a_schema\' does not exist'));
});

it('Update value in table that doesn\'t exist', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': '{{schema}}',
			'table': 'not_a_table',
			'records': [{ 'name': 'Harper', 'customerid': 1 }],
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'Table \'northnwd.not_a_table\' does not exist'));
});

it('Set attribute to number', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'records': [{ '4289': 'Mutt', 'firstname': 'Test for number attribute', 'employeeid': 25 }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'));
// Unmatched Postman assertion: pm.expect(jsonData.inserted_hashes[0]).to.eql(25))
});

it('Set attribute to number confirm', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'describe_table', 'table': '{{emps_tb}}', 'schema': '{{schema}}' })
		.expect(200)
		// Unmatched Postman assertion: var found = false
		// Unmatched Postman assertion: jsonData.attributes.forEach((obj) => {
		// Unmatched Postman assertion: if( Object.values(obj)[0] === '4289' ) {
		// Unmatched Postman assertion: found = true;
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(found));
});

it('Set attribute name greater than 250 bytes', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'records': [{
				'4289': 'Mutt',
				'firstname': 'Test for number attribute',
				'employeeid': 31,
				'IIetmyLabradorcomeoutsidewithmewhenIwastakingthebinsoutonemorningIlethimgoforawanderthinkinghewasjustgoingtopeeonthetelegraphpoleattheendofourdrivewaylikehealwaysdoesInsteadhesawhisopportunityandseizeditHekeptwalkingpastthetelegraphpolepasttheborderofour': 'a story about a dog',
			}],
		})
		.expect(400)
		// Unmatched Postman assertion: var longAttribute = "transaction aborted due to attribute name IIetmyLabradorcomeoutsidewithmewhenIwastakingthebinsoutonemorningIlethimgoforawanderthinkinghewasjustgoingtopeeonthetelegraphpoleattheendofourdrivewaylikehealwaysdoesInsteadhesawhisopportunityandseizeditHekeptwalkingpastthetelegraphpolepasttheborderofour being too long. Attribute names cannot be longer than 250 bytes."
		.expect((r) => assert.ok(r.body.error == longAttribute));
});

it('insert valid records into dev.invalid_attributes', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': 'dev',
			'table': 'invalid_attribute',
			'records': [{ 'id': 100, 'some_attribute': 'some_att1', 'another_attribute': 'another_1' }, {
				'id': 101,
				'some_attribute': 'some_att2',
				'another_attribute': 'another_2',
			}],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('inserted 2')));
});

it('insert records into dev.leading_zero', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': 'dev',
			'table': 'leading_zero',
			'records': [{ 'id': 0, 'some_attribute': 'some_att1', 'another_attribute': 'another_1' }, {
				'id': '011',
				'some_attribute': 'some_att2',
				'another_attribute': 'another_2',
			}, { 'id': '00011', 'some_attribute': 'some_att3', 'another_attribute': 'another_3' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('inserted 3')))
		.expect((r) => assert.ok(r.body.inserted_hashes == [0, '011', '00011']));
});

it('insert test records into dev.rando', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': 'dev',
			'table': 'rando',
			'records': [{ 'id': 987654321, 'name': 'Cool Dawg' }, {
				'id': 987654322,
				'name': 'The Coolest Dawg',
			}, { 'id': 987654323, 'name': 'Sup Dawg' }, { 'id': 987654324, 'name': 'Snoop Dawg' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('inserted 4')));
});

it('test SQL updating with numeric hash in single quotes', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'UPDATE dev.rando set active = true WHERE id IN (\'987654321\', \'987654322\')' })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('updated 2')))
		.expect((r) => assert.ok(r.body.update_hashes.includes(987654321) && r.body.update_hashes.includes(987654322)));
});

it('Upsert dog data for conditions search tests', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'upsert',
			'schema': 'dev',
			'table': 'dog_conditions',
			'records': [{
				'id': 1,
				'breed_id': 154,
				'weight_lbs': 35,
				'dog_name': 'Penny',
				'age': 5,
				'adorable': true,
				'owner_id': 2,
				'group': 'A',
				'location': 'Denver, NC',
			}, {
				'id': 2,
				'breed_id': 346,
				'weight_lbs': 55,
				'dog_name': 'Harper',
				'age': 5,
				'adorable': true,
				'owner_id': 3,
				'group': 'A',
				'location': 'Denver, CO',
			}, {
				'id': 3,
				'breed_id': 348,
				'weight_lbs': 84,
				'dog_name': 'Alby',
				'age': 8,
				'adorable': true,
				'owner_id': 4,
				'group': 'A',
				'location': 'Portland, OR',
			}, {
				'id': 4,
				'breed_id': 347,
				'weight_lbs': 60,
				'dog_name': 'Billy',
				'age': 4,
				'adorable': true,
				'owner_id': 1,
				'group': 'B',
				'location': 'Evergreen, CO',
			}, {
				'id': 5,
				'breed_id': 348,
				'weight_lbs': 15,
				'dog_name': 'Rose Merry',
				'age': 6,
				'adorable': true,
				'owner_id': 2,
				'group': 'B',
				'location': 'Denver, CO',
			}, {
				'id': 6,
				'breed_id': 351,
				'weight_lbs': 28,
				'dog_name': 'Kato',
				'age': 4,
				'adorable': true,
				'owner_id': 3,
				'group': 'A',
				'location': 'Charlotte, NC',
			}, {
				'id': 7,
				'breed_id': 349,
				'weight_lbs': 35,
				'dog_name': 'Simon',
				'age': 1,
				'adorable': true,
				'owner_id': 4,
				'group': 'C',
				'location': 'Denver, CO',
			}, {
				'id': 8,
				'breed_id': 250,
				'weight_lbs': 55,
				'dog_name': 'Gemma',
				'age': 3,
				'adorable': true,
				'owner_id': 1,
				'group': 'A',
				'location': 'Denver, NC',
			}, {
				'id': 9,
				'breed_id': 104,
				'weight_lbs': 75,
				'dog_name': 'Bode',
				'age': 9,
				'adorable': true,
				'owner_id': null,
				'group': 'C',
				'location': 'Boulder, CO',
			}, {
				'id': 10,
				'breed_id': null,
				'weight_lbs': null,
				'dog_name': null,
				'age': 7,
				'adorable': null,
				'owner_id': null,
				'group': 'D',
				'location': 'Boulder, CO',
			}, {
				'id': 11,
				'breed_id': null,
				'weight_lbs': null,
				'dog_name': null,
				'age': null,
				'adorable': null,
				'owner_id': null,
				'group': 'C',
				'location': 'Denver, CO',
			}],
		})
		.expect(200)
		// Unmatched Postman assertion: pm.expect(jsonData.upserted_hashes.length).to.eql(11)
		.expect((r) => assert.ok(r.body.skipped_hashes == 'undefined'))
		.expect((r) => assert.ok(r.body.message == 'upserted 11 of 11 records'));
});

it('Insert test records into 123.4', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '123',
			'table': '4',
			'records': [{ 'id': 987654321, 'name': 'Cool Dawg' }, {
				'id': 987654322,
				'name': 'The Coolest Dawg',
			}, { 'id': 987654323, 'name': 'Sup Dawg' }, { 'id': 987654324, 'name': 'Snoop Dawg' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('inserted 4')));
});

it('Insert records into 123.4 number schema table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'insert', 'schema': 123, 'table': 4, 'records': [{ 'name': 'Hot Dawg' }] })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('inserted 1')));
});

it('Update test records in 123.4', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': '123',
			'table': '4',
			'records': [{ 'id': 987654321, 'name': 'Hot Dawg' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('updated 1')));
});

it('Update records in 123.4 number schema table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': 123,
			'table': 4,
			'records': [{ 'id': 987654321, 'name': 'Hot Diddy Dawg' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('updated 1')));
});

it('Insert records missing table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '123',
			'records': [{ 'id': 987654321, 'name': 'Cool Dawg' }, {
				'id': 987654322,
				'name': 'The Coolest Dawg',
			}, { 'id': 987654323, 'name': 'Sup Dawg' }, { 'id': 987654324, 'name': 'Snoop Dawg' }],
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == '\'table\' is required'));
});

it('Insert records missing records', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'insert', 'schema': '123', 'table': '4' })
		.expect(400)
		.expect((r) => assert.ok(r.body.error == '\'records\' is required'));
});

it('Upsert records missing table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'upsert',
			'schema': '123',
			'records': [{ 'id': 987654321, 'name': 'Cool Dawg' }, {
				'id': 987654322,
				'name': 'The Coolest Dawg',
			}, { 'id': 987654323, 'name': 'Sup Dawg' }, { 'id': 987654324, 'name': 'Snoop Dawg' }],
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == '\'table\' is required'));
});

it('Upsert records missing records', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'upsert', 'schema': '123', 'table': '4' })
		.expect(400)
		.expect((r) => assert.ok(r.body.error == '\'records\' is required'));
});

it('Update records missing table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': '123',
			'records': [{ 'id': 987654321, 'name': 'Cool Dawg' }, {
				'id': 987654322,
				'name': 'The Coolest Dawg',
			}, { 'id': 987654323, 'name': 'Sup Dawg' }, { 'id': 987654324, 'name': 'Snoop Dawg' }],
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == '\'table\' is required'));
});

it('Update records missing records', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'upsert', 'schema': '123', 'table': '4' })
		.expect(400)
		.expect((r) => assert.ok(r.body.error == '\'records\' is required'));
});

it('insert invalid attribute name - single row', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'INSERT INTO dev.invalid_attribute (id, `some/attribute`) VALUES (\'1\', \'some_attribute\')',
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'Attribute names cannot include backticks or forward slashes'));
});

it('update single row w/ invalid attribute name', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'UPDATE dev.invalid_attribute SET `some/attribute` = \'some attribute\' WHERE id = 100',
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'Attribute names cannot include backticks or forward slashes'));
});

it('insert all invalid attribute names - multiple rows', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'INSERT INTO dev.invalid_attribute (id, `some/attribute1`, `some_/attribute2`, `some_attribute/3`) VALUES (\'1\', \'some_attribute\', \'another_attribute\', \'some_other_attribute\'), (\'2\', \'some_attribute\', \'another_attribute\', \'some_other_attribute\'), (\'3\', \'some_attribute\', \'another_attribute\', \'some_other_attribute\'), (\'4\', \'some_attribute\', \'another_attribute\', \'some_other_attribute\'), (\'5\', \'some_attribute\', \'another_attribute\', \'some_other_attribute\'), (\'6\', \'some_attribute\', \'another_attribute\', \'some_other_attribute\')',
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'Attribute names cannot include backticks or forward slashes'));
});

it('update multiple rows with invalid attribute', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'UPDATE dev.invalid_attribute SET `/some_attribute` = \'new_value\' WHERE id IN(100, 101)',
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'Attribute names cannot include backticks or forward slashes'));
});

it('insert some invalid attribute names - multiple rows', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'INSERT INTO dev.invalid_attribute (id, some_attribute, another_attribute, `some_/other_attribute`) VALUES (\'1\', \'some_attribute\', \'another_attribute\', \'some_other_attribute\'), (\'2\', \'some_attribute\', \'another_attribute\', \'some_other_attribute\'), (\'3\', \'some_attribute\', \'another_attribute\', \'some_other_attribute\'), (\'4\', \'some_attribute\', \'another_attribute\', \'some_other_attribute\'), (\'5\', \'some_attribute\', \'another_attribute\', \'some_other_attribute\'), (\'6\', \'some_attribute\', \'another_attribute\', \'some_other_attribute\')',
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'Attribute names cannot include backticks or forward slashes'));
});

it('select by hash no result', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM {{schema}}.{{emps_tb}} WHERE {{emps_id}} = 190' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 0));
});

it('select by hash one result', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM {{schema}}.{{emps_tb}} WHERE {{emps_id}} = 3' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(typeof r.body[0] === 'object'));
});

it('select by hash multiple results', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT * FROM {{schema}}.{{emps_tb}} WHERE {{emps_id}} = 3 OR {{emps_id}} = 5',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2))
		.expect((r) => assert.ok(typeof r.body[0] === 'object'));
// Unmatched Postman assertion: pm.expect((typeof jsonData[1])).to.eql("object"))
});

it('insert initial date function data into table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'INSERT INTO dev.time_functions (id, c_date, c_time, c_timestamp, getdate, now) VALUES (1, CURRENT_DATE(), CURRENT_TIME(), CURRENT_TIMESTAMP, GETDATE(), NOW()), (2, CURRENT_DATE(), CURRENT_TIME(), CURRENT_TIMESTAMP, GETDATE(), NOW()), (3, CURRENT_DATE(), CURRENT_TIME(), CURRENT_TIMESTAMP, GETDATE(), NOW()), (4, CURRENT_DATE(), CURRENT_TIME(), CURRENT_TIMESTAMP, GETDATE(), NOW())',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'inserted 4 of 4 records'));
// Unmatched Postman assertion: pm.expect(jsonData.inserted_hashes[0]).to.eql(1))
});

it('check initial date function data in table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.time_functions' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 4))
		// Unmatched Postman assertion: var current_date = new Date().getUTCDate()
		// Unmatched Postman assertion: jsonData.forEach(row => {
		// Unmatched Postman assertion: pm.expect([1,2,3,4]).to.include(row.id)
		.expect((r) => assert.ok(new Date(row.now).getUTCDate() == current_date))
		.expect((r) => assert.ok(row.now.toString().length == 13))
		.expect((r) => assert.ok(new Date(row.getdate).getUTCDate() == current_date))
		.expect((r) => assert.ok(row.getdate.toString().length == 13))
		.expect((r) => assert.ok(new Date(row.c_timestamp).getUTCDate() == current_date))

		.expect((r) => assert.ok(row.c_timestamp.toString().length == 13));
// Unmatched Postman assertion: pm.expect(row.c_date).to.match(/\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}$/)
// Unmatched Postman assertion: pm.expect(row.c_time).to.match(/^[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}.\d{3}$/))
});

it('update w/ date function data to null in table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'UPDATE dev.time_functions SET c_date = null, c_time = null, c_timestamp = null, getdate = null, now = null',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'updated 4 of 4 records'));
// Unmatched Postman assertion: pm.expect(jsonData.update_hashes[0]).to.eql(1))
});

it('check data set to null in table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.time_functions' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 4));
// Unmatched Postman assertion: var current_date = new Date().getDate()
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect([1,2,3,4]).to.include(row.id)
// Unmatched Postman assertion: pm.expect(row.now).to.be.null;
// Unmatched Postman assertion: pm.expect(row.getdate).to.be.null;
// Unmatched Postman assertion: pm.expect(row.c_timestamp).to.be.null;
// Unmatched Postman assertion: pm.expect(row.c_date).to.be.null;
// Unmatched Postman assertion: pm.expect(row.c_time).to.be.null;})
});

it('update w/ new date function data in table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'UPDATE dev.time_functions SET c_date = CURRENT_DATE(), c_time = CURRENT_TIME(), c_timestamp = CURRENT_TIMESTAMP, getdate = GETDATE(), now = NOW()',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'updated 4 of 4 records'))
		.expect((r) => assert.ok(r.body.update_hashes.length == 4));
});

it('check data updated to correct date values in table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.time_functions' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 4))
		// Unmatched Postman assertion: var current_date = new Date().getUTCDate()
		// Unmatched Postman assertion: jsonData.forEach(row => {
		// Unmatched Postman assertion: pm.expect([1,2,3,4]).to.include(row.id)
		.expect((r) => assert.ok(new Date(row.now).getUTCDate() == current_date))
		// Unmatched Postman assertion: pm.expect(row.now.toString().length).to.equal(13)
		.expect((r) => assert.ok(new Date(row.getdate).getUTCDate() == current_date))

		.expect((r) => assert.ok(row.getdate.toString().length == 13))
		.expect((r) => assert.ok(new Date(row.c_timestamp).getUTCDate() == current_date))
		.expect((r) => assert.ok(row.c_timestamp.toString().length == 13))
		.expect((r) => assert.ok(row.c_date.match(/\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}$/)))
		.expect((r) => assert.ok(row.c_time.match(/^[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}.\d{3}$/)));
});

it('update w/ other date functions', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'UPDATE dev.time_functions SET today = NOW(), add_day = DATE_ADD(CURRENT_TIMESTAMP, 1, \'days\'), sub_3_years = DATE_SUB(\'2020-4-1\', 3, \'years\'), server_time = GET_SERVER_TIME(), offset_utc = OFFSET_UTC(NOW(), -6)',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'updated 4 of 4 records'))
		.expect((r) => assert.ok(r.body.update_hashes.length == 4));
});

it('check other date function updates are correct in table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.time_functions' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 4));
// Unmatched Postman assertion: var current_date = new Date()
// Unmatched Postman assertion: var current_day = current_date.getUTCDate()
// Unmatched Postman assertion: var c_date_plus1 = current_date.setUTCDate(current_day + 1)
// Unmatched Postman assertion: var c_day_plus1 = new Date(c_date_plus1).getUTCDate()
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect(row.c_timestamp).to.match(/\d{13}$/)
// Unmatched Postman assertion: pm.expect(new Date(row.add_day).getUTCDate()).to.equal(c_day_plus1)
// Unmatched Postman assertion: pm.expect(row.add_day).to.match(/\d{13}$/)
// Unmatched Postman assertion: pm.expect(new Date(row.sub_3_years).getFullYear()).to.equal(2017)
// Unmatched Postman assertion: pm.expect(row.sub_3_years).to.match(/\d{13}$/)
// Unmatched Postman assertion: pm.expect(new Date(row.today).getUTCDate()).to.equal(current_day)
// Unmatched Postman assertion: pm.expect(row.today).to.match(/\d{13}$/))
});

it('update w/ other date functions', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'UPDATE dev.time_functions SET add_day = DATE_ADD(DATE(), 5, \'days\'), tomorrow_epoch = DATE_FORMAT(DATE_ADD(NOW(), 1, \'days\'), \'x\') WHERE id > 2',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'updated 2 of 2 records'));
// Unmatched Postman assertion: pm.expect(jsonData.update_hashes.length).to.eql(2))
});

it('select with date function in WHERE returns correct rows', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT * FROM dev.time_functions WHERE DATE_DIFF(add_day, c_timestamp, \'days\') > 3 AND tomorrow_epoch > NOW()',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2))
		// Unmatched Postman assertion: var current_date = new Date().getDate()
		// Unmatched Postman assertion: var date_plus_5 = new Date(new Date().setDate(current_date + 5))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok([3, 4].includes(row.id)));
// Unmatched Postman assertion: pm.expect(new Date(row.add_day).getDate()).to.equal(date_plus_5.getDate()))
});

it('delete with date function in WHERE deletes correct rows', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'DELETE FROM dev.time_functions WHERE DATE_DIFF(add_day, c_timestamp, \'days\') < 3',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == '2 of 2 records successfully deleted'));
// Unmatched Postman assertion: pm.expect(jsonData.deleted_hashes.length).to.eql(2))
});

it('check that correct rows were deleted based on date function', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.time_functions' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2))
		// Unmatched Postman assertion: var current_date = new Date().getDate()
		// Unmatched Postman assertion: var date_plus_3 = new Date().setDate(current_date + 3)
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok([3, 4].includes(row.id)));
// Unmatched Postman assertion: pm.expect(row.add_day).to.be.above(date_plus_3))
});

it('check that DATE(__createdtime__) returns correct value w/ correct alias', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT id, DATE(__createdtime__), DATE(__updatedtime__) as updatedtime FROM dev.time_functions WHERE id = 3 OR id = 4',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2))
		// Unmatched Postman assertion: var current_date = new Date().getDate()
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok([3, 4].includes(row.id)));
// Unmatched Postman assertion: pm.expect(new Date(row.updatedtime).getDate()).to.eql(current_date)
// Unmatched Postman assertion: pm.expect(new Date(row['DATE(__createdtime__)']).getDate()).to.eql(current_date)
// Unmatched Postman assertion: pm.expect(row.updatedtime).to.match(/\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}T[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}.\d{3}[+|-][0-1][0-9][0-5][0-9]$/)
// Unmatched Postman assertion: pm.expect(row['DATE(__createdtime__)']).to.match(/\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}T[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}.\d{3}[+|-][0-1][0-9][0-5][0-9]$/))
});

it('count movies where movie.keyword starts with super', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT count(*) AS `count` from dev.movie where search_json(\'$[$substring(name,0, 5) = "super"].name\', keywords) is not null',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'));
// Unmatched Postman assertion: pm.expect(jsonData[0].count).to.eql(161))
});

it('return array of just movie keywords', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT title, search_json(\'name\', keywords) as keywords from dev.movie where title Like \'%Avengers%\'',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2));
// Unmatched Postman assertion: jsonData.forEach(data=>{
// Unmatched Postman assertion: pm.expect(Array.isArray(data.keywords)).to.eql(true)
// Unmatched Postman assertion: pm.expect(typeof data.keywords[0] === 'string').to.eql(true)
//Unmatched Postman assertion: }))
});

it('filter on credits.cast with join to movie', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT m.title, m.overview, m.release_date, search_json(\'$[name in ["Robert Downey Jr.", "Chris Evans", "Scarlett Johansson", "Mark Ruffalo", "Chris Hemsworth", "Jeremy Renner", "Clark Gregg", "Samuel L. Jackson", "Gwyneth Paltrow", "Don Cheadle"]].{"actor": name, "character": character}\', c.`cast`) as characters from dev.credits c inner join dev.movie m on c.movie_id = m.id where search_json(\'$count($[name in ["Robert Downey Jr.", "Chris Evans", "Scarlett Johansson", "Mark Ruffalo", "Chris Hemsworth", "Jeremy Renner", "Clark Gregg", "Samuel L. Jackson", "Gwyneth Paltrow", "Don Cheadle"]])\', c.`cast`) >= 2',
		})
		.expect(200);

// Unmatched Postman assertion: let titles = [
// Unmatched Postman assertion: "Out of Sight",
// Unmatched Postman assertion: "Iron Man",
// Unmatched Postman assertion: "Captain America: The First Avenger",
// Unmatched Postman assertion: "In Good Company",
// Unmatched Postman assertion: "Zodiac",
// Unmatched Postman assertion: "The Spirit",
// Unmatched Postman assertion: "S.W.A.T.",
// Unmatched Postman assertion: "Iron Man 2",
// Unmatched Postman assertion: "Thor",
// Unmatched Postman assertion: "The Avengers",
// Unmatched Postman assertion: "Iron Man 3",
// Unmatched Postman assertion: "Thor: The Dark World",
// Unmatched Postman assertion: "Avengers: Age of Ultron",
// Unmatched Postman assertion: "Captain America: The Winter Soldier",
// Unmatched Postman assertion: "Captain America: Civil War"
// Unmatched Postman assertion: ];

// Unmatched Postman assertion: jsonData.forEach(data=>{
// Unmatched Postman assertion: pm.expect(titles.indexOf(data.title)).to.be.gt(-1)
//Unmatched Postman assertion: }))
});

it('insert values into table dev.sql_function', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'INSERT INTO dev.sql_function (id, rando, week_day) VALUES (1, FLOOR(RANDOM() * (10 - 1)) + 1, date_format(NOW(), \'dddd\')), (2, FLOOR(RANDOM() * (10 - 1)) + 1, date_format(NOW(), \'dddd\'))',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'inserted 2 of 2 records'))
		.expect((r) => assert.ok(r.body.inserted_hashes[0] == 1));
// Unmatched Postman assertion: pm.expect(jsonData.inserted_hashes[1]).to.eql(2))
});

it('SELECT inserted values FROM dev.sql_function', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.sql_function' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2));
// Unmatched Postman assertion: jsonData.forEach(record => {
// Unmatched Postman assertion: pm.expect(typeof record.week_day).to.eql("string")
// Unmatched Postman assertion: pm.expect(typeof record.rando).to.eql("number")
// Unmatched Postman assertion: pm.expect(record.rando >= 1 && record.rando <= 10).to.eql(true)
//Unmatched Postman assertion: }))
});

it('update values into table dev.sql_function', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'UPDATE dev.sql_function SET rando = rando * 10, upper_week_day = UPPER(week_day)',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'updated 2 of 2 records'))
		.expect((r) => assert.ok(r.body.update_hashes[0] == 1));
// Unmatched Postman assertion: pm.expect(jsonData.update_hashes[1]).to.eql(2))
});

it('SELECT updated values FROM dev.sql_function', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.sql_function' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2));
// Unmatched Postman assertion: })
// Unmatched Postman assertion: pm.expect(jsonData[0].rando >= 10 && jsonData[0].rando <= 100).to.eql(true)
// Unmatched Postman assertion: pm.expect(jsonData[1].rando >= 10 && jsonData[1].rando <= 100).to.eql(true)
// Unmatched Postman assertion: pm.expect(jsonData[0].upper_week_day === jsonData[0].week_day.toUpperCase()).to.eql(true)
// Unmatched Postman assertion: pm.expect(jsonData[1].upper_week_day === jsonData[1].week_day.toUpperCase()).to.eql(true))
});

it('update value in table for non-existent row', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'UPDATE northnwd.customers SET companyname = \'Google\' WHERE customerid = -100',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'updated 0 of 0 records'))
		.expect((r) => assert.ok(r.body.skipped_hashes == []))
		.expect((r) => assert.ok(r.body.update_hashes == []));
});

it('Create table keywords for SQL tests', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'create_table', 'schema': 'dev', 'table': 'keywords', 'hash_attribute': 'id' })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('successfully created')));
});

it('Upsert keywords data for SQL tests', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'upsert',
			'schema': 'dev',
			'table': 'keywords',
			'records': [{
				'ALL': 'yes',
				'Inserted': true,
				'__createdtime__': 1605111134623,
				'__updatedtime__': 1605111134623,
				'group': 'A',
				'id': 1,
			}, {
				'ALL': 'no',
				'Inserted': false,
				'__createdtime__': 1605111134624,
				'__updatedtime__': 1605111134624,
				'group': 'B',
				'id': 2,
			}, {
				'ALL': 'yes',
				'Inserted': true,
				'__createdtime__': 1605111134624,
				'__updatedtime__': 1605111134624,
				'group': 'C',
				'id': 3,
			}, {
				'ALL': 'no',
				'Inserted': false,
				'__createdtime__': 1605111134624,
				'__updatedtime__': 1605111134624,
				'group': 'A',
				'id': 4,
			}, {
				'ALL': 'yes',
				'Inserted': true,
				'__createdtime__': 1605111134624,
				'__updatedtime__': 1605111134624,
				'group': 'B',
				'id': 5,
			}, {
				'ALL': 'no',
				'Inserted': false,
				'__createdtime__': 1605111134624,
				'__updatedtime__': 1605111134624,
				'group': 'C',
				'id': 6,
			}, {
				'ALL': 'yes',
				'Inserted': true,
				'__createdtime__': 1605111134624,
				'__updatedtime__': 1605111134624,
				'group': 'A',
				'id': 7,
			}, {
				'ALL': 'no',
				'Inserted': false,
				'__createdtime__': 1605111134624,
				'__updatedtime__': 1605111134624,
				'group': 'B',
				'id': 8,
			}, {
				'ALL': 'yes',
				'Inserted': true,
				'__createdtime__': 1605111134624,
				'__updatedtime__': 1605111134624,
				'group': 'C',
				'id': 9,
			}, {
				'ALL': 'no',
				'Inserted': false,
				'__createdtime__': 1605111134624,
				'__updatedtime__': 1605111134624,
				'group': 'D',
				'id': 10,
			}],
		})
		.expect(200);
// Unmatched Postman assertion: pm.expect(jsonData.upserted_hashes).to.have.length(10))
});

it('Delete row from table with reserverd word in WHERE clause', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'DELETE FROM dev.keywords WHERE `group` = \'D\'' })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == '1 of 1 record successfully deleted'))
		// Unmatched Postman assertion: pm.expect(jsonData.deleted_hashes[0]).to.eql(10)
		// Unmatched Postman assertion: pm.expect(jsonData.deleted_hashes).to.have.length(1)
		.expect((r) => assert.ok(r.body.skipped_hashes.length == 0));
});

it('Delete row from table with multiple reserverd words in WHERE clause', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'DELETE FROM dev.keywords WHERE `group` = \'A\' AND [Inserted] = true' })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == '2 of 2 records successfully deleted'))
		// Unmatched Postman assertion: pm.expect(jsonData.deleted_hashes[0]).to.eql(1)
		// Unmatched Postman assertion: pm.expect(jsonData.deleted_hashes[1]).to.eql(7)
		// Unmatched Postman assertion: pm.expect(jsonData.deleted_hashes).to.have.length(2)
		.expect((r) => assert.ok(r.body.skipped_hashes.length == 0));
});

it('UPDATE rows from table with reserved word in SET and WHERE clause', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'UPDATE dev.keywords SET `group` = \'D\' WHERE [ALL] = \'no\'' })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'updated 4 of 4 records'))
		// Unmatched Postman assertion: pm.expect(jsonData.update_hashes).to.have.length(4)
		.expect((r) => assert.ok(r.body.skipped_hashes.length == 0));
});

it('Drop table keywords', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'drop_table', 'schema': 'dev', 'table': 'keywords' })
		.expect(200);
// Unmatched Postman assertion: tests["Create Table"] = responseBody.has("successfully deleted table 'dev.keywords'"))
});

it('Create table dev.cat for Update', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ 'operation': 'create_table', 'schema': 'dev', 'table': 'cat', 'hash_attribute': 'id' })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'table \'dev.cat\' successfully created.'));
});

it('Insert data into dev.cat', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			'operation': 'insert',
			'schema': 'dev',
			'table': 'cat',
			'records': [{
				'id': 1,
				'weight_lbs': 8,
				'cat_name': 'Sophie',
				'age': 21,
				'adorable': true,
				'outdoor_privilages': null,
				'owner_id': 2,
			}, {
				'id': 2,
				'weight_lbs': 12,
				'cat_name': 'George',
				'age': 11,
				'adorable': true,
				'outdoor_privilages': null,
				'owner_id': 2,
			}, {
				'id': 3,
				'weight_lbs': 20,
				'cat_name': 'Biggie Paws',
				'age': 5,
				'adorable': true,
				'outdoor_privilages': null,
				'owner_id': 4,
			}, {
				'id': 4,
				'weight_lbs': 6,
				'cat_name': 'Willow',
				'age': 4,
				'adorable': true,
				'outdoor_privilages': null,
				'owner_id': 1,
			}, {
				'id': 5,
				'weight_lbs': 15,
				'cat_name': 'Bird',
				'age': 6,
				'adorable': true,
				'outdoor_privilages': null,
				'owner_id': 2,
			}, {
				'id': 6,
				'weight_lbs': 8,
				'cat_name': 'Murph',
				'age': 4,
				'adorable': true,
				'outdoor_privilages': null,
				'owner_id': 3,
			}, {
				'id': 7,
				'weight_lbs': 16,
				'cat_name': 'Simba',
				'age': 1,
				'adorable': true,
				'outdoor_privilages': null,
				'owner_id': 4,
			}, {
				'id': 8,
				'weight_lbs': 12,
				'cat_name': 'Gemma',
				'age': 3,
				'adorable': true,
				'outdoor_privilages': null,
				'owner_id': 1,
			}, { 'id': 9, 'weight_lbs': 10, 'cat_name': 'Bob', 'age': 8, 'adorable': true, 'outdoor_privilages': null }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'inserted 9 of 9 records'));
});

it('Update record basic where dev.cat', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ 'operation': 'sql', 'sql': 'UPDATE dev.cat SET cat_name = \'Bobby\' WHERE id = 9' })
		.expect((r) => assert.ok(r.body.message == 'updated 1 of 1 records', 'Expected response message to eql "updated 1 of 1 records"'))
		.expect(200);

// Unmatched Postman assertion: var jsonData = pm.response.json(
// Unmatched Postman assertion: pm.expect(jsonData.update_hashes[0]).to.eql(9))
});

it('Confirm update record basic where dev.cat', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ 'operation': 'sql', 'sql': 'SELECT cat_name, weight_lbs, age, id FROM dev.cat WHERE id = 9' })
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == 9))
		.expect((r) => assert.ok(r.body[0].weight_lbs == 10))
		.expect((r) => assert.ok(r.body[0].cat_name == 'Bobby'))
		.expect((r) => assert.ok(r.body[0].age == 8));
});

it('Update record "where x != y" dev.cat', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ 'operation': 'sql', 'sql': 'UPDATE dev.cat SET adorable = false WHERE owner_id != 2' })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'updated 5 of 5 records'))
		.expect((r) => assert.ok(r.body.update_hashes.includes(3, 4, 6, 7, 8)));
});

it('Confirm update record "where x != y" dev.cat', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ 'operation': 'sql', 'sql': 'SELECT cat_name, adorable, id FROM dev.cat WHERE owner_id != 2' })
		.expect(200)
		// Unmatched Postman assertion: pm.expect(jsonData.length).to.equal(5)
		// Unmatched Postman assertion: jsonData.forEach(obj => {
		.expect((r) => assert.ok(Object.keys(obj).length == 3))
		// Unmatched Postman assertion: pm.expect(obj.adorable).to.equal(false)
		.expect((r) => assert.ok(obj.cat_name == 'Biggie Paws' || obj.cat_name == 'Willow' || obj.cat_name == 'Murph' || obj.cat_name == 'Simba' || obj.cat_name == 'Gemma'));
// Unmatched Postman assertion: pm.expect(obj.id).to.be.oneOf([3,4,6,7,8])})
});

it('Update record No where dev.cat', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ 'operation': 'sql', 'sql': 'UPDATE dev.cat SET adorable = true' })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'updated 9 of 9 records'))
		.expect((r) => assert.ok(r.body.update_hashes.includes(1, 2, 3, 4, 5, 6, 7, 8, 9)));
// Unmatched Postman assertion: pm.expect(jsonData.skipped_hashes).to.eql([]))
});

it('Confirm update record No where dev.cat', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ 'operation': 'sql', 'sql': 'SELECT cat_name, adorable, id FROM dev.cat' })
		.expect(200)
		// Unmatched Postman assertion: pm.expect(jsonData.length).equals(9)
		// Unmatched Postman assertion: jsonData.forEach(obj => {
		.expect((r) => assert.ok(Object.keys(obj).length == 3))
		// Unmatched Postman assertion: pm.expect(obj.adorable).to.equal(true)
		.expect((r) => {
			const cats = ['Sophie', 'George', 'Biggie Paws', 'Willow', 'Bird', 'Murph', 'Simba', 'Gemma', 'Bobby'];
			assert.ok(cats.some(el => obj.cat_name.includes(el)));
		});
// Unmatched Postman assertion: pm.expect().to.be.oneOf()
// Unmatched Postman assertion: pm.expect(obj.id).to.be.oneOf([1,2,3,4,5,6,7,8,9])})
});

it('Update record multiple wheres, multiple columns dev.cat', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			'operation': 'sql',
			'sql': 'UPDATE dev.cat SET outdoor_privilages = false, weight_lbs = 6 WHERE owner_id = 2 AND cat_name = \'Sophie\'',
		})
		.expect((r) => assert.ok(r.body.message == 'updated 1 of 1 records', 'Expected response message to eql "updated 1 of 1 records"'))
		.expect(200);
// Unmatched Postman assertion: pm.expect(jsonData.update_hashes[0]).to.eql(1))
});

it('Confirm update record multiple wheres, multiple columns dev.cat', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			'operation': 'sql',
			'sql': 'SELECT cat_name, weight_lbs, owner_id, outdoor_privilages, id FROM dev.cat WHERE owner_id = 2 AND cat_name = \'Sophie\'',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == 1))
		.expect((r) => assert.ok(r.body[0].weight_lbs == 6))
		.expect((r) => assert.ok(r.body[0].cat_name == 'Sophie'))
		.expect((r) => assert.ok(r.body[0].owner_id == 2))
		.expect((r) => assert.ok(r.body[0].outdoor_privilages == false));
});

it('Update record "where x is NULL" dev.cat', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			'operation': 'sql',
			'sql': 'UPDATE dev.cat SET outdoor_privilages = true WHERE outdoor_privilages IS null',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'updated 8 of 8 records'))
		.expect((r) => assert.ok(r.body.update_hashes.includes(2, 3, 4, 5, 6, 7, 8, 9)));
});

it('Confirm update record "where x is NULL" dev.cat', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			'operation': 'sql',
			'sql': 'SELECT cat_name, outdoor_privilages, id FROM dev.cat WHERE outdoor_privilages IS null',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 0));
});

it('Update record with nonexistant id dev.cat', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ 'operation': 'sql', 'sql': 'UPDATE dev.cat SET cat_name = \'Garfield\' WHERE id = 75' })
		.expect(200)
		// @@@@@@@
		.expect((r) => assert.ok(r.body.message == 'updated 0 of 0 records'))
		.expect((r) => assert.ok(r.body.update_hashes == []));
});

it('Confirm update record with nonexistant id dev.cat', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ 'operation': 'sql', 'sql': 'SELECT cat_name, weight_lbs, age FROM dev.cat WHERE id = 75' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 0));
});

it('Drop table cat from dev.cat', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ 'operation': 'drop_table', 'schema': 'dev', 'table': 'cat' })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'successfully deleted table \'dev.cat\''));
});

it('Create table "geo"', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'create_table', 'table': 'geo', 'hash_attribute': 'id' })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'table \'data.geo\' successfully created.'));
});

it('Insert values into "geo" table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send('{\n   \n\t"operation":"insert",\n\t"table":"geo",\n\t"records": [\n        {\n            "id": 1,\n            "name": "Wellington",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [174.776230, -41.286461]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[ [174.615474867904,-41.34148585702194],\n                    [174.8800567396483,-41.31574371071801],\n                    [174.6896944170223,-41.19759744824616],\n                    [174.615474867904,-41.34148585702194]\n                ]]\n            },\n            "geo_line": {\n                "type": "LineString",\n                "coordinates": [\n                    [174.615474867904,-41.34148585702194],\n                    [174.8800567396483,-41.31574371071801]\n                ]\n            }\n        },\n        {\n            "id": 2,\n            "name": "North Adams",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [-73.108704, 42.700539]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[                  [-73.12391499193579,42.70656096680374],\n                    [-73.12255557219314,42.69646774251972],\n                    [-73.09908993001123,42.6984753377431],\n                    [-73.10369107948782,42.70876034407737],\n                    [-73.12391499193579,42.70656096680374]\n                ]]\n            }\n        },\n        {\n            "id": 3,\n            "name": "Denver",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [-104.990250, 39.739235]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[          [-105.0487835030464,39.77676227285275],\n                    [-105.0175466672944,39.68744341857906],\n                    [-104.9113967289065,39.74637288224356],\n                    [-105.0487835030464,39.77676227285275]\n                ]]\n            }\n        },\n        {\n            "id": 4,\n            "name": "New York City",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [-74.005974, 40.712776]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[             [-74.00852603549784,40.73107908806126],\n                    [-74.03702059033735,40.70472625054263],\n                    [-73.98786450714653,40.70419899758365],\n                    [-74.00852603549784,40.73107908806126]\n                ]]\n            }\n        },\n        {\n            "id": 5,\n            "name": "Salt Lake City",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [-111.920485, 40.7766079]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[           [-112.8291507578281,40.88206673094385],\n                    [-112.8956858211181,40.30332102898777],\n                    [-111.6032172200158,40.02757615254776],\n                    [-111.1456265349256,40.95908300700454],\n                    [-111.9047878338339,41.3291504973315],\n                    [-112.8291507578281,40.88206673094385]\n                ]]\n            },\n            "geo_line": {\n                "type": "LineString",\n                "coordinates": [        [-112.8291507578281,40.88206673094385],\n                    [-112.8956858211181,40.30332102898777],\n                    [-111.6032172200158,40.02757615254776],\n                    [-111.1456265349256,40.95908300700454],\n                    [-111.9047878338339,41.3291504973315],\n                    [-112.8291507578281,40.88206673094385]\n                ]\n            }\n        },\n        {\n            "id": 6,\n            "name": "Null Island",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [null, null]\n            },\n            "geo_poly": null,\n            "geo_line": {\n                "type": "LineString",\n                "coordinates": [\n                    [-112.8291507578281,40.88206673094385],\n                    [null, null]\n                ]\n            }\n        },\n        {\n            "id": 7\n        },\n        {\n            "id": 8,\n            "name": "Hobbiton",\n            "geo_point" : [174.776230, -41.286461],\n            "geo_poly": "Somewhere in the shire",\n            "geo_line": {\n                "type": "LineString"\n            }\n        }\n    ]\n}\n')
		.expect((r) => assert.ok(r.body.message == 'inserted 8 of 8 records'))
		.expect(200);
});

it('geoArea test 1', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT id, name, geoArea(geo_poly) as area FROM data.geo ORDER BY area ASC' })
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [
			{
				'id': 6,
				'name': 'Null Island',
			},
			{
				'id': 7,
				'name': null,
			},
			{
				'id': 8,
				'name': 'Hobbiton',
			},
			{
				'id': 2,
				'name': 'North Adams',
				'area': 2084050.5321900067,
			},
			{
				'id': 4,
				'name': 'New York City',
				'area': 6153970.008639627,
			},
			{
				'id': 3,
				'name': 'Denver',
				'area': 53950986.64863105,
			},
			{
				'id': 1,
				'name': 'Wellington',
				'area': 168404308.63474682,
			},
			{
				'id': 5,
				'name': 'Salt Lake City',
				'area': 14011200847.709723,
			}]));
});

it('geoArea test 2', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT id, name FROM data.geo where geoArea(geo_poly) > 53950986.64863106' })
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [
			{
				'id': 1,
				'name': 'Wellington',
			},
			{
				'id': 5,
				'name': 'Salt Lake City',
			}]));
});

it('geoArea test 3', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT geoArea(\'{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[0.123456,0],[0.123456,0.123456],[0,0.123456]]]}}\')',
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [
			{
				'geoArea(\'{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[0.123456,0],[0.123456,0.123456],[0,0.123456]]]}}\')': 188871526.05092356,
			}]));
});

it('geoLength test 1', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT geoLength(\'{"type": "Feature","geometry": {"type": "LineString","coordinates": [[-104.97963309288025,39.76163265441438],[-104.9823260307312,39.76365323407955],[-104.99193906784058,39.75616442110704]]}}\')',
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [
			{
				'geoLength(\'{"type": "Feature","geometry": {"type": "LineString","coordinates": [[-104.97963309288025,39.76163265441438],[-104.9823260307312,39.76365323407955],[-104.99193906784058,39.75616442110704]]}}\')': 1.491544504248235,
			}]));
});

it('geoLength test 2', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT id, name, geoLength(geo_line, \'miles\') FROM data.geo' })
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [
			{
				'id': 1,
				'name': 'Wellington',
				'geoLength(geo_line,"miles")': 13.842468187961332,
			},
			{
				'id': 2,
				'name': 'North Adams',
			},
			{
				'id': 3,
				'name': 'Denver',
			},
			{
				'id': 4,
				'name': 'New York City',
			},
			{
				'id': 5,
				'name': 'Salt Lake City',
				'geoLength(geo_line,"miles")': 283.9341846273217,
			},
			{
				'id': 6,
				'name': 'Null Island',
				'geoLength(geo_line,"miles")': 7397.000649273201,
			},
			{
				'id': 7,
				'name': null,
			},
			{
				'id': 8,
				'name': 'Hobbiton',
			}]));
});

it('geoLength test 3', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT id, name FROM data.geo WHERE geoLength(geo_line, \'miles\') < 100' })
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [
			{
				'id': 1,
				'name': 'Wellington',
			}]));
});

it('geoDifference test 1', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT geoDifference(\'{"type": "Feature","properties": {"name":"Colorado"},"geometry": {"type": "Polygon","coordinates": [[[-109.072265625,37.00255267215955],[-102.01904296874999,37.00255267215955],[-102.01904296874999,41.0130657870063],[-109.072265625,41.0130657870063],[-109.072265625,37.00255267215955]]]}}\',\'{"type": "Feature","properties": {"name":"City Park"},"geometry": {"type": "Polygon","coordinates": [[[-104.95973110198975,39.7543828214657],[-104.95955944061278,39.744781185675386],[-104.95904445648193,39.74422022399989],[-104.95835781097412,39.74402223643582],[-104.94097709655762,39.74392324244047],[-104.9408483505249,39.75434982844515],[-104.95973110198975,39.7543828214657]]]}}\')',
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [
			{
				'geoDifference(\'{"type": "Feature","properties": {"name":"Colorado"},"geometry": {"type": "Polygon","coordinates": [[[-109.072265625,37.00255267215955],[-102.01904296874999,37.00255267215955],[-102.01904296874999,41.0130657870063],[-109.072265625,41.0130657870063],[-109.072265625,37.00255267215955]]]}}\',\'{"type": "Feature","properties": {"name":"City Park"},"geometry": {"type": "Polygon","coordinates": [[[-104.95973110198975,39.7543828214657],[-104.95955944061278,39.744781185675386],[-104.95904445648193,39.74422022399989],[-104.95835781097412,39.74402223643582],[-104.94097709655762,39.74392324244047],[-104.9408483505249,39.75434982844515],[-104.95973110198975,39.7543828214657]]]}}\')': {
					'type': 'Feature',
					'properties': {
						'name': 'Colorado',
					},
					'geometry': {
						'type': 'Polygon',
						'coordinates': [
							[
								[
									-109.072265625,
									37.00255267215955,
								],
								[
									-102.01904296874999,
									37.00255267215955,
								],
								[
									-102.01904296874999,
									41.0130657870063,
								],
								[
									-109.072265625,
									41.0130657870063,
								],
								[
									-109.072265625,
									37.00255267215955,
								],
							],
							[
								[
									-104.95973110198975,
									39.7543828214657,
								],
								[
									-104.9408483505249,
									39.75434982844515,
								],
								[
									-104.94097709655762,
									39.74392324244047,
								],
								[
									-104.95835781097412,
									39.74402223643582,
								],
								[
									-104.95904445648193,
									39.74422022399989,
								],
								[
									-104.95955944061278,
									39.744781185675386,
								],
								[
									-104.95973110198975,
									39.7543828214657,
								],
							],
						],
					},
				},
			}]));
});

it('geoDifference test 2', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT geoDifference(\'{"type": "Feature","properties": {"name":"Colorado"},"geometry": {"type": "Polygon","coordinates": [[[-109.072265625,37.00255267215955],[-102.01904296874999,37.00255267215955],[-102.01904296874999,41.0130657870063],[-109.072265625,41.0130657870063],[-109.072265625,37.00255267215955]]]}}\', null)',
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [
			{},
		]));
});

it('geoDistance test 1', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT geoDistance(\'[-104.979127,39.761563]\', \'[-77.035248,38.889475]\', \'miles\')',
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [
			{
				'geoDistance(\'[-104.979127,39.761563]\',\'[-77.035248,38.889475]\',\'miles\')': 1488.6913067538915,
			},
		]));
});

it('geoDistance test 2', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT id, name, geoDistance(\'[-104.979127,39.761563]\', geo_point, \'miles\') as distance FROM data.geo WHERE geoDistance(\'[-104.979127,39.761563]\', geo_point, \'kilometers\') < 40 ORDER BY distance ASC',
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [
			{
				'id': 3,
				'name': 'Denver',
				'distance': 1.6520011088478226,
			}]));
});

it('geoDistance test 3', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT id, name, geoDistance(\'[-104.979127,39.761563]\', geo_point, \'miles\') as distance FROM data.geo',
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [
// Unmatched Postman assertion: {
// Unmatched Postman assertion: "id": 1,
// Unmatched Postman assertion: "name": "Wellington",
// Unmatched Postman assertion: "distance": 7525.228704326891
// Unmatched Postman assertion: },
// Unmatched Postman assertion: {
// Unmatched Postman assertion: "id": 2,
// Unmatched Postman assertion: "name": "North Adams",
// Unmatched Postman assertion: "distance": 1658.5109905949885
// Unmatched Postman assertion: },
// Unmatched Postman assertion: {
// Unmatched Postman assertion: "id": 3,
// Unmatched Postman assertion: "name": "Denver",
// Unmatched Postman assertion: "distance": 1.6520011088478226
// Unmatched Postman assertion: },
// Unmatched Postman assertion: {
// Unmatched Postman assertion: "id": 4,
// Unmatched Postman assertion: "name": "New York City",
// Unmatched Postman assertion: "distance": 1626.4974205601618
// Unmatched Postman assertion: },
// Unmatched Postman assertion: {
// Unmatched Postman assertion: "id": 5,
// Unmatched Postman assertion: "name": "Salt Lake City",
// Unmatched Postman assertion: "distance": 372.4978228173876
// Unmatched Postman assertion: },
// Unmatched Postman assertion: {
// Unmatched Postman assertion: "id": 6,
// Unmatched Postman assertion: "name": "Null Island",
// Unmatched Postman assertion: "distance": 7010.231359296063
// Unmatched Postman assertion: },
// Unmatched Postman assertion: {
// Unmatched Postman assertion: "id": 7,
// Unmatched Postman assertion: "name": null
// Unmatched Postman assertion: },
// Unmatched Postman assertion: {
// Unmatched Postman assertion: "id": 8,
// Unmatched Postman assertion: "name": "Hobbiton",
// Unmatched Postman assertion: "distance": 7525.228704326891
// Unmatched Postman assertion: }
});

it('geoNear test 1', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT id, name FROM data.geo WHERE geoNear(\'[-104.979127,39.761563]\', geo_point, 50, \'miles\')',
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [
// Unmatched Postman assertion: {
// Unmatched Postman assertion: "id": 3,
// Unmatched Postman assertion: "name": "Denver"
// Unmatched Postman assertion: }
});

it('geoNear test 2', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT id, name, geoDistance(\'[-104.979127,39.761563]\', geo_point, \'miles\') as distance FROM data.geo WHERE geoNear(\'[-104.979127,39.761563]\', geo_point, 20, \'degrees\') ORDER BY distance ASC',
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [
// Unmatched Postman assertion: {
// Unmatched Postman assertion: "id": 3,
// Unmatched Postman assertion: "name": "Denver",
// Unmatched Postman assertion: "distance": 1.6520011088478226
// Unmatched Postman assertion: },
// Unmatched Postman assertion: {
// Unmatched Postman assertion: "id": 5,
// Unmatched Postman assertion: "name": "Salt Lake City",
// Unmatched Postman assertion: "distance": 372.4978228173876
// Unmatched Postman assertion: }
});

it('geoContains test 1', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT id, name FROM data.geo WHERE geoContains(\'{"type": "Feature","properties": {"name":"Colorado"},"geometry": {"type": "Polygon","coordinates": [[[-109.072265625,37.00255267],[-102.01904296874999,37.00255267],[-102.01904296874999,41.01306579],[-109.072265625,41.01306579],[-109.072265625,37.00255267]]]}}\', geo_point)',
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [
// Unmatched Postman assertion: {
// Unmatched Postman assertion: "id": 3,
// Unmatched Postman assertion: "name": "Denver"
// Unmatched Postman assertion: }
});

it('geoContains test 2', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT id, name FROM data.geo WHERE geoContains(geo_poly, \'{"type": "Feature","properties": {"name": "HarperDB Headquarters"},"geometry": {"type": "Polygon","coordinates": [[[-104.98060941696167,39.760704817357905],[-104.98053967952728,39.76065120861263],[-104.98055577278137,39.760642961109674],[-104.98037070035934,39.76049450588716],[-104.9802714586258,39.76056254790385],[-104.9805235862732,39.76076461167841],[-104.98060941696167,39.760704817357905]]]}}\')',
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [
// Unmatched Postman assertion: {
// Unmatched Postman assertion: "id": 3,
// Unmatched Postman assertion: "name": "Denver"
// Unmatched Postman assertion: }
});

it('geoEqual test 1', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT * FROM data.geo WHERE geoEqual(geo_poly, \'{"type": "Feature","properties": {"name": "HarperDB Headquarters"},"geometry": {"type": "Polygon","coordinates": [[[-104.98060941696167,39.760704817357905],[-104.98053967952728,39.76065120861263],[-104.98055577278137,39.760642961109674],[-104.98037070035934,39.76049450588716],[-104.9802714586258,39.76056254790385],[-104.9805235862732,39.76076461167841],[-104.98060941696167,39.760704817357905]]]}}\')',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 0));
});

it('geoCrosses test 1', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT id, name FROM data.geo WHERE geoCrosses(geo_poly,\'{"type": "Feature","properties": {"name": "Highway I-25"},"geometry": {"type": "LineString","coordinates": [[-104.9139404296875,41.00477542222947],[-105.0238037109375,39.715638134796336],[-104.853515625,39.53370327008705],[-104.853515625,38.81403111409755],[-104.61181640625,38.39764411353178],[-104.8974609375,37.68382032669382],[-104.501953125,37.00255267215955]]}}\')',
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [{ 'id': 3, 'name': 'Denver' }]));
});

it('geoConvert test 1', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT geoConvert(\'[-104.979127,39.761563]\',\'point\',\'{"name": "HarperDB Headquarters"}\')',
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [
// Unmatched Postman assertion: {
// Unmatched Postman assertion: "geoConvert('[-104.979127,39.761563]','point','{\"name\": \"HarperDB Headquarters\"}')": {
// Unmatched Postman assertion: "type": "Feature",
// Unmatched Postman assertion: "properties": "{\"name\": \"HarperDB Headquarters\"}",
// Unmatched Postman assertion: "geometry": {
// Unmatched Postman assertion: "type": "Point",
// Unmatched Postman assertion: "coordinates": [
// Unmatched Postman assertion: -104.979127,
// Unmatched Postman assertion: 39.761563
// Unmatched Postman assertion: ]
// Unmatched Postman assertion: }
// Unmatched Postman assertion: }
// Unmatched Postman assertion: }
});

it('Drop table '
geo;
'', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'drop_table', 'schema': 'data', 'table': 'geo' })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'successfully deleted table \'data.geo\''));
};
)
;

it('insert value into table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'INSERT INTO northnwd.customers (customerid, postalcode, companyname) VALUES (\'TEST3\', 11385, \'Microsoft\')',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'));
// Unmatched Postman assertion: pm.expect(jsonData.inserted_hashes[0]).to.eql("TEST3"))
});

it('insert value into table confirm', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT customerid, postalcode, companyname FROM northnwd.customers WHERE customerid = \'TEST3\'',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body[0].customerid == 'TEST3'))
		.expect((r) => assert.ok(r.body[0].postalcode == 11385))
		.expect((r) => assert.ok(r.body[0].companyname == 'Microsoft'));
});

it('update value in table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'UPDATE northnwd.customers SET companyname = \'Google\' WHERE customerid = \'TEST3\'',
		})
		.expect((r) => assert.ok(r.body.message == 'updated 1 of 1 records', 'Expected response message to eql "updated 1 of 1 records"'))
		.expect(200)
		.expect((r) => assert.ok(r.body.update_hashes[0] == 'TEST3'));
});

it('update value in table confirm', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT customerid, postalcode, companyname FROM northnwd.customers WHERE customerid = \'TEST3\'',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body[0].customerid == 'TEST3'))
		.expect((r) => assert.ok(r.body[0].postalcode == 11385))
		.expect((r) => assert.ok(r.body[0].companyname == 'Google'));
});

it('attempt to update __createdtime__ in table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'UPDATE northnwd.customers SET __createdtime__ = \'bad value\' WHERE customerid = \'TEST3\'',
		})
		.expect((r) => assert.ok(r.body.message == 'updated 1 of 1 records', 'Expected response message to eql "updated 1 of 1 records"'))
		.expect(200)
		.expect((r) => assert.ok(r.body.update_hashes[0] == 'TEST3'));
});

it('Confirm __createdtime__ did not get changed', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT __createdtime__ FROM northnwd.customers WHERE customerid = \'TEST3\'' })
		.expect(200)
		.expect((r) => assert.ok(r.body[0].__createdtime__ != 'bad value'));
});

it('delete value from table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'DELETE FROM northnwd.customers WHERE customerid = \'TEST3\'' })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('successfully deleted')));
});

it('delete value from table confirm', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT customerid, postalcode, companyname FROM northnwd.customers WHERE companyname = \'Microsoft\'',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 0));
});

it('select w/ where in numeric values as strings', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * from dev.books WHERE id IN(\'1\',\'2\',\'3\') ORDER BY id' })
		.expect((r) => assert.ok(r.body.length == 3))
		// Unmatched Postman assertion: jsonData.forEach((row, i) => {
		.expect((r) => assert.ok(row.id == i + 1));
});

it('select w/ where between', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * from dev.books WHERE id BETWEEN 1 AND 3 ORDER BY id' })
		.expect((r) => assert.ok(r.body.length == 3))
		// Unmatched Postman assertion: jsonData.forEach((row, i) => {
		.expect((r) => assert.ok(row.id == i + 1));
});

it('select w/ where not between', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * from dev.books WHERE id NOT BETWEEN 1 AND 3 ORDER BY id' });
// Unmatched Postman assertion: pm.expect(jsonData.length).to.eql(47)
// Unmatched Postman assertion: jsonData.forEach((row, i) => {
// Unmatched Postman assertion: pm.expect(row.id).to.be.above(3))
});

it('select w/ where value equals 0', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * from dev.books WHERE books_count = 0 ' })
		.expect((r) => assert.ok(r.body.length == 4));
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect(row.books_count).to.eql(0))
});

it('select w/ where value equals "false"', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * from dev.books WHERE nytimes_best_seller = \'false\' ' })
		.expect((r) => assert.ok(r.body.length == 25));
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect(row.nytimes_best_seller).to.eql(false))
});

it('select employees orderby id asc', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select {{emps_id}}, * from {{schema}}.{{emps_tb}} order by {{emps_id}} asc ',
		})
		.expect((r) => assert.ok(r.body.length == 10))
		.expect((r) => assert.ok(r.body[0].employeeid == 1));
// Unmatched Postman assertion: pm.expect(jsonData[1].employeeid).to.eql(2)
// Unmatched Postman assertion: pm.expect(jsonData[8].employeeid).to.eql(9)
// Unmatched Postman assertion: pm.expect(jsonData[9].employeeid).to.eql(25))
});

it('select 2 + 2', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select 2 + 2 ' });
// Unmatched Postman assertion: pm.expect(jsonData[0]["2 + 2"]).to.eql(4))
});

it('select * FROM orders - test no schema', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * FROM orders' })
		.expect(500)
		.expect((r) => assert.ok(r.body.error == 'schema not defined for table orders'));
});

it(
	'select * from call.aggr - reserved words', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ 'operation': 'sql', 'sql': 'select * from call.aggr' })
			.expect(400);
	});

it('select * from `call`.`aggr` - reserved words', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select age AS `alter`, * from `call`.`aggr` as `and` WHERE `all` > 3 ORDER BY `and`.`all` desc',
		})
		.expect(200);
});

// Unmatched Postman assertion: pm.expect(jsonData[0].all).to.eql(11))
})
;

it('select * from call.aggr where id = 11 - select dot & double dot', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * from `call`.`aggr` where `all` = 11' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].owner_name == '..'));
// Unmatched Postman assertion: pm.expect(jsonData[0].dog_name).to.eql("."))
});

it('select * from invalid schema - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * from `braaah`.`aggr`' })
		.expect(404)
		.expect((r) => assert.ok(r.body.error == 'database \'braaah\' does not exist'));
});

it('select * from invalid table - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * from `call`.`braaaah`' })
		.expect(404)
		.expect((r) => assert.ok(r.body.error == 'Table \'call.braaaah\' does not exist'));
});

it('select orders orderby id desc', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select {{ords_id}}, * from {{schema}}.{{ords_tb}} order by {{ords_id}} desc ',
		});
// Unmatched Postman assertion: pm.expect(jsonData[0].orderid).to.eql(11077))
});

it('select count(*) orders where shipregion is null', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select count(*) as `count` from {{schema}}.{{ords_tb}} where shipregion IS NULL',
		});
// Unmatched Postman assertion: pm.expect(jsonData[0].count).to.eql(414))
});

it('select count(*) orders where shipregion is not null', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select count(*) AS `count` from {{schema}}.{{ords_tb}} where shipregion is not null',
		});
// Unmatched Postman assertion: pm.expect(jsonData[0].count).to.eql(416))
});

it('select most buyer orderby price asc', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select a.{{ords_id}}, a.productid, d.companyname, d.contactmame, b.productname, sum(a.unitprice) as unitprice, sum(a.quantity), sum(a.discount) from {{schema}}.{{ordd_tb}} a join {{schema}}.{{prod_tb}} b on a.{{prod_id}}=b.{{prod_id}} join {{schema}}.{{ords_tb}} c on a.{{ords_id}}=c.{{ords_id}} join {{schema}}.{{cust_tb}} d on c.{{cust_id}}=d.{{cust_id}} group by a.{{ords_id}}, a.productid, d.companyname, d.contactmame, b.productname order by unitprice desc, d.companyname ',
		})
		.expect((r) => assert.ok(r.body[0].companyname == 'Berglunds snabbk\ufffdp'));
// Unmatched Postman assertion: pm.expect(jsonData[1].companyname).to.eql("Great Lakes Food Market"))
});

it('select most buyer orderby price asc & companyname alias', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select a.{{ords_id}}, a.productid, d.companyname as compname, d.contactmame, b.productname, sum(a.unitprice) as unitprice, sum(a.quantity), sum(a.discount) from {{schema}}.{{ordd_tb}} a join {{schema}}.{{prod_tb}} b on a.{{prod_id}}=b.{{prod_id}} join {{schema}}.{{ords_tb}} c on a.{{ords_id}}=c.{{ords_id}} join {{schema}}.{{cust_tb}} d on c.{{cust_id}}=d.{{cust_id}} group by a.{{ords_id}}, a.productid, d.companyname, d.contactmame, b.productname order by unitprice desc, compname ',
		});
// Unmatched Postman assertion: pm.expect(jsonData[0].compname).to.eql("Berglunds snabbk\ufffdp")
// Unmatched Postman assertion: pm.expect(jsonData[1].compname).to.eql("Great Lakes Food Market"))
});

it('select most buyer orderby order_id asc & product_id desc', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select a.{{ords_id}} as ords_id, a.productid, d.companyname as companyname, d.contactmame, b.productname, sum(a.unitprice) as unitprice, sum(a.quantity), sum(a.discount) from {{schema}}.{{ordd_tb}} a join {{schema}}.{{prod_tb}} b on a.{{prod_id}}=b.{{prod_id}} join {{schema}}.{{ords_tb}} c on a.{{ords_id}}=c.{{ords_id}} join {{schema}}.{{cust_tb}} d on c.{{cust_id}}=d.{{cust_id}} group by a.{{ords_id}}, a.productid, d.companyname, d.contactmame, b.productname order by ords_id, a.productid desc',
		})
		// Unmatched Postman assertion: pm.expect(jsonData[0].ords_id).to.eql(10248)
		// Unmatched Postman assertion: pm.expect(jsonData[1].ords_id).to.eql(10248)
		// Unmatched Postman assertion: pm.expect(jsonData[19].ords_id).to.eql(10254)
		.expect((r) => assert.ok(r.body[0].companyname == 'Vins et alcools Chevalier'));
// Unmatched Postman assertion: pm.expect(jsonData[19].companyname).to.eql("Chop-suey Chinese")
// Unmatched Postman assertion: pm.expect(jsonData[0].productid).to.eql(72)
// Unmatched Postman assertion: pm.expect(jsonData[1].productid).to.eql(42)
// Unmatched Postman assertion: pm.expect(jsonData[19].productid).to.eql(24))
});

it('select product orderby id asc', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select {{prod_id}}, * from {{schema}}.{{prod_tb}} order by {{prod_id}} asc ',
		});
// Unmatched Postman assertion: pm.expect(jsonData[0].productid).to.eql(1))
});

it('select customers orderby id asc', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select {{cust_id}}, * from {{schema}}.{{cust_tb}} order by {{cust_id}} asc ',
		})
		.expect((r) => assert.ok(r.body[0].customerid == 'ALFKI'));
});

it('select all details join 5 table where customername', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select a.{{cust_id}}, a.companyname, a.contactmame, b.{{ords_id}}, b.shipname, d.productid, d.productname, d.unitprice, c.quantity, c.discount, e.employeeid, e.firstname, e.lastname from {{schema}}.{{cust_tb}} a join {{schema}}.{{ords_tb}} b on a.{{cust_id}}=b.{{cust_id}} join {{schema}}.{{ordd_tb}} c on b.{{ordd_id}}=c.{{ordd_id}} join {{schema}}.{{prod_tb}} d on c.{{prod_id}}=d.{{prod_id}} join {{schema}}.{{emps_tb}} e on b.{{emps_id}}=e.{{emps_id}}  where a.companyname=\'Alfreds Futterkiste\' ',
		})
		.expect((r) => assert.ok(r.body[0].customerid == 'ALFKI'));
});

it('select * with LEFT OUTER JOIN', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.breed b LEFT JOIN dev.dog d ON b.id = d.breed_id' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 351))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		// Unmatched Postman assertion: const keys = Object.keys(row)
		// Unmatched Postman assertion: pm.expect(keys.length).to.eql(16)
		// Unmatched Postman assertion: Object.keys(row).forEach(key => {
		.expect((r) => assert.ok(row[key] != undefined));

});

it('select specific columns with LEFT OUTER JOIN Copy', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT b.name, b.id, d.* FROM dev.breed b LEFT JOIN dev.dog d ON b.id = d.breed_id',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 351))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		// Unmatched Postman assertion: const keys = Object.keys(row)
		// Unmatched Postman assertion: pm.expect(keys.length).to.eql(11)
		// Unmatched Postman assertion: Object.keys(row).forEach(key => {
		.expect((r) => assert.ok(row[key] != undefined));

});

it('select order details', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select {{ordd_id}}, productid, unitprice,quantity, discount from {{schema}}.{{ordd_tb}} order by {{ordd_id}} asc',
		});
// Unmatched Postman assertion: pm.expect(jsonData[0].orderid).to.eql(10248))
});

it('select count groupby country', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select count({{cust_id}}) as counter,country from {{schema}}.{{cust_tb}} group by country order by counter desc',
		});
// Unmatched Postman assertion: pm.expect(jsonData[0].country).to.eql('USA'))
});

it('select most have the extension employees', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select extension,* from {{schema}}.{{emps_tb}} order by extension desc' });
// Unmatched Postman assertion: pm.expect(jsonData[0].firstname).to.eql("Nancy")})
});

it('select top 10 most price of product', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select categoryid,productname,quantityperunit,unitprice,* from {{schema}}.{{prod_tb}}  order by unitprice desc limit 10 ',
		});
// Unmatched Postman assertion: pm.expect(jsonData[0].productname).to.equal("C\ufffdte de Blaye"))
});

it('select count min max avg sum price of products', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select count(unitprice) as allproducts, min(unitprice) as minprice, max(unitprice) as maxprice, avg(unitprice) as avgprice, sum(unitprice) as sumprice from {{schema}}.{{prod_tb}} ',
		});
// Unmatched Postman assertion: pm.expect(jsonData[0].allproducts).to.equal(77))
});

it('select round unit price using alias', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT ROUND(unitprice) AS Price FROM {{schema}}.{{prod_tb}} GROUP BY ROUND(unitprice)',
		})
		.expect(200);
// Unmatched Postman assertion: var objKeysData = Object.keys(jsonData[0])
// Unmatched Postman assertion: pm.expect(objKeysData[0]).to.eql('Price'))
});

it('select where (like)and(<=>)', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select * from {{schema}}.{{prod_tb}} where (productname like \'T%\') and (unitprice>100) ',
		});
// Unmatched Postman assertion: pm.expect(jsonData[0].unitprice > 100).to.be.true;})
});

it('select - where attr < comparator', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * from {{schema}}.{{prod_tb}} where unitprice < 81' });
// Unmatched Postman assertion: jsonData.forEach((record)=>{
// Unmatched Postman assertion: pm.expect(record.unitprice < 81).to.be.true;});
});

it('select - where attr <= comparator', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * from {{schema}}.{{prod_tb}} where unitprice <= 81' })
		// Unmatched Postman assertion: jsonData.forEach((record)=>{
		.expect((r) => assert.ok(record.unitprice <= 81));
});

it('select - where attr > comparator', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * from {{schema}}.{{prod_tb}} where unitprice > 81' });
// Unmatched Postman assertion: jsonData.forEach((record)=>{
// Unmatched Postman assertion: pm.expect(record.unitprice > 81).to.be.true;});
});

it('select - where attr >= comparator', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * from {{schema}}.{{prod_tb}} where unitprice >= 81' });
// Unmatched Postman assertion: jsonData.forEach((record)=>{
// Unmatched Postman assertion: pm.expect(record.unitprice >= 81).to.be.true;});
});

it('select - where attr w/ multiple comparators', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select * from {{schema}}.{{prod_tb}} where unitprice > 20 AND unitprice <= 81',
		})
		// Unmatched Postman assertion: jsonData.forEach((record)=>{
		// Unmatched Postman assertion: pm.expect(record.unitprice > 20).to.be.true;
		.expect((r) => assert.ok(record.unitprice <= 81));
});

it('select - where w/ multiple attr comparators', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select * from {{schema}}.{{prod_tb}} where unitprice > 10 AND unitprice <=81 AND unitsinstock = 0',
		})
		// Unmatched Postman assertion: jsonData.forEach((record)=>{
		.expect((r) => assert.ok(record.unitprice > 10))
		.expect((r) => assert.ok(record.unitprice <= 81));
// Unmatched Postman assertion: pm.expect(record.unitsinstock).to.eql(0)});
});

it('select - where w/ multiple comparators for multiple attrs', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select * from {{schema}}.{{prod_tb}} where unitprice > 10 AND unitprice <=81 AND unitsinstock > 10',
		})
		// Unmatched Postman assertion: jsonData.forEach((record)=>{
		.expect((r) => assert.ok(record.unitprice > 10))
		.expect((r) => assert.ok(record.unitprice <= 81))
		.expect((r) => assert.ok(record.unitsinstock > 10));
});

it('select - where w/ IN() and multiple of comparators for multiple attrs', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select * from {{schema}}.{{prod_tb}} where unitprice > 10 AND unitprice <=81 AND unitsinstock > 10 AND supplierid IN(1,2,3,4)',
		})
		// Unmatched Postman assertion: jsonData.forEach((record)=>{
		.expect((r) => assert.ok(record.unitprice > 10))
		.expect((r) => assert.ok(record.unitprice <= 81))
		.expect((r) => assert.ok(record.unitsinstock > 10));
// Unmatched Postman assertion: pm.expect(record.supplierid).to.be.oneOf([1,2,3,4])});
});

it('update SQL employee', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'update {{schema}}.{{emps_tb}} set address = \'abc1234\' where {{emps_id}} = 1',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.update_hashes[0] == 1));
});

it('select verify SQL update', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select address from {{schema}}.{{emps_tb}} where {{emps_id}} = 1' })
		.expect(200);
// Unmatched Postman assertion: pm.expect(jsonData[0].address).to.eql('abc1234'))
});

it('select * dev.long_text', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * FROM dev.long_text' })
		.expect((r) => assert.ok(r.body.length == 25));
// Unmatched Postman assertion: jsonData.forEach((record)=>{
// Unmatched Postman assertion: pm.expect(record.remarks.length).to.gt(255)});
});

it('select * dev.long_text regexp', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * FROM dev.long_text where remarks regexp \'dock\'' })
		.expect((r) => assert.ok(r.body.length == 3));
// Unmatched Postman assertion: jsonData.forEach((record)=>{
// Unmatched Postman assertion: pm.expect(record.remarks.indexOf('dock')).to.gte(0)});
});

it('update employee with falsey data', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'UPDATE {{schema}}.{{emps_tb}} SET address = false, hireDate = 0, notes = null, birthdate = undefined WHERE {{emps_id}} = 1',
		})
		.expect(200);
// Unmatched Postman assertion: pm.expect(jsonData.update_hashes[0]).to.eql(1))
});

it('select employee to confirm falsey update', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM {{schema}}.{{emps_tb}} WHERE {{emps_id}} = 1' })
		.expect(200);
// Unmatched Postman assertion: pm.expect(jsonData[0].address).to.be.false;
// Unmatched Postman assertion: pm.expect(jsonData[0].hireDate).to.eql(0)
// Unmatched Postman assertion: pm.expect(jsonData).to.not.have.property('notes')
// Unmatched Postman assertion: pm.expect(jsonData).to.not.have.property('birthdate'))
});

it('setup for next test - insert array', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '{{schema}}',
			'table': '{{cust_tb}}',
			'records': [{ 'array': ['arr1', 'arr2', 'arr3'], 'customerid': 'arrayTest' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'));
// Unmatched Postman assertion: pm.expect(jsonData.inserted_hashes[0]).to.eql("arrayTest"))
});

it('select array from table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * from {{schema}}.{{cust_tb}} where {{cust_id}} = \'arrayTest\'' })
		.expect(200);
// Unmatched Postman assertion: pm.expect(jsonData[0].array).to.eql(["arr1","arr2","arr3"])
// Unmatched Postman assertion: pm.expect(jsonData[0].customerid).to.eql("arrayTest"))
});

it('setup for next test - insert object', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '{{schema}}',
			'table': '{{cust_tb}}',
			'records': [{ 'object': { 'red': '1', 'white': '2', 'blue': '3' }, 'customerid': 'objTest' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'));
// Unmatched Postman assertion: pm.expect(jsonData.inserted_hashes[0]).to.eql("objTest"))
});

it('select object from table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * from {{schema}}.{{cust_tb}} where {{cust_id}} = \'objTest\'' })
		.expect(200);
// Unmatched Postman assertion: pm.expect(jsonData[0].object).to.eql({"red": "1", "white": "2", "blue": "3"})
// Unmatched Postman assertion: pm.expect(jsonData[0].customerid).to.eql("objTest"))
});

it('select without sql parameter', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'slq': 'select * from {{schema}}.{{cust_tb}}' })
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'The \'sql\' parameter is missing from the request body'));
});

it('select * dev.remarks_blob like w/ special chars pt1', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * FROM dev.remarks_blob where remarks like \'%4 Bedroom/2.5+ bath%\'' })
		.expect((r) => assert.ok(r.body.length == 3))
		// Unmatched Postman assertion: jsonData.forEach((record)=>{
		// Unmatched Postman assertion: let keys = Object.keys(record)
		// Unmatched Postman assertion: if(keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1){
		.expect((r) => assert.ok(keys.length == 5))
		// Unmatched Postman assertion: } else{
		.expect((r) => assert.ok(keys.length == 3));
// Unmatched Postman assertion: }
// Unmatched Postman assertion: pm.expect(record.remarks.includes('4 Bedroom/2.5+ bath')).to.eql(true)});
});

it('select * dev.remarks_blob like w/ special chars pt2', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select * FROM dev.remarks_blob where remarks like \'This custom built dream home is stunningly gorgeous!  It is a 5+ acres luxury equestrian property with access to Jennings State Forest from your backyard, no need to trailer your horses anywhere for a beautifully scenic peaceful ride.%\'',
		})
		.expect((r) => assert.ok(r.body.length == 2))
		// Unmatched Postman assertion: jsonData.forEach((record)=>{
		// Unmatched Postman assertion: let keys = Object.keys(record)
		// Unmatched Postman assertion: if(keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1){
		.expect((r) => assert.ok(keys.length == 5))
		// Unmatched Postman assertion: } else{
		.expect((r) => assert.ok(keys.length == 3));
// Unmatched Postman assertion: }
// Unmatched Postman assertion: pm.expect(record.remarks.includes('This custom built dream home is stunningly gorgeous!  It is a 5+ acres luxury equestrian property with access to Jennings State Forest from your backyard, no need to trailer your horses anywhere for a beautifully scenic peaceful ride.')).to.eql(true)});
});

it('select * dev.remarks_blob like w/ special chars pt3', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select * FROM dev.remarks_blob where remarks like \'%...GOURGEOUS HOME in a Heart of MANDARIN,Next to Loretto Magnet schoolClose to I-295, shopping & entertainment. Gated community! Loaded with upgrades:%\'',
		})
		.expect((r) => assert.ok(r.body.length == 2))
		// Unmatched Postman assertion: jsonData.forEach((record)=>{
		// Unmatched Postman assertion: let keys = Object.keys(record)
		// Unmatched Postman assertion: if(keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1){
		.expect((r) => assert.ok(keys.length == 5))
		// Unmatched Postman assertion: } else{
		.expect((r) => assert.ok(keys.length == 3));
// Unmatched Postman assertion: }
// Unmatched Postman assertion: pm.expect(record.remarks.includes('...GOURGEOUS HOME in a Heart of MANDARIN,Next to Loretto Magnet schoolClose to I-295, shopping & entertainment. Gated community! Loaded with upgrades:')).to.eql(true)});
});

it('select * dev.remarks_blob like w/ special chars pt4', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select * FROM dev.remarks_blob where remarks like \'**Spacious & updated 2-story home on large preserve lot nearly 1/2 acre! Concrete block constr. & desirable ICW location near JTB, shopping, dining & the beach! Great split BD flrpln w/soaring ceilings features 4BD + office, upstairs loft & 3 full BA.\'',
		})
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		// Unmatched Postman assertion: jsonData.forEach((record)=>{
		// Unmatched Postman assertion: let keys = Object.keys(record)
		// Unmatched Postman assertion: if(keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1){
		.expect((r) => assert.ok(keys.length == 5))
		// Unmatched Postman assertion: } else{
		.expect((r) => assert.ok(keys.length == 3));
// Unmatched Postman assertion: }
// Unmatched Postman assertion: pm.expect(record.remarks.includes('**Spacious & updated 2-story home on large preserve lot nearly 1/2 acre! Concrete block constr. & desirable ICW location near JTB, shopping, dining & the beach! Great split BD flrpln w/soaring ceilings features 4BD + office, upstairs loft & 3 full BA.')).to.eql(true)});
});

it('select * dev.remarks_blob like w/ special chars pt5', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * FROM dev.remarks_blob where remarks like \'%\'' })
		.expect((r) => assert.ok(r.body.length == 11))
		// Unmatched Postman assertion: jsonData.forEach((record)=>{
		// Unmatched Postman assertion: let keys = Object.keys(record)
		// Unmatched Postman assertion: if(keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1){
		.expect((r) => assert.ok(keys.length == 5))
		// Unmatched Postman assertion: } else{
		.expect((r) => assert.ok(keys.length == 3));
// Unmatched Postman assertion: }});
});

it('select * FROM {{schema}}.{{ords_tb}} LIMIT 100 OFFSET 0', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * FROM {{schema}}.{{ords_tb}} LIMIT 100 OFFSET 0' })
		.expect((r) => assert.ok(r.body.length == 100))
		.expect((r) => assert.ok(r.body[0].orderid == 10248));
// Unmatched Postman assertion: pm.expect(jsonData[99].orderid).to.eql(10347))
});

it('select * FROM {{schema}}.{{ords_tb}} LIMIT 100 OFFSET 0 Copy', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'select * FROM {{schema}}.{{ords_tb}} LIMIT 100 OFFSET 100' })
		.expect((r) => assert.ok(r.body.length == 100));
// Unmatched Postman assertion: pm.expect(jsonData[0].orderid).to.eql(10348)
// Unmatched Postman assertion: pm.expect(jsonData[99].orderid).to.eql(10447))
});

it('select AVE(rating) w/ join, group by and order by (1 of 2)', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select b.authors as authors, AVG(r.rating) as rating from dev.ratings as r join dev.books as b on r.book_id = b.id group by b.authors order by rating desc',
		});
// Unmatched Postman assertion: pm.expect(jsonData.length).to.eql(26)
// Unmatched Postman assertion: pm.expect(jsonData[0].rating).to.eql(4.46)
// Unmatched Postman assertion: pm.expect(jsonData[1].rating).to.eql(4.42)
// Unmatched Postman assertion: pm.expect(jsonData[25].rating).to.eql(2.77)
// Unmatched Postman assertion: pm.expect(jsonData[0].authors).to.eql("J.K. Rowling, Mary GrandPré, Rufus Beck")
// Unmatched Postman assertion: pm.expect(jsonData[1].authors).to.eql("Gabriel García Márquez, Gregory Rabassa")
// Unmatched Postman assertion: pm.expect(jsonData[25].authors).to.eql("Henry James, Patricia Crick"))
});

it('select AVE(rating) w/ join, group by and order by (2 of 2)', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select b.id, b.authors as authors, AVG(r.rating) from dev.ratings as r join dev.books as b on r.book_id = b.id group by b.authors, b.id order by b.id',
		})
		.expect((r) => assert.ok(r.body.length == 50))
		.expect((r) => assert.ok(r.body[0].id == 1));
// Unmatched Postman assertion: pm.expect(jsonData[49].id).to.eql(50)
// Unmatched Postman assertion: pm.expect(jsonData[5].id).to.eql(6)
// Unmatched Postman assertion: pm.expect(jsonData[5].authors).to.eql("J.K. Rowling, Mary GrandPré")
// Unmatched Postman assertion: pm.expect(jsonData[5][`AVG(r.rating)`]).to.eql(4.09)
// Unmatched Postman assertion: pm.expect(jsonData[21].id).to.eql(22)
// Unmatched Postman assertion: pm.expect(jsonData[21].authors).to.eql("Edward P. Jones")
// Unmatched Postman assertion: pm.expect(jsonData[21][`AVG(r.rating)`]).to.eql(3.73))
});

it('select AVE(rating) w/ join and group by (1 of 2)', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select b.id, b.authors as authors, AVG(r.rating) from dev.ratings as r join dev.books as b on r.book_id = b.id group by b.authors, b.id',
		})
		.expect((r) => assert.ok(r.body.length == 50))
		.expect((r) => assert.ok(Object.keys(jsonData[0]).length == 3));
// Unmatched Postman assertion: pm.expect(Object.keys(jsonData[49]).length).to.eql(3))
});

it('select AVE(rating) w/ join, gb, ob, and LIMIT', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select b.id as id, b.authors as authors, AVG(r.rating) as rating from dev.ratings as r join dev.books as b on r.book_id = b.id group by b.id, b.authors order by id limit 10',
		})
		.expect((r) => assert.ok(r.body.length == 10))
		.expect((r) => assert.ok(r.body[0].id == 1))
		// Unmatched Postman assertion: pm.expect(jsonData[9].id).to.eql(10)
		.expect((r) => assert.ok(Object.keys(jsonData[0]).length == 3));
// Unmatched Postman assertion: pm.expect(Object.keys(jsonData[8]).length).to.eql(3))
});

it('select COUNT(rating) w/ join, gb, ob, limit, and OFFSET', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select b.authors as authors, COUNT(r.rating) as rating_count from dev.ratings as r join dev.books as b on r.book_id = b.id group by b.authors order by b.authors limit 15 offset 5',
		});
// Unmatched Postman assertion: pm.expect(jsonData.length).to.eql(15)
// Unmatched Postman assertion: pm.expect(jsonData[0].authors).to.eql("Frank Herbert")
// Unmatched Postman assertion: pm.expect(jsonData[14].authors).to.eql("Marguerite Duras, Barbara Bray, Maxine Hong Kingston")
// Unmatched Postman assertion: pm.expect(jsonData[9].authors).to.eql("J.K. Rowling, Mary GrandPré")
// Unmatched Postman assertion: pm.expect(jsonData[0].rating_count).to.eql(400)
// Unmatched Postman assertion: pm.expect(jsonData[11].rating_count).to.eql(300))
});

it('select w/ function alias in ORDER BY and LIMIT', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'select a.{{ords_id}} as ords_id, a.productid, d.companyname as companyname, d.contactmame, b.productname, ROUND(a.unitprice) as unitprice from {{schema}}.{{ordd_tb}} a join {{schema}}.{{prod_tb}} b on a.{{prod_id}}=b.{{prod_id}} join {{schema}}.{{ords_tb}} c on a.{{ords_id}}=c.{{ords_id}} join {{schema}}.{{cust_tb}} d on c.{{cust_id}}=d.{{cust_id}} order by unitprice DESC LIMIT 25',
		})
		.expect((r) => assert.ok(r.body.length == 25));
// Unmatched Postman assertion: pm.expect(jsonData[0].ords_id).to.eql(10518)
// Unmatched Postman assertion: pm.expect(jsonData[0].unitprice).to.eql(264)
// Unmatched Postman assertion: pm.expect(jsonData[24].ords_id).to.eql(10510)
// Unmatched Postman assertion: pm.expect(jsonData[24].unitprice).to.eql(124)
// Unmatched Postman assertion: pm.expect(jsonData[15].unitprice).to.eql(264)
// Unmatched Postman assertion: pm.expect(jsonData[16].unitprice).to.eql(211)
// Unmatched Postman assertion: pm.expect(jsonData[20].unitprice).to.eql(211))
});

it('select w/ inconsistent table refs & ORDER BY column not in SELECT', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT a.productid, a.unitprice as unitprice FROM {{schema}}.{{ordd_tb}} a ORDER BY a.{{ords_id}} DESC',
		})
		.expect((r) => assert.ok(r.body.length == 2155));
// Unmatched Postman assertion: pm.expect(jsonData[0].productid).to.eql(2)
// Unmatched Postman assertion: pm.expect(jsonData[0].unitprice).to.eql(19)
// Unmatched Postman assertion: pm.expect(jsonData[1].productid).to.eql(3)
// Unmatched Postman assertion: pm.expect(jsonData[1].unitprice).to.eql(10)
// Unmatched Postman assertion: pm.expect(jsonData[3].productid).to.eql(6)
// Unmatched Postman assertion: pm.expect(jsonData[3].unitprice).to.eql(25)
// Unmatched Postman assertion: pm.expect(jsonData[15].unitprice).to.eql(9.65)
// Unmatched Postman assertion: pm.expect(jsonData[996].unitprice).to.eql(18)
// Unmatched Postman assertion: pm.expect(jsonData[1255].unitprice).to.eql(9.5))
});

it('select w/ inconsistent table refs, ORDER BY column not in SELECT & LIMIT/OFFSET', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT productid, a.unitprice as unitprice FROM {{schema}}.{{ordd_tb}} a ORDER BY {{ords_id}} DESC LIMIT 250 OFFSET 5',
		});
// Unmatched Postman assertion: pm.expect(jsonData.length).to.eql(250)
// Unmatched Postman assertion: pm.expect(jsonData[0].productid).to.eql(8)
// Unmatched Postman assertion: pm.expect(jsonData[0].unitprice).to.eql(40)
// Unmatched Postman assertion: pm.expect(jsonData[1].productid).to.eql(10)
// Unmatched Postman assertion: pm.expect(jsonData[1].unitprice).to.eql(31)
// Unmatched Postman assertion: pm.expect(jsonData[5].productid).to.eql(16)
// Unmatched Postman assertion: pm.expect(jsonData[5].unitprice).to.eql(17.45)
// Unmatched Postman assertion: pm.expect(jsonData[10].unitprice).to.eql(9.65)
// Unmatched Postman assertion: pm.expect(jsonData[216].unitprice).to.eql(7.75)
// Unmatched Postman assertion: pm.expect(jsonData[249].unitprice).to.eql(17.45))
});

it('select w/ inconsistent table refs & second ORDER BY column not included in SELECT', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT a.{{ords_id}} as ords_id, a.unitprice as unitprice FROM {{schema}}.{{ordd_tb}} a ORDER BY productid DESC, a.{{ords_id}} DESC',
		})
		.expect((r) => assert.ok(r.body.length == 2155));
// Unmatched Postman assertion: pm.expect(jsonData[0].ords_id).to.eql(11077)
// Unmatched Postman assertion: pm.expect(jsonData[0].unitprice).to.eql(13)
// Unmatched Postman assertion: pm.expect(jsonData[1].ords_id).to.eql(11068)
// Unmatched Postman assertion: pm.expect(jsonData[1].unitprice).to.eql(13)
// Unmatched Postman assertion: pm.expect(jsonData[3].ords_id).to.eql(11015)
// Unmatched Postman assertion: pm.expect(jsonData[3].unitprice).to.eql(13)
// Unmatched Postman assertion: pm.expect(jsonData[15].unitprice).to.eql(13)
// Unmatched Postman assertion: pm.expect(jsonData[996].unitprice).to.eql(46)
// Unmatched Postman assertion: pm.expect(jsonData[1255].unitprice).to.eql(14.4))
});

it('select w/ inconsistent table refs, second ORDER BY column not included in SELECT & LIMIT/OFFSETS', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT a.{{ords_id}} as ords_id, a.unitprice as unitprice FROM {{schema}}.{{ordd_tb}} a ORDER BY productid DESC, a.{{ords_id}} DESC LIMIT 205 OFFSET 50',
		});
// Unmatched Postman assertion: pm.expect(jsonData.length).to.eql(205)
// Unmatched Postman assertion: pm.expect(jsonData[0].ords_id).to.eql(10808)
// Unmatched Postman assertion: pm.expect(jsonData[0].unitprice).to.eql(18)
// Unmatched Postman assertion: pm.expect(jsonData[1].ords_id).to.eql(10749)
// Unmatched Postman assertion: pm.expect(jsonData[1].unitprice).to.eql(18)
// Unmatched Postman assertion: pm.expect(jsonData[3].ords_id).to.eql(10732)
// Unmatched Postman assertion: pm.expect(jsonData[3].unitprice).to.eql(18)
// Unmatched Postman assertion: pm.expect(jsonData[16].unitprice).to.eql(14.4)
// Unmatched Postman assertion: pm.expect(jsonData[66].unitprice).to.eql(6.2)
// Unmatched Postman assertion: pm.expect(jsonData[204].unitprice).to.eql(15))
});

it('Select * on 3 table INNER JOIN', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT `d`.*, `b`.*, `o`.* FROM `dev`.`dog` AS `d` INNER JOIN `dev`.`breed` AS `b` ON `d`.`breed_id` = `b`.`id` INNER JOIN `dev`.`owner` AS `o` ON `d`.`owner_id` = `o`.`id` ORDER BY `dog_name`',
		})
		.expect((r) => assert.ok(r.body.length == 7))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok(row.id))
		.expect((r) => assert.ok(row.id1))
		.expect((r) => assert.ok(row.id2))
		.expect((r) => assert.ok(row.name))
		.expect((r) => assert.ok(row.name1));
// Unmatched Postman assertion: })

// Unmatched Postman assertion: pm.expect(jsonData[1].name1).to.eql("Sam")
// Unmatched Postman assertion: pm.expect(jsonData[1].id2).to.eql(1)
// Unmatched Postman assertion: pm.expect(jsonData[4].id1).to.eql(154))
});

it('Select with basic CROSS SCHEMA JOIN', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id',
		})
		.expect((r) => assert.ok(r.body.length == 8))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok(row.id))
		.expect((r) => assert.ok(row.id1))
		.expect((r) => assert.ok(row.dog_name))
		.expect((r) => assert.ok(row.age))
		.expect((r) => assert.ok(row.name))
		// Unmatched Postman assertion: })

		.expect((r) => assert.ok(r.body[1].name == 'David'))
		.expect((r) => assert.ok(r.body[1].id1 == 3));
// Unmatched Postman assertion: pm.expect(jsonData[4].id1).to.eql(2))
});

it('Select with complex CROSS SCHEMA JOIN', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT d.id, d.dog_name, d.age, d.adorable, o.* FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id ORDER BY o.name, o.id LIMIT 5 OFFSET 1',
		})
		.expect((r) => assert.ok(r.body.length == 5))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok(row.id))
		.expect((r) => assert.ok(row.id1))
		.expect((r) => assert.ok(row.dog_name))
		.expect((r) => assert.ok(row.age))
		.expect((r) => assert.ok(row.name));
// Unmatched Postman assertion: })

// Unmatched Postman assertion: pm.expect(jsonData[0].name).to.eql("David")
// Unmatched Postman assertion: pm.expect(jsonData[0].id).to.eql(6)
// Unmatched Postman assertion: pm.expect(jsonData[0].id1).to.eql(3)
// Unmatched Postman assertion: pm.expect(jsonData[4].name).to.eql("Kyle")
// Unmatched Postman assertion: pm.expect(jsonData[4].id).to.eql(5)
// Unmatched Postman assertion: pm.expect(jsonData[4].id1).to.eql(2))
});

it('Select with basic CROSS 3 SCHEMA JOINS', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name, b.id, b.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id',
		})
		.expect((r) => assert.ok(r.body.length == 7))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok(row.id))
		.expect((r) => assert.ok(row.id1))
		.expect((r) => assert.ok(row.id2))
		.expect((r) => assert.ok(row.dog_name))
		.expect((r) => assert.ok(row.age))
		.expect((r) => assert.ok(row.name))
		.expect((r) => assert.ok(row.name1))
		// Unmatched Postman assertion: })

		.expect((r) => assert.ok(r.body[1].name == 'David'))
		.expect((r) => assert.ok(r.body[1].id1 == 3))
		.expect((r) => assert.ok(r.body[4].id1 == 2));
// Unmatched Postman assertion: pm.expect(jsonData[6].id1).to.eql(1)
// Unmatched Postman assertion: pm.expect(jsonData[6].name1).to.eql("MASTIFF"))
});

it('Select with complex CROSS 3 SCHEMA JOINS', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT d.age AS dog_age, AVG(d.weight_lbs) AS dog_weight, o.name AS owner_name, b.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id GROUP BY o.name, b.name, d.age ORDER BY b.name',
		})
		.expect((r) => assert.ok(r.body.length == 7))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok(row.dog_age))
		.expect((r) => assert.ok(row.dog_weight))
		.expect((r) => assert.ok(row.owner_name))
		.expect((r) => assert.ok(row.name))
		// Unmatched Postman assertion: })

		// Unmatched Postman assertion: pm.expect(jsonData[0].dog_age).to.eql(1)
		.expect((r) => assert.ok(r.body[0].dog_weight == 35))
		.expect((r) => assert.ok(r.body[0].owner_name == 'Kaylan'))
		.expect((r) => assert.ok(r.body[0].name == 'BEAGLE MIX'))
		// Unmatched Postman assertion: pm.expect(jsonData[6].dog_age).to.eql(5)
		// Unmatched Postman assertion: pm.expect(jsonData[6].dog_weight).to.eql(35)
		.expect((r) => assert.ok(r.body[6].owner_name == 'Kyle'));
// Unmatched Postman assertion: pm.expect(jsonData[6].name).to.eql("WHIPPET"))
});

it('Select - simple full table query', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.dog' })
		.expect((r) => assert.ok(r.body.length == 9));
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect(Object.keys(row).length).to.equal(9))
});

it('Select - simple full table query w/ * and alias', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT *, dog_name as dname FROM dev.dog' })
		.expect((r) => assert.ok(r.body.length == 9))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok(Object.keys(row).length == 9))
		.expect((r) => assert.ok(row.dname))
		.expect((r) => assert.ok(!row.dog_name));
});
})
;

it('Select - simple full table query w/ single alias', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT dog_name as dname FROM dev.dog' })
		.expect((r) => assert.ok(r.body.length == 9))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		// Unmatched Postman assertion: pm.expect(Object.keys(row).length).to.equal(1)
		.expect((r) => assert.ok(row.dname))
		.expect((r) => assert.ok(!row.dog_name));
});
})
;

it('Select - simple full table query w/ multiple aliases', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT id as dog_id, dog_name as dname, age as dog_age FROM dev.dog' })
		.expect((r) => assert.ok(r.body.length == 9))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		// Unmatched Postman assertion: pm.expect(Object.keys(row).length).to.equal(3)
		.expect((r) => assert.ok(row.dname))
		.expect((r) => assert.ok(!row.dog_name))
		// Unmatched Postman assertion: pm.expect(row.dog_id).to.exist;
		// Unmatched Postman assertion: pm.expect(row.id).to.not.exist;
		.expect((r) => assert.ok(row.dog_age));
// Unmatched Postman assertion: pm.expect(row.age).to.not.exist;})
});

it('Select - simple full table query from leading_zero', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.leading_zero' })
		.expect((r) => assert.ok(r.body.length == 3));
// Unmatched Postman assertion: let ids = [];
// Unmatched Postman assertion: let expected_ids = [0, "00011", "011"];
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: ids.push(row.id)
//Unmatched Postman assertion: pm.expect(ids).to.eql(expected_ids))
});

it('Select - basic self JOIN', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT a.* FROM dev.owner as a INNER JOIN dev.owner as b ON a.name = b.best_friend',
		})
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'));

// Unmatched Postman assertion: pm.expect(jsonData[0].id).to.eql(1))
});

it('Select - basic self JOIN - reverse scenario', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'sql',
			'sql': 'SELECT b.* FROM dev.owner as a INNER JOIN dev.owner as b ON a.name = b.best_friend',
		})
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'));

// Unmatched Postman assertion: pm.expect(jsonData[0].id).to.eql(3))
});

it('query from leading_zero where id = 0', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.leading_zero where id = 0' })
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		// Unmatched Postman assertion: let record = jsonData[0];
		.expect((r) => assert.ok(record.id == 0))
		.expect((r) => assert.ok(record.another_attribute == 'another_1'))
		.expect((r) => assert.ok(record.some_attribute == 'some_att1'));
});

it('query from leading_zero where id = '
011;
'', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.leading_zero where id = \'011\'' })
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		// Unmatched Postman assertion: let record = jsonData[0];
		// Unmatched Postman assertion: pm.expect(record.id).to.eql('011')
		.expect((r) => assert.ok(record.another_attribute == 'another_2'));
// Unmatched Postman assertion: pm.expect(record.some_attribute).to.eql("some_att2"))
};
)
;

it('query from leading_zero where id = 011', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.leading_zero where id = 011' })
		.expect((r) => assert.ok(r.body.length == 0));
});

it('insert record with dog_name =  single space value & empty string', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'INSERT INTO dev.dog (id, dog_name) VALUES (1111, \' \'), (2222, \'\')' })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'inserted 2 of 2 records'))
		.expect((r) => assert.ok(r.body.inserted_hashes == [1111, 2222]));
});

it('SELECT record with dog_name = single space and validate value', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT id, dog_name FROM dev.dog  WHERE dog_name = \' \'' })
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [{ id: 1111, dog_name: ' ' }]));
});

it('SELECT record with dog_name = empty string and validate value', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT id, dog_name FROM dev.dog  WHERE dog_name = \'\'' })
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [{ id: 2222, dog_name: '' }]));
});

it('Delete dev.dog records previously created', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'DELETE FROM dev.dog WHERE id IN (1111, 2222)' })
		.expect(200)
		.expect((r) => assert.ok(r.body.deleted_hashes == [1111, 2222]));
});

it('insert invalid attribute name - single row', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': 'dev',
			'table': 'invalid_attribute',
			'records': [{ 'id': 1, 'some`$`attribute': 'some_attribute' }],
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'Attribute names cannot include backticks or forward slashes'));
});

it('update single row w/ invalid attribute name', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': 'dev',
			'table': 'invalid_attribute',
			'records': [{ 'id': 100, 'some/attribute': 'some_attribute' }],
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'Attribute names cannot include backticks or forward slashes'));
});

it('insert all invalid attribute names - multiple rows', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': 'dev',
			'table': 'invalid_attribute',
			'records': [{
				'id': 1,
				'some/attribute1': 'some_attribute1',
				'some/attribute2': 'some_attribute2',
				'some/attribute3': 'some_attribute3',
				'some_attribute4': 'some_attribute4',
			}, {
				'id': 2,
				'some/attribute1': 'some_attribute1',
				'some/attribute2': 'some_attribute2',
				'some/attribute3': 'some_attribute3',
				'some_attribute4': 'some_attribute4',
			}, {
				'id': 3,
				'some/attribute1': 'some_attribute1',
				'some/attribute2': 'some_attribute2',
				'some/attribute3': 'some_attribute3',
				'some_attribute4': 'some_attribute4',
			}, {
				'id': 4,
				'some/attribute1': 'some_attribute1',
				'some/attribute2': 'some_attribute2',
				'some/attribute3': 'some_attribute3',
				'some_attribute4': 'some_attribute4',
			}, {
				'id': 5,
				'some/attribute1': 'some_attribute1',
				'some/attribute2': 'some_attribute2',
				'some/attribute3': 'some_attribute3',
				'some_attribute4': 'some_attribute4',
			}, {
				'id': 6,
				'some/attribute1': 'some_attribute1',
				'some/attribute2': 'some_attribute2',
				'some/attribute3': 'some_attribute3',
				'some_attribute4': 'some_attribute4',
			}],
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'Attribute names cannot include backticks or forward slashes'));
});

it('update multiple rows with invalid attribute', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': 'dev',
			'table': 'invalid_attribute',
			'records': [{ 'id': 100, 'some/attribute': 'some_attribute' }, {
				'id': 101,
				'some-`attribute`': 'some_attribute',
			}],
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'Attribute names cannot include backticks or forward slashes'));
});

it('upsert multiple rows with invalid attribute key', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'upsert',
			'schema': 'dev',
			'table': 'invalid_attribute',
			'records': [{ 'id': 100, 'some/attribute': 'some_attribute' }, {
				'id': 101,
				'some-`attribute`': 'some_attribute',
			}],
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'Attribute names cannot include backticks or forward slashes'));
});

it('insert some invalid attribute names - multiple rows', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': 'dev',
			'table': 'invalid_attribute',
			'records': [{
				'id': 1,
				'some_attribute1': 'some_attribute1',
				'some_attribute2': 'some_attribute2',
				'$ome-attribute3': 'some_attribute3',
				'some_attribute4': 'some_attribute4',
			}, {
				'id': 2,
				'some_attribute1': 'some_attribute1',
				'some_attribute2': 'some_attribute2',
				'$ome-attribute3': 'some_attribute3',
				'some_attribute4': 'some_attribute4',
			}, {
				'id': 3,
				'some_attribute1': 'some_attribute1',
				'some_attribute2': 'some_attribute2',
				'some-attribute3': 'some_attribute3',
				'some_attribute4/': 'some_attribute4',
			}, {
				'id': 4,
				'some_attribute1': 'some_attribute1',
				'some_attribute2': 'some_attribute2',
				'some-attribute3/': 'some_attribute3',
				'some_attribute4': 'some_attribute4',
			}, {
				'id': 5,
				'some_attribute1': 'some_attribute1',
				'some_attribute2': 'some_attribute2',
				'some-attribute3': 'some_attribute3',
				'some_`attribute4`': 'some_attribute4',
			}, {
				'id': 6,
				'some_attribute1': 'some_attribute1',
				'some_attribute2': 'some_attribute2',
				'some-attribute3`': 'some_attribute3',
				'some_attribute4': 'some_attribute4',
			}],
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'Attribute names cannot include backticks or forward slashes'));
});

it('NoSQL search by hash no result', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'hash_attribute': '{{emps_id}}',
			'hash_values': [100],
			'get_attributes': ['firstname', 'lastname'],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 0));
});

it('NoSQL search by hash one result', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'hash_attribute': '{{emps_id}}',
			'hash_values': [1],
			'get_attributes': ['firstname', 'lastname'],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(typeof r.body[0] === 'object'));
});

it('NoSQL search by hash multiple results', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'hash_attribute': '{{emps_id}}',
			'hash_values': [1, 5],
			'get_attributes': ['firstname', 'lastname'],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2))
		.expect((r) => assert.ok(typeof r.body[0] === 'object'));
// Unmatched Postman assertion: pm.expect((typeof jsonData[1])).to.eql("object"))
});

it('NoSQL search by value no result', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'hash_attribute': '{{emps_id}}',
			'search_attribute': 'lastname',
			'search_value': 'Xyz',
			'get_attributes': ['firstname', 'lastname'],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 0));
});

it('NoSQL search by value one result', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'hash_attribute': '{{emps_id}}',
			'search_attribute': 'lastname',
			'search_value': 'King',
			'get_attributes': ['firstname', 'lastname'],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(typeof r.body[0] === 'object'));
});

it('NoSQL search by value multiple results', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'hash_attribute': '{{emps_id}}',
			'search_attribute': 'lastname',
			'search_value': 'D*',
			'get_attributes': ['firstname', 'lastname'],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2))
		.expect((r) => assert.ok(typeof r.body[0] === 'object'));
// Unmatched Postman assertion: pm.expect((typeof jsonData[1])).to.eql("object"))
});

it('NoSQL search by value limit 20', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': '{{schema}}',
			'table': '{{ords_tb}}',
			'search_attribute': '{{ordd_id}}',
			'search_value': '*',
			'get_attributes': ['*'],
			'limit': 20,
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 20))

		// Unmatched Postman assertion: let ids = [10248,10249,10250,10251,10252,10253,10254,10255,10256,10257,10258,10259,10260,10261,10262,10263,10264,10265,10266,10267];

		// Unmatched Postman assertion: for(let x = 0, length = ids.length; x < length; x++){
		.expect((r) => assert.ok(r.body[x].orderid == ids[x]));
// Unmatched Postman assertion: }})
});

it('NoSQL search by value offset 20', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': '{{schema}}',
			'table': '{{ords_tb}}',
			'search_attribute': '{{ordd_id}}',
			'search_value': '*',
			'get_attributes': ['*'],
			'offset': 20,
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 810))

		// Unmatched Postman assertion: let ids = [10268,10269,10270,10271,10272,10273,10274,10275,10276,10277,10278,10279,10280,10281,10282,10283,10284,10285,10286,10287,10288,10289,10290,10291,10292,10293,10294,10295,10296,10297,10298,10299,10300,10301,10302,10303,10304,10305,10306,10307,10308,10309,10310,10311,10312,10313,10314,10315,10316,10317,10318,10319,10320,10321,10322,10323,10324,10325,10326,10327,10328,10329,10330,10331,10332,10333,10334,10335,10336,10337,10338,10339,10340,10341,10342,10343,10344,10345,10346,10347,10348,10349,10350,10351,10352,10353,10354,10355,10356,10357,10358,10359,10360,10361,10362,10363,10364,10365,10366,10367,10368,10369,10370,10371,10372,10373,10374,10375,10376,10377,10378,10379,10380,10381,10382,10383,10384,10385,10386,10387,10388,10389,10390,10391,10392,10393,10394,10395,10396,10397,10398,10399,10400,10401,10402,10403,10404,10405,10406,10407,10408,10409,10410,10411,10412,10413,10414,10415,10416,10417,10418,10419,10420,10421,10422,10423,10424,10425,10426,10427,10428,10429,10430,10431,10432,10433,10434,10435,10436,10437,10438,10439,10440,10441,10442,10443,10444,10445,10446,10447,10448,10449,10450,10451,10452,10453,10454,10455,10456,10457,10458,10459,10460,10461,10462,10463,10464,10465,10466,10467,10468,10469,10470,10471,10472,10473,10474,10475,10476,10477,10478,10479,10480,10481,10482,10483,10484,10485,10486,10487,10488,10489,10490,10491,10492,10493,10494,10495,10496,10497,10498,10499,10500,10501,10502,10503,10504,10505,10506,10507,10508,10509,10510,10511,10512,10513,10514,10515,10516,10517,10518,10519,10520,10521,10522,10523,10524,10525,10526,10527,10528,10529,10530,10531,10532,10533,10534,10535,10536,10537,10538,10539,10540,10541,10542,10543,10544,10545,10546,10547,10548,10549,10550,10551,10552,10553,10554,10555,10556,10557,10558,10559,10560,10561,10562,10563,10564,10565,10566,10567,10568,10569,10570,10571,10572,10573,10574,10575,10576,10577,10578,10579,10580,10581,10582,10583,10584,10585,10586,10587,10588,10589,10590,10591,10592,10593,10594,10595,10596,10597,10598,10599,10600,10601,10602,10603,10604,10605,10606,10607,10608,10609,10610,10611,10612,10613,10614,10615,10616,10617,10618,10619,10620,10621,10622,10623,10624,10625,10626,10627,10628,10629,10630,10631,10632,10633,10634,10635,10636,10637,10638,10639,10640,10641,10642,10643,10644,10645,10646,10647,10648,10649,10650,10651,10652,10653,10654,10655,10656,10657,10658,10659,10660,10661,10662,10663,10664,10665,10666,10667,10668,10669,10670,10671,10672,10673,10674,10675,10676,10677,10678,10679,10680,10681,10682,10683,10684,10685,10686,10687,10688,10689,10690,10691,10692,10693,10694,10695,10696,10697,10698,10699,10700,10701,10702,10703,10704,10705,10706,10707,10708,10709,10710,10711,10712,10713,10714,10715,10716,10717,10718,10719,10720,10721,10722,10723,10724,10725,10726,10727,10728,10729,10730,10731,10732,10733,10734,10735,10736,10737,10738,10739,10740,10741,10742,10743,10744,10745,10746,10747,10748,10749,10750,10751,10752,10753,10754,10755,10756,10757,10758,10759,10760,10761,10762,10763,10764,10765,10766,10767,10768,10769,10770,10771,10772,10773,10774,10775,10776,10777,10778,10779,10780,10781,10782,10783,10784,10785,10786,10787,10788,10789,10790,10791,10792,10793,10794,10795,10796,10797,10798,10799,10800,10801,10802,10803,10804,10805,10806,10807,10808,10809,10810,10811,10812,10813,10814,10815,10816,10817,10818,10819,10820,10821,10822,10823,10824,10825,10826,10827,10828,10829,10830,10831,10832,10833,10834,10835,10836,10837,10838,10839,10840,10841,10842,10843,10844,10845,10846,10847,10848,10849,10850,10851,10852,10853,10854,10855,10856,10857,10858,10859,10860,10861,10862,10863,10864,10865,10866,10867,10868,10869,10870,10871,10872,10873,10874,10875,10876,10877,10878,10879,10880,10881,10882,10883,10884,10885,10886,10887,10888,10889,10890,10891,10892,10893,10894,10895,10896,10897,10898,10899,10900,10901,10902,10903,10904,10905,10906,10907,10908,10909,10910,10911,10912,10913,10914,10915,10916,10917,10918,10919,10920,10921,10922,10923,10924,10925,10926,10927,10928,10929,10930,10931,10932,10933,10934,10935,10936,10937,10938,10939,10940,10941,10942,10943,10944,10945,10946,10947,10948,10949,10950,10951,10952,10953,10954,10955,10956,10957,10958,10959,10960,10961,10962,10963,10964,10965,10966,10967,10968,10969,10970,10971,10972,10973,10974,10975,10976,10977,10978,10979,10980,10981,10982,10983,10984,10985,10986,10987,10988,10989,10990,10991,10992,10993,10994,10995,10996,10997,10998,10999,11000,11001,11002,11003,11004,11005,11006,11007,11008,11009,11010,11011,11012,11013,11014,11015,11016,11017,11018,11019,11020,11021,11022,11023,11024,11025,11026,11027,11028,11029,11030,11031,11032,11033,11034,11035,11036,11037,11038,11039,11040,11041,11042,11043,11044,11045,11046,11047,11048,11049,11050,11051,11052,11053,11054,11055,11056,11057,11058,11059,11060,11061,11062,11063,11064,11065,11066,11067,11068,11069,11070,11071,11072,11073,11074,11075,11076,11077];

		// Unmatched Postman assertion: for(let x = 0, length = ids.length; x < length; x++){
		.expect((r) => assert.ok(r.body[x].orderid == ids[x]));
// Unmatched Postman assertion: }})
});

it('NoSQL search by value limit 20 offset 20', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': '{{schema}}',
			'table': '{{ords_tb}}',
			'search_attribute': '{{ordd_id}}',
			'search_value': '*',
			'get_attributes': ['*'],
			'limit': 20,
			'offset': 20,
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 20))

		// Unmatched Postman assertion: let ids = [10268,10269,10270,10271,10272,10273,10274,10275,10276,10277,10278,10279,10280,10281,10282,10283,10284,10285,10286,10287];

		// Unmatched Postman assertion: for(let x = 0, length = ids.length; x < length; x++){
		.expect((r) => assert.ok(r.body[x].orderid == ids[x]));
// Unmatched Postman assertion: }})
});

it('NoSQL search by value reverse', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': '{{schema}}',
			'table': '{{ords_tb}}',
			'search_attribute': '{{ordd_id}}',
			'search_value': '*',
			'get_attributes': ['*'],
			'reverse': true,
		})
		.expect(200)
		// Unmatched Postman assertion: pm.expect(jsonData.length).to.eql(830)

		// Unmatched Postman assertion: let ids = [11077,11076,11075,11074,11073,11072,11071,11070,11069,11068,11067,11066,11065,11064,11063,11062,11061,11060,11059,11058,11057,11056,11055,11054,11053,11052,11051,11050,11049,11048,11047,11046,11045,11044,11043,11042,11041,11040,11039,11038,11037,11036,11035,11034,11033,11032,11031,11030,11029,11028,11027,11026,11025,11024,11023,11022,11021,11020,11019,11018,11017,11016,11015,11014,11013,11012,11011,11010,11009,11008,11007,11006,11005,11004,11003,11002,11001,11000,10999,10998,10997,10996,10995,10994,10993,10992,10991,10990,10989,10988,10987,10986,10985,10984,10983,10982,10981,10980,10979,10978,10977,10976,10975,10974,10973,10972,10971,10970,10969,10968,10967,10966,10965,10964,10963,10962,10961,10960,10959,10958,10957,10956,10955,10954,10953,10952,10951,10950,10949,10948,10947,10946,10945,10944,10943,10942,10941,10940,10939,10938,10937,10936,10935,10934,10933,10932,10931,10930,10929,10928,10927,10926,10925,10924,10923,10922,10921,10920,10919,10918,10917,10916,10915,10914,10913,10912,10911,10910,10909,10908,10907,10906,10905,10904,10903,10902,10901,10900,10899,10898,10897,10896,10895,10894,10893,10892,10891,10890,10889,10888,10887,10886,10885,10884,10883,10882,10881,10880,10879,10878,10877,10876,10875,10874,10873,10872,10871,10870,10869,10868,10867,10866,10865,10864,10863,10862,10861,10860,10859,10858,10857,10856,10855,10854,10853,10852,10851,10850,10849,10848,10847,10846,10845,10844,10843,10842,10841,10840,10839,10838,10837,10836,10835,10834,10833,10832,10831,10830,10829,10828,10827,10826,10825,10824,10823,10822,10821,10820,10819,10818,10817,10816,10815,10814,10813,10812,10811,10810,10809,10808,10807,10806,10805,10804,10803,10802,10801,10800,10799,10798,10797,10796,10795,10794,10793,10792,10791,10790,10789,10788,10787,10786,10785,10784,10783,10782,10781,10780,10779,10778,10777,10776,10775,10774,10773,10772,10771,10770,10769,10768,10767,10766,10765,10764,10763,10762,10761,10760,10759,10758,10757,10756,10755,10754,10753,10752,10751,10750,10749,10748,10747,10746,10745,10744,10743,10742,10741,10740,10739,10738,10737,10736,10735,10734,10733,10732,10731,10730,10729,10728,10727,10726,10725,10724,10723,10722,10721,10720,10719,10718,10717,10716,10715,10714,10713,10712,10711,10710,10709,10708,10707,10706,10705,10704,10703,10702,10701,10700,10699,10698,10697,10696,10695,10694,10693,10692,10691,10690,10689,10688,10687,10686,10685,10684,10683,10682,10681,10680,10679,10678,10677,10676,10675,10674,10673,10672,10671,10670,10669,10668,10667,10666,10665,10664,10663,10662,10661,10660,10659,10658,10657,10656,10655,10654,10653,10652,10651,10650,10649,10648,10647,10646,10645,10644,10643,10642,10641,10640,10639,10638,10637,10636,10635,10634,10633,10632,10631,10630,10629,10628,10627,10626,10625,10624,10623,10622,10621,10620,10619,10618,10617,10616,10615,10614,10613,10612,10611,10610,10609,10608,10607,10606,10605,10604,10603,10602,10601,10600,10599,10598,10597,10596,10595,10594,10593,10592,10591,10590,10589,10588,10587,10586,10585,10584,10583,10582,10581,10580,10579,10578,10577,10576,10575,10574,10573,10572,10571,10570,10569,10568,10567,10566,10565,10564,10563,10562,10561,10560,10559,10558,10557,10556,10555,10554,10553,10552,10551,10550,10549,10548,10547,10546,10545,10544,10543,10542,10541,10540,10539,10538,10537,10536,10535,10534,10533,10532,10531,10530,10529,10528,10527,10526,10525,10524,10523,10522,10521,10520,10519,10518,10517,10516,10515,10514,10513,10512,10511,10510,10509,10508,10507,10506,10505,10504,10503,10502,10501,10500,10499,10498,10497,10496,10495,10494,10493,10492,10491,10490,10489,10488,10487,10486,10485,10484,10483,10482,10481,10480,10479,10478,10477,10476,10475,10474,10473,10472,10471,10470,10469,10468,10467,10466,10465,10464,10463,10462,10461,10460,10459,10458,10457,10456,10455,10454,10453,10452,10451,10450,10449,10448,10447,10446,10445,10444,10443,10442,10441,10440,10439,10438,10437,10436,10435,10434,10433,10432,10431,10430,10429,10428,10427,10426,10425,10424,10423,10422,10421,10420,10419,10418,10417,10416,10415,10414,10413,10412,10411,10410,10409,10408,10407,10406,10405,10404,10403,10402,10401,10400,10399,10398,10397,10396,10395,10394,10393,10392,10391,10390,10389,10388,10387,10386,10385,10384,10383,10382,10381,10380,10379,10378,10377,10376,10375,10374,10373,10372,10371,10370,10369,10368,10367,10366,10365,10364,10363,10362,10361,10360,10359,10358,10357,10356,10355,10354,10353,10352,10351,10350,10349,10348,10347,10346,10345,10344,10343,10342,10341,10340,10339,10338,10337,10336,10335,10334,10333,10332,10331,10330,10329,10328,10327,10326,10325,10324,10323,10322,10321,10320,10319,10318,10317,10316,10315,10314,10313,10312,10311,10310,10309,10308,10307,10306,10305,10304,10303,10302,10301,10300,10299,10298,10297,10296,10295,10294,10293,10292,10291,10290,10289,10288,10287,10286,10285,10284,10283,10282,10281,10280,10279,10278,10277,10276,10275,10274,10273,10272,10271,10270,10269,10268,10267,10266,10265,10264,10263,10262,10261,10260,10259,10258,10257,10256,10255,10254,10253,10252,10251,10250,10249,10248];

		// Unmatched Postman assertion: for(let x = 0, length = ids.length; x < length; x++){
		.expect((r) => assert.ok(r.body[x].orderid == ids[x]));
// Unmatched Postman assertion: }})
});

it('NoSQL search by value reverse offset 20', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': '{{schema}}',
			'table': '{{ords_tb}}',
			'search_attribute': '{{ordd_id}}',
			'search_value': '*',
			'get_attributes': ['*'],
			'reverse': true,
			'offset': 20,
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 810))

		// Unmatched Postman assertion: let ids = [11057,11056,11055,11054,11053,11052,11051,11050,11049,11048,11047,11046,11045,11044,11043,11042,11041,11040,11039,11038,11037,11036,11035,11034,11033,11032,11031,11030,11029,11028,11027,11026,11025,11024,11023,11022,11021,11020,11019,11018,11017,11016,11015,11014,11013,11012,11011,11010,11009,11008,11007,11006,11005,11004,11003,11002,11001,11000,10999,10998,10997,10996,10995,10994,10993,10992,10991,10990,10989,10988,10987,10986,10985,10984,10983,10982,10981,10980,10979,10978,10977,10976,10975,10974,10973,10972,10971,10970,10969,10968,10967,10966,10965,10964,10963,10962,10961,10960,10959,10958,10957,10956,10955,10954,10953,10952,10951,10950,10949,10948,10947,10946,10945,10944,10943,10942,10941,10940,10939,10938,10937,10936,10935,10934,10933,10932,10931,10930,10929,10928,10927,10926,10925,10924,10923,10922,10921,10920,10919,10918,10917,10916,10915,10914,10913,10912,10911,10910,10909,10908,10907,10906,10905,10904,10903,10902,10901,10900,10899,10898,10897,10896,10895,10894,10893,10892,10891,10890,10889,10888,10887,10886,10885,10884,10883,10882,10881,10880,10879,10878,10877,10876,10875,10874,10873,10872,10871,10870,10869,10868,10867,10866,10865,10864,10863,10862,10861,10860,10859,10858,10857,10856,10855,10854,10853,10852,10851,10850,10849,10848,10847,10846,10845,10844,10843,10842,10841,10840,10839,10838,10837,10836,10835,10834,10833,10832,10831,10830,10829,10828,10827,10826,10825,10824,10823,10822,10821,10820,10819,10818,10817,10816,10815,10814,10813,10812,10811,10810,10809,10808,10807,10806,10805,10804,10803,10802,10801,10800,10799,10798,10797,10796,10795,10794,10793,10792,10791,10790,10789,10788,10787,10786,10785,10784,10783,10782,10781,10780,10779,10778,10777,10776,10775,10774,10773,10772,10771,10770,10769,10768,10767,10766,10765,10764,10763,10762,10761,10760,10759,10758,10757,10756,10755,10754,10753,10752,10751,10750,10749,10748,10747,10746,10745,10744,10743,10742,10741,10740,10739,10738,10737,10736,10735,10734,10733,10732,10731,10730,10729,10728,10727,10726,10725,10724,10723,10722,10721,10720,10719,10718,10717,10716,10715,10714,10713,10712,10711,10710,10709,10708,10707,10706,10705,10704,10703,10702,10701,10700,10699,10698,10697,10696,10695,10694,10693,10692,10691,10690,10689,10688,10687,10686,10685,10684,10683,10682,10681,10680,10679,10678,10677,10676,10675,10674,10673,10672,10671,10670,10669,10668,10667,10666,10665,10664,10663,10662,10661,10660,10659,10658,10657,10656,10655,10654,10653,10652,10651,10650,10649,10648,10647,10646,10645,10644,10643,10642,10641,10640,10639,10638,10637,10636,10635,10634,10633,10632,10631,10630,10629,10628,10627,10626,10625,10624,10623,10622,10621,10620,10619,10618,10617,10616,10615,10614,10613,10612,10611,10610,10609,10608,10607,10606,10605,10604,10603,10602,10601,10600,10599,10598,10597,10596,10595,10594,10593,10592,10591,10590,10589,10588,10587,10586,10585,10584,10583,10582,10581,10580,10579,10578,10577,10576,10575,10574,10573,10572,10571,10570,10569,10568,10567,10566,10565,10564,10563,10562,10561,10560,10559,10558,10557,10556,10555,10554,10553,10552,10551,10550,10549,10548,10547,10546,10545,10544,10543,10542,10541,10540,10539,10538,10537,10536,10535,10534,10533,10532,10531,10530,10529,10528,10527,10526,10525,10524,10523,10522,10521,10520,10519,10518,10517,10516,10515,10514,10513,10512,10511,10510,10509,10508,10507,10506,10505,10504,10503,10502,10501,10500,10499,10498,10497,10496,10495,10494,10493,10492,10491,10490,10489,10488,10487,10486,10485,10484,10483,10482,10481,10480,10479,10478,10477,10476,10475,10474,10473,10472,10471,10470,10469,10468,10467,10466,10465,10464,10463,10462,10461,10460,10459,10458,10457,10456,10455,10454,10453,10452,10451,10450,10449,10448,10447,10446,10445,10444,10443,10442,10441,10440,10439,10438,10437,10436,10435,10434,10433,10432,10431,10430,10429,10428,10427,10426,10425,10424,10423,10422,10421,10420,10419,10418,10417,10416,10415,10414,10413,10412,10411,10410,10409,10408,10407,10406,10405,10404,10403,10402,10401,10400,10399,10398,10397,10396,10395,10394,10393,10392,10391,10390,10389,10388,10387,10386,10385,10384,10383,10382,10381,10380,10379,10378,10377,10376,10375,10374,10373,10372,10371,10370,10369,10368,10367,10366,10365,10364,10363,10362,10361,10360,10359,10358,10357,10356,10355,10354,10353,10352,10351,10350,10349,10348,10347,10346,10345,10344,10343,10342,10341,10340,10339,10338,10337,10336,10335,10334,10333,10332,10331,10330,10329,10328,10327,10326,10325,10324,10323,10322,10321,10320,10319,10318,10317,10316,10315,10314,10313,10312,10311,10310,10309,10308,10307,10306,10305,10304,10303,10302,10301,10300,10299,10298,10297,10296,10295,10294,10293,10292,10291,10290,10289,10288,10287,10286,10285,10284,10283,10282,10281,10280,10279,10278,10277,10276,10275,10274,10273,10272,10271,10270,10269,10268,10267,10266,10265,10264,10263,10262,10261,10260,10259,10258,10257,10256,10255,10254,10253,10252,10251,10250,10249,10248];

		// Unmatched Postman assertion: for(let x = 0, length = ids.length; x < length; x++){
		.expect((r) => assert.ok(r.body[x].orderid == ids[x]));
// Unmatched Postman assertion: }})
});

it('NoSQL search by value reverse limit 20', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': '{{schema}}',
			'table': '{{ords_tb}}',
			'search_attribute': '{{ordd_id}}',
			'search_value': '*',
			'get_attributes': ['*'],
			'reverse': true,
			'limit': 20,
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 20))

		// Unmatched Postman assertion: let ids = [11077,11076,11075,11074,11073,11072,11071,11070,11069,11068,11067,11066,11065,11064,11063,11062,11061,11060,11059,11058];

		// Unmatched Postman assertion: for(let x = 0, length = ids.length; x < length; x++){
		.expect((r) => assert.ok(r.body[x].orderid == ids[x]));
// Unmatched Postman assertion: }})
});

it('NoSQL search by value reverse offset 20 limit 20', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': '{{schema}}',
			'table': '{{ords_tb}}',
			'search_attribute': '{{ordd_id}}',
			'search_value': '*',
			'get_attributes': ['*'],
			'reverse': true,
			'offset': 20,
			'limit': 20,
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 20))

		// Unmatched Postman assertion: let ids = [11057,11056,11055,11054,11053,11052,11051,11050,11049,11048,11047,11046,11045,11044,11043,11042,11041,11040,11039,11038];

		// Unmatched Postman assertion: for(let x = 0, length = ids.length; x < length; x++){
		.expect((r) => assert.ok(r.body[x].orderid == ids[x]));
// Unmatched Postman assertion: }})
});

it('update NoSQL employee', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'records': [{ '{{emps_id}}': 1, 'address': 'def1234' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.update_hashes[0] == 1));
});

it('update NoSQL employee confirm', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'hash_attribute': '{{emps_id}}',
			'hash_values': [1],
			'get_attributes': ['{{emps_id}}', 'address'],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body[0].employeeid == 1))
		.expect((r) => assert.ok(r.body[0].address == 'def1234'));
});

it('update NoSQL call.aggr set data to dot & double dot', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': 'call',
			'table': 'aggr',
			'records': [{ 'all': 4, 'dog_name': '.', 'owner_name': '..' }],
		})
		.expect(200);
// Unmatched Postman assertion: pm.expect(jsonData.update_hashes[0]).to.eql(4)
});

it('update NoSQL employee add new attribute', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'records': [{ '{{emps_id}}': 1, 'address': 'def1234', 'test_record': 'I\'mATest' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.update_hashes[0] == 1));

//Unmatched Postman assertion: function pausecomp(millis)
// Unmatched Postman assertion: {
// Unmatched Postman assertion: var date = new Date()
// Unmatched Postman assertion: var curDate = null;
// Unmatched Postman assertion: do { curDate = new Date() }
// Unmatched Postman assertion: while(curDate-date < millis)
// Unmatched Postman assertion: }
// Unmatched Postman assertion: pausecomp(100))
});

it('Insert with duplicate records to make sure both are not added', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'records': [{
				'{{emps_id}}': 212,
				'address': 'def1234',
				'lastname': 'dobolina',
				'firstname': 'bob',
			}, { '{{emps_id}}': 212, 'address': 'def1234', 'lastname': 'dobolina2', 'firstname': 'bob' }],
		})
		.expect(200);
// Unmatched Postman assertion: pm.expect(jsonData.skipped_hashes[0]).to.eql(212)
});

it('Insert with no hash', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'records': [{ 'address': '1 North Street', 'lastname': 'Dog', 'firstname': 'Harper' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 1))
		.expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'));
});

it('Insert with empty hash', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'records': [{ '{{emps_id}}': '', 'address': '23 North Street', 'lastname': 'Cat', 'firstname': 'Brian' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 1))
		.expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'));
});

it('NoSQL search by hash', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'hash_attribute': '{{emps_id}}',
			'hash_values': [1],
			'get_attributes': ['address', 'test_record'],
		})
		.expect(200);
// Unmatched Postman assertion: pm.expect(jsonData[0].address).to.eql('def1234')
// Unmatched Postman assertion: pm.expect(jsonData[0].test_record).to.eql("I'mATest"))
});

it('NoSQL search by hash - check dot & double dot', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': 'call',
			'table': 'aggr',
			'hash_values': [4],
			'get_attributes': ['*'],
		})
		.expect(200);
// Unmatched Postman assertion: pm.expect(jsonData[0].dog_name).to.eql('.')
// Unmatched Postman assertion: pm.expect(jsonData[0].owner_name).to.eql(".."))
});

it('NoSQL search by hash no schema', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': 'callABC',
			'table': 'aggr',
			'hash_values': [4],
			'get_attributes': ['*'],
		})
		.expect(404)
		.expect((r) => assert.ok(r.body.error == 'database \'callABC\' does not exist'));
});

it('NoSQL search by hash no table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': 'call',
			'table': 'aggrABC',
			'hash_values': [4],
			'get_attributes': ['*'],
		})
		.expect(404)
		.expect((r) => assert.ok(r.body.error == 'Table \'call.aggrABC\' does not exist'));
});

it('NoSQL search by hash hash_value bad data type', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': 'call',
			'table': 'aggr',
			'hash_values': 4,
			'get_attributes': ['*'],
		})
		.expect(500)
		.expect((r) => assert.ok(r.body.error == '\'hash_values\' must be an array'));
});

it('NoSQL search by hash get_attributes bad data type', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': 'call',
			'table': 'aggr',
			'hash_values': [4],
			'get_attributes': '*',
		})
		.expect(500)
		.expect((r) => assert.ok(r.body.error == '\'get_attributes\' must be an array'));
});

it('update NoSQL employee with falsey attributes', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'records': [{ '{{emps_id}}': 2, 'address': 0, 'hireDate': null, 'notes': false }],
		})
		.expect((r) => assert.ok(r.body.message == 'updated 1 of 1 records', 'Expected response message to eql "updated 1 of 1 records"'))
		.expect(200);
// Unmatched Postman assertion: pm.expect(jsonData.update_hashes[0]).to.eql(2))
});

it('NoSQL search by hash to confirm falsey update', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'hash_attribute': '{{emps_id}}',
			'hash_values': [2],
			'get_attributes': ['address', 'hireDate', 'notes'],
		})
		.expect(200);
// Unmatched Postman assertion: pm.expect(jsonData[0].address).to.eql(0)
// Unmatched Postman assertion: pm.expect(jsonData[0].hireDate).to.eql(null)
// Unmatched Postman assertion: pm.expect(jsonData[0].notes).to.eql(false))
});

it('update NoSQL one employee record with no hash attribute', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'records': [{ 'address': '3000 Dog Place' }],
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'a valid hash attribute must be provided with update record, check log for more info'));
});

it('update NoSQL one employee record with empty hash attribute', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'records': [{ '{{emps_id}}': '', 'address': '123 North Blvd', 'notes': 'This guy is the real deal' }],
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'a valid hash attribute must be provided with update record, check log for more info'));
});

it('update NoSQL multiple employee records with no hash attribute', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'records': [{
				'{{emps_id}}': 2,
				'address': '123 North Blvd',
				'notes': 'This guy is the real deal',
			}, { 'address': '45 Lost St', 'notes': 'This person doesn\'t even have an id!' }, {
				'{{emps_id}}': 3,
				'address': '1 Main St',
				'notes': 'This guy okay',
			}],
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == 'a valid hash attribute must be provided with update record, check log for more info'));
});

it('update NoSQL employee with valid nonexistent hash', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'records': [{ '{{emps_id}}': 'There is no way this exists', 'notes': 'who is this fella?' }],
		})
		.expect(200)
		// Unmatched Postman assertion: if(jsonData.message === "updated 0 of 1 records"){
		.expect((r) => assert.ok(r.body.message == 'updated 0 of 1 records'))
		.expect((r) => assert.ok(r.body.update_hashes == []))
		// Unmatched Postman assertion: pm.expect(jsonData.skipped_hashes[0]).to.eql("There is no way this exists")
		// Unmatched Postman assertion: } else if(jsonData.message === "updated 1 of 1 records"){
		.expect((r) => assert.ok(r.body.message == 'updated 1 of 1 records', 'Expected response message to eql "updated 1 of 1 records"'))
		// Unmatched Postman assertion: pm.expect(jsonData.update_hashes[0]).to.eql("There is no way this exists")
		.expect((r) => assert.ok(r.body.skipped_hashes == []));
// Unmatched Postman assertion: }})
});

it('NoSQL search by value - * at end', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': 'dev',
			'table': 'remarks_blob',
			'search_attribute': 'remarks',
			'search_value': 'Location ... Location ...GOURGEOUS HOME in a Heart of MANDARIN,Next to Loretto Magnet schoolClose to I-295, shopping & entertainment. Gated community! Loaded with upgrades:*',
			'get_attributes': ['*'],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2))
		// Unmatched Postman assertion: jsonData.forEach((record)=>{
		// Unmatched Postman assertion: let keys = Object.keys(record)
		// Unmatched Postman assertion: if(keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1){
		.expect((r) => assert.ok(keys.length == 5))
		// Unmatched Postman assertion: } else{
		.expect((r) => assert.ok(keys.length == 3));
// Unmatched Postman assertion: }
// Unmatched Postman assertion: pm.expect(record.remarks.includes('Location ... Location ...GOURGEOUS HOME in a Heart of MANDARIN,Next to Loretto Magnet schoolClose to I-295, shopping & entertainment. Gated community! Loaded with upgrades:')).to.eql(true)});
});

it('NoSQL search by value - * at start', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': 'dev',
			'table': 'remarks_blob',
			'search_attribute': 'remarks',
			'search_value': '**DON\'T MISS THIS BEAUTIFUL DAVID WEEKLEY BELMONTE MODEL*ONE OF THE LARGEST LOTS IN CROSSWATER*GREAT FOR OUTDOOR FUN!*LUXURIOUS LIVING!*HIGH TECH HOME*CROWN MOLDING, CUSTOM PLANTATION SHUTTERS, 18\'\' TILE & CUSTOM WHITE OAK HARDWOOD FLOORING...',
			'get_attributes': ['*'],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		// Unmatched Postman assertion: jsonData.forEach((record)=>{
		// Unmatched Postman assertion: let keys = Object.keys(record)
		// Unmatched Postman assertion: if(keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1){
		.expect((r) => assert.ok(keys.length == 5))
		// Unmatched Postman assertion: } else{
		.expect((r) => assert.ok(keys.length == 3));
// Unmatched Postman assertion: }
// Unmatched Postman assertion: pm.expect(record.remarks.includes("*DON'T MISS THIS BEAUTIFUL DAVID WEEKLEY BELMONTE MODEL*ONE OF THE LARGEST LOTS IN CROSSWATER*GREAT FOR OUTDOOR FUN!*LUXURIOUS LIVING!*HIGH TECH HOME*CROWN MOLDING, CUSTOM PLANTATION SHUTTERS, 18'' TILE & CUSTOM WHITE OAK HARDWOOD FLOORING...")).to.eql(true)});
});

it('NoSQL search by value - * at start and end', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': 'dev',
			'table': 'remarks_blob',
			'search_attribute': 'remarks',
			'search_value': '*4 Bedroom/2.5+*',
			'get_attributes': ['*'],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 3))
		// Unmatched Postman assertion: jsonData.forEach((record)=>{
		// Unmatched Postman assertion: let keys = Object.keys(record)
		// Unmatched Postman assertion: if(keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1){
		.expect((r) => assert.ok(keys.length == 5))
		// Unmatched Postman assertion: } else{
		.expect((r) => assert.ok(keys.length == 3));
// Unmatched Postman assertion: }
// Unmatched Postman assertion: pm.expect(record.remarks.includes("4 Bedroom/2.5+")).to.eql(true)});
});

it('NoSQL search by value - * as search_value', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': 'dev',
			'table': 'remarks_blob',
			'search_attribute': 'remarks',
			'search_value': '*',
			'get_attributes': ['*'],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 11))
		// Unmatched Postman assertion: jsonData.forEach((record)=>{
		// Unmatched Postman assertion: let keys = Object.keys(record)
		// Unmatched Postman assertion: if(keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1){
		.expect((r) => assert.ok(keys.length == 5))
		// Unmatched Postman assertion: } else{
		.expect((r) => assert.ok(keys.length == 3));
// Unmatched Postman assertion: }});
});

it('NoSQL search by value - *** at start', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': 'dev',
			'table': 'remarks_blob',
			'search_attribute': 'remarks',
			'search_value': '***Spacious & updated 2-story home on large preserve lot nearly 1/2 acre! Concrete block constr. & desirable ICW location near JTB, shopping, dining & the beach! Great split BD flrpln w/soaring ceilings features 4BD + office, upstairs loft & 3 full BA.',
			'get_attributes': ['*'],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		// Unmatched Postman assertion: jsonData.forEach((record)=>{
		// Unmatched Postman assertion: let keys = Object.keys(record)
		// Unmatched Postman assertion: if(keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1){
		.expect((r) => assert.ok(keys.length == 5))
		// Unmatched Postman assertion: } else{
		.expect((r) => assert.ok(keys.length == 3));
// Unmatched Postman assertion: }
// Unmatched Postman assertion: pm.expect(record.remarks.includes("**Spacious & updated 2-story home on large preserve lot nearly 1/2 acre! Concrete block constr. & desirable ICW location near JTB, shopping, dining & the beach! Great split BD flrpln w/soaring ceilings features 4BD + office, upstairs loft & 3 full BA.")).to.eql(true)});
});

it('NoSQL search by hash on leading_zero, value = 0', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': 'dev',
			'table': 'leading_zero',
			'hash_attribute': 'id',
			'hash_values': [0],
			'get_attributes': ['*'],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		// Unmatched Postman assertion: let record = jsonData[0];
		.expect((r) => assert.ok(record.id == 0))
		.expect((r) => assert.ok(record.another_attribute == 'another_1'))
		.expect((r) => assert.ok(record.some_attribute == 'some_att1'));
});

it('NoSQL search by hash on leading_zero, values '
011;
', ';
00011;
'', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': 'dev',
			'table': 'leading_zero',
			'hash_attribute': 'id',
			'hash_values': ['011', '00011'],
			'get_attributes': ['*'],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2))
		// Unmatched Postman assertion: let record = jsonData[0];
		.expect((r) => assert.ok(record.id == '011'))
		.expect((r) => assert.ok(record.another_attribute == 'another_2'))
		.expect((r) => assert.ok(record.some_attribute == 'some_att2'))
		// Unmatched Postman assertion: let record2 = jsonData[1];
		.expect((r) => assert.ok(record2.id == '00011'))
		.expect((r) => assert.ok(record2.another_attribute == 'another_3'));
// Unmatched Postman assertion: pm.expect(record2.some_attribute).to.eql("some_att3"))
};
)
;

it('NoSQL search by value leading_zero - value = 0', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': 'dev',
			'table': 'leading_zero',
			'search_attribute': 'id',
			'search_value': 0,
			'get_attributes': ['*'],
		})
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		// Unmatched Postman assertion: let record = jsonData[0];
		.expect((r) => assert.ok(record.id == 0))
		.expect((r) => assert.ok(record.another_attribute == 'another_1'))
		.expect((r) => assert.ok(record.some_attribute == 'some_att1'));
});

it('NoSQL search by value leading_zero - value = "011"', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': 'dev',
			'table': 'leading_zero',
			'search_attribute': 'id',
			'search_value': '011',
			'get_attributes': ['*'],
		})
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		// Unmatched Postman assertion: let record = jsonData[0];
		// Unmatched Postman assertion: pm.expect(record.id).to.eql('011')
		.expect((r) => assert.ok(record.another_attribute == 'another_2'));
// Unmatched Postman assertion: pm.expect(record.some_attribute).to.eql("some_att2"))
});

it('NoSQL search by value leading_zero - value = "0*"', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': 'dev',
			'table': 'leading_zero',
			'search_attribute': 'id',
			'search_value': '0*',
			'get_attributes': ['*'],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2))
		// Unmatched Postman assertion: let record2 = jsonData[0];
		.expect((r) => assert.ok(record2.id == '00011'))
		.expect((r) => assert.ok(record2.another_attribute == 'another_3'));
// Unmatched Postman assertion: pm.expect(record2.some_attribute).to.eql("some_att3")
// Unmatched Postman assertion: let record1 = jsonData[1];
// Unmatched Postman assertion: pm.expect(record1.id).to.eql("011")
// Unmatched Postman assertion: pm.expect(record1.another_attribute).to.eql("another_2")
// Unmatched Postman assertion: pm.expect(record1.some_attribute).to.eql("some_att2"))
});

it('Upsert into products 1 new record & 2 that exist', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'upsert',
			'schema': '{{schema}}',
			'table': '{{prod_tb}}',
			'records': [{
				'categoryid': 1,
				'unitsnnorder': 0,
				'unitsinstock': 39,
				'supplierid': 1,
				'productid': 1,
				'discontinued': true,
				'reorderlevel': 10,
				'productname': 'Chai',
				'quantityperunit': '10 boxes x 20 bags',
				'unitprice': 18,
			}, {
				'productid': 100,
				'categoryid': 1,
				'unitsnnorder': 0,
				'unitsinstock': 39,
				'supplierid': 1,
				'discontinued': true,
				'reorderlevel': 10,
				'productname': 'Chai',
				'quantityperunit': '10 boxes x 20 bags',
				'unitprice': 18,
			}, {
				'productid': 101,
				'categoryid': 1,
				'unitsnnorder': 0,
				'unitsinstock': 39,
				'supplierid': 1,
				'discontinued': true,
				'reorderlevel': 10,
				'productname': 'Chai',
				'quantityperunit': '10 boxes x 20 bags',
				'unitprice': 18,
			}],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.upserted_hashes.length == 3))
		// Unmatched Postman assertion: pm.expect(jsonData.upserted_hashes).to.eql([1, 100, 101])
		.expect((r) => assert.ok(r.body.skipped_hashes == 'undefined'))
		.expect((r) => assert.ok(r.body.message == 'upserted 3 of 3 records'));
});

it('Confirm upserted records exist and are updated', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': '{{schema}}',
			'table': '{{prod_tb}}',
			'search_attribute': 'discontinued',
			'search_value': true,
			'get_attributes': ['*'],
		})
		.expect(200);
// Unmatched Postman assertion: const expectedHashes = [1, 100, 101];
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect(expectedHashes.includes(row.productid)).to.be.true;
// Unmatched Postman assertion: pm.expect(row.discontinued).to.be.true;});
});

it('Upsert into products 3 new records w/o hash vals', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'upsert',
			'schema': '{{schema}}',
			'table': '{{prod_tb}}',
			'records': [{
				'categoryid': 1,
				'unitsnnorder': 0,
				'unitsinstock': 39,
				'supplierid': 1,
				'discontinued': 'True',
				'reorderlevel': 10,
				'productname': 'Chai',
				'quantityperunit': '10 boxes x 20 bags',
				'unitprice': 18,
			}, {
				'categoryid': 1,
				'unitsnnorder': 0,
				'unitsinstock': 39,
				'supplierid': 1,
				'discontinued': 'True',
				'reorderlevel': 10,
				'productname': 'Chai',
				'quantityperunit': '10 boxes x 20 bags',
				'unitprice': 18,
			}, {
				'categoryid': 1,
				'unitsnnorder': 0,
				'unitsinstock': 39,
				'supplierid': 1,
				'discontinued': 'True',
				'reorderlevel': 10,
				'productname': 'Chai',
				'quantityperunit': '10 boxes x 20 bags',
				'unitprice': 18,
			}],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.upserted_hashes.length == 3))
		.expect((r) => assert.ok(r.body.skipped_hashes == 'undefined'))
		.expect((r) => assert.ok(r.body.message == 'upserted 3 of 3 records'));
});

it('Remove added record from products', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'delete', 'schema': '{{schema}}', 'table': '{{prod_tb}}', 'hash_values': [100] })
		.expect(200)
		.expect((r) => assert.ok(r.body.deleted_hashes.length == 1))
		// Unmatched Postman assertion: pm.expect(jsonData.deleted_hashes).to.eql([100])
		.expect((r) => assert.ok(r.body.skipped_hashes.length == 0))
		.expect((r) => assert.ok(r.body.skipped_hashes == []))
		.expect((r) => assert.ok(r.body.message == '1 of 1 record successfully deleted'));
});

it('Update products 1 existing record & one that does not exist', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': '{{schema}}',
			'table': '{{prod_tb}}',
			'records': [{ 'productid': 1, 'discontinued': true }, {
				'categoryid': 1,
				'unitsnnorder': 0,
				'unitsinstock': 39,
				'supplierid': 1,
				'productid': 100,
				'discontinued': 'False',
				'reorderlevel': 10,
				'productname': 'Chai',
				'quantityperunit': '10 boxes x 20 bags',
				'unitprice': 18,
			}],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.update_hashes.length == 1))
		.expect((r) => assert.ok(r.body.update_hashes == [1]))
		// Unmatched Postman assertion: pm.expect(jsonData.skipped_hashes.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(jsonData.skipped_hashes).to.eql([100])
		.expect((r) => assert.ok(r.body.message == 'updated 1 of 2 records'));
});

it('Restore Product record', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': '{{schema}}',
			'table': '{{prod_tb}}',
			'records': [{ 'productid': 1, 'discontinued': 'False' }],
		})
		.expect((r) => assert.ok(r.body.message == 'updated 1 of 1 records', 'Expected response message to eql "updated 1 of 1 records"'))
		.expect(200)
		.expect((r) => assert.ok(r.body.update_hashes.length == 1))
		.expect((r) => assert.ok(r.body.update_hashes == [1]))
		.expect((r) => assert.ok(r.body.skipped_hashes.length == 0))
		.expect((r) => assert.ok(r.body.skipped_hashes == []));
});

it('attempt to update __createdtime__', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'records': [{ '{{emps_id}}': 1, '__createdtime__': 'bad value' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.update_hashes[0] == 1));
});

it('confirm __createdtime__ did not change', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': '{{schema}}',
			'table': '{{emps_tb}}',
			'hash_attribute': '{{emps_id}}',
			'hash_values': [1],
			'get_attributes': ['{{emps_id}}', '__createdtime__'],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body[0].employeeid == 1))
		.expect((r) => assert.ok(r.body[0].__createdtime__ != 'bad value'));
});

it('insert record with dog_name =  single space value & empty string', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': 'dev',
			'table': 'dog',
			'records': [{ 'id': 1111, 'dog_name': ' ' }, { 'id': 2222, 'dog_name': '' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'inserted 2 of 2 records'))
		.expect((r) => assert.ok(r.body.inserted_hashes == [1111, 2222]));
});

it('search by value dog_name = single space string', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': 'dev',
			'table': 'dog',
			'search_attribute': 'dog_name',
			'search_value': ' ',
			'get_attributes': ['id', 'dog_name'],
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [{ id: 1111, dog_name: ' ' }]));
});

it('search by value dog_name = empty string', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': 'dev',
			'table': 'dog',
			'search_attribute': 'dog_name',
			'search_value': '',
			'get_attributes': ['id', 'dog_name'],
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [{ id: 2222, dog_name: '' }]));
});

it('Delete dev.dog records previously created', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'delete', 'schema': 'dev', 'table': 'dog', 'hash_values': [1111, 2222] })
		.expect(200)
		.expect((r) => assert.ok(r.body.deleted_hashes == [1111, 2222]));
});

it('Search by value 123.4', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'schema': '123',
			'table': '4',
			'search_attribute': 'name',
			'search_value': 'Hot Diddy Dawg',
			'get_attributes': ['id', 'name'],
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [{ id: 987654321, name: 'Hot Diddy Dawg' }]));
});

it('Search by hash 123.4', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_hash',
			'schema': '123',
			'table': '4',
			'hash_values': [987654321],
			'get_attributes': ['name'],
		})
		.expect(200)
		.expect((r) => assert.deepEqual(r.body, [{ name: 'Hot Diddy Dawg' }]));
});

it('Delete 123.4 record', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'delete', 'schema': '123', 'table': '4', 'hash_values': [987654321] })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == '1 of 1 record successfully deleted'));
});

it('search by conditions - equals', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'conditions': [{ 'search_attribute': 'age', 'search_type': 'equals', 'search_value': 5 }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok([1, 2].includes(row.id)));
});
})
;

it('search by conditions - contains', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'conditions': [{ 'search_attribute': 'location', 'search_type': 'contains', 'search_value': 'Denver' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 6));
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect(row.location.includes('Denver')).to.be.true;})
});

it('search by conditions - starts_with', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'conditions': [{ 'search_attribute': 'location', 'search_type': 'starts_with', 'search_value': 'Denver' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 6));
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect(row.location.startsWith('Denver')).to.equal(true))
});

it('search by conditions - ends_with', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'conditions': [{ 'search_attribute': 'dog_name', 'search_type': 'ends_with', 'search_value': 'y' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 4))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok([...row.dog_name].pop() == 'y'));
});

it('search by conditions - greater_than', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'conditions': [{ 'search_attribute': 'age', 'search_type': 'greater_than', 'search_value': 4 }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 6));
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect(row.age > 4).to.be.true;})
});

it('search by conditions - greater_than_equal', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'conditions': [{ 'search_attribute': 'age', 'search_type': 'greater_than_equal', 'search_value': 4 }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 8));
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect(row.age >= 4).to.be.true;})
});

it('search by conditions - less_than', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'conditions': [{ 'search_attribute': 'age', 'search_type': 'less_than', 'search_value': 4 }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2));
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect(row.age < 4).to.be.true;})
});

it('search by conditions - less_than_equal', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'conditions': [{ 'search_attribute': 'age', 'search_type': 'less_than_equal', 'search_value': 4 }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 4));
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect(row.age <= 4).to.be.true;})
});

it('search by conditions - between', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'conditions': [{ 'search_attribute': 'age', 'search_type': 'between', 'search_value': [2, 5] }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 5));
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect(row.age <= 5 && row.age >= 2).to.be.true;})
});

it('search by conditions - between using same value', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'conditions': [{ 'search_attribute': 'age', 'search_type': 'between', 'search_value': [5, 5] }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2));
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect(row.age).to.equal(5))
});

it('search by conditions - between w/ alpha', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'conditions': [{ 'search_attribute': 'group', 'search_type': 'between', 'search_value': ['A', 'B'] }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 7))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok(['A', 'B'].includes(row.group)));
});
})
;

it('search by conditions - equals & equals', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'conditions': [{
				'search_attribute': 'group',
				'search_type': 'equals',
				'search_value': 'A',
			}, { 'search_attribute': 'age', 'search_type': 'equals', 'search_value': 5 }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2));
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect(row.age === 5 && row.group === "A").to.be.true;})
});

it('search by conditions - equals || equals', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'operator': 'OR',
			'conditions': [{
				'search_attribute': 'group',
				'search_type': 'equals',
				'search_value': 'A',
			}, { 'search_attribute': 'group', 'search_type': 'equals', 'search_value': 'B' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 7))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok(['A', 'B'].includes(row.group)));
});
})
;

it('search by conditions - equals & contains', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'conditions': [{
				'search_attribute': 'location',
				'search_type': 'contains',
				'search_value': 'CO',
			}, { 'search_attribute': 'group', 'search_type': 'equals', 'search_value': 'B' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok(row.group == 'B'));
// Unmatched Postman assertion: pm.expect(row.location.includes('CO')).to.be.true;})
});

it('search by conditions - equals & ends_with', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'conditions': [{
				'search_attribute': 'location',
				'search_type': 'ends_with',
				'search_value': 'CO',
			}, { 'search_attribute': 'group', 'search_type': 'equals', 'search_value': 'B' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok(row.group == 'B'))
		.expect((r) => assert.ok(row.location.spl
});

it(', ')[1] == 'CO';
))
})
;

it('search by conditions - greater_than_equal & starts_with', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'conditions': [{
				'search_attribute': 'location',
				'search_type': 'starts_with',
				'search_value': 'Denver',
			}, { 'search_attribute': 'age', 'search_type': 'greater_than_equal', 'search_value': 5 }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 3))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		// Unmatched Postman assertion: pm.expect(row.age).to.be.gte(5)
		.expect((r) => assert.ok(row.location.spl
});

it(',')[0] == 'Denver';
))
})
;

it('search by conditions - less_than_equal ||  greater_than', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'operator': 'OR',
			'conditions': [{
				'search_attribute': 'age',
				'search_type': 'less_than_equal',
				'search_value': 4,
			}, { 'search_attribute': 'age', 'search_type': 'greater_than', 'search_value': 5 }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 8));
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect(row.age <=4 || row.age > 5).to.be.true;})
});

it('search by conditions - contains || contains', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['*'],
			'operator': 'OR',
			'conditions': [{
				'search_attribute': 'location',
				'search_type': 'contains',
				'search_value': 'NC',
			}, { 'search_attribute': 'location', 'search_type': 'contains', 'search_value': 'CO' }],
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 10));
// Unmatched Postman assertion: jsonData.forEach(row => {
// Unmatched Postman assertion: pm.expect(row.location.includes('CO') || row.location.includes('NC')).to.be.true;})
});

it('search by conditions - contains & between', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['id', 'age', 'group', 'location'],
			'conditions': [{
				'search_attribute': 'group',
				'search_type': 'between',
				'search_value': ['A', 'C'],
			}, { 'search_attribute': 'location', 'search_type': 'contains', 'search_value': 'Denver' }],
		})
		.expect(200)

		// Unmatched Postman assertion: const expected_hash_order = [1,2,8,5,7,11];

		.expect((r) => assert.ok(r.body.length == 6))
		// Unmatched Postman assertion: jsonData.forEach((row, i) => {
		.expect((r) => assert.ok(['A', 'B', 'C'].includes(row.group)))
		.expect((r) => assert.ok(row.location.spl
});

it(',')[0] == 'Denver';
))
.
expect((r) => assert.ok(row.id == expected_hash_order[i]));
})
;

it('search by conditions - starts_with '
AND;
' between', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'sort': { 'attribute': 'id' },
			'get_attributes': ['id', 'age', 'location', 'group'],
			'operator': 'AND',
			'conditions': [{
				'search_attribute': 'group',
				'search_type': 'between',
				'search_value': ['A', 'C'],
			}, { 'search_attribute': 'location', 'search_type': 'starts_with', 'search_value': 'Denver' }],
		})
		.expect(200)

		// Unmatched Postman assertion: const expected_hash_order = [1,2,5,7,8,11];

		.expect((r) => assert.ok(r.body.length == 6))
		// Unmatched Postman assertion: jsonData.forEach((row, i) => {
		.expect((r) => assert.ok(['A', 'B', 'C'].includes(row.group)))
		.expect((r) => assert.ok(row.location.spl
};
)

it(',')[0] == 'Denver';
))
.
expect((r) => assert.ok(row.id == expected_hash_order[i]));
})
;

it('search by conditions - starts_with & between w/ offset', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'sort': { 'attribute': 'id' },
			'get_attributes': ['id', 'age', 'location', 'group'],
			'offset': 1,
			'conditions': [{
				'search_attribute': 'group',
				'search_type': 'between',
				'search_value': ['A', 'C'],
			}, { 'search_attribute': 'location', 'search_type': 'starts_with', 'search_value': 'Denver' }],
		})
		.expect(200)

		// Unmatched Postman assertion: const expected_hash_order = [2,5,7,8,11];

		.expect((r) => assert.ok(r.body.length == 5))
		// Unmatched Postman assertion: jsonData.forEach((row, i) => {
		.expect((r) => assert.ok(['A', 'B', 'C'].includes(row.group)))
		.expect((r) => assert.ok(row.location.spl
});

it(',')[0] == 'Denver';
))
.
expect((r) => assert.ok(row.id == expected_hash_order[i]));
})
;

it('search by conditions - starts_with & between limit', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'sort': { 'attribute': 'id' },
			'get_attributes': ['id', 'age', 'location', 'group'],
			'limit': 4,
			'conditions': [{
				'search_attribute': 'group',
				'search_type': 'between',
				'search_value': ['A', 'C'],
			}, { 'search_attribute': 'location', 'search_type': 'starts_with', 'search_value': 'Denver' }],
		})
		.expect(200)

		// Unmatched Postman assertion: const expected_hash_order = [1,2,5,7];

		.expect((r) => assert.ok(r.body.length == 4))
		// Unmatched Postman assertion: jsonData.forEach((row, i) => {
		.expect((r) => assert.ok(['A', 'B', 'C'].includes(row.group)))
		.expect((r) => assert.ok(row.location.spl
});

it(',')[0] == 'Denver';
))
.
expect((r) => assert.ok(row.id == expected_hash_order[i]));
})
;

it('search by conditions - starts_with & between offset, limit', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'sort': { 'attribute': 'id' },
			'get_attributes': ['id', 'age', 'location', 'group'],
			'offset': 1,
			'limit': 3,
			'conditions': [{
				'search_attribute': 'group',
				'search_type': 'between',
				'search_value': ['A', 'C'],
			}, { 'search_attribute': 'location', 'search_type': 'starts_with', 'search_value': 'Denver' }],
		})
		.expect(200)

		// Unmatched Postman assertion: const expected_hash_order = [2,5,7];

		.expect((r) => assert.ok(r.body.length == expected_hash_order.length))
		// Unmatched Postman assertion: jsonData.forEach((row, i) => {
		.expect((r) => assert.ok(['A', 'B', 'C'].includes(row.group)))
		.expect((r) => assert.ok(row.location.spl
});

it(',')[0] == 'Denver';
))
.
expect((r) => assert.ok(row.id == expected_hash_order[i]));
})
;

it('search by conditions - starts_with condition, offset, limit of 2', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['id', 'age', 'location', 'group'],
			'offset': 3,
			'limit': 2,
			'conditions': [{ 'search_attribute': 'location', 'search_type': 'starts_with', 'search_value': 'Denver' }],
		})
		.expect(200)

		// Unmatched Postman assertion: const expected_hash_order = [11,1];

		.expect((r) => assert.ok(r.body.length == expected_hash_order.length))
		// Unmatched Postman assertion: jsonData.forEach((row, i) => {
		.expect((r) => assert.ok(row.location.spl
});

it(',')[0] == 'Denver';
))
.
expect((r) => assert.ok(row.id == expected_hash_order[i]));
})
;

it('search by conditions - starts_with condition, offset, limit of 10', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['id', 'age', 'location', 'group'],
			'offset': 3,
			'limit': 10,
			'conditions': [{ 'search_attribute': 'location', 'search_type': 'starts_with', 'search_value': 'Denver' }],
		})
		.expect(200)

		// Unmatched Postman assertion: const expected_hash_order = [11,1,8];

		.expect((r) => assert.ok(r.body.length == 3))
		// Unmatched Postman assertion: jsonData.forEach((row, i) => {
		.expect((r) => assert.ok(row.location.spl
});

it(',')[0] == 'Denver';
))
.
expect((r) => assert.ok(row.id == expected_hash_order[i]));
})
;

it('search by conditions - ends_with condition, offset, limit of 3', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_conditions',
			'schema': 'dev',
			'table': 'dog_conditions',
			'get_attributes': ['id', 'age', 'location', 'group'],
			'offset': 3,
			'limit': 3,
			'conditions': [{ 'search_attribute': 'location', 'search_type': 'ends_with', 'search_value': 'CO' }],
			'sort': { 'attribute': 'id' },
		})
		.expect(200)

		// Unmatched Postman assertion: const expected_hash_order = [7,9,10];

		.expect((r) => assert.ok(r.body.length == expected_hash_order.length))
		// Unmatched Postman assertion: jsonData.forEach((row, i) => {
		.expect((r) => assert.ok(row.location.spl
});

it(', ')[1] == 'CO';
))
.
expect((r) => assert.ok(row.id == expected_hash_order[i]));
})
;

it('Add non-SU bulk_load_role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'add_role', 'role': 'bulk_load_role', 'permission': {
				'super_user': false,
				'{{schema}}': {
					'tables': {
						'{{supp_tb}}': {
							'read': true,
							'insert': true,
							'update': true,
							'delete': true,
							'attribute_permissions': [{
								'attribute_name': 'companyname',
								'read': true,
								'insert': true,
								'update': true,
							}],
						},
						'{{csv_tb}}': {
							'read': true,
							'insert': true,
							'update': true,
							'delete': false,
							'attribute_permissions': [{
								'attribute_name': 'name',
								'read': false,
								'insert': true,
								'update': false,
							}, {
								'attribute_name': 'section',
								'read': true,
								'insert': false,
								'update': true,
							}, { 'attribute_name': 'image', 'read': true, 'insert': true, 'update': true }],
						},
					},
				},
				'dev': {
					'tables': {
						'books': {
							'read': true,
							'insert': true,
							'update': true,
							'delete': true,
							'attribute_permissions': [{
								'attribute_name': 'books_count',
								'read': true,
								'insert': false,
								'update': true,
							}],
						},
						'dog': {
							'read': true,
							'insert': true,
							'update': true,
							'delete': false,
							'attribute_permissions': [{
								'attribute_name': 'dog_name',
								'read': false,
								'insert': true,
								'update': true,
							}, {
								'attribute_name': 'age',
								'read': true,
								'insert': false,
								'update': true,
							}, {
								'attribute_name': 'adorable',
								'read': true,
								'insert': true,
								'update': false,
							}, { 'attribute_name': 'owner_id', 'read': true, 'insert': false, 'update': false }],
						},
						'owner': {
							'read': true,
							'insert': true,
							'update': true,
							'delete': false,
							'attribute_permissions': [{
								'attribute_name': 'name',
								'read': true,
								'insert': false,
								'update': false,
							}],
						},
					},
				},
			},
		})
		.expect(200);

	Unmatched;
	Postman;
	assertion: responseData = JSON.parse(responseBody);
// Unmatched Postman assertion: postman.setEnvironmentVariable("role_id", responseData.id)})
});

it('Add user with new bulk_load_role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'add_user',
			'role': 'bulk_load_role',
			'username': 'bulk_load_user',
			'password': '{{password}}',
			'active': true,
		})
		.expect(200);
});

it('CSV Data Load  update to table w/ new attr & restricted attrs', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'csv_data_load',
			'action': 'update',
			'schema': '{{schema}}',
			'table': '{{supp_tb}}',
			'data': 'supplierid,companyname, rando\n19,The Chum Bucket, Another attr value\n',
		})
		.expect(200);

	Unmatched;
	Postman;
	assertion: const responseData = JSON.parse(responseBody);
// Unmatched Postman assertion: let id_index = responseData.message.indexOf('id ')
// Unmatched Postman assertion: let parsedId = responseData.message.substr(id_index + 3, responseData.message.length)
// Unmatched Postman assertion: pm.environment.set("job_id", parsedId))
});

it('Check Data CSV job - update - perms error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'get_job', 'id': '{{job_id}}' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: const msg = jsonData[0].message;
		.expect((r) => assert.ok(r.body[0].status == 'ERROR'))
		.expect((r) => assert.ok(r.body[0].id == getJobId(job_id)))
		.expect((r) => assert.ok(msg.error == 'This operation is not authorized due to role restrictions and/or invalid database items'))
		// Unmatched Postman assertion: pm.expect(msg.unauthorized_access.length).to.eql(0)
		.expect((r) => assert.ok(msg.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.message.invalid_schema_items[0] == 'Attribute \' rando\' does not exist on \'northnwd.suppliers\''))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		.expect((r) => assert.ok(r.body[0].status != 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check Data CSV job - update - perms error')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check Data CSV job - update - perms error')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('CSV Data Load - upsert - to table w/ some restricted attrs & new attr', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'csv_data_load',
			'action': 'upsert',
			'schema': 'dev',
			'table': 'dog',
			'data': 'id,dog_name,adorable,age,rando\n19,doggy,true,22,Another attr value\n',
		})
		.expect(200);

	Unmatched;
	Postman;
	assertion: const responseData = JSON.parse(responseBody);
// Unmatched Postman assertion: let id_index = responseData.message.indexOf('id ')
// Unmatched Postman assertion: let parsedId = responseData.message.substr(id_index + 3, responseData.message.length)
// Unmatched Postman assertion: pm.environment.set("job_id", parsedId))
});

it('Check Data CSV job - upsert - perms error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'get_job', 'id': '{{job_id}}' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: const msg = jsonData[0].message;
		.expect((r) => assert.ok(r.body[0].status == 'ERROR'))
		.expect((r) => assert.ok(r.body[0].id == getJobId(job_id)))
		.expect((r) => assert.ok(msg.error == 'This operation is not authorized due to role restrictions and/or invalid database items'))
		.expect((r) => assert.ok(r.body[0].message.unauthorized_access.length == 1))
		// Unmatched Postman assertion: const unauth_obj = msg.unauthorized_access[0];
		.expect((r) => assert.ok(unauth_obj.schema == 'dev'))
		.expect((r) => assert.ok(unauth_obj.table == 'dog'))
		.expect((r) => assert.ok(unauth_obj.required_table_permissions.length == 0))
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions.length).to.eql(2)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].attribute_name).to.eql("adorable")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].required_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].required_permissions[0]).to.eql("update")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].attribute_name).to.eql("age")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].required_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].required_permissions[0]).to.eql("insert")
		.expect((r) => assert.ok(msg.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.message.invalid_schema_items[0] == 'Attribute \'rando\' does not exist on \'dev.dog\''))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		.expect((r) => assert.ok(r.body[0].status != 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check Data CSV job - upsert - perms error')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check Data CSV job - upsert - perms error')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('CSV URL Load - upsert - to table w/ restricted attrs', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'csv_url_load',
			'action': 'upsert',
			'schema': '{{schema}}',
			'table': '{{csv_tb}}',
			'csv_url': 'https://harperdb-integration-test-data.s3.us-east-2.amazonaws.com/breeds.csv',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'));

	Unmatched;
	Postman;
	assertion: let id_index = jsonData.message.indexOf('id ');
// Unmatched Postman assertion: let parsedId = jsonData.message.substr(id_index + 3, jsonData.message.length)
// Unmatched Postman assertion: pm.environment.set("job_id", parsedId))
});

it('Check URL CSV job  - upsert -  perms error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'get_job', 'id': '{{job_id}}' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: const msg = jsonData[0].message;
		.expect((r) => assert.ok(r.body[0].status == 'ERROR'))
		.expect((r) => assert.ok(r.body[0].id == getJobId(job_id)))
		.expect((r) => assert.ok(msg.error == 'This operation is not authorized due to role restrictions and/or invalid database items'))
		.expect((r) => assert.ok(r.body[0].message.unauthorized_access.length == 1))
		// Unmatched Postman assertion: const unauth_obj = msg.unauthorized_access[0];
		.expect((r) => assert.ok(unauth_obj.schema == 'northnwd'))
		.expect((r) => assert.ok(unauth_obj.table == 'url_csv_data'))
		.expect((r) => assert.ok(unauth_obj.required_table_permissions.length == 0))
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions.length).to.eql(2)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].attribute_name).to.eql("name")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].required_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].required_permissions[0]).to.eql("update")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].attribute_name).to.eql("section")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].required_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].required_permissions[0]).to.eql("insert")
		.expect((r) => assert.ok(msg.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.message.invalid_schema_items[0] == 'Attribute \'country\' does not exist on \'northnwd.url_csv_data\''))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		.expect((r) => assert.ok(r.body[0].status != 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check URL CSV job  - upsert -  perms error')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check URL CSV job  - upsert -  perms error')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('CSV URL Load - update - to table w/ restricted attrs', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'csv_url_load',
			'action': 'update',
			'schema': '{{schema}}',
			'table': '{{csv_tb}}',
			'csv_url': 'https://harperdb-integration-test-data.s3.us-east-2.amazonaws.com/breeds.csv',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'));

	Unmatched;
	Postman;
	assertion: let id_index = jsonData.message.indexOf('id ');
// Unmatched Postman assertion: let parsedId = jsonData.message.substr(id_index + 3, jsonData.message.length)
// Unmatched Postman assertion: pm.environment.set("job_id", parsedId))
});

it('Check URL CSV job  - update -  perms error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'get_job', 'id': '{{job_id}}' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: const msg = jsonData[0].message;
		.expect((r) => assert.ok(r.body[0].status == 'ERROR'))
		.expect((r) => assert.ok(r.body[0].id == getJobId(job_id)))
		.expect((r) => assert.ok(msg.error == 'This operation is not authorized due to role restrictions and/or invalid database items'))
		.expect((r) => assert.ok(r.body[0].message.unauthorized_access.length == 1))
		// Unmatched Postman assertion: const unauth_obj = msg.unauthorized_access[0];
		.expect((r) => assert.ok(unauth_obj.schema == 'northnwd'))
		.expect((r) => assert.ok(unauth_obj.table == 'url_csv_data'))
		.expect((r) => assert.ok(unauth_obj.required_table_permissions.length == 0))
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].attribute_name).to.eql("name")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].required_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].required_permissions[0]).to.eql("update")
		.expect((r) => assert.ok(msg.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.message.invalid_schema_items[0] == 'Attribute \'country\' does not exist on \'northnwd.url_csv_data\''))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		.expect((r) => assert.ok(r.body[0].status != 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check URL CSV job  - update -  perms error')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check URL CSV job  - update -  perms error')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('CSV File Load to table w/ restricted attrs', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'csv_file_load',
			'action': 'insert',
			'schema': 'dev',
			'table': 'books',
			'file_path': '{{files_location}}Books.csv',
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'));

	Unmatched;
	Postman;
	assertion: let id_index = jsonData.message.indexOf('id ');
// Unmatched Postman assertion: let parsedId = jsonData.message.substr(id_index + 3, jsonData.message.length)
// Unmatched Postman assertion: pm.environment.set("job_id", parsedId))
});

it('Check File CSV job perms error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'get_job', 'id': '{{job_id}}' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: const msg = jsonData[0].message;
		.expect((r) => assert.ok(r.body[0].status == 'ERROR'))
		.expect((r) => assert.ok(r.body[0].id == getJobId(job_id)))
		.expect((r) => assert.ok(msg.error == 'This operation is not authorized due to role restrictions and/or invalid database items'))
		.expect((r) => assert.ok(r.body[0].message.unauthorized_access.length == 1))
		// Unmatched Postman assertion: const unauth_obj = msg.unauthorized_access[0];
		.expect((r) => assert.ok(unauth_obj.schema == 'dev'))
		// Unmatched Postman assertion: pm.expect(unauth_obj.table).to.eql("books")
		.expect((r) => assert.ok(unauth_obj.required_table_permissions.length == 0))
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions.length).to.eql(2)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].attribute_name).to.eql("id")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].required_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].required_permissions[0]).to.eql("insert")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].attribute_name).to.eql("books_count")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].required_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].required_permissions[0]).to.eql("insert")
		// Unmatched Postman assertion: pm.expect(msg.invalid_schema_items.length).to.eql(17)
		// Unmatched Postman assertion: const expected_invalid_items = [
		// Unmatched Postman assertion: "Attribute 'authors' does not exist on 'dev.books'",
		// Unmatched Postman assertion: "Attribute 'original_publication_year' does not exist on 'dev.books'",
		// Unmatched Postman assertion: "Attribute 'original_title' does not exist on 'dev.books'",
		// Unmatched Postman assertion: "Attribute 'title' does not exist on 'dev.books'",
		// Unmatched Postman assertion: "Attribute 'language_code' does not exist on 'dev.books'",
		// Unmatched Postman assertion: "Attribute 'average_rating' does not exist on 'dev.books'",
		// Unmatched Postman assertion: "Attribute 'ratings_count' does not exist on 'dev.books'",
		// Unmatched Postman assertion: "Attribute 'work_ratings_count' does not exist on 'dev.books'",
		// Unmatched Postman assertion: "Attribute 'work_text_reviews_count' does not exist on 'dev.books'",
		// Unmatched Postman assertion: "Attribute 'ratings_1' does not exist on 'dev.books'",
		// Unmatched Postman assertion: "Attribute 'ratings_2' does not exist on 'dev.books'",
		// Unmatched Postman assertion: "Attribute 'ratings_3' does not exist on 'dev.books'",
		// Unmatched Postman assertion: "Attribute 'ratings_4' does not exist on 'dev.books'",
		// Unmatched Postman assertion: "Attribute 'ratings_5' does not exist on 'dev.books'",
		// Unmatched Postman assertion: "Attribute 'nytimes_best_seller' does not exist on 'dev.books'",
		// Unmatched Postman assertion: "Attribute 'image_url' does not exist on 'dev.books'",
		// Unmatched Postman assertion: "Attribute 'small_image_url' does not exist on 'dev.books'"
		// Unmatched Postman assertion: ];
		// Unmatched Postman assertion: msg.invalid_schema_items.forEach(item => {
		.expect((r) => assert.ok(expected_invalid_items.includes(item)))
		//Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		.expect((r) => assert.ok(r.body[0].status != 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check File CSV job perms error')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check File CSV job perms error')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Import CSV from S3 to table w/ restricted attrs', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'import_from_s3',
			'action': 'insert',
			'schema': 'dev',
			'table': 'dog',
			's3': {
				'aws_access_key_id': '{{s3_key}}',
				'aws_secret_access_key': '{{s3_secret}}',
				'bucket': 'harperdb-integration-test-data',
				'key': 'non_public_folder/dogs.csv',
				'region': 'us-east-2',
			},
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'));

	Unmatched;
	Postman;
	assertion: let id_index = jsonData.message.indexOf('id ');
// Unmatched Postman assertion: let parsedId = jsonData.message.substr(id_index + 3, jsonData.message.length)
// Unmatched Postman assertion: pm.environment.set("job_id", parsedId))
});

it('Check S3 CSV job perms error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'get_job', 'id': '{{job_id}}' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: const msg = jsonData[0].message;
		.expect((r) => assert.ok(r.body[0].status == 'ERROR'))
		.expect((r) => assert.ok(r.body[0].id == getJobId(job_id)))
		.expect((r) => assert.ok(msg.error == 'This operation is not authorized due to role restrictions and/or invalid database items'))
		.expect((r) => assert.ok(r.body[0].message.unauthorized_access.length == 1))
		// Unmatched Postman assertion: const unauth_obj = msg.unauthorized_access[0];
		.expect((r) => assert.ok(unauth_obj.schema == 'dev'))
		.expect((r) => assert.ok(unauth_obj.table == 'dog'))
		.expect((r) => assert.ok(unauth_obj.required_table_permissions.length == 0))
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions.length).to.eql(2)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].attribute_name).to.eql("owner_id")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].required_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].required_permissions[0]).to.eql("insert")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].attribute_name).to.eql("age")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].required_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].required_permissions[0]).to.eql("insert")
		// Unmatched Postman assertion: pm.expect(msg.invalid_schema_items.length).to.eql(2)
		// Unmatched Postman assertion: const expected_invalid_items = [
		// Unmatched Postman assertion: "Attribute 'breed_id' does not exist on 'dev.dog'",
		// Unmatched Postman assertion: "Attribute 'weight_lbs' does not exist on 'dev.dog'"
		// Unmatched Postman assertion: ];
		// Unmatched Postman assertion: msg.invalid_schema_items.forEach(item => {
		.expect((r) => assert.ok(expected_invalid_items.includes(item)))
		//Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		.expect((r) => assert.ok(r.body[0].status != 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 CSV job perms error')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 CSV job perms error')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Import JSON from S3 - upsert - to table w/ restricted attrs', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'import_from_s3',
			'action': 'upsert',
			'schema': 'dev',
			'table': 'owner',
			's3': {
				'aws_access_key_id': '{{s3_key}}',
				'aws_secret_access_key': '{{s3_secret}}',
				'bucket': 'harperdb-integration-test-data',
				'key': 'non_public_folder/owners_update.json',
				'region': 'us-east-2',
			},
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'));

	Unmatched;
	Postman;
	assertion: let id_index = jsonData.message.indexOf('id ');
// Unmatched Postman assertion: let parsedId = jsonData.message.substr(id_index + 3, jsonData.message.length)
// Unmatched Postman assertion: pm.environment.set("job_id", parsedId))
});

it('Check S3 JSON upsert perms error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'get_job', 'id': '{{job_id}}' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch (status) {
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: const msg = jsonData[0].message;
		.expect((r) => assert.ok(r.body[0].status == 'ERROR'))
		.expect((r) => assert.ok(r.body[0].id == getJobId(job_id)))
		.expect((r) => assert.ok(msg.error == 'This operation is not authorized due to role restrictions and/or invalid database items'))
		.expect((r) => assert.ok(r.body[0].message.unauthorized_access.length == 1))
		// Unmatched Postman assertion: const unauth_obj = msg.unauthorized_access[0];
		.expect((r) => assert.ok(unauth_obj.schema == 'dev'))
		.expect((r) => assert.ok(unauth_obj.table == 'owner'))
		.expect((r) => assert.ok(unauth_obj.required_table_permissions.length == 0))
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions.length).to.eql(2)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].attribute_name).to.eql("id")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].required_permissions.length).to.eql(2)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].required_permissions[0]).to.eql("insert")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].required_permissions[1]).to.eql("update")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].attribute_name).to.eql("name")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].required_permissions.length).to.eql(2)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].required_permissions[0]).to.eql("insert")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].required_permissions[1]).to.eql("update")
		.expect((r) => assert.ok(msg.invalid_schema_items.length == 0))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		.expect((r) => assert.ok(r.body[0].status != 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 JSON upsert perms error')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 JSON upsert perms error')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Import JSON from S3 - insert - to table w/ restricted attrs', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'import_from_s3',
			'action': 'insert',
			'schema': 'dev',
			'table': 'owner',
			's3': {
				'aws_access_key_id': '{{s3_key}}',
				'aws_secret_access_key': '{{s3_secret}}',
				'bucket': 'harperdb-integration-test-data',
				'key': 'non_public_folder/owners_update.json',
				'region': 'us-east-2',
			},
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'));

	Unmatched;
	Postman;
	assertion: let id_index = jsonData.message.indexOf('id ');
// Unmatched Postman assertion: let parsedId = jsonData.message.substr(id_index + 3, jsonData.message.length)
// Unmatched Postman assertion: pm.environment.set("job_id", parsedId))
});

it('Check S3 JSON insert perms error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'get_job', 'id': '{{job_id}}' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: const msg = jsonData[0].message;
		.expect((r) => assert.ok(r.body[0].status == 'ERROR'))
		.expect((r) => assert.ok(r.body[0].id == getJobId(job_id)))
		.expect((r) => assert.ok(msg.error == 'This operation is not authorized due to role restrictions and/or invalid database items'))
		.expect((r) => assert.ok(r.body[0].message.unauthorized_access.length == 1))
		// Unmatched Postman assertion: const unauth_obj = msg.unauthorized_access[0];
		.expect((r) => assert.ok(unauth_obj.schema == 'dev'))
		.expect((r) => assert.ok(unauth_obj.table == 'owner'))
		.expect((r) => assert.ok(unauth_obj.required_table_permissions.length == 0))
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions.length).to.eql(2)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].attribute_name).to.eql("id")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].required_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[0].required_permissions[0]).to.eql("insert")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].attribute_name).to.eql("name")
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].required_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(unauth_obj.required_attribute_permissions[1].required_permissions[0]).to.eql("insert")
		.expect((r) => assert.ok(msg.invalid_schema_items.length == 0))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		.expect((r) => assert.ok(r.body[0].status != 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 JSON insert perms error')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 JSON insert perms error')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Alter non-SU bulk_load_role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'alter_role',
			'id': '{{role_id}}',
			'role': 'bulk_load_role',
			'permission': {
				'super_user': false,
				'{{schema}}': {
					'tables': {
						'{{supp_tb}}': {
							'read': true,
							'insert': true,
							'update': true,
							'delete': true,
							'attribute_permissions': [],
						},
					},
				},
				'dev': {
					'tables': {
						'dog': {
							'read': true,
							'insert': true,
							'update': true,
							'delete': false,
							'attribute_permissions': [{
								'attribute_name': 'dog_name',
								'read': false,
								'insert': true,
								'update': true,
							}, {
								'attribute_name': 'age',
								'read': true,
								'insert': true,
								'update': true,
							}, {
								'attribute_name': 'adorable',
								'read': true,
								'insert': true,
								'update': true,
							}, {
								'attribute_name': 'owner_id',
								'read': true,
								'insert': true,
								'update': true,
							}, {
								'attribute_name': 'weight_lbs',
								'read': true,
								'insert': true,
								'update': true,
							}, {
								'attribute_name': 'breed_id',
								'read': true,
								'insert': true,
								'update': true,
							}, { 'attribute_name': '__updatedtime__', 'read': true, 'insert': true, 'update': false }],
						},
					},
				},
			},
		})
		.expect(200);
});

it('CSV Data Load  upsert to table w/ full perms', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'csv_data_load',
			'action': 'upsert',
			'schema': '{{schema}}',
			'table': '{{supp_tb}}',
			'data': 'companyname, new_attr\nThe Chum Bucket, Another attr value\n',
		})
		.expect(200);

	Unmatched;
	Postman;
	assertion: const responseData = JSON.parse(responseBody);
// Unmatched Postman assertion: let id_index = responseData.message.indexOf('id ')
// Unmatched Postman assertion: let parsedId = responseData.message.substr(id_index + 3, responseData.message.length)
// Unmatched Postman assertion: pm.environment.set("job_id", parsedId))
});

it('Check Data CSV upsert job completed', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'get_job', 'id': '{{job_id}}' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		.expect((r) => assert.ok(r.body[0].status != 'ERROR'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		.expect((r) => assert.ok(r.body[0].message.includes('successfully loaded 1 of 1 records')));
// Unmatched Postman assertion: pm.expect(status).to.eql('COMPLETE')
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check Data CSV upsert job completed')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check Data CSV upsert job completed')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Check row from Data CSV job was upserted', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT count(*) AS row_count FROM {{schema}}.{{supp_tb}}' })
		.expect(200);
// Unmatched Postman assertion: pm.expect(jsonData[0].row_count).to.eql(30))
});

it('Import CSV from S3 to table w/ full attr perms - update', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'import_from_s3',
			'action': 'update',
			'schema': 'dev',
			'table': 'dog',
			's3': {
				'aws_access_key_id': '{{s3_key}}',
				'aws_secret_access_key': '{{s3_secret}}',
				'bucket': 'harperdb-integration-test-data',
				'key': 'non_public_folder/dogs.csv',
				'region': 'us-east-2',
			},
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'));

	Unmatched;
	Postman;
	assertion: let id_index = jsonData.message.indexOf('id ');
// Unmatched Postman assertion: let parsedId = jsonData.message.substr(id_index + 3, jsonData.message.length)
// Unmatched Postman assertion: pm.environment.set("job_id", parsedId))
});

it('Check S3 CSV update job completed', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'get_job', 'id': '{{job_id}}' })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		.expect((r) => assert.ok(r.body[0].status != 'ERROR'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		.expect((r) => assert.ok(r.body[0].message.includes('successfully loaded 9 of 12 records')));
// Unmatched Postman assertion: pm.expect(status).to.eql('COMPLETE')
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 CSV update job completed')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 CSV update job completed')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'));
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Check rows from S3 update were updated', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.dog' })
		.expect(200)
		.expect((r) => {
			r.body.forEach(row => {
				assert.ok(row.__updatedtime__ > row.__createdtime__);
			});
		});
});

it('Drop bulk_load_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'drop_user', 'username': 'bulk_load_user' })
		.expect(200)
		.expect((r) => assert.ok(r.body.message));

// Unmatched Postman assertion: pm.expect(jsonData.message).to.contain('successfully deleted'))
});

it('Drop bulk_load_user role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'drop_role', 'id': '{{role_id}}' })
		.expect(200)
		.expect((r) => assert.ok(r.body.message));

// Unmatched Postman assertion: pm.expect(jsonData.message).to.contain('successfully deleted'))
});

it('Authentication - bad username', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'create_schema', 'schema': 'auth' })
		.expect(401)
		.expect((r) => assert.ok(r.body.error == 'Login failed'));
});

it('Authentication - bad password', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'create_schema', 'schema': 'auth' })
		.expect(401)
		.expect((r) => assert.ok(r.body.error == 'Login failed'));
});

it('NoSQL Add non SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'add_role', 'role': 'developer_test_5', 'permission': {
				'super_user': false,
				'northnwd': {
					'tables': {
						'customers': {
							'read': true,
							'insert': true,
							'update': true,
							'delete': true,
							'attribute_permissions': [],
						},
						'suppliers': {
							'read': false,
							'insert': false,
							'update': false,
							'delete': false,
							'attribute_permissions': [],
						},
						'region': {
							'read': true,
							'insert': false,
							'update': false,
							'delete': false,
							'attribute_permissions': [{
								'attribute_name': 'regiondescription',
								'read': true,
								'insert': false,
								'update': false,
								'delete': false,
							}],
						},
						'territories': {
							'read': true,
							'insert': true,
							'update': false,
							'delete': false,
							'attribute_permissions': [{
								'attribute_name': 'territorydescription',
								'read': true,
								'insert': true,
								'update': false,
								'delete': false,
							}],
						},
						'categories': {
							'read': true,
							'insert': true,
							'update': true,
							'delete': false,
							'attribute_permissions': [{
								'attribute_name': 'description',
								'read': true,
								'insert': true,
								'update': true,
								'delete': false,
							}],
						},
						'shippers': {
							'read': true,
							'insert': true,
							'update': true,
							'delete': true,
							'attribute_permissions': [{
								'attribute_name': 'companyname',
								'read': false,
								'insert': false,
								'update': false,
								'delete': false,
							}],
						},
					},
				},
				'dev': {
					'tables': {
						'dog': {
							'read': true,
							'insert': true,
							'update': true,
							'delete': true,
							'attribute_permissions': [{
								'attribute_name': '__createdtime__',
								'read': true,
								'insert': true,
								'update': true,
							}, {
								'attribute_name': '__updatedtime__',
								'read': true,
								'insert': true,
								'update': true,
							}, {
								'attribute_name': 'age',
								'read': true,
								'insert': true,
								'update': false,
							}, {
								'attribute_name': 'dog_name',
								'read': true,
								'insert': false,
								'update': true,
							}, {
								'attribute_name': 'adorable',
								'read': true,
								'insert': true,
								'update': true,
							}, { 'attribute_name': 'owner_id', 'read': false, 'insert': true, 'update': true }],
						},
						'breed': {
							'read': true,
							'insert': true,
							'update': true,
							'delete': true,
							'attribute_permissions': [{
								'attribute_name': '__createdtime__',
								'read': false,
								'insert': false,
								'update': true,
							}, { 'attribute_name': '__updatedtime__', 'read': false, 'insert': true, 'update': true }],
						},
						'dog_conditions': {
							'read': true,
							'insert': true,
							'update': false,
							'delete': false,
							'attribute_permissions': [{
								'attribute_name': 'age',
								'read': true,
								'insert': false,
								'update': false,
							}, {
								'attribute_name': 'group',
								'read': true,
								'insert': false,
								'update': false,
							}, {
								'attribute_name': 'breed_id',
								'read': false,
								'insert': true,
								'update': false,
							}, {
								'attribute_name': 'dog_name',
								'read': true,
								'insert': false,
								'update': false,
							}, {
								'attribute_name': 'id',
								'read': true,
								'insert': true,
								'update': false,
							}, { 'attribute_name': 'location', 'read': false, 'insert': false, 'update': false }],
						},
					},
				},
			},
		})
		.expect(200);

	Unmatched;
	Postman;
	assertion: responseData = JSON.parse(responseBody);
// Unmatched Postman assertion: postman.setEnvironmentVariable("role_id", responseData.id)})
});

it('NoSQL Add User with new Role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'add_user',
			'role': 'developer_test_5',
			'username': 'test_user',
			'password': '{{password}}',
			'active': true,
		})
		.expect(200);
});

it('NoSQL try to get user info as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ 'operation': 'list_users' })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == 'Operation \'listUsersExternal\' is restricted to \'super_user\' roles'))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0));
});

it('NoSQL Try to read suppliers table as SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'table': '{{supp_tb}}',
			'schema': '{{schema}}',
			'hash_attribute': 'id',
			'search_attribute': '{{supp_id}}',
			'search_value': '*',
			'get_attributes': ['{{supp_id}}'],
		})
		.expect(200);
});

it('NoSQL Try to read FULLY restricted suppliers table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'table': '{{supp_tb}}',
			'schema': '{{schema}}',
			'hash_attribute': 'id',
			'search_attribute': '{{supp_id}}',
			'search_value': '*',
			'get_attributes': ['{{supp_id}}'],
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == 'Table \'northnwd.suppliers\' does not exist'))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0));
});

it('NoSQL Try to read region table as SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'table': '{{regi_tb}}',
			'schema': '{{schema}}',
			'hash_attribute': 'id',
			'search_attribute': '{{regi_id}}',
			'search_value': '*',
			'get_attributes': ['*'],
		})
		.expect(200);
});

it('NoSQL Try to read region table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'search_by_value',
			'table': '{{regi_tb}}',
			'schema': '{{schema}}',
			'hash_attribute': 'id',
			'search_attribute': '{{regi_id}}',
			'search_value': '*',
			'get_attributes': ['*'],
		})
		.expect(200);
});

it('NoSQL Try to insert into region table as SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '{{schema}}',
			'table': '{{regi_tb}}',
			'records': [{ '{{regi_id}}': 16, 'regiondescription': 'test description' }],
		})
		.expect(200);
});

it('NoSQL Try to insert into insert restricted region table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '{{schema}}',
			'table': '{{regi_tb}}',
			'records': [{ '{{regi_id}}': 17, 'regiondescription': 'test description' }],
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions[0]).to.eql('insert')
		.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'northnwd'))
		.expect((r) => assert.ok(r.body.unauthorized_access[0].table == 'region'))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0));
});

it('NoSQL Try to insert FULLY restricted attribute in categories table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '{{schema}}',
			'table': '{{cate_tb}}',
			'records': [{ '{{cate_id}}': 9, 'categoryname': 'test name', 'description': 'test description' }],
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == 'Attribute \'categoryname\' does not exist on \'northnwd.categories\''))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0));
});

it('NoSQL Try to insert into territories table as SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '{{schema}}',
			'table': '{{terr_tb}}',
			'records': [{ '{{terr_id}}': 123456, 'territorydescription': 'test description' }],
		})
		.expect(200);
});

it('NoSQL Try to insert into territories table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'insert',
			'schema': '{{schema}}',
			'table': '{{terr_tb}}',
			'records': [{ '{{terr_id}}': 1234567, 'territorydescription': 'test description' }],
		})
		.expect(200);
});

it('NoSQL Try to update territories table as SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			'operation': 'update',
			'schema': '{{schema}}',
			'table': '{{terr_tb}}',
			'records': [{ '{{terr_id}}': 123456, 'territorydescription': 'test description updated' }],
		})
		.expect(200);
});

it('NoSQL Try to update restricted territories table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"schema": "{{schema}}",
			"table": "{{terr_tb}}",
			"records": [{ "{{terr_id}}": 1234567, "territorydescription": "test description updated" }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions[0]).to.eql('update')
		.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'northnwd'))
		.expect((r) => assert.ok(r.body.unauthorized_access[0].table == 'territories'))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('NoSQL Try to update categories table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"schema": "{{schema}}",
			"table": "{{cate_tb}}",
			"records": [{ "{{cate_id}}": 1, "description": "test description updated" }]
		})
		.expect(200)
});

it('NoSQL Try to update categories table with new attr as test_user - expect error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"schema": "{{schema}}",
			"table": "{{cate_tb}}",
			"records": [{ "{{cate_id}}": 1, "description": "test description updated", "active": true }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'active' does not exist on 'northnwd.categories'"))
});

it('NoSQL Try to update FULLY restricted attrs in categories table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"schema": "{{schema}}",
			"table": "{{cate_tb}}",
			"records": [{
				"{{cate_id}}": 1,
				"categoryname": "test name",
				"description": "test description updated",
				"picture": "test picture"
			}]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 2))
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'categoryname' does not exist on 'northnwd.categories'")).to.eql(true)
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'picture' does not exist on 'northnwd.categories'")).to.eql(true)

		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('NoSQL Try to delete from categories table as SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete", "table": "{{cate_tb}}", "schema": "{{schema}}", "hash_values": [1] })
		.expect(200)
});

it('NoSQL Try to delete from restricted categories table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete", "table": "{{cate_tb}}", "schema": "{{schema}}", "hash_values": [2] })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions[0]).to.eql('delete')
		.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'northnwd'))
		.expect((r) => assert.ok(r.body.unauthorized_access[0].table == 'categories'))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('NoSQL Try to read shippers table FULLY restricted attribute as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_value",
			"table": "{{ship_tb}}",
			"schema": "{{schema}}",
			"hash_attribute": "id",
			"search_attribute": "{{ship_id}}",
			"search_value": "*",
			"get_attributes": ["companyname"]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 2))
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'shipperid' does not exist on 'northnwd.shippers'")).to.eql(true)
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'companyname' does not exist on 'northnwd.shippers'")).to.eql(true)

		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('NoSQL Try to read ALL shippers table FULLY restricted attributes as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_value",
			"table": "{{ship_tb}}",
			"schema": "{{schema}}",
			"hash_attribute": "id",
			"search_attribute": "{{ship_id}}",
			"search_value": "*",
			"get_attributes": ["*"]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'shipperid' does not exist on 'northnwd.shippers'"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('NoSQL Try to update shippers table FULLY restricted attributes as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"schema": "{{schema}}",
			"table": "{{ship_tb}}",
			"records": [{ "{{ship_id}}": 1, "companyname": "bad update name" }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 2))
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'shipperid' does not exist on 'northnwd.shippers'")).to.eql(true)
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'companyname' does not exist on 'northnwd.shippers'")).to.eql(true)

		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('NoSQL Try to insert shippers table restricted attributes as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "{{schema}}",
			"table": "{{ship_tb}}",
			"records": [{ "{{ship_id}}": 1, "companyname": "bad update name", "phone": "(503) 555-9831" }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 3))
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'shipperid' does not exist on 'northnwd.shippers'")).to.eql(true)
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'companyname' does not exist on 'northnwd.shippers'")).to.eql(true)
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'phone' does not exist on 'northnwd.shippers'")).to.eql(true)

		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('NoSQL Try to insert to categories table with FULLY restricted attribute as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "{{schema}}",
			"table": "{{cate_tb}}",
			"records": [{ "{{cate_id}}": 4, "categoryname": "bad update name" }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'categoryname' does not exist on 'northnwd.categories'"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('NoSQL Try to insert categories table unrestricted attribute as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "{{schema}}",
			"table": "{{cate_tb}}",
			"records": [{ "{{cate_id}}": 1, "description": "Cheese and cheese and cheese" }]
		})
		.expect(200)
});

it('NoSQL Try to update categories table unrestricted attribute as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"schema": "{{schema}}",
			"table": "{{cate_tb}}",
			"records": [{ "{{cate_id}}": 2, "description": "Meats and cheeses" }]
		})
		.expect(200)
});

it('NoSQL Try to insert to categories table FULLY restricted attribute as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "{{schema}}",
			"table": "{{cate_tb}}",
			"records": [{ "{{cate_id}}": 1, "categoryname": "Stuff and things" }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'categoryname' does not exist on 'northnwd.categories'"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('NoSQL create_schema - non-SU expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_schema", "schema": "test-schema" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Operation 'createSchema' is restricted to 'super_user' roles"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('NoSQL create_schema - SU expect success', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_schema", "schema": "test-schema" })
		.expect(200)
});

it('NoSQL create_table - non-SU expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "schema": "test-schema", "table": "test-table", "hash_attribute": "id" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Operation 'createTable' is restricted to 'super_user' roles"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('NoSQL create_table - SU expect success', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "schema": "test-schema", "table": "test-table", "hash_attribute": "id" })
		.expect(200)
});

it('Insert record to evaluate dropAttribute', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "test-schema",
			"table": "test-table",
			"records": [{ "id": 1, "test_attribute": "Stuff and things" }]
		})
		.expect(200)
});

it('NoSQL drop_attribute - non-SU expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "drop_attribute",
			"schema": "test-schema",
			"table": "test-table",
			"attribute": "test_attribute"
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Operation 'dropAttribute' is restricted to 'super_user' roles"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('NoSQL drop_attribute - SU expect success', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "drop_attribute",
			"schema": "test-schema",
			"table": "test-table",
			"attribute": "test_attribute"
		})
		.expect(200)
});

it('NoSQL drop_table - non-SU expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_table", "schema": "test-schema", "table": "test-table" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Operation 'dropTable' is restricted to 'super_user' roles"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('NoSQL drop_table - SU expect success', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_table", "schema": "test-schema", "table": "test-table" })
		.expect(200)
});

it('NoSQL drop_schema - non-SU expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "test-schema" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Operation 'dropSchema' is restricted to 'super_user' roles"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('NoSQL drop_schema - SU expect success', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "test-schema" })
		.expect(200)
});

it('NoSQL Try to update timestamp value on dog table as test_user - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "dev",
			"table": "dog",
			"records": [{ "id": 1, "__createdtime__": "Stuff and things" }, {
				"id": 2,
				"__updatedtime__": "Stuff and other things"
			}]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "Internal timestamp attributes - '__createdtime_' and '__updatedtime__' - cannot be inserted to or updated by HDB users."))
});

it('NoSQL Try to update attr w/ timestamp value in update row as SU  - expect success', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"schema": "dev",
			"table": "dog",
			"records": [{ "id": 1, "adorable": false, "__createdtime__": "Stuff and things" }, {
				"id": 2,
				"adorable": false,
				"__updatedtime__": "Stuff and other things"
			}]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "updated 2 of 2 records"))

// Unmatched Postman assertion: pm.expect(jsonData.update_hashes.length).to.eql(2))
});

it('NoSQL Try to update timestamp value on dog table as SU - expect', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"schema": "dev",
			"table": "dog",
			"records": [{ "id": 1, "__createdtime__": "Stuff and things" }, {
				"id": 2,
				"__updatedtime__": "Stuff and other things"
			}]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "updated 2 of 2 records"))

// Unmatched Postman assertion: pm.expect(jsonData.update_hashes.length).to.eql(2))
});

it('NoSQL - Upsert - table perms true/no attribute perms set - expect success', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "upsert",
			"schema": "{{schema}}",
			"table": "{{cust_tb}}",
			"records": [{
				"{{cust_id}}": "FURIB",
				"region": "Durkastan",
				"contactmame": "Hans Blix"
			}, { "region": "Durkastan", "contactmame": "Hans Blix" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.upserted_hashes.length == 2))
		.expect((r) => assert.ok(r.body.upserted_hashes.includes("FURIB")))
		.expect((r) => assert.ok(r.body.skipped_hashes == 'undefined'))
		.expect((r) => assert.ok(r.body.message == "upserted 2 of 2 records"))
});

it('NoSQL - Upsert - table perms true/attr perms true - expect success', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "upsert",
			"schema": "{{schema}}",
			"table": "{{cate_tb}}",
			"records": [{ "{{cate_id}}": 8, "description": "Seaweed and fishies" }, { "description": "Junk food" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.upserted_hashes.length == 2))
		// Unmatched Postman assertion: pm.expect(jsonData.upserted_hashes.includes(8)).to.be.true;
		.expect((r) => assert.ok(r.body.skipped_hashes == 'undefined'))
		.expect((r) => assert.ok(r.body.message == "upserted 2 of 2 records"))
});

it('NoSQL - Upsert - table perms true/no attr perms and new attribute included - expect success', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "upsert",
			"schema": "{{schema}}",
			"table": "{{cust_tb}}",
			"records": [{
				"{{cust_id}}": "FURIB",
				"region": "Durkastan",
				"contactmame": "Hans Blix",
				"active": false
			}, { "region": "Durkastan", "contactmame": "Sam Johnson", "active": true }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.upserted_hashes.length == 2))
		.expect((r) => assert.ok(r.body.upserted_hashes.includes("FURIB")))
		.expect((r) => assert.ok(r.body.skipped_hashes == 'undefined'))
		.expect((r) => assert.ok(r.body.message == "upserted 2 of 2 records"))
});

it('NoSQL - Upsert - table perms true/false  - expect error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "upsert",
			"schema": "{{schema}}",
			"table": "{{terr_tb}}",
			"records": [{ "regionid": 1, "territorydescription": "Westboro", "territoryid": 1581 }, {
				"regionid": 55,
				"territorydescription": "Denver Metro"
			}]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'northnwd'))
		.expect((r) => assert.ok(r.body.unauthorized_access[0].table == "territories"))
// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions.length).to.eql(1)
// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions[0]).to.eql("update")
// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_attribute_permissions.length).to.eql(0))
});

it('NoSQL - Upsert - table perms true/attr perms true but new attribute included - expect error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "upsert",
			"schema": "{{schema}}",
			"table": "{{cate_tb}}",
			"records": [{
				"{{cate_id}}": 8,
				"description": "Seaweed and fishies",
				"active": true
			}, { "description": "Junk food", "active": false }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'active' does not exist on 'northnwd.categories'"))
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
});

it('NoSQL - Upsert - table perms true/some attr perms false - expect error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "upsert",
			"schema": "dev",
			"table": "dog",
			"records": [{ "adorable": true, "dog_name": "Penny", "owner_id": 2, "age": 5, "id": 10 }, {
				"adorable": true,
				"dog_name": "Penny",
				"owner_id": 2,
				"age": 5,
				"id": 2
			}, { "adorable": true, "dog_name": "Penny", "owner_id": 2, "age": 5, "id": 10, "birthday": "10/11/19" }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		// Unmatched Postman assertion: const expected_attr_perm_errs = {
		// Unmatched Postman assertion: dog_name: "insert",
		// Unmatched Postman assertion: age: "update"
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == "dev"))
		.expect((r) => assert.ok(r.body.unauthorized_access[0].table == "dog"))
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions.length).to.eql(0)
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_attribute_permissions.length).to.eql(2)
		// Unmatched Postman assertion: jsonData.unauthorized_access[0].required_attribute_permissions.forEach(attr_perm_err => {
		// Unmatched Postman assertion: pm.expect(attr_perm_err.required_permissions[0]).to.eql(expected_attr_perm_errs[attr_perm_err.attribute_name])
		// Unmatched Postman assertion: })
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'birthday' does not exist on 'dev.dog'"))
});

it('NoSQL - Upsert - w/ null value as hash- expect error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "upsert",
			"schema": "{{schema}}",
			"table": "{{cust_tb}}",
			"records": [{
				"{{cust_id}}": "null",
				"region": "Durkastan",
				"contactmame": "Hans Blix",
				"active": false
			}, { "region": "Durkastan", "contactmame": "Sam Johnson", "active": true }]
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == "Invalid hash value: 'null' is not a valid hash attribute value, check log for more info"))
});

it('NoSQL - Upsert - w/ invalid attr name - expect error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "upsert",
			"schema": "{{schema}}",
			"table": "{{cust_tb}}",
			"records": [{
				"{{cust_id}}": "FURIB",
				"region": "Durkastan",
				"contactmame": "Hans Blix",
				"active/not active": false
			}, { "region": "Durkastan", "contactmame": "Sam Johnson", "active/not active": false }]
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == "Attribute names cannot include backticks or forward slashes"))
});

it('search by conditions - equals - allowed attr', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_conditions",
			"schema": "dev",
			"table": "dog_conditions",
			"get_attributes": ["*"],
			"conditions": [{ "search_attribute": "age", "search_type": "equals", "search_value": 5 }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 2))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok([1, 2].includes(row.id)))
		.expect((r) => assert.ok(row.location == undefined))
		.expect((r) => assert.ok(row.breed_id == undefined))
})
})
;

it('search by conditions - ends_with - allowed attr', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_conditions",
			"schema": "dev",
			"table": "dog_conditions",
			"get_attributes": ["*"],
			"conditions": [{ "search_attribute": "dog_name", "search_type": "ends_with", "search_value": "y" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 4))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok([...row.dog_name].pop() == "y"))
		.expect((r) => assert.ok(row.location == undefined))
		.expect((r) => assert.ok(row.breed_id == undefined))
});

it('search by conditions - equals - restricted attr', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_conditions",
			"schema": "dev",
			"table": "dog_conditions",
			"get_attributes": ["*"],
			"conditions": [{ "search_attribute": "location", "search_type": "equals", "search_value": "Denver, CO" }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'location' does not exist on 'dev.dog_conditions'"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('search by conditions - contains - restricted attr', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_conditions",
			"schema": "dev",
			"table": "dog_conditions",
			"get_attributes": ["*"],
			"conditions": [{ "search_attribute": "location", "search_type": "contains", "search_value": "Denver" }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'location' does not exist on 'dev.dog_conditions'"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('search by conditions - starts_with - non-existent attr', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_conditions",
			"schema": "dev",
			"table": "dog_conditions",
			"get_attributes": ["*"],
			"conditions": [{ "search_attribute": "random_attr", "search_type": "starts_with", "search_value": 1 }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'random_attr' does not exist on 'dev.dog_conditions'"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('search by conditions - starts_with - unauth'
d
attr
', async () => {
const response = await request(envUrl)
	.post('')
	.set(headers)
	.send({
		"operation": "search_by_conditions",
		"schema": "dev",
		"table": "dog_conditions",
		"get_attributes": ["*"],
		"conditions": [{ "search_attribute": "breed_id", "search_type": "starts_with", "search_value": 1 }]
	})
	.expect(403)
	.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
	.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
	.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
	.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == "dev"))
	.expect((r) => assert.ok(r.body.unauthorized_access[0].table == "dog_conditions"))
// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_attribute_permissions.length).to.eql(1)
// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_attribute_permissions[0].attribute_name).to.eql("breed_id")
// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_attribute_permissions[0].required_permissions[0]).to.eql("read"))
})
;

it('search by conditions - starts_with - unauth'
d
attrs in get / search
', async () => {
const response = await request(envUrl)
	.post('')
	.set(headers)
	.send({
		"operation": "search_by_conditions",
		"schema": "dev",
		"table": "dog_conditions",
		"get_attributes": ["id", "dog_name", "location"],
		"conditions": [{ "search_attribute": "breed_id", "search_type": "starts_with", "search_value": 1 }]
	})
	.expect(403)
	.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
	.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
	.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'location' does not exist on 'dev.dog_conditions'"))
	.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
	.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == "dev"))
	.expect((r) => assert.ok(r.body.unauthorized_access[0].table == "dog_conditions"))
// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_attribute_permissions.length).to.eql(1)
// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_attribute_permissions[0].attribute_name).to.eql("breed_id")
// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_attribute_permissions[0].required_permissions[0]).to.eql("read"))
})
;

it('search by conditions - equals & contains - restricted attr', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_conditions",
			"schema": "dev",
			"table": "dog_conditions",
			"get_attributes": ["*"],
			"conditions": [{
				"search_attribute": "group",
				"search_type": "equals",
				"search_value": "A"
			}, { "search_attribute": "location", "search_type": "contains", "search_value": "CO" }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'location' does not exist on 'dev.dog_conditions'"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('search by conditions - starts_with & between w/ sort', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_conditions",
			"schema": "dev",
			"table": "dog_conditions",
			"get_attributes": ["*"],
			"sort_attributes": [{ "attribute": "age", "desc": false }, { "attribute": "location", "desc": true }],
			"conditions": [{
				"search_attribute": "group",
				"search_type": "between",
				"search_value": ["A", "C"]
			}, { "search_attribute": "location", "search_type": "starts_with", "search_value": "Denver" }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'location' does not exist on 'dev.dog_conditions'"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('search by conditions - 4 conditions - restricted attrs', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_conditions",
			"schema": "dev",
			"table": "dog_conditions",
			"get_attributes": ["*"],
			"conditions": [{
				"search_attribute": "group_id",
				"search_type": "between",
				"search_value": [0, 100]
			}, {
				"search_attribute": "dog_name",
				"search_type": "ends_with",
				"search_value": "y"
			}, {
				"search_attribute": "location",
				"search_type": "contains",
				"search_value": "enve"
			}, { "search_attribute": "age", "search_type": "greater_than", "search_value": 1 }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 2))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'group_id' does not exist on 'dev.dog_conditions'"))
		.expect((r) => assert.ok(r.body.invalid_schema_items[1] == "Attribute 'location' does not exist on 'dev.dog_conditions'"))

		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('search by conditions - 4 conditions - restricted/unauth'
d
attrs
', async () => {
const response = await request(envUrl)
	.post('')
	.set(headers)
	.send({
		"operation": "search_by_conditions",
		"schema": "dev",
		"table": "dog_conditions",
		"get_attributes": ["*"],
		"conditions": [{
			"search_attribute": "group_id",
			"search_type": "between",
			"search_value": [0, 100]
		}, { "search_attribute": "breed_id", "search_type": "equals", "search_value": 5 }, {
			"search_attribute": "age",
			"search_type": "less_than",
			"search_value": 100
		}, { "search_attribute": "location", "search_type": "contains", "search_value": "enver," }]
	})
	.expect(403)
	.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
	.expect((r) => assert.ok(r.body.invalid_schema_items.length == 2))
	.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'group_id' does not exist on 'dev.dog_conditions'"))
	.expect((r) => assert.ok(r.body.invalid_schema_items[1] == "Attribute 'location' does not exist on 'dev.dog_conditions'"))

	.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
	.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == "dev"))
	.expect((r) => assert.ok(r.body.unauthorized_access[0].table == "dog_conditions"))
// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_attribute_permissions.length).to.eql(1)
// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_attribute_permissions[0].attribute_name).to.eql("breed_id")
// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_attribute_permissions[0].required_permissions[0]).to.eql("read"))
})
;

it('NoSQL Alter non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "alter_role", "id": "{{role_id}}", "role": "developer_test_5", "permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"customers": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": []
						},
						"suppliers": {
							"read": false,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": []
						},
						"region": {
							"read": true,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "regiondescription",
								"read": true,
								"insert": false,
								"update": false,
								"delete": false
							}]
						},
						"territories": {
							"read": true,
							"insert": true,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "territorydescription",
								"read": true,
								"insert": true,
								"update": false,
								"delete": false
							}]
						},
						"categories": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": true,
								"insert": true,
								"update": true,
								"delete": false
							}]
						},
						"shippers": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "companyname",
								"read": false,
								"insert": false,
								"update": false,
								"delete": false
							}]
						}
					}
				},
				"dev": {
					"tables": {
						"dog": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "__createdtime__",
								"read": true,
								"insert": true,
								"update": true
							}, { "attribute_name": "__updatedtime__", "read": true, "insert": true, "update": true }]
						},
						"breed": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "__createdtime__",
								"read": false,
								"insert": false,
								"update": true
							}, { "attribute_name": "__updatedtime__", "read": false, "insert": true, "update": true }]
						}
					}
				}
			}
		})
		.expect(200)

	Unmatched
	Postman
	assertion: // responseData = JSON.parse(responseBody)
// Unmatched Postman assertion: // postman.setEnvironmentVariable("role_id", responseData.id)})
});

it('NoSQL drop test user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_user", "username": "test_user" })
		.expect(200)
});

it('NoSQL drop_role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_role", "id": "{{role_id}}" })
		.expect(200)
});

it('NoSQL Add cluster_user Role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "add_role", "role": "test_cluster_user_role", "permission": { "cluster_user": true } })
		.expect(200)
		.expect((r) => assert.ok(r.body.id));
// Unmatched Postman assertion: postman.setEnvironmentVariable("cluster_user_role_id", r.body.id))
});

it('NoSQL Add cluster_user with another permission, expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "cluster_user_bad",
			"permission": { "cluster_user": true, "super_user": true }
		})
		.expect(400
			.expect((r) => assert.ok(r.body.error == "Errors in the role permissions JSON provided"))
			.expect((r) => assert.ok(responseData.main_permissions.length == 1))
			.expect((r) => assert.ok(r.body.main_permissions[0] == "Roles cannot have both 'super_user' and 'cluster_user' values included in their permissions set."))
// Unmatched Postman assertion: pm.expect(Object.keys(responseData.schema_permissions).length).to.equal(0)

});

it('NoSQL Add User with cluster_user Role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_user",
			"role": "test_cluster_user_role",
			"username": "test_cluster_user",
			"password": "{{password}}",
			"active": true
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message))

// Unmatched Postman assertion: pm.expect(jsonData.message).to.contain('successfully added'))
});

it('NoSQL alter cluster user, change password', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "alter_user", "username": "test_cluster_user", "password": "{{password}}111" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message))

// Unmatched Postman assertion: pm.expect(jsonData.message).to.contain('updated 1 of 1 records'))
});

it('NoSQL drop test_cluster_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_user", "username": "test_cluster_user" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message))

// Unmatched Postman assertion: pm.expect(jsonData.message).to.contain('successfully deleted'))
});

it('NoSQL drop cluster_user role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_role", "id": "{{cluster_user_role_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message))

// Unmatched Postman assertion: pm.expect(jsonData.message).to.contain('successfully deleted'))
});

it('SQL Add non SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role", "role": "developer_test_5", "permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"customers": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": []
						},
						"suppliers": {
							"read": false,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": []
						},
						"region": {
							"read": true,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "regiondescription",
								"read": true,
								"insert": false,
								"update": false
							}]
						},
						"territories": {
							"read": true,
							"insert": true,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "territorydescription",
								"read": true,
								"insert": true,
								"update": false
							}]
						},
						"categories": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": true,
								"insert": true,
								"update": true
							}]
						},
						"shippers": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "companyname",
								"read": false,
								"insert": false,
								"update": false
							}]
						}
					}
				},
				"dev": {
					"tables": {
						"dog": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": []
						}
					}
				},
				"other": {
					"tables": {
						"owner": {
							"read": true,
							"insert": false,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "name",
								"read": false,
								"insert": false,
								"update": false
							}]
						}
					}
				},
				"another": {
					"tables": {
						"breed": {
							"read": false,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "image",
								"read": false,
								"insert": false,
								"update": false
							}]
						}
					}
				}
			}
		})
		.expect(200)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)
// Unmatched Postman assertion: postman.setEnvironmentVariable("role_id", responseData.id)})
});

it('SQL Add User with new Role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_user",
			"role": "developer_test_5",
			"username": "test_user",
			"password": "{{password}}",
			"active": true
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "test_user successfully added"))
});

it('Add user that already exists', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_user",
			"role": "developer_test_5",
			"username": "test_user",
			"password": "{{password}}",
			"active": true
		})
		.expect(409)

		.expect((r) => assert.ok(r.body.error == "User test_user already exists"))
});

it('Add user bad role name', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_user",
			"role": "developer_test 5",
			"username": "test_user1",
			"password": "{{password}}",
			"active": true
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == "Role is invalid"))
});

it('get user info', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "list_users" })
		.expect(200)
// Unmatched Postman assertion: responseData = JSON.parse(responseBody)
// Unmatched Postman assertion: for(let user of responseData) {
// Unmatched Postman assertion: if(user.username === 'test_user') {
// Unmatched Postman assertion: postman.setEnvironmentVariable("user_role_id", user.role.id)
// Unmatched Postman assertion: }
// Unmatched Postman assertion: }})
});

it('try to set bad role to user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "alter_user", "role": "blahblah", "username": "test_user" })
		.expect(404)
		.expect((r) => assert.ok(r.body.error == "Update failed.  Requested 'blahblah' role not found."))
});

it('get user info make sure role was not changed', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "list_users" })
		.expect(200)
// Unmatched Postman assertion: responseData = JSON.parse(responseBody)

// Unmatched Postman assertion: for(let user of responseData) {
// Unmatched Postman assertion: if(user.username === 'test_user') {
// Unmatched Postman assertion: pm.expect(postman.getEnvironmentVariable("user_role_id")).to.eql(user.role.id)
// Unmatched Postman assertion: }
// Unmatched Postman assertion: }})
});

it('SQL Try to read suppliers table as SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "select * from {{schema}}.{{supp_tb}}" })
		.expect(200)
});

it('SQL Try to read FULLY restricted suppliers table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "select * from {{schema}}.{{supp_tb}}" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Table 'northnwd.suppliers' does not exist"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('SQL Try to read region table as SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "select * from {{schema}}.{{regi_tb}}" })
		.expect(200)
});

it('SQL Try to read region table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "select * from {{schema}}.{{regi_tb}}" })
		.expect(200)

	Unmatched
	Postman
	assertion: var permitted_attrs = ["regiondescription", "regionid"];// Unmatched Postman assertion: jsonData.forEach(obj => {
// Unmatched Postman assertion: Object.keys(obj).forEach(attr_name => {
// Unmatched Postman assertion: pm.expect(permitted_attrs.includes(attr_name))
// Unmatched Postman assertion: })
// Unmatched Postman assertion: })
});

it('SQL Try to insert into region table as SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "insert into northnwd.region (regionid, regiondescription) values ('16', 'test description')"
		})
		.expect(200)
});

it('SQL Try to insert into restricted region table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "insert into northnwd.region (regionid, regiondescription) values ('17', 'test description')"
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions[0]).to.eql('insert')
		.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'northnwd'))
		.expect((r) => assert.ok(r.body.unauthorized_access[0].table == "region"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('SQL Try to insert into territories table as SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "insert into northnwd.territories (regionid, territoryid, territorydescription) values ('1', '65', 'Im a test')"
		})
		.expect(200)
});

it('SQL Try to insert into territories table with restricted attribute as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "insert into northnwd.territories (regionid, territoryid, territorydescription) values ('1', '65', 'Im a test')"
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'regionid' does not exist on 'northnwd.territories'"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('SQL Try to insert into territories table with allowed attributes as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "insert into northnwd.territories (territoryid, territorydescription) values (165, 'Im a test')"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "inserted 1 of 1 records"))
// Unmatched Postman assertion: pm.expect(jsonData.inserted_hashes[0]).to.eql(165))
});

it('SQL Try to update territories table as SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "update northnwd.territories set territorydescription = 'update test' where territoryid = 65"
		})
		.expect(200)
});

it('SQL Try to update restricted territories table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "update northnwd.territories set territorydescription = 'update test' where territoryid = 65"
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions[0]).to.eql('update')
		.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'northnwd'))
		.expect((r) => assert.ok(r.body.unauthorized_access[0].table == 'territories'))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('SQL Try to update categories table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "update northnwd.categories set description = 'update test' where categoryid = 2"
		})
		.expect(200)
});

it('SQL Try to update restricted attr in categories table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "update northnwd.categories set description = 'update test', picture = 'test picture' where categoryid = 2"
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'picture' does not exist on 'northnwd.categories'"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('SQL Try to delete from categories table as SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "delete from northnwd.categories where categoryid = 2" })
		.expect(200)
});

it('SQL Try to delete from restricted categories table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "delete from northnwd.categories where categoryid = 2" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions[0]).to.eql('delete')
		.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'northnwd'))
		.expect((r) => assert.ok(r.body.unauthorized_access[0].table == 'categories'))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('SQL Try to read shippers table w/ FULLY restricted attributes as test_user - expect empty array', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "select * from {{schema}}.{{ship_tb}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 0))
});

it('SQL Try to update shippers table restricted attribute as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "update northnwd.{{ship_tb}} set companyname = 'bad update name' where {{ship_id}} = 1"
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Attribute 'companyname' does not exist on 'northnwd.shippers'"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('SQL Try to insert into shippers table w/ FULLY restricted attributes as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "insert into northnwd.shippers (shipperid, companyname, phone) values ('1', 'bad update name', '(503) 555-9831')"
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 3))
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'shipperid' does not exist on 'northnwd.shippers'")).to.eql(true)
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'companyname' does not exist on 'northnwd.shippers'")).to.eql(true)
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'phone' does not exist on 'northnwd.shippers'")).to.eql(true)

		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('SQL Try to insert categories table unrestricted attributes as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "insert into northnwd.categories (categoryid, description) values ('9', 'Other food stuff')"
		})
		.expect(200)
});

it('SQL Try to read shippers table as test_user with restricted attribute in WHERE', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "select shipperid from {{schema}}.{{ship_tb}} WHERE (phone IS NOT NULL AND shipperid = 0) OR companyname IS NOT NULL"
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 3))
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'shipperid' does not exist on 'northnwd.shippers'")).to.eql(true)
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'phone' does not exist on 'northnwd.shippers'")).to.eql(true)
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'companyname' does not exist on 'northnwd.shippers'")).to.eql(true)

		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('Select with restricted CROSS SCHEMA JOIN as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id"
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 2))
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'")).to.eql(true)
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'")).to.eql(true)

		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('Select * with restricted CROSS SCHEMA JOIN as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "SELECT d.*, o.* FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id ORDER BY o.name, o.id LIMIT 5 OFFSET 1"
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 2))
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'")).to.eql(true)
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'")).to.eql(true)

		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('Select restricted attrs in CROSS 3 SCHEMA JOINS as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name, b.id, b.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id"
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions[0]).to.eql('read')
		.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == "another"))
		.expect((r) => assert.ok(r.body.unauthorized_access[0].table == "breed"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 2))
// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'")).to.eql(true)
// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'")).to.eql(true))
});

it('Select with complex CROSS 3 SCHEMA JOINS as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "SELECT d.age AS dog_age, AVG(d.weight_lbs) AS dog_weight, o.name AS owner_name, b.name, b.image FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id GROUP BY o.name, b.name, d.age ORDER BY b.name"
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions[0]).to.eql('read')
		.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == "another"))
		.expect((r) => assert.ok(r.body.unauthorized_access[0].table == "breed"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 2))
// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'")).to.eql(true)
// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'")).to.eql(true))
});

it('Select * w/ two table CROSS SCHEMA JOIN on table with FULLY restricted attributes as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "SELECT d.*, o.* FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id ORDER BY o.name, o.id LIMIT 5 OFFSET 1"
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 2))
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'")).to.eql(true)
		// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'")).to.eql(true)

		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('SQL ALTER non SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "alter_role", "role": "developer_test_5", "id": "{{role_id}}", "permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"customers": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": []
						},
						"suppliers": {
							"read": false,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": []
						},
						"region": {
							"read": true,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "regiondescription",
								"read": true,
								"insert": false,
								"update": false
							}]
						},
						"territories": {
							"read": true,
							"insert": true,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "territorydescription",
								"read": true,
								"insert": true,
								"update": false
							}]
						},
						"categories": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": true,
								"insert": true,
								"update": true
							}]
						},
						"shippers": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "companyname",
								"read": false,
								"insert": false,
								"update": false
							}]
						}
					}
				},
				"dev": {
					"tables": {
						"dog": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": []
						}
					}
				},
				"other": {
					"tables": {
						"owner": {
							"read": true,
							"insert": false,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "name",
								"read": true,
								"insert": false,
								"update": false
							}]
						}
					}
				},
				"another": {
					"tables": {
						"breed": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "name",
								"read": true,
								"insert": false,
								"update": false
							}]
						}
					}
				}
			}
		})
		.expect(200)
});

it('Select two table CROSS SCHEMA JOIN as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 9))
		//Unmatched Postman assertion: var expected_attributes = ["id", "dog_name", "age", "adorable", "id1", "name"]
		// Unmatched Postman assertion: //Important to test that only the id (returned as id1) and name attributes come back for 'other.owner' since user only has access to those two attributes

		// Unmatched Postman assertion: jsonData.forEach(row => {
		// Unmatched Postman assertion: expected_attributes.forEach(attr => {
		// Unmatched Postman assertion: pm.expect(row[attr]).to.exist;
		// Unmatched Postman assertion: })
		// Unmatched Postman assertion: })
		.expect((r) => assert.ok(r.body[1].name == "Kyle"))
// Unmatched Postman assertion: pm.expect(jsonData[3].id1).to.eql(1)
// Unmatched Postman assertion: pm.expect(jsonData[4].id1).to.eql(2))
});

it('Select * w/ two table CROSS SCHEMA JOIN as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "SELECT d.*, o.* FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id ORDER BY o.name, o.id LIMIT 5 OFFSET 1"
		})
		.expect(200)
		// Unmatched Postman assertion: var expected_names = ["David", "Kaylan", "Kyle", "Kyle", "Kyle"];
		// Unmatched Postman assertion: var expected_attrs = ["__createdtime__", "age", "dog_name", "adorable", "owner_id", "__updatedtime__", "id", "weight_lbs", "breed_id", "name", "id1"]

		.expect((r) => assert.ok(r.body.length == 5))
// Unmatched Postman assertion: jsonData.forEach((obj, i) => {
// Unmatched Postman assertion: pm.expect(obj.name).to.eql(expected_names[i])
// Unmatched Postman assertion: Object.keys(k => {
// Unmatched Postman assertion: pm.expect(expected_attrs.includes(k)).to.eql(true)

});

it('Select w/ CROSS 3 SCHEMA JOINS as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name, b.id, b.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id"
		})
		.expect((r) => assert.ok(r.body.length == 9))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok(row.id))
		.expect((r) => assert.ok(row.id1))
		.expect((r) => assert.ok(row.id2))
		.expect((r) => assert.ok(row.dog_name))
		.expect((r) => assert.ok(row.age))
		.expect((r) => assert.ok(row.name))
		.expect((r) => assert.ok(row.name1))
		// Unmatched Postman assertion: })

		.expect((r) => assert.ok(r.body[1].name == "Kyle"))
		// Unmatched Postman assertion: pm.expect(jsonData[1].id1).to.eql(2)
		.expect((r) => assert.ok(r.body[4].id1 == 2))
// Unmatched Postman assertion: pm.expect(jsonData[6].id1).to.eql(4)
// Unmatched Postman assertion: pm.expect(jsonData[6].name1).to.eql("BEAGLE MIX"))
});

it('Select with complex CROSS 3 SCHEMA JOINS as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "SELECT d.age AS dog_age, AVG(d.weight_lbs) AS dog_weight, o.name AS owner_name, b.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id GROUP BY o.name, b.name, d.age ORDER BY b.name"
		})
		.expect((r) => assert.ok(r.body.length == 9))
		// Unmatched Postman assertion: jsonData.forEach(row => {
		.expect((r) => assert.ok(row.dog_age))
		.expect((r) => assert.ok(row.dog_weight))
		.expect((r) => assert.ok(row.owner_name))
		.expect((r) => assert.ok(row.name))
		// Unmatched Postman assertion: })

		// Unmatched Postman assertion: pm.expect(jsonData[0].dog_age).to.eql(3)
		.expect((r) => assert.ok(r.body[0].dog_weight == 35))
		.expect((r) => assert.ok(r.body[0].owner_name == "Kaylan"))
		.expect((r) => assert.ok(r.body[0].name == "BEAGLE MIX"))
		// Unmatched Postman assertion: pm.expect(jsonData[6].dog_age).to.eql(8)
		// Unmatched Postman assertion: pm.expect(jsonData[6].dog_weight).to.eql(15)
		.expect((r) => assert.ok(r.body[6].owner_name == "Kyle"))
// Unmatched Postman assertion: pm.expect(jsonData[6].name).to.eql("TERRIER MIX"))
});

it('SQL ALTER non SU role with multi table join restrictions', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "alter_role",
			"role": "developer_test_5",
			"id": "{{role_id}}",
			"permission": {
				"super_user": false,
				"dev": {
					"tables": {
						"dog": {
							"read": false,
							"insert": true,
							"update": true,
							"delete": false,
							"attribute_permissions": []
						}
					}
				},
				"other": {
					"tables": {
						"owner": {
							"read": true,
							"insert": false,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "name",
								"read": false,
								"insert": false,
								"update": false
							}]
						}
					}
				},
				"another": {
					"tables": {
						"breed": {
							"read": true,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "name",
								"read": true,
								"insert": false,
								"update": false
							}]
						}
					}
				}
			}
		})
		.expect(200)
});

it('Select with ALL RESTRICTED complex CROSS 3 SCHEMA JOINS as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "SELECT d.age AS dog_age, AVG(d.weight_lbs) AS dog_weight, o.name AS owner_name, b.name, b.country FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id GROUP BY o.name, b.name, d.age ORDER BY b.name"
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions[0]).to.eql('read')
		.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'dev'))
		.expect((r) => assert.ok(r.body.unauthorized_access[0].table == 'dog'))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 3))
// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'")).to.eql(true)
// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'")).to.eql(true)
// Unmatched Postman assertion: pm.expect(jsonData.invalid_schema_items.includes("Attribute 'country' does not exist on 'another.breed'")).to.eql(true))
});

it('SQL drop test user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_user", "username": "test_user" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "test_user successfully deleted"))
});

it('Drop non-existent user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_user", "username": "test_user" })
		.expect(404)
		.expect((r) => assert.ok(r.body.error == 'User test_user does not exist'))
});

it('SQL drop_role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_role", "id": "{{role_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'developer_test_5 successfully deleted'))
});

it('Drop non-existent role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_role", "id": "{{role_id}}" })
		.expect(404)
		.expect((r) => assert.ok(r.body.error == 'Role not found'))
});

it('Create schema for S3 test', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_schema", "schema": "S3_DATA" })
		.expect(200)
});

it('Create dogs table for S3 test', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "schema": "S3_DATA", "table": "dogs", "hash_attribute": "id" })
		.expect(200)
});

it('Create breed table for S3 test', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "schema": "S3_DATA", "table": "breed", "hash_attribute": "id" })
		.expect(200)
});

it('Create owners table for S3 test', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "schema": "S3_DATA", "table": "owners", "hash_attribute": "id" })
		.expect(200)
});

it('Create sensor table for S3 test', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "schema": "S3_DATA", "table": "sensor", "hash_attribute": "id" })
		.expect(200)
});

it('Import dogs.xlsx from S3 - expect error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "import_from_s3",
			"action": "insert",
			"schema": "S3_DATA",
			"table": "dogs",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/dogs.xlsx",
				"region": "us-east-2"
			}
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == "S3 key must include one of the following valid file extensions - '.csv', '.json'"))
});

it('Import dogs.csv from S3', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "import_from_s3",
			"action": "insert",
			"schema": "S3_DATA",
			"table": "dogs",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/dogs.csv",
				"region": "us-east-2"
			}
		})
		.expect(200)

		// Unmatched Postman assertion: if (jsonData.message) {
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
		// Unmatched Postman assertion: eval(pm.globals.get("function:getJobId"))(jsonData, "Import owners.json from S3")
		// Unmatched Postman assertion: } else {
		// Unmatched Postman assertion: postman.setNextRequest("Import owners.json from S3")
		.expect((r) => assert.ok(r.body.hasOwnProperty('message')))
// Unmatched Postman assertion: }})
});

it('Check S3 dog data loaded', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: console.log("Error checking S3 import job.")
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status != 'ERROR'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].message == "successfully loaded 12 of 12 records"))
		.expect((r) => assert.ok(r.body[0].status == 'COMPLETE' || r.body[0].status == ERROR))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 dog data loaded')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 dog data loaded')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Import owners.json from S3', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "import_from_s3",
			"action": "insert",
			"schema": "S3_DATA",
			"table": "owners",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/owners.json",
				"region": "us-east-2"
			}
		})
		.expect(200)

		// Unmatched Postman assertion: if (jsonData.message) {
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
		// Unmatched Postman assertion: eval(pm.globals.get("function:getJobId"))(jsonData, "Import breed.json from S3")
		// Unmatched Postman assertion: } else {
		// Unmatched Postman assertion: postman.setNextRequest("Import breed.json from S3")
		.expect((r) => assert.ok(r.body.hasOwnProperty('message')))
// Unmatched Postman assertion: }})
});

it('Check S3 owners data loaded', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: console.log("Error checking S3 import job.")
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status != 'ERROR'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].message == "successfully loaded 4 of 4 records"))
		.expect((r) => assert.ok(r.body[0].status == 'COMPLETE' || r.body[0].status == ERROR))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 owners data loaded')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 owners data loaded')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Import breed.json from S3', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "import_from_s3",
			"action": "insert",
			"schema": "S3_DATA",
			"table": "breed",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/breed.json",
				"region": "us-east-2"
			}
		})
		.expect(200)

		// Unmatched Postman assertion: if (jsonData.message) {
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
		// Unmatched Postman assertion: eval(pm.globals.get("function:getJobId"))(jsonData, "Import does_not_exist.csv from S3 - expect fail")
		// Unmatched Postman assertion: } else {
		// Unmatched Postman assertion: postman.setNextRequest("Import does_not_exist.csv from S3 - expect fail")
		.expect((r) => assert.ok(r.body.hasOwnProperty('message')))
// Unmatched Postman assertion: }})
});

it('Check S3 breed data loaded', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: console.log("Error checking S3 import job.")
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status != 'ERROR'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].message == "successfully loaded 350 of 350 records"))
		.expect((r) => assert.ok(r.body[0].status == 'COMPLETE' || r.body[0].status == ERROR))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 breed data loaded')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 breed data loaded')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Import does_not_exist.csv from S3 - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "import_from_s3",
			"action": "insert",
			"schema": "S3_DATA",
			"table": "owners",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/does_not_exist.csv",
				"region": "us-east-2"
			}
		})
		.expect(200)

		// Unmatched Postman assertion: if (jsonData.message) {
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
		// Unmatched Postman assertion: eval(pm.globals.get("function:getJobId"))(jsonData, "Import dogs_update.csv from S3")
		// Unmatched Postman assertion: } else {
		// Unmatched Postman assertion: postman.setNextRequest("Import dogs_update.csv from S3")
		.expect((r) => assert.ok(r.body.hasOwnProperty('message')))
// Unmatched Postman assertion: }})
});

it('Check for error from S3 does_not_exist.csv import', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: console.log("Error correctly found in response checking invalid S3 import job.")
		.expect((r) => assert.ok(r.body[0].message == "The specified key does not exist."))
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status == 'ERROR'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(status == ["ERROR"]))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check for error from S3 does_not_exist.csv import')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check for error from S3 does_not_exist.csv import')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Import dogs_update.csv from S3', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "import_from_s3",
			"action": "update",
			"schema": "S3_DATA",
			"table": "dogs",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/dogs_update.csv",
				"region": "us-east-2"
			}
		})
		.expect(200)

		// Unmatched Postman assertion: if (jsonData.message) {
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
		// Unmatched Postman assertion: eval(pm.globals.get("function:getJobId"))(jsonData, "Import owners_update.json from S3")
		// Unmatched Postman assertion: } else {
		// Unmatched Postman assertion: postman.setNextRequest("Import owners_update.json from S3")
		.expect((r) => assert.ok(r.body.hasOwnProperty('message')))
// Unmatched Postman assertion: }})
});

it('Check S3 dogs update loaded', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: console.log("Error checking S3 import job.")
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status != 'ERROR'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].message == "successfully loaded 12 of 12 records"))
		.expect((r) => assert.ok(r.body[0].status == 'COMPLETE' || r.body[0].status == ERROR))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 dogs update loaded')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 dogs update loaded')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Import owners_update.json from S3', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "import_from_s3",
			"action": "update",
			"schema": "S3_DATA",
			"table": "owners",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/owners_update.json",
				"region": "us-east-2"
			}
		})
		.expect(200)

		// Unmatched Postman assertion: if (jsonData.message) {
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
		// Unmatched Postman assertion: eval(pm.globals.get("function:getJobId"))(jsonData, "Import large sensor_data.json from S3")
		// Unmatched Postman assertion: } else {
		// Unmatched Postman assertion: postman.setNextRequest("Import large sensor_data.json from S3")
		.expect((r) => assert.ok(r.body.hasOwnProperty('message')))
// Unmatched Postman assertion: }})
});

it('Check S3 owners update loaded', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: console.log("Error checking S3 import job.")
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status != 'ERROR'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].message == "successfully loaded 4 of 4 records"))
		.expect((r) => assert.ok(r.body[0].status == 'COMPLETE' || r.body[0].status == ERROR))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 owners update loaded')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 owners update loaded')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Import large sensor_data.json from S3', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "import_from_s3",
			"action": "insert",
			"schema": "S3_DATA",
			"table": "sensor",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/sensor_data.json",
				"region": "us-east-2"
			}
		})
		.expect(200)

		// Unmatched Postman assertion: if (jsonData.message) {
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
		// Unmatched Postman assertion: eval(pm.globals.get("function:getJobId"))(jsonData, "Import large sensor_data.json for UPSERT from S3")
		// Unmatched Postman assertion: } else {
		// Unmatched Postman assertion: postman.setNextRequest("Import large sensor_data.json for UPSERT from S3")
		.expect((r) => assert.ok(r.body.hasOwnProperty('message')))
// Unmatched Postman assertion: }})
});

it('Check S3 large sensor_data loaded', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: console.log("Error checking S3 import job.")
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status != 'ERROR'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].message == "successfully loaded 20020 of 20020 records"))
		.expect((r) => assert.ok(r.body[0].status == 'COMPLETE' || r.body[0].status == ERROR))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 large sensor_data loaded')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 large sensor_data loaded')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Import large sensor_data.json for UPSERT from S3', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "import_from_s3",
			"action": "upsert",
			"schema": "S3_DATA",
			"table": "sensor",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/sensor_data.json",
				"region": "us-east-2"
			}
		})
		.expect(200)

		// Unmatched Postman assertion: if (jsonData.message) {
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
		// Unmatched Postman assertion: eval(pm.globals.get("function:getJobId"))(jsonData, "Import does_not_exist_UPDATE.csv from S3 - expect fail")
		// Unmatched Postman assertion: } else {
		// Unmatched Postman assertion: postman.setNextRequest("Import does_not_exist_UPDATE.csv from S3 - expect fail")
		.expect((r) => assert.ok(r.body.hasOwnProperty('message')))
// Unmatched Postman assertion: }})
});

it('Check S3 large sensor_data upserted', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: console.log("Error checking S3 import job.")
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status != 'ERROR'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].message == "successfully loaded 20020 of 20020 records"))
		.expect((r) => assert.ok(r.body[0].status == 'COMPLETE' || r.body[0].status == ERROR))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 large sensor_data upserted')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 large sensor_data upserted')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Check rows from S3 upsert were updated', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "SELECT * FROM S3_DATA.sensor" })
		.expect(200)
		.expect((r) => {
			r.body.forEach(row => {
				assert.ok(row.__updatedtime__ > row.__createdtime__)
			})
		})
});

it('Import does_not_exist_UPDATE.csv from S3 - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "import_from_s3",
			"action": "update",
			"schema": "S3_DATA",
			"table": "owners",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/does_not_exist_UPDATE.csv",
				"region": "us-east-2"
			}
		})
		.expect(200)
		.expect(200)
		// Unmatched Postman assertion: var jobMsgIndex = jsonData.message.indexOf('Starting job')
		// Unmatched Postman assertion: if (jobMsgIndex === 0) {
		.expect((r) => assert.ok(jobMsgIndex == 0))
		// Unmatched Postman assertion: eval(pm.globals.get("function:getJobId"))(jsonData, "Export to S3")
		// Unmatched Postman assertion: } else {
		.expect((r) => assert.ok(jobMsgIndex == 0))
		// Unmatched Postman assertion: postman.setNextRequest("Export to S3")
		// Unmatched Postman assertion: }
		// Unmatched Postman assertion: if (jsonData.message) {
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
		// Unmatched Postman assertion: eval(pm.globals.get("function:getJobId"))(jsonData, "Export to S3")
		// Unmatched Postman assertion: } else {
		// Unmatched Postman assertion: postman.setNextRequest("Export to S3")
		.expect((r) => assert.ok(r.body.hasOwnProperty('message')))
// Unmatched Postman assertion: }})
});

it('Check for error from S3 does_not_exist_UPDATE.csv import', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: console.log("Error correctly found in response checking invalid S3 import job.")
		.expect((r) => assert.ok(r.body[0].message == "The specified key does not exist."))
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status == 'ERROR'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(status == ["ERROR"]))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check for error from S3 does_not_exist_UPDATE.csv import')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check for error from S3 does_not_exist_UPDATE.csv import')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Export to S3', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "export_to_s3",
			"format": "csv",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/test_export",
				"region": "us-east-2"
			},
			"search_operation": { "operation": "sql", "sql": "SELECT * FROM S3_DATA.dogs LIMIT 1" }
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
// Unmatched Postman assertion: eval(pm.globals.get("function:getJobId"))(jsonData, "Create S3 test table")
});

it('Check S3 export', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: console.log("Error checking S3 import job.")
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status != 'ERROR'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: pm.environment.set("next_request", "Create S3 test table")
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].result.ETag))
		.expect((r) => assert.ok(r.body[0].result.VersionId))
// Unmatched Postman assertion: pm.expect(status).to.eql('COMPLETE')
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 export')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 export')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Export to S3 search_by_conditions', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "export_to_s3",
			"format": "csv",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/test_export",
				"region": "us-east-2"
			},
			"search_operation": {
				"operation": "search_by_conditions",
				"database": "S3_DATA",
				"table": "dogs",
				"operator": "and",
				"get_attributes": ["*"],
				"conditions": [{ "search_attribute": "breed_id", "search_type": "between", "search_value": [199, 280] }]
			}
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
// Unmatched Postman assertion: eval(pm.globals.get("function:getJobId"))(jsonData, "Create S3 test table")
});

it('Check S3 export search_by_conditions', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: console.log("Error checking S3 import job.")
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status != 'ERROR'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: pm.environment.set("next_request", "Export local search_by_conditions")
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].result.ETag))
		.expect((r) => assert.ok(r.body[0].result.VersionId))
// Unmatched Postman assertion: pm.expect(status).to.eql('COMPLETE')
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 export search_by_conditions')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check S3 export search_by_conditions')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Export local search_by_conditions', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "export_local",
			"path": "./",
			"format": "json",
			"filename": "integration-test",
			"search_operation": {
				"operation": "search_by_conditions",
				"database": "S3_DATA",
				"table": "dogs",
				"operator": "and",
				"get_attributes": ["*"],
				"conditions": [{ "search_attribute": "breed_id", "search_type": "between", "search_value": [199, 200] }]
			}
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
// Unmatched Postman assertion: eval(pm.globals.get("function:getJobId"))(jsonData, "Create S3 test table")
});

it('Check export local search_by_conditions', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: console.log("Error checking export local search_by_conditions")
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status != 'ERROR'))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case 'COMPLETE':
// Unmatched Postman assertion: console.log(jsonData[0])
// Unmatched Postman assertion: if(pm.environment.get("next_request")){
// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
// Unmatched Postman assertion: pm.environment.set("next_request", "Create S3 test table")
// Unmatched Postman assertion: }
// Unmatched Postman assertion: pm.expect(jsonData[0].message.message).to.equal("Successfully exported JSON locally.")
// Unmatched Postman assertion: pm.expect(jsonData[0].type).to.equal("export_local")
// Unmatched Postman assertion: pm.expect(status).to.eql('COMPLETE')
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check export local search_by_conditions')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check export local search_by_conditions')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Create S3 test table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "schema": "S3_DATA", "table": "s3_test", "hash_attribute": "id" })
		.expect(200)
});

it('Create S3 CSV import test table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "schema": "S3_DATA", "table": "s3_test_csv_import", "hash_attribute": "id" })
		.expect(200)
});

it('Create S3 JSON import test table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "create_table",
			"schema": "S3_DATA",
			"table": "s3_test_json_import",
			"hash_attribute": "id"
		})
		.expect(200)
});

it('Insert records S3 test table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "S3_DATA",
			"table": "s3_test",
			"records": [{
				"id": "a",
				"address": "1 North Street",
				"lastname": "Dog",
				"firstname": "Harper",
				"one": "only one"
			}, {
				"id": "b",
				"object": { "name": "object", "number": 1, "array": [1, "two"] },
				"array": [1, 2, "three"],
				"firstname": "Harper"
			}, { "id": "c", "object_array": [{ "number": 1 }, { "number": "two", "count": 2 }] }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 3))
		.expect((r) => assert.ok(r.body.message == "inserted 3 of 3 records"))
});

it('Export S3 test table CSV', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "export_to_s3",
			"format": "csv",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/test_export_csv",
				"region": "us-east-2"
			},
			"search_operation": { "operation": "sql", "sql": "SELECT * FROM S3_DATA.s3_test" }
		})
		.expect(200)
// Unmatched Postman assertion: let message_parts = jsonData.message.spl})

	it(' ')
		// Unmatched Postman assertion: pm.environment.set('job_id', message_parts[4])
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
});

it('Wait for CSV export to complete', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
// Unmatched Postman assertion: need here a call to checkJobCompleted(job_id, expectedErrorMessage, expectedCompletedMessage);
});

it('Import S3 test table CSV', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "import_from_s3",
			"action": "insert",
			"schema": "S3_DATA",
			"table": "s3_test_csv_import",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/test_export_csv.csv",
				"region": "us-east-2"
			}
		})
		.expect(200)
// Unmatched Postman assertion: let message_parts = jsonData.message.spl})

	it(' ')
		// Unmatched Postman assertion: pm.environment.set('job_id', message_parts[4])
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
});

it('Wait for CSV import to complete', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
// Unmatched Postman assertion: need here a call to checkJobCompleted(job_id, expectedErrorMessage, expectedCompletedMessage);
});

it('Confirm CSV records import', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "select `one`, `object_array`, `id`, `address`, `object`, `lastname`, `firstname`, `array` FROM S3_DATA.s3_test_csv_import ORDER BY id ASC"
		})
		.expect(200)
		// Unmatched Postman assertion: let expected_res = [
		// Unmatched Postman assertion: {
		// Unmatched Postman assertion: "one": "only one",
		// Unmatched Postman assertion: "object_array": "",
		// Unmatched Postman assertion: "id": "a",
		// Unmatched Postman assertion: "address": "1 North Street",
		// Unmatched Postman assertion: "object": "",
		// Unmatched Postman assertion: "lastname": "Dog",
		// Unmatched Postman assertion: "firstname": "Harper",
		// Unmatched Postman assertion: "array": ""
		// Unmatched Postman assertion: },
		// Unmatched Postman assertion: {
		// Unmatched Postman assertion: "one": "",
		// Unmatched Postman assertion: "object_array": "",
		// Unmatched Postman assertion: "id": "b",
		// Unmatched Postman assertion: "address": "",
		// Unmatched Postman assertion: "object": {
		// Unmatched Postman assertion: "name": "object",
		// Unmatched Postman assertion: "number": 1,
		// Unmatched Postman assertion: "array": [
		// Unmatched Postman assertion: 1,
		// Unmatched Postman assertion: "two"
		// Unmatched Postman assertion: ]
		// Unmatched Postman assertion: },
		// Unmatched Postman assertion: "lastname": "",
		// Unmatched Postman assertion: "firstname": "Harper",
		// Unmatched Postman assertion: "array": [
		// Unmatched Postman assertion: 1,
		// Unmatched Postman assertion: 2,
		// Unmatched Postman assertion: "three"
		// Unmatched Postman assertion: ]
		// Unmatched Postman assertion: },
		// Unmatched Postman assertion: {
		// Unmatched Postman assertion: "one": "",
		// Unmatched Postman assertion: "object_array": [
		// Unmatched Postman assertion: {
		// Unmatched Postman assertion: "number": 1
		// Unmatched Postman assertion: },
		// Unmatched Postman assertion: {
		// Unmatched Postman assertion: "number": "two",
		// Unmatched Postman assertion: "count": 2
		// Unmatched Postman assertion: }
		// Unmatched Postman assertion: ],
		// Unmatched Postman assertion: "id": "c",
		// Unmatched Postman assertion: "address": "",
		// Unmatched Postman assertion: "object": "",
		// Unmatched Postman assertion: "lastname": "",
		// Unmatched Postman assertion: "firstname": "",
		// Unmatched Postman assertion: "array": ""
		// Unmatched Postman assertion: }
		// Unmatched Postman assertion: ]
		.expect((r) => assert.ok(r.body == expected_res))
});

it('Export S3 test table JSON', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "export_to_s3",
			"format": "json",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/test_export_json",
				"region": "us-east-2"
			},
			"search_operation": { "operation": "sql", "sql": "SELECT * FROM S3_DATA.s3_test" }
		})
		.expect(200)
// Unmatched Postman assertion: let message_parts = jsonData.message.spl})

	it(' ')
		// Unmatched Postman assertion: pm.environment.set('job_id', message_parts[4])
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
});

it('Wait for JSON export to complete', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
// Unmatched Postman assertion: need here a call to checkJobCompleted(job_id, expectedErrorMessage, expectedCompletedMessage);
});

it('Import S3 test table JSON', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "import_from_s3",
			"action": "insert",
			"schema": "S3_DATA",
			"table": "s3_test_json_import",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/test_export_json.json",
				"region": "us-east-2"
			}
		})
		.expect(200)
// Unmatched Postman assertion: let message_parts = jsonData.message.spl})

	it(' ')
		// Unmatched Postman assertion: pm.environment.set('job_id', message_parts[4])
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
});

it('Wait for JSON import to complete', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
// Unmatched Postman assertion: need here a call to checkJobCompleted(job_id, expectedErrorMessage, expectedCompletedMessage);
});

it('Confirm JSON records import', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "sql",
			"sql": "select `one`, `object_array`, `id`, `address`, `object`, `lastname`, `firstname`, `array` FROM S3_DATA.s3_test_csv_import ORDER BY id ASC"
		})
		.expect(200)
		// Unmatched Postman assertion: let expected_res = [
		// Unmatched Postman assertion: {
		// Unmatched Postman assertion: "one": "only one",
		// Unmatched Postman assertion: "object_array": "",
		// Unmatched Postman assertion: "id": "a",
		// Unmatched Postman assertion: "address": "1 North Street",
		// Unmatched Postman assertion: "object": "",
		// Unmatched Postman assertion: "lastname": "Dog",
		// Unmatched Postman assertion: "firstname": "Harper",
		// Unmatched Postman assertion: "array": ""
		// Unmatched Postman assertion: },
		// Unmatched Postman assertion: {
		// Unmatched Postman assertion: "one": "",
		// Unmatched Postman assertion: "object_array": "",
		// Unmatched Postman assertion: "id": "b",
		// Unmatched Postman assertion: "address": "",
		// Unmatched Postman assertion: "object": {
		// Unmatched Postman assertion: "name": "object",
		// Unmatched Postman assertion: "number": 1,
		// Unmatched Postman assertion: "array": [
		// Unmatched Postman assertion: 1,
		// Unmatched Postman assertion: "two"
		// Unmatched Postman assertion: ]
		// Unmatched Postman assertion: },
		// Unmatched Postman assertion: "lastname": "",
		// Unmatched Postman assertion: "firstname": "Harper",
		// Unmatched Postman assertion: "array": [
		// Unmatched Postman assertion: 1,
		// Unmatched Postman assertion: 2,
		// Unmatched Postman assertion: "three"
		// Unmatched Postman assertion: ]
		// Unmatched Postman assertion: },
		// Unmatched Postman assertion: {
		// Unmatched Postman assertion: "one": "",
		// Unmatched Postman assertion: "object_array": [
		// Unmatched Postman assertion: {
		// Unmatched Postman assertion: "number": 1
		// Unmatched Postman assertion: },
		// Unmatched Postman assertion: {
		// Unmatched Postman assertion: "number": "two",
		// Unmatched Postman assertion: "count": 2
		// Unmatched Postman assertion: }
		// Unmatched Postman assertion: ],
		// Unmatched Postman assertion: "id": "c",
		// Unmatched Postman assertion: "address": "",
		// Unmatched Postman assertion: "object": "",
		// Unmatched Postman assertion: "lastname": "",
		// Unmatched Postman assertion: "firstname": "",
		// Unmatched Postman assertion: "array": ""
		// Unmatched Postman assertion: }
		// Unmatched Postman assertion: ]
		.expect((r) => assert.ok(r.body == expected_res))
});

it('Drop S3 schema', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "S3_DATA" })
		.expect(200)
});

it('Jobs - Add non SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "developer_test_5",
			"permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"customers": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": []
						},
						"suppliers": {
							"read": false,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": []
						},
						"region": {
							"read": true,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "regiondescription",
								"read": true,
								"insert": false,
								"update": false
							}]
						},
						"territories": {
							"read": true,
							"insert": true,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "territorydescription",
								"read": true,
								"insert": true,
								"update": false
							}]
						},
						"categories": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": true,
								"insert": true,
								"update": true
							}]
						},
						"shippers": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "companyname",
								"read": false,
								"insert": false,
								"update": false
							}]
						}
					}
				}
			}
		})
		.expect(200)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)
// Unmatched Postman assertion: postman.setEnvironmentVariable("role_id", responseData.id)})
});

it('Jobs - Add User with new Role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_user",
			"role": "developer_test_5",
			"username": "test_user",
			"password": "{{password}}",
			"active": true
		})
		.expect(200)
});

it('Jobs - Add jobs test schema', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_schema", "schema": "test_job" })
		.expect(200)

	Unmatched
	Postman
	assertion: tests["Create Schema"] = responseBody.has("successfully created")
	setTimeout(500)
});

it('Jobs - Add runner table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "schema": "test_job", "table": "runner", "hash_attribute": "runner_id" })
		.expect(200)

	setTimeout(500)
});

it('Jobs - Insert into runners table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "test_job",
			"table": "runner",
			"records": [{ "name": "Harper", "shoes": "Nike", "runner_id": "1", "age": 55 }]
		})
		.expect(200)
//Unmatched Postman assertion: function pausecomp(millis)
// Unmatched Postman assertion: {
// Unmatched Postman assertion: var date = new Date()
// Unmatched Postman assertion: var curDate = null;
// Unmatched Postman assertion: do { curDate = new Date() }
// Unmatched Postman assertion: while(curDate-date < millis)
// Unmatched Postman assertion: }
// Unmatched Postman assertion: pausecomp(100))
});

it('Jobs - Validate 1 entry in runners table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "select * from test_job.runner" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
});

it('Jobs - Test Remove Files Before with test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete_files_before", "date": "2018-06-14", "schema": "dog" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Operation 'deleteFilesBefore' is restricted to 'super_user' roles"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('Jobs - Test Remove Files Before with su and store job_id', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "delete_files_before",
			"date": "{{date_tomorrow}}",
			"schema": "test_job",
			"table": "runner"
		})
		.expect(200)
// Unmatched Postman assertion: var jsonData = JSON.parse(responseBody)
// Unmatched Postman assertion: let id_index = jsonData.message.indexOf('id ')
// Unmatched Postman assertion: let parsedId = jsonData.message.substr(id_index + 3, jsonData.message.length)
// Unmatched Postman assertion: pm.environment.set("job_id", parsedId))
});

it('Jobs - Wait for remove files before', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
// Unmatched Postman assertion: need here a call to checkJobCompleted(job_id, expectedErrorMessage, expectedCompletedMessage);
});

it('Jobs - Validate 0 entry in runners table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "select * from test_job.runner" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 0))
});

it('Search Jobs by date', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_jobs_by_start_date",
			"from_date": "{{date_yesterday}}",
			"to_date": "{{date_tomorrow}}"
		})
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData.length).to.be.above(0))
});

it('Search Jobs by date - non-super user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_jobs_by_start_date",
			"from_date": "{{date_yesterday}}",
			"to_date": "{{date_tomorrow}}"
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Operation 'handleGetJobsByStartDate' is restricted to 'super_user' roles"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('Search Jobs by job_id', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
});

it('Search Jobs by job_id - non-super user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
});

it('Jobs - Bulk CSV load into restricted region table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "csv_data_load",
			"schema": "{{schema}}",
			"table": "{{regi_tb}}",
			"data": "regionid, regiondescription\n'17', 'test description'\n"
		})
		.expect(403)
});

it('Jobs - Bulk CSV load into restricted region table as su', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "csv_data_load",
			"schema": "{{schema}}",
			"table": "{{regi_tb}}",
			"data": "regionid, regiondescription\n'17', 'test description'\n"
		})
		.expect(200)
});

it('Jobs - Bulk CSV Load - insert suppliers table restricted attribute as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "csv_file_load",
			"action": "insert",
			"schema": "{{schema}}",
			"table": "{{supp_tb}}",
			"file_path": "{{files_location}}Suppliers.csv"
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Table 'northnwd.suppliers' does not exist"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('Jobs Test Export To Local using SQL as su', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "export_local",
			"path": "./",
			"filename": "test_export.json",
			"format": "json",
			"search_operation": { "operation": "sql", "sql": "select * from {{schema}}.{{ship_tb}}" }
		})
		.expect(200)
});

it('Jobs Test Export To Local using NoSQL as su', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "export_local",
			"path": "./",
			"filename": "test_export.json",
			"format": "json",
			"search_operation": {
				"operation": "search_by_hash",
				"schema": "{{schema}}",
				"table": "{{ship_tb}}",
				"hash_attribute": "{{ship_id}}",
				"hash_values": [1],
				"get_attributes": ["companyname"]
			}
		})
		.expect(200)
});

it('Jobs Test Export To Local using SQL as test_user on table with FULLY restricted attrs', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "export_local",
			"path": "./",
			"filename": "test_export.json",
			"format": "json",
			"search_operation": { "operation": "sql", "sql": "select * from {{schema}}.{{ship_tb}}" }
		})
		.expect(200)
});

it('Jobs Test Export To Local using SQL on RESTRICTED table as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "export_local",
			"path": "./",
			"filename": "test_export.json",
			"format": "json",
			"search_operation": { "operation": "sql", "sql": "select * from {{schema}}.{{supp_tb}}" }
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Table 'northnwd.suppliers' does not exist"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('Jobs Test Export To Local using SQL as test_user on table w/ two attr perms', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "export_local",
			"path": "./",
			"filename": "test_export.json",
			"format": "json",
			"search_operation": { "operation": "sql", "sql": "select * from {{schema}}.{{regi_tb}}" }
		})
		.expect(200)
});

it('Jobs Test Export To Local using NoSQL as test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "export_local",
			"path": "./",
			"filename": "test_export",
			"format": "json",
			"search_operation": {
				"operation": "search_by_hash",
				"schema": "{{schema}}",
				"table": "{{supp_tb}}",
				"hash_attribute": "{{supp_id}}",
				"hash_values": [1],
				"get_attributes": ["{{supp_id}}"]
			}
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Operation 'export_local' is restricted to 'super_user' roles"))
});

it('Jobs - drop test user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_user", "username": "test_user" })
		.expect(200)
});

it('Jobs -  drop_role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_role", "id": "{{role_id}}" })
		.expect(200)
});

it('Jobs - Delete Jobs_test schema', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "test_job" })

// Unmatched Postman assertion: tests["Delete Schema"] = responseBody.has("successfully delete"))
});

it('create test schema', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_schema", "schema": "test_delete_before" })
		.expect(200)

	Unmatched
	Postman
	assertion: tests["Create Schema"] = responseBody.has("successfully created")
	setTimeout(500)
});

it('create test table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "schema": "test_delete_before", "table": "address", "hash_attribute": "id" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('successfully created')))
	setTimeout(500)
});

it('Insert new records', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "test_delete_before",
			"table": "address",
			"records": [{ "id": 1, "address": "24 South st" }, { "id": 2, "address": "6 Truck Lane" }, {
				"id": 3,
				"address": "19 Broadway"
			}, { "id": 4, "address": "34A Mountain View" }, { "id": 5, "address": "234 Curtis St" }, {
				"id": 6,
				"address": "115 Way Rd"
			}]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 6))

	setTimeout(1000)
});

it('Insert additional new records', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "test_delete_before",
			"table": "address",
			"records": [{ "id": 11, "address": "24 South st" }, { "id": 12, "address": "6 Truck Lane" }, {
				"id": 13,
				"address": "19 Broadway"
			}]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 3))
});

it('Delete records before', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "delete_files_before",
			"date": "{{insert_timestamp}}",
			"schema": "test_delete_before",
			"table": "address"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
// Unmatched Postman assertion: eval(pm.globals.get("function:getJobIdDelete"))(jsonData, null)
});

it('Check Delete Records Before Job Completed', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status != 'ERROR'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status == 'COMPLETE' || r.body[0].status == ERROR))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check Delete Records Before Job Completed')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check Delete Records Before Job Completed')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Search by hash confirm', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_hash",
			"schema": "test_delete_before",
			"table": "address",
			"hash_attribute": "id",
			"hash_values": [1, 2, 3, 4, 5, 6, 11, 12, 13],
			"get_attributes": ["id", "address"]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 3))
// Unmatched Postman assertion: var ids = [];
// Unmatched Postman assertion: jsonData.forEach((record) => {
// Unmatched Postman assertion: ids.push(record.id)
// Unmatched Postman assertion: })
// Unmatched Postman assertion: pm.expect(ids.includes(11)).to.be.true;
// Unmatched Postman assertion: pm.expect(ids.includes(12)).to.be.true;
// Unmatched Postman assertion: pm.expect(ids.includes(13)).to.be.true;
// Unmatched Postman assertion: pm.expect(ids.includes(1)).to.be.false;
// Unmatched Postman assertion: pm.expect(ids.includes(2)).to.be.false;
// Unmatched Postman assertion: pm.expect(ids.includes(3)).to.be.false;
// Unmatched Postman assertion: pm.expect(ids.includes(4)).to.be.false;
// Unmatched Postman assertion: pm.expect(ids.includes(5)).to.be.false;
// Unmatched Postman assertion: pm.expect(ids.includes(6)).to.be.false;})
});

it('Insert new records', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "test_delete_before",
			"table": "address",
			"records": [{ "id": "1a", "address": "24 South st" }, { "id": "2a", "address": "6 Truck Lane" }, {
				"id": "3a",
				"address": "19 Broadway"
			}, { "id": "4a", "address": "34A Mountain View" }, { "id": "5a", "address": "234 Curtis St" }, {
				"id": "6a",
				"address": "115 Way Rd"
			}]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 6))

	setTimeout(1000)
});

it('Insert additional new records', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "test_delete_before",
			"table": "address",
			"records": [{ "id": "11a", "address": "24 South st" }, { "id": "12a", "address": "6 Truck Lane" }, {
				"id": "13a",
				"address": "19 Broadway"
			}]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 3))
});

it('Delete records before', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "delete_files_before",
			"date": "{{insert_timestamp}}",
			"schema": "test_delete_before",
			"table": "address"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
// Unmatched Postman assertion: eval(pm.globals.get("function:getJobIdDeleteA"))(jsonData, null)
});

it('Check Delete Records Before Alias Job Completed', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status != 'ERROR'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status == 'COMPLETE' || r.body[0].status == ERROR))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check Delete Records Before Alias Job Completed')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check Delete Records Before Alias Job Completed')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('Search by hash confirm', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_hash",
			"schema": "test_delete_before",
			"table": "address",
			"hash_attribute": "id",
			"hash_values": ["1a", "2a", "3a", "4a", "5a", "6a", "11a", "12a", "13a"],
			"get_attributes": ["id", "address"]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 3))
// Unmatched Postman assertion: var ids = [];
// Unmatched Postman assertion: jsonData.forEach((record) => {
// Unmatched Postman assertion: ids.push(record.id)
// Unmatched Postman assertion: })
// Unmatched Postman assertion: pm.expect(ids.includes("11a")).to.be.true;
// Unmatched Postman assertion: pm.expect(ids.includes("12a")).to.be.true;
// Unmatched Postman assertion: pm.expect(ids.includes("13a")).to.be.true;
// Unmatched Postman assertion: pm.expect(ids.includes("1a")).to.be.false;
// Unmatched Postman assertion: pm.expect(ids.includes("2a")).to.be.false;
// Unmatched Postman assertion: pm.expect(ids.includes("3a")).to.be.false;
// Unmatched Postman assertion: pm.expect(ids.includes("4a")).to.be.false;
// Unmatched Postman assertion: pm.expect(ids.includes("5a")).to.be.false;
// Unmatched Postman assertion: pm.expect(ids.includes("6a")).to.be.false;})
});

it('Create schema for drop test', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_schema", "schema": "{{drop_schema}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "database 'drop_schema' successfully created"))
});

it('Create table for drop test', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "create_table",
			"schema": "{{drop_schema}}",
			"table": "{{drop_table}}",
			"hash_attribute": "id"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "table 'drop_schema.drop_table' successfully created."))
});

it('Insert records for drop test', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "{{drop_schema}}",
			"table": "{{drop_table}}",
			"records": [{ "id": 4, "address": "194 Greenbrook Drive" }, {
				"id": 7,
				"address": "195 Greenbrook Lane"
			}, { "id": 9, "address": "196 Greenbrook Lane" }, { "id": 0, "address": "197 Greenbrook Drive" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 4))
});

it('Drop schema', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "{{drop_schema}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted 'drop_schema'"))
});

it('Confirm drop schema', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_schema", "schema": "{{drop_schema}}" })
		.expect(404)
		.expect((r) => assert.ok(r.body.error == "database 'drop_schema' does not exist"))
});

it('Create schema again', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_schema", "schema": "{{drop_schema}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "database 'drop_schema' successfully created"))
});

it('Create table again', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "create_table",
			"schema": "{{drop_schema}}",
			"table": "{{drop_table}}",
			"hash_attribute": "id"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "table 'drop_schema.drop_table' successfully created."))
});

it('Confirm correct attributes', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_table", "schema": "{{drop_schema}}", "table": "{{drop_table}}" })
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData.attributes.length).to.eql(3))
});

it('Clean up after drop schema tests', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "{{drop_schema}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted 'drop_schema'"))
});

it('Create schema for wildcard test', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_schema", "schema": "h*rper%1" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "database 'h*rper%1' successfully created"))
});

it('Drop wildcard schema', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "h*rper%1" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted 'h*rper%1'"))
});

it('Drop number table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_table", "schema": "123", "table": "4" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted table '123.4'"))
});

it('Drop number number table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_table", "schema": 1123, "table": 1 })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted table '1123.1'"))
});

it('Drop number schema', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "123" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted '123'"))
});

it('Drop number number schema', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": 1123 })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted '1123'"))
});

it('create schema drop_attr', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_schema", "schema": "drop_attr" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('successfully created')))
});

it('create table test', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "schema": "drop_attr", "table": "test", "hash_attribute": "id" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('successfully created')))
});

it('Insert records into test table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "drop_attr",
			"table": "test",
			"records": [{ "id": 1, "address": "5 North Street", "lastname": "Dog", "firstname": "Harper" }, {
				"id": 2,
				"address": "4 North Street",
				"lastname": "Dog",
				"firstname": "Harper"
			}, { "id": 3, "address": "3 North Street", "lastname": "Dog", "firstname": "Harper" }, {
				"id": 4,
				"address": "2 North Street",
				"lastname": "Dog",
				"firstname": "Harper"
			}, { "id": 5, "address": "1 North Street", "lastname": "Dog", "firstname": "Harper" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 5))
		.expect((r) => assert.ok(r.body.message == "inserted 5 of 5 records"))
});

it('Drop attribute lastname', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_attribute", "schema": "drop_attr", "table": "test", "attribute": "lastname" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted attribute 'lastname'"))
});

it('Upsert some values', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "upsert",
			"schema": "drop_attr",
			"table": "test",
			"records": [{ "id": "123a", "categoryid": 1, "unitsnnorder": 0, "unitsinstock": 39 }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.upserted_hashes.length == 1))
		.expect((r) => assert.ok(r.body.upserted_hashes == ["123a"]))
		.expect((r) => assert.ok(r.body.message == "upserted 1 of 1 records"))
});

it('Search by hash confirm upsert', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_hash",
			"schema": "drop_attr",
			"table": "test",
			"hash_values": ["123a"],
			"get_attributes": ["*"]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].id == "123a"))
		.expect((r) => assert.ok(r.body[0].unitsinstock == 39))
		.expect((r) => assert.ok(r.body[0].unitsnnorder == 0))
});

it('Drop attribute unitsnnorder', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_attribute", "schema": "drop_attr", "table": "test", "attribute": "unitsnnorder" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted attribute 'unitsnnorder'"))
});

it('Update some values', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"schema": "drop_attr",
			"table": "test",
			"records": [{ "id": 1, "lastname": "thor" }]
		})
		.expect((r) => assert.ok(r.body.message == 'updated 1 of 1 records', 'Expected response message to eql "updated 1 of 1 records"'))
		.expect(200)
		.expect((r) => assert.ok(r.body.update_hashes.length == 1))
		.expect((r) => assert.ok(r.body.update_hashes == [1]))
});

it('Search by hash confirm update', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_hash",
			"schema": "drop_attr",
			"table": "test",
			"hash_values": [1],
			"get_attributes": ["*"]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].id == 1))
		.expect((r) => assert.ok(r.body[0].lastname == "thor"))
});

it('Drop attribute lastname', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_attribute", "schema": "drop_attr", "table": "test", "attribute": "lastname" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted attribute 'lastname'"))
});

it('Delete a record', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete", "schema": "drop_attr", "table": "test", "hash_values": [1] })
		.expect(200)
		.expect((r) => assert.ok(r.body.deleted_hashes.length == 1))
		.expect((r) => assert.ok(r.body.deleted_hashes == [1]))
		.expect((r) => assert.ok(r.body.message == "1 of 1 record successfully deleted"))
});

it('Search by hash confirm delete', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_hash",
			"schema": "drop_attr",
			"table": "test",
			"hash_values": [1],
			"get_attributes": ["*"]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 0))
});

it('Drop schema drop_attr', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "drop_attr" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("successfully deleted")))
});

it('create schema drop_attr', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_schema", "schema": "drop_attr" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('successfully created')))
});

it('create table test', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "schema": "drop_attr", "table": "test", "hash_attribute": "id" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('successfully created')))
});

it('Insert records into test table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "drop_attr",
			"table": "test",
			"records": [{ "id": 1, "address": "5 North Street", "lastname": "Dog", "firstname": "Harper" }, {
				"id": 2,
				"address": "4 North Street",
				"lastname": "Dog",
				"firstname": "Harper"
			}, { "id": 3, "address": "3 North Street", "lastname": "Dog", "firstname": "Harper" }, {
				"id": 4,
				"address": "2 North Street",
				"lastname": "Dog",
				"firstname": "Harper"
			}, { "id": 5, "address": "1 North Street", "lastname": "Dog", "firstname": "Harper" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 5))
		.expect((r) => assert.ok(r.body.message == "inserted 5 of 5 records"))
});

it('Drop attribute lastname', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_attribute", "schema": "drop_attr", "table": "test", "attribute": "lastname" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted attribute 'lastname'"))
});

it('Upsert some values', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "upsert",
			"schema": "drop_attr",
			"table": "test",
			"records": [{ "id": "123a", "categoryid": 1, "unitsnnorder": 0, "unitsinstock": 39 }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.upserted_hashes.length == 1))
		.expect((r) => assert.ok(r.body.upserted_hashes == ["123a"]))
		.expect((r) => assert.ok(r.body.message == "upserted 1 of 1 records"))
});

it('Search by hash confirm upsert', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_hash",
			"schema": "drop_attr",
			"table": "test",
			"hash_values": ["123a"],
			"get_attributes": ["*"]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].id == "123a"))
		.expect((r) => assert.ok(r.body[0].unitsinstock == 39))
// Unmatched Postman assertion: pm.expect(jsonData[0].unitsnnorder).to.eql(0))
});

it('Drop attribute unitsnnorder', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_attribute", "schema": "drop_attr", "table": "test", "attribute": "unitsnnorder" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted attribute 'unitsnnorder'"))
});

it('Update some values', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"schema": "drop_attr",
			"table": "test",
			"records": [{ "id": 1, "lastname": "thor" }]
		})
		.expect((r) => assert.ok(r.body.message == 'updated 1 of 1 records', 'Expected response message to eql "updated 1 of 1 records"'))
		.expect(200)
		.expect((r) => assert.ok(r.body.update_hashes.length == 1))
		.expect((r) => assert.ok(r.body.update_hashes == [1]))
});

it('Search by hash confirm update', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_hash",
			"schema": "drop_attr",
			"table": "test",
			"hash_values": [1],
			"get_attributes": ["*"]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].id == 1))
		.expect((r) => assert.ok(r.body[0].lastname == "thor"))
});

it('Drop attribute lastname', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_attribute", "schema": "drop_attr", "table": "test", "attribute": "lastname" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted attribute 'lastname'"))
});

it('Delete a record', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete", "schema": "drop_attr", "table": "test", "hash_values": [1] })
		.expect(200)
		.expect((r) => assert.ok(r.body.deleted_hashes.length == 1))
		.expect((r) => assert.ok(r.body.deleted_hashes == [1]))
		.expect((r) => assert.ok(r.body.message == "1 of 1 record successfully deleted"))
});

it('Search by hash confirm delete', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_hash",
			"schema": "drop_attr",
			"table": "test",
			"hash_values": [1],
			"get_attributes": ["*"]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 0))
});

it('Drop schema drop_attr', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "drop_attr" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("successfully deleted")))
});

it('create schema drop_attr', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_schema", "schema": "drop_attr" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('successfully created')))
});

it('create table test', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "schema": "drop_attr", "table": "test", "hash_attribute": "id" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('successfully created')))
});

it('Insert records into test table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "drop_attr",
			"table": "test",
			"records": [{ "id": 1, "address": "5 North Street", "lastname": "Dog", "firstname": "Harper" }, {
				"id": 2,
				"address": "4 North Street",
				"lastname": "Dog",
				"firstname": "Harper"
			}, { "id": 3, "address": "3 North Street", "lastname": "Dog", "firstname": "Harper" }, {
				"id": 4,
				"address": "2 North Street",
				"lastname": "Dog",
				"firstname": "Harper"
			}, { "id": 5, "address": "1 North Street", "lastname": "Dog", "firstname": "Harper" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 5))
		.expect((r) => assert.ok(r.body.message == "inserted 5 of 5 records"))
});

it('Drop attribute lastname', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_attribute", "schema": "drop_attr", "table": "test", "attribute": "lastname" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted attribute 'lastname'"))
});

it('Upsert some values', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "upsert",
			"schema": "drop_attr",
			"table": "test",
			"records": [{ "id": "123a", "categoryid": 1, "unitsnnorder": 0, "unitsinstock": 39 }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.upserted_hashes.length == 1))
		.expect((r) => assert.ok(r.body.upserted_hashes == ["123a"]))
		.expect((r) => assert.ok(r.body.message == "upserted 1 of 1 records"))
});

it('Search by hash confirm upsert', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_hash",
			"schema": "drop_attr",
			"table": "test",
			"hash_values": ["123a"],
			"get_attributes": ["*"]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].id == "123a"))
		.expect((r) => assert.ok(r.body[0].unitsinstock == 39))
		.expect((r) => assert.ok(r.body[0].unitsnnorder == 0))
});

it('Drop attribute unitsnnorder', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_attribute", "schema": "drop_attr", "table": "test", "attribute": "unitsnnorder" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted attribute 'unitsnnorder'"))
});

it('Update some values', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"schema": "drop_attr",
			"table": "test",
			"records": [{ "id": 1, "lastname": "thor" }]
		})
		.expect((r) => assert.ok(r.body.message == 'updated 1 of 1 records', 'Expected response message to eql "updated 1 of 1 records"'))
		.expect(200)
		.expect((r) => assert.ok(r.body.update_hashes.length == 1))
		.expect((r) => assert.ok(r.body.update_hashes == [1]))
});

it('Search by hash confirm update', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_hash",
			"schema": "drop_attr",
			"table": "test",
			"hash_values": [1],
			"get_attributes": ["*"]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].id == 1))
		.expect((r) => assert.ok(r.body[0].lastname == "thor"))
});

it('Drop attribute lastname', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_attribute", "schema": "drop_attr", "table": "test", "attribute": "lastname" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted attribute 'lastname'"))
});

it('Delete a record', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete", "schema": "drop_attr", "table": "test", "hash_values": [1] })
		.expect(200)
		.expect((r) => assert.ok(r.body.deleted_hashes.length == 1))
		.expect((r) => assert.ok(r.body.deleted_hashes == [1]))
		.expect((r) => assert.ok(r.body.message == "1 of 1 record successfully deleted"))
});

it('Search by hash confirm delete', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_hash",
			"schema": "drop_attr",
			"table": "test",
			"hash_values": [1],
			"get_attributes": ["*"]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 0))
});

it('Drop schema drop_attr', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "drop_attr" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("successfully deleted")))
});

it('Insert new Employees', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "{{schema}}",
			"table": "{{emps_tb}}",
			"records": [{ "employeeid": 924, "address": "194 Greenbrook Drive" }, {
				"employeeid": 925,
				"address": "195 Greenbrook Lane"
			}, { "employeeid": 926, "address": "196 Greenbrook Lane" }, {
				"employeeid": 927,
				"address": "197 Greenbrook Drive"
			}]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 4))
});

it('Delete records ending in Lane', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "delete from {{schema}}.{{emps_tb}} where address like '%Lane'" })
		.expect(200)
});

it('Verify records are deleted', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "SELECT * from {{schema}}.{{emps_tb}} where address like '%Lane'" })
		.expect(200)
// Unmatched Postman assertion: //we want to test that the returned result is an empty array"// Unmatched Postman assertion: pm.expect(Array.isArray(jsonData) && jsonData.length === 0).to.be.true;
});

it('NoSQL Delete', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete", "schema": "{{schema}}", "table": "{{emps_tb}}", "hash_values": [924, 927] })
		.expect(200)
// Unmatched Postman assertion: let expected_result = {
// Unmatched Postman assertion: "message": "2 of 2 records successfully deleted",
// Unmatched Postman assertion: "deleted_hashes": [
// Unmatched Postman assertion: 924,
// Unmatched Postman assertion: 927
// Unmatched Postman assertion: ],
// Unmatched Postman assertion: "skipped_hashes": []
// Unmatched Postman assertion: };// Unmatched Postman assertion: pm.expect(jsonData).to.eql(expected_result))
});

it('NoSQL Verify records are deleted', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_hash",
			"schema": "{{schema}}",
			"table": "{{emps_tb}}",
			"hash_values": [924, 925, 926, 927],
			"get_attributes": ["*"]
		})
		.expect(200)
// Unmatched Postman assertion: //we want to test that the returned result is an empty array"// Unmatched Postman assertion: pm.expect(Array.isArray(jsonData) && jsonData.length === 0).to.be.true;
});

it('Insert records with objects and arrays', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "{{schema}}",
			"table": "{{emps_tb}}",
			"records": [{
				"employeeid": 7924,
				"address": [{ "height": 12, "weight": 46 }, { "shoe_size": 12, "iq": 46 }]
			}, { "employeeid": 7925, "address": { "number": 12, "age": 46 } }, {
				"employeeid": 7926,
				"address": { "numberArray": ["1", "2", "3"], "string": "Penny" }
			}, { "employeeid": 7927, "address": ["1", "2", "3"] }]
		})
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData.message).to.be.eql("inserted 4 of 4 records"))
});

it('Delete records contaitng objects and arrays', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "delete",
			"schema": "{{schema}}",
			"table": "{{emps_tb}}",
			"hash_values": [7924, 7925, 7926, 7927]
		})
		.expect(200)
// Unmatched Postman assertion: let expected_result = {
// Unmatched Postman assertion: "message": "4 of 4 records successfully deleted",
// Unmatched Postman assertion: "deleted_hashes": [
// Unmatched Postman assertion: 7924,
// Unmatched Postman assertion: 7925,
// Unmatched Postman assertion: 7926,
// Unmatched Postman assertion: 7927
// Unmatched Postman assertion: ],
// Unmatched Postman assertion: "skipped_hashes": []
// Unmatched Postman assertion: }// Unmatched Postman assertion: pm.expect(jsonData).to.be.eql(expected_result))
});

it('Verify object and array records deleted', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_hash",
			"schema": "{{schema}}",
			"table": "{{emps_tb}}",
			"hash_values": [7924, 7925, 7926, 7925],
			"get_attributes": ["employeeid", "address"]
		})
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData).to.be.eql([]))
});

it('test SQL deleteing with numeric hash in single quotes', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "DELETE FROM dev.rando WHERE id IN ('987654321', '987654322')" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("2 of 2 records successfully deleted")))
		.expect((r) => assert.ok(r.body.deleted_hashes.includes(987654321) && r.body.deleted_hashes.includes(987654322)))
});

it('test SQL deleteing with numeric no condition', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "DELETE FROM dev.rando" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("2 of 2 records successfully deleted")))
		.expect((r) => assert.ok(r.body.deleted_hashes.includes(987654323) && r.body.deleted_hashes.includes(987654324)))
});

it('Turn on log audit and custom functions', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "set_configuration",
			"logging_auditLog": true,
			"customFunctions_enabled": true,
			"localStudio_enabled": true,
			"clustering_enabled": true,
			"replication_url": null
		})
		.expect(200)
});

it('Restart for new settings', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "restart" })
		.expect(200)

	Unmatched
	Postman
	assertion: // This timeout is here to give HDB time to restart before the next text is ran.
		setTimeout(60000)
});

it('create test table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "create_table",
			"schema": "test_delete_before",
			"table": "testerama",
			"hash_attribute": "id"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('successfully created')))
	setTimeout(500)
});

it('Insert new records', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "test_delete_before",
			"table": "testerama",
			"records": [{ "id": 1, "address": "24 South st" }, { "id": 2, "address": "6 Truck Lane" }, {
				"id": 3,
				"address": "19 Broadway"
			}, { "id": 4, "address": "34A Mountain View" }, { "id": 5, "address": "234 Curtis St" }, {
				"id": 6,
				"address": "115 Way Rd"
			}]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 6))

	setTimeout(1000)
});

it('Insert additional new records', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "test_delete_before",
			"table": "testerama",
			"records": [{ "id": 11, "address": "24 South st" }, { "id": 12, "address": "6 Truck Lane" }, {
				"id": 13,
				"address": "19 Broadway"
			}]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 3))
});

it('Delete records before', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "delete_audit_logs_before",
			"timestamp": "{{insert_timestamp}}",
			"schema": "test_delete_before",
			"table": "testerama"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response'))
// Unmatched Postman assertion: eval(pm.globals.get("function:getJobIdDelete"))(jsonData, null)
});

it('Check Delete Audit Logs Job Completed', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_job", "id": "{{job_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
		.expect((r) => assert.ok(r.body[0].hasOwnProperty('status')))
		// Unmatched Postman assertion: let status = jsonData[0].status;
		// Unmatched Postman assertion: switch(status){
		// Unmatched Postman assertion: case 'ERROR':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status != 'ERROR'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: case 'COMPLETE':
		// Unmatched Postman assertion: console.log(jsonData[0])
		// Unmatched Postman assertion: if(pm.environment.get("next_request")){
		// Unmatched Postman assertion: postman.setNextRequest(pm.environment.get("next_request"))
		// Unmatched Postman assertion: }
		.expect((r) => assert.ok(r.body[0].status == 'COMPLETE' || r.body[0].status == ERROR))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: case '0':
// Unmatched Postman assertion: case 0:
// Unmatched Postman assertion: case 'IN_PROGRESS':
// Unmatched Postman assertion: console.log('in progress, checking again')
	setTimeout(1000)
		// Unmatched Postman assertion: postman.setNextRequest('Check Delete Audit Logs Job Completed')
		.expect((r) => assert.ok(r.body[0].status == 'IN_PROGRESS' || r.body[0].status == 0 || r.body[0].status == '0'))
		// Unmatched Postman assertion: break;
		// Unmatched Postman assertion: default:
		// Unmatched Postman assertion: postman.setNextRequest('Check Delete Audit Logs Job Completed')
		.expect((r) => assert.ok(r.status == 'IN_PROGRESS' || r.status == 0 || r.status == '0' || r.status == 'ERROR' || r.status == 'COMPLETE'))
// Unmatched Postman assertion: break;
// Unmatched Postman assertion: }})
});

it('create test table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "create_table",
			"schema": "test_delete_before",
			"table": "test_read",
			"hash_attribute": "id"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('successfully created')))
	setTimeout(500)
});

it('Insert new records', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "test_delete_before",
			"table": "test_read",
			"records": [{ "id": 1, "name": "Penny" }, { "id": 2, "name": "Kato", "age": 6 }]
		})
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData.inserted_hashes.length).to.eql(2)

	setTimeout(100)
});

it('Insert more records', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "test_delete_before",
			"table": "test_read",
			"records": [{ "id": 3, "name": "Riley", "age": 7 }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 1))

	setTimeout(100)
});

it('Update records', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"schema": "test_delete_before",
			"table": "test_read",
			"records": [{ "id": 1, "name": "Penny B", "age": 8 }, { "id": 2, "name": "Kato B" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.update_hashes.length == 2))

	setTimeout(100)
});

it('Insert another record', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "test_delete_before",
			"table": "test_read",
			"records": [{ "id": "blerrrrr", "name": "Rosco" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 1))

	setTimeout(100)
});

it('Update a record', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"schema": "test_delete_before",
			"table": "test_read",
			"records": [{ "id": "blerrrrr", "breed": "Mutt" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.update_hashes.length == 1))

	setTimeout(100)
});

it('Delete some records', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete", "schema": "test_delete_before", "table": "test_read", "hash_values": [3, 1] })
		.expect(200)
		.expect((r) => assert.ok(r.body.deleted_hashes.length == 2))

	setTimeout(100)
});

it('Insert another record', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "test_delete_before",
			"table": "test_read",
			"records": [{ "id": 4, "name": "Griff" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.inserted_hashes.length == 1))

	setTimeout(100)
});

it('Upsert records', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "upsert",
			"schema": "test_delete_before",
			"table": "test_read",
			"records": [{ "id": 4, "name": "Griffy Jr." }, { "id": 5, "name": "Gizmo", "age": 10 }, {
				"name": "Moe",
				"age": 11
			}]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.upserted_hashes.length == 3))

	setTimeout(100)
});

it('Check upsert transaction', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "read_audit_log",
			"schema": "test_delete_before",
			"table": "test_read",
			"search_type": "hash_value",
			"search_values": [5]
		})
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData["5"].length).to.eql(1)
// Unmatched Postman assertion: const transaction = jsonData["5"][0]
// Unmatched Postman assertion: pm.expect(transaction.operation).to.eql("upsert")
// Unmatched Postman assertion: pm.expect(transaction.records.length).to.eql(1)
// Unmatched Postman assertion: Object.keys(transaction.records[0]).forEach(key => {
// Unmatched Postman assertion: pm.expect(["id", "name", "age", "__updatedtime__", "__createdtime__"]).includes(key)

	setTimeout(100)
});

it('Fetch all Transactions', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "read_audit_log", "schema": "test_delete_before", "table": "test_read" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 8))
		// Unmatched Postman assertion: const expected_attrs = ["id", "name", "__updatedtime__"];
		// Unmatched Postman assertion: const other_attrs = ["age", "__createdtime__"];
		// Unmatched Postman assertion: const upsert_trans = jsonData[7]; console.log(upsert_trans)
		// Unmatched Postman assertion: pm.expect(upsert_trans.operation).to.eql("upsert")
		// Unmatched Postman assertion: pm.expect(upsert_trans.records.length).to.eql(3)
		// Unmatched Postman assertion: pm.expect(upsert_trans.records[0].id).to.eql(4)
		// Unmatched Postman assertion: Object.keys(upsert_trans.records[0]).forEach(key => {
		.expect((r) => assert.ok([...expected_attrs, ...other_attrs]).includes(key))

		// Unmatched Postman assertion: pm.expect(upsert_trans.records[1].id).to.eql(5)
		// Unmatched Postman assertion: Object.keys(upsert_trans.records[1]).forEach(key => {
		.expect((r) => assert.ok([...expected_attrs, ...other_attrs]).includes(key))

		// Unmatched Postman assertion: pm.expect(upsert_trans.records[2].id).to.be.string;
		// Unmatched Postman assertion: Object.keys(upsert_trans.records[2]).forEach(key => {
		.expect((r) => assert.ok([...expected_attrs, ...other_attrs]).includes(key))
//Unmatched Postman assertion: })
	setTimeout(100)
});

it('Fetch timestamp Transactions', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "read_audit_log",
			"schema": "test_delete_before",
			"table": "test_read",
			"search_type": "timestamp",
			"search_values": []
		})
		.expect(200)
		// Unmatched Postman assertion: let user = pm.environment.get("username")
		.expect((r) => assert.ok(r.body.length == 8))

	setTimeout(100)
});

it('Fetch user transactions', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "read_audit_log",
			"schema": "test_delete_before",
			"table": "test_read",
			"search_type": "username",
			"search_values": ["{{username}}"]
		})
		.expect(200)
// Unmatched Postman assertion: let user = pm.environment.get("username")
// Unmatched Postman assertion: pm.expect(jsonData[user].length).to.eql(8)
// Unmatched Postman assertion: })
	setTimeout(100)
});

it('Fetch hash transactions', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "read_audit_log",
			"schema": "test_delete_before",
			"table": "test_read",
			"search_type": "hash_value",
			"search_values": [1, "blerrrrr"]
		})
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData["1"].length).to.eql(3)
// Unmatched Postman assertion: pm.expect(jsonData["blerrrrr"].length).to.eql(2)

	setTimeout(100)
});

it('drop test_read table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_table", "schema": "test_delete_before", "table": "test_read" })
		.expect(200)

	setTimeout(500)
});

it('Describe schema - SU on system schema', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_schema", "schema": "system" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Your role does not have permission to view database metadata for 'system'"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('Describe Schema - schema doesnt
exist
', async () => {
const response = await request(envUrl)
	.post('')
	.set(headers)
	.send({ "operation": "describe_schema", "schema": "blahh" })
	.expect(404)
	.expect((r) => assert.ok(r.body.error == "database 'blahh' does not exist"))
})
;

it('Describe Table - SU on system table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_table", "schema": "system", "table": "hdb_user" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Your role does not have permission to view database metadata for 'system'"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('Describe Table - schema and table don'
t
exist
', async () => {
const response = await request(envUrl)
	.post('')
	.set(headers)
	.send({ "operation": "describe_table", "schema": "blahh", "table": "blahh" })
	.expect(404)
	.expect((r) => assert.ok(r.body.error == "database 'blahh' does not exist"))
})
;

it('Describe Table - table doesnt
exist
', async () => {
const response = await request(envUrl)
	.post('')
	.set(headers)
	.send({ "operation": "describe_table", "schema": "dev", "table": "blahh" })
	.expect(404)
	.expect((r) => assert.ok(r.body.error == "Table 'dev.blahh' does not exist"))
})
;

it('Add non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role", "role": "test_dev_role", "permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"region": {
							"read": true,
							"insert": true,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "regiondescription",
								"read": true,
								"insert": true,
								"update": false
							}]
						},
						"territories": {
							"read": true,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": []
						},
						"categories": {
							"read": false,
							"insert": false,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": false,
								"insert": false,
								"update": false,
								"delete": true
							}]
						},
						"products": {
							"read": false,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "discontinued",
								"read": false,
								"insert": false,
								"update": false
							}]
						}
					}
				},
				"other": {
					"tables": {
						"owner": {
							"read": true,
							"insert": false,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "name",
								"read": false,
								"insert": false,
								"update": true
							}]
						}
					}
				},
				"another": {
					"tables": {
						"breed": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "name",
								"read": false,
								"insert": false,
								"update": false
							}]
						}
					}
				}
			}
		})
		.expect(200)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)
// Unmatched Postman assertion: postman.setEnvironmentVariable("role_id", responseData.id)})
});

it('Add User with non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_user",
			"role": "test_dev_role",
			"username": "test_user",
			"password": "{{password}}",
			"active": true
		})
		.expect(200)
});

it('Describe All - non-SU test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_all" })
		.expect(200)
		.expect((r) => {
			const keys = Object.keys(r.body);
			assert.ok(keys.length == 3);
			assert.ok(r.body.hasOwnProperty('another'));
		})

		// Unmatched Postman assertion: pm.expect(json_response).to.haveOwnProperty('')
		// Unmatched Postman assertion: pm.expect(json_response.another).to.haveOwnProperty('breed')
		// Unmatched Postman assertion: pm.expect(json_response.another.breed.schema).to.eql('another')
		// Unmatched Postman assertion: pm.expect(json_response.another.breed.name).to.eql('breed')
		// Unmatched Postman assertion: pm.expect(json_response.another.breed.attributes.length).to.eql(0)
		// Unmatched Postman assertion: pm.expect(json_response.another.breed.hash_attribute).to.eql('id')
		// Unmatched Postman assertion: pm.expect(json_response.another.breed.record_count).to.eql(350)
		.expect((r) => assert.ok(r.body.another.breed.hasOwnProperty('clustering_stream_name')))
		.expect((r) => assert.ok(r.body.another.breed.hasOwnProperty('last_updated_record')))
		// Unmatched Postman assertion: pm.expect(json_response).to.haveOwnProperty('northnwd')
		.expect((r) => assert.ok(r.body.northnwd.hasOwnProperty('categories')))
		.expect((r) => assert.ok(r.body.northnwd.hasOwnProperty('region')))
		.expect((r) => assert.ok(r.body.northnwd.hasOwnProperty('territories')))
// Unmatched Postman assertion: pm.expect(Object.keys(json_response.northnwd).length).to.eql(3)
// Unmatched Postman assertion: pm.expect(Object.keys(json_response.other).length).to.eql(1)
// Unmatched Postman assertion: pm.expect(json_response.other).to.haveOwnProperty('owner'))
});

it('Describe Schema - restricted perms - non-SU test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_schema", "schema": "dev" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "database 'dev' does not exist"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('Describe Schema - non-SU test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_schema", "schema": "northnwd" })
		.expect(200)
// Unmatched Postman assertion: var response_arr = Object.values(jsonResponse)
// Unmatched Postman assertion: pm.expect(response_arr.length).to.eql(3)
// Unmatched Postman assertion: pm.expect(jsonResponse).to.haveOwnProperty('categories')
// Unmatched Postman assertion: pm.expect(jsonResponse).to.haveOwnProperty('region')
// Unmatched Postman assertion: pm.expect(jsonResponse).to.haveOwnProperty('territories'))
});

it('Describe Table - restricted perms - non-SU test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_table", "schema": "northnwd", "table": "shippers" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Table 'northnwd.shippers' does not exist"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('Describe Table - non-SU test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_table", "schema": "northnwd", "table": "region" })
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonResponse).to.haveOwnProperty('schema')
// Unmatched Postman assertion: pm.expect(jsonResponse).to.haveOwnProperty('name')
// Unmatched Postman assertion: pm.expect(jsonResponse).to.haveOwnProperty('attributes')
// Unmatched Postman assertion: pm.expect(jsonResponse).to.haveOwnProperty('hash_attribute')
// Unmatched Postman assertion: pm.expect(jsonResponse).to.haveOwnProperty('clustering_stream_name')
// Unmatched Postman assertion: pm.expect(jsonResponse).to.haveOwnProperty('record_count')
// Unmatched Postman assertion: pm.expect(jsonResponse).to.haveOwnProperty('last_updated_record')
// Unmatched Postman assertion: pm.expect(jsonResponse.attributes.length).to.equal(2)

});

it('Describe  SYSTEM schema as non-SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_table", "schema": "system" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Your role does not have permission to view database metadata for 'system'"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('Describe  SYSTEM table as non-SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_table", "table": "hdb_user", "schema": "system" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Your role does not have permission to view database metadata for 'system'"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('List Users does not return protected info', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "list_users" })
		.expect(200)
// Unmatched Postman assertion: jsonResponse.forEach(user => {
// Unmatched Postman assertion: pm.expect(user.password).to.be.undefined;
// Unmatched Postman assertion: pm.expect(user.hash).to.be.undefined;
// Unmatched Postman assertion: pm.expect(user.refresh_token).to.be.undefined;

});

it('Drop test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_user", "username": "test_user" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "test_user successfully deleted"))
});

it('Drop_role - non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_role", "id": "{{role_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "test_dev_role successfully deleted"))
});

it('Add non-SU role with NO PERMS', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "add_role", "role": "developer_test_no_perms", "permission": { "super_user": false } })
		.expect(200)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)
// Unmatched Postman assertion: postman.setEnvironmentVariable("role_id", responseData.id)})
});

it('Add User with new NO PERMS Role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_user",
			"role": "developer_test_no_perms",
			"username": "no_perms_user",
			"password": "{{password}}",
			"active": true
		})
		.expect(200)
});

it('Describe All - test user NO PERMS', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_all" })
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonResponse).to.eql({}))
});

it('Describe Schema - test user NO PERMS', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_schema", "schema": "northnwd" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "database 'northnwd' does not exist"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('Describe Table - test user NO PERMS', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_table", "schema": "northnwd", "table": "region" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Table 'northnwd.region' does not exist"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('Drop no_perms_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_user", "username": "no_perms_user" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'no_perms_user successfully deleted'))
});

it('Drop_role - NO PERMS role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_role", "id": "{{role_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'developer_test_no_perms successfully deleted'))
});

it('Add non-SU role with perm for ONE table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "developer_test_one_perm",
			"permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"employees": {
							"read": true,
							"insert": true,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "city",
								"read": false,
								"insert": true,
								"update": false
							}, {
								"attribute_name": "firstname",
								"read": true,
								"insert": true,
								"update": false
							}, {
								"attribute_name": "lastname",
								"read": true,
								"insert": true,
								"update": false
							}, { "attribute_name": "region", "read": false, "insert": false, "update": false }]
						}
					}
				}
			}
		})
		.expect(200)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)
// Unmatched Postman assertion: postman.setEnvironmentVariable("role_id", responseData.id)})
});

it('Add User with new ONE PERM Role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_user",
			"role": "developer_test_one_perm",
			"username": "one_perm_user",
			"password": "{{password}}",
			"active": true
		})
		.expect(200)
});

it('Describe All - test user ONE TABLE PERM', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_all" })
		.expect(200)
// Unmatched Postman assertion: pm.expect(Object.keys(jsonResponse).length).to.eql(1)
// Unmatched Postman assertion: pm.expect(Object.keys(jsonResponse.northnwd).length).to.eql(1)
// Unmatched Postman assertion: pm.expect(Object.keys(jsonResponse.northnwd.employees).length).to.eql(11)
// Unmatched Postman assertion: pm.expect(jsonResponse.northnwd.employees.db_size).to.be.a('number')
// Unmatched Postman assertion: pm.expect(jsonResponse.northnwd.employees.attributes.length).to.eql(4)})
});

it('Describe Schema - restricted schema - non-SU test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_schema", "schema": "dev" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "database 'dev' does not exist"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('Describe Schema - non-SU test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_schema", "schema": "northnwd" })
		.expect(200)
// Unmatched Postman assertion: var expected_schema = {
// Unmatched Postman assertion: northnwd: {
// Unmatched Postman assertion: employees: ["employeeid", "city", "firstname", "lastname"]
// Unmatched Postman assertion: }
// Unmatched Postman assertion: }

// Unmatched Postman assertion: var response_arr = Object.values(jsonResponse)
// Unmatched Postman assertion: pm.expect(response_arr.length).to.eql(1)
// Unmatched Postman assertion: response_arr.forEach(table_data => {
// Unmatched Postman assertion: const { name, schema, attributes } = table_data;
// Unmatched Postman assertion: attributes.forEach(attr => {
// Unmatched Postman assertion: pm.expect(expected_schema[schema][name].includes(attr.attribute)).to.eql(true)
// Unmatched Postman assertion: })

});

it('Describe Table - restricted table - non-SU test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_table", "schema": "northnwd", "table": "shippers" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Table 'northnwd.shippers' does not exist"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
});

it('Describe Table - non-SU test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_table", "schema": "northnwd", "table": "employees" })
		.expect(200)
// Unmatched Postman assertion: let top_attributes = ["name", "schema", "id", "hash_attribute", "__updatedtime__", "__createdtime__", "attributes", "record_count"];
// Unmatched Postman assertion: var expected_attributes = ["employeeid", "city", "firstname", "lastname"];

// Unmatched Postman assertion: pm.expect(jsonResponse.schema).to.eql('northnwd')
// Unmatched Postman assertion: pm.expect(jsonResponse.name).to.eql('employees')
// Unmatched Postman assertion: jsonResponse.attributes.forEach(attr => {
// Unmatched Postman assertion: pm.expect(expected_attributes.includes(attr.attribute)).to.eql(true)
// Unmatched Postman assertion: })
// Unmatched Postman assertion: pm.expect(jsonResponse.attributes.length).to.equal(4)})
});

it('Drop one_perm_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_user", "username": "one_perm_user" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'one_perm_user successfully deleted'))
});

it('Drop_role - ONE TABLE PERMS role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_role", "id": "{{role_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'developer_test_one_perm successfully deleted'))
});

it('Add role with mismatched table/attr READ perms - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "developer_test",
			"permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"categories": {
							"read": false,
							"insert": true,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": true,
								"insert": true,
								"update": true
							}]
						}
					}
				}
			}
		})
		.expect(400)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)

		.expect((r) => assert.ok(r.body.error == "Errors in the role permissions JSON provided"))
		// Unmatched Postman assertion: "main_permissions")
		// Unmatched Postman assertion: })

		.expect((r) => assert.ok(r.body.main_permissions.length == 0))
// Unmatched Postman assertion: })

// Unmatched Postman assertion: pm.expect(responseData.schema_permissions.northnwd_categories[0]).to.equal("You have a conflict with TABLE permissions for 'northnwd.categories' being false and ATTRIBUTE permissions being true"))
});

it('Add role with non-boolean READ table perms - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "developer_test",
			"permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"categories": {
							"read": "Doooooh",
							"insert": true,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": true,
								"insert": true,
								"update": true
							}]
						}
					}
				}
			}
		})
		.expect(400)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)

		.expect((r) => assert.ok(r.body.error == "Errors in the role permissions JSON provided"))
		// Unmatched Postman assertion: "main_permissions")
		// Unmatched Postman assertion: })

		.expect((r) => assert.ok(r.body.main_permissions.length == 0))
// Unmatched Postman assertion: })

// Unmatched Postman assertion: pm.expect(responseData.schema_permissions.northnwd_categories.length).to.equal(1)
// Unmatched Postman assertion: pm.expect(responseData.schema_permissions.northnwd_categories[0]).to.equal("Table READ permission must be a boolean"))
});

it('Add role with non-boolean INSERT/DELETE perms - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "developer_test",
			"permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"categories": {
							"read": true,
							"insert": "Doooooh",
							"update": true,
							"delete": "Doooooh",
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": true,
								"insert": true,
								"update": true
							}]
						}
					}
				}
			}
		})
		.expect(400)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)

		.expect((r) => assert.ok(r.body.error == "Errors in the role permissions JSON provided"))
		// Unmatched Postman assertion: "main_permissions")
		// Unmatched Postman assertion: })

		.expect((r) => assert.ok(r.body.main_permissions.length == 0))
// Unmatched Postman assertion: })

// Unmatched Postman assertion: pm.expect(responseData.schema_permissions.northnwd_categories.length).to.equal(2)
// Unmatched Postman assertion: pm.expect(responseData.schema_permissions.northnwd_categories).to.includes("Table INSERT permission must be a boolean")
// Unmatched Postman assertion: pm.expect(responseData.schema_permissions.northnwd_categories).to.includes("Table DELETE permission must be a boolean"))
});

it('Add role with non-boolean READ and UPDATE attribute perms - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "developer_test",
			"permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"categories": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": "Doooooh",
								"insert": true,
								"update": "Doooooh"
							}]
						}
					}
				}
			}
		})
		.expect(400)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)

		.expect((r) => assert.ok(r.body.error == "Errors in the role permissions JSON provided"))
		// Unmatched Postman assertion: "main_permissions")
		// Unmatched Postman assertion: })

		.expect((r) => assert.ok(r.body.main_permissions.length == 0))
// Unmatched Postman assertion: })

// Unmatched Postman assertion: pm.expect(responseData.schema_permissions.northnwd_categories.length).to.equal(2)
// Unmatched Postman assertion: pm.expect(responseData.schema_permissions.northnwd_categories).to.include("READ attribute permission for 'description' must be a boolean")
// Unmatched Postman assertion: pm.expect(responseData.schema_permissions.northnwd_categories).to.include("UPDATE attribute permission for 'description' must be a boolean"))
});

it('Add role with mismatched table/attr INSERT perms - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "developer_test",
			"permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"categories": {
							"read": true,
							"insert": false,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": true,
								"insert": true,
								"update": true
							}]
						}
					}
				}
			}
		})
		.expect(400)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)

		.expect((r) => assert.ok(r.body.error == "Errors in the role permissions JSON provided"))
		// Unmatched Postman assertion: "main_permissions")
		// Unmatched Postman assertion: })

		.expect((r) => assert.ok(r.body.main_permissions.length == 0))
// Unmatched Postman assertion: })

// Unmatched Postman assertion: pm.expect(responseData.schema_permissions.northnwd_categories[0]).to.equal("You have a conflict with TABLE permissions for 'northnwd.categories' being false and ATTRIBUTE permissions being true")})
});

it('Add role with mismatched table/attr UPDATE perms - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "developer_test",
			"permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"categories": {
							"read": true,
							"insert": true,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": true,
								"insert": true,
								"update": true
							}]
						}
					}
				}
			}
		})
		.expect(400)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)

		.expect((r) => assert.ok(r.body.error == "Errors in the role permissions JSON provided"))
		// Unmatched Postman assertion: "main_permissions")
		// Unmatched Postman assertion: })

		.expect((r) => assert.ok(r.body.main_permissions.length == 0))
// Unmatched Postman assertion: })

// Unmatched Postman assertion: pm.expect(responseData.schema_permissions.northnwd_categories[0]).to.equal("You have a conflict with TABLE permissions for 'northnwd.categories' being false and ATTRIBUTE permissions being true")})
});

it('Add role with multiple mismatched table/attr perms - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "developer_test",
			"permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"categories": {
							"read": false,
							"insert": true,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": true,
								"insert": true,
								"update": true
							}]
						}
					}
				}
			}
		})
		.expect(400)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)

		.expect((r) => assert.ok(r.body.error == "Errors in the role permissions JSON provided"))
		// Unmatched Postman assertion: "main_permissions")
		// Unmatched Postman assertion: })

		.expect((r) => assert.ok(r.body.main_permissions.length == 0))
// Unmatched Postman assertion: })

// Unmatched Postman assertion: pm.expect(responseData.schema_permissions.northnwd_categories[0]).to.equal("You have a conflict with TABLE permissions for 'northnwd.categories' being false and ATTRIBUTE permissions being true")})
});

it('Add role with with misformed attr perms array key  - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "developer_test",
			"permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"categories": {
							"read": false,
							"insert": true,
							"update": false,
							"delete": false,
							"attribute_restrictions": [{
								"attribute_name": "description",
								"read": true,
								"insert": true,
								"update": true
							}]
						}
					}
				}
			}
		})
		.expect(400)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)

		.expect((r) => assert.ok(r.body.error == "Errors in the role permissions JSON provided"))
		// Unmatched Postman assertion: "main_permissions")
		// Unmatched Postman assertion: })

		.expect((r) => assert.ok(r.body.main_permissions.length == 0))
// Unmatched Postman assertion: })

// Unmatched Postman assertion: pm.expect(responseData.schema_permissions.northnwd_categories).to.include("Invalid table permission key value 'attribute_restrictions'")
// Unmatched Postman assertion: pm.expect(responseData.schema_permissions.northnwd_categories).to.include("Missing 'attribute_permissions' array"))
});

it('Add role with with missing attr perms for table  - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "developer_test",
			"permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"categories": {
							"read": false,
							"insert": true,
							"update": false,
							"delete": false
						}
					}
				}
			}
		})
		.expect(400)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)

		.expect((r) => assert.ok(r.body.error == "Errors in the role permissions JSON provided"))
		// Unmatched Postman assertion: "main_permissions")
		// Unmatched Postman assertion: })

		.expect((r) => assert.ok(r.body.main_permissions.length == 0))
// Unmatched Postman assertion: })

// Unmatched Postman assertion: pm.expect(responseData.schema_permissions.northnwd_categories[0]).to.equal("Missing 'attribute_permissions' array")})
});

it('Add role with with perms for non-existent schema  - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "developer_test",
			"permission": {
				"super_user": false,
				"wrong_schema": {
					"tables": {
						"categories": {
							"read": false,
							"insert": true,
							"update": false,
							"delete": false
						}
					}
				}
			}
		})
		.expect(400)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)

		.expect((r) => assert.ok(r.body.error == "Errors in the role permissions JSON provided"))
		// Unmatched Postman assertion: "main_permissions")
		// Unmatched Postman assertion: })

		.expect((r) => assert.ok(responseData.main_permissions.length == 1))
		.expect((r) => assert.ok(r.body.main_permissions[0] == "database 'wrong_schema' does not exist"))
// Unmatched Postman assertion: })

// Unmatched Postman assertion: pm.expect(Object.keys(responseData.schema_permissions).length).to.equal(0))
});

it('Add role with with perms for non-existent table  - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "developer_test",
			"permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"wrong_table": {
							"read": false,
							"insert": true,
							"update": false,
							"delete": false
						}
					}
				}
			}
		})
		.expect(400)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)

		.expect((r) => assert.ok(r.body.error == "Errors in the role permissions JSON provided"))
		// Unmatched Postman assertion: "main_permissions")
		// Unmatched Postman assertion: })

		.expect((r) => assert.ok(responseData.main_permissions.length == 1))
		.expect((r) => assert.ok(r.body.main_permissions[0] == "Table 'northnwd.wrong_table' does not exist"))
// Unmatched Postman assertion: })

// Unmatched Postman assertion: pm.expect(Object.keys(responseData.schema_permissions).length).to.equal(0))
});

it('Add SU role with perms  - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "developer_test",
			"permission": {
				"super_user": true,
				"northnwd": {
					"tables": {
						"categories": {
							"read": false,
							"insert": true,
							"update": false,
							"delete": false,
							"attribute_permissions": []
						}
					}
				}
			}
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == "Errors in the role permissions JSON provided"))
		.expect((r) => assert.ok(r.body.main_permissions.length == 1))
		.expect((r) => assert.ok(r.body.main_permissions[0] == "Roles with 'super_user' set to true cannot have other permissions set."))
		.expect((r) => assert.ok(Object.keys(r.body.schema_permissions).length == 0))
});

it('Add CU role with perms  - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "developer_test",
			"permission": {
				"cluster_user": true,
				"northnwd": {
					"tables": {
						"categories": {
							"read": false,
							"insert": true,
							"update": false,
							"delete": false,
							"attribute_permissions": []
						}
					}
				}
			}
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == "Errors in the role permissions JSON provided"))
		.expect((r) => assert.ok(r.body.main_permissions.length == 1))
		.expect((r) => assert.ok(r.body.main_permissions[0] == "Roles with 'cluster_user' set to true cannot have other permissions set."))
		.expect((r) => assert.ok(Object.keys(r.body.schema_permissions).length == 0))
});

it('Add non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role", "role": "test_dev_role", "permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"region": {
							"read": true,
							"insert": true,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "regiondescription",
								"read": true,
								"insert": true,
								"update": false
							}]
						},
						"territories": {
							"read": true,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": []
						},
						"categories": {
							"read": false,
							"insert": false,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": false,
								"insert": false,
								"update": false,
								"delete": true
							}]
						},
						"products": {
							"read": false,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "discontinued",
								"read": false,
								"insert": false,
								"update": false
							}]
						}
					}
				},
				"other": {
					"tables": {
						"owner": {
							"read": true,
							"insert": false,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "name",
								"read": false,
								"insert": false,
								"update": true
							}]
						}
					}
				},
				"another": {
					"tables": {
						"breed": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "name",
								"read": false,
								"insert": false,
								"update": false
							}]
						}
					}
				}
			}
		})
		.expect(200)
// Unmatched Postman assertion: postman.setEnvironmentVariable("role_id", r.body.id)})
});

it('Add User with non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_user",
			"role": "test_dev_role",
			"username": "test_user",
			"password": "{{password}}",
			"active": true
		})
		.expect(200)
});

it('system_information as non-SU - expect fail', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "system_information" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Operation 'systemInformation' is restricted to 'super_user' roles"))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('Drop test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_user", "username": "test_user" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "test_user successfully deleted"))
});

it('Drop_role - non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_role", "id": "{{role_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "test_dev_role successfully deleted"))
});

it('Add non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role", "role": "test_dev_role", "permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"region": {
							"read": true,
							"insert": true,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "regiondescription",
								"read": true,
								"insert": true,
								"update": false
							}]
						},
						"territories": {
							"read": true,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": []
						},
						"categories": {
							"read": false,
							"insert": false,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": false,
								"insert": false,
								"update": false,
								"delete": true
							}]
						},
						"products": {
							"read": false,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "discontinued",
								"read": false,
								"insert": false,
								"update": false
							}]
						}
					}
				},
				"other": {
					"tables": {
						"owner": {
							"read": true,
							"insert": false,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "name",
								"read": false,
								"insert": false,
								"update": true
							}]
						}
					}
				},
				"another": {
					"tables": {
						"breed": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "name",
								"read": false,
								"insert": false,
								"update": false
							}]
						}
					}
				}
			}
		})
		.expect(200)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)
// Unmatched Postman assertion: postman.setEnvironmentVariable("role_id", responseData.id)})
});

it('Add User with non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_user",
			"role": "test_dev_role",
			"username": "test_user",
			"password": "{{password}}",
			"active": true
		})
		.expect(200)
});

it('Query system table as SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_value",
			"table": "hdb_user",
			"schema": "system",
			"search_attribute": "username",
			"search_value": "{{username}}",
			"get_attributes": ["*"]
		})
		.expect(200)
// Unmatched Postman assertion: var objKeysData = Object.keys(jsonData[0])
// Unmatched Postman assertion: pm.expect(jsonData[0].username).to.eql(environment["username"])
// Unmatched Postman assertion: pm.expect(objKeysData.includes("password")).to.be.true;
// Unmatched Postman assertion: pm.expect(objKeysData.includes("role")).to.be.true;})
});

it('Query system table non SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_value",
			"table": "hdb_user",
			"schema": "system",
			"search_attribute": "username",
			"search_value": "{{username}}",
			"get_attributes": ["*"]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions[0]).to.eql('read')
		.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'system'))
		.expect((r) => assert.ok(r.body.unauthorized_access[0].table == 'hdb_user'))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('Insert record system table as non SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "system",
			"table": "hdb_user",
			"records": [{
				"username": "admin",
				"role": "0bffc136-0b0b-4582-8efe-44031f40d906",
				"password": "fakepassword",
				"active": true
			}]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions.length).to.eql(1)
		// Unmatched Postman assertion: pm.expect(jsonData.unauthorized_access[0].required_table_permissions[0]).to.eql('insert')
		.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'system'))
		.expect((r) => assert.ok(r.body.unauthorized_access[0].table == 'hdb_user'))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
});

it('Update record system table as non SU ', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"schema": "system",
			"table": "hdb_user",
			"records": [{
				"username": "admin",
				"role": "0bffc136-0b0b-4582-8efe-44031f40d906",
				"password": "fakepassword",
				"active": true
			}]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."))
});

it('Delete record system table as non SU ', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete", "schema": "system", "table": "hdb_user", "hash_values": ["admin1"] })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."))
});

it('Drop system table as SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_table", "schema": "system", "table": "hdb_user" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."))
});

it('Drop system table as non SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_table", "schema": "system", "table": "hdb_user" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."))
});

it('Drop test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_user", "username": "test_user" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "test_user successfully deleted"))
});

it('Drop_role - non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_role", "id": "{{role_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "test_dev_role successfully deleted"))
});

it('SQL update system table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "UPDATE system.hdb_user SET name = 'jerry' where id = 1" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."))
});

it('SQL delete system table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "delete from system.hdb_user where id = 1" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."))
});

it('Delete attribute from system table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_attribute", "schema": "system", "table": "hdb_user", "attribute": "password" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."))
});

it('Add non-SU role for schema tests', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role", "role": "test_schema_user", "permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"customers": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": []
						},
						"suppliers": {
							"read": false,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": []
						},
						"region": {
							"read": true,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "regiondescription",
								"read": true,
								"insert": false,
								"update": false,
								"delete": false
							}]
						},
						"territories": {
							"read": true,
							"insert": true,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "territorydescription",
								"read": true,
								"insert": true,
								"update": false,
								"delete": false
							}]
						},
						"categories": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": true,
								"insert": true,
								"update": true,
								"delete": false
							}]
						},
						"shippers": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "companyname",
								"read": false,
								"insert": false,
								"update": false,
								"delete": false
							}]
						}
					}
				},
				"dev": {
					"tables": {
						"dog": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "__createdtime__",
								"read": true,
								"insert": true,
								"update": true
							}, {
								"attribute_name": "__updatedtime__",
								"read": true,
								"insert": true,
								"update": true
							}, {
								"attribute_name": "age",
								"read": true,
								"insert": true,
								"update": false
							}, {
								"attribute_name": "dog_name",
								"read": true,
								"insert": false,
								"update": true
							}, {
								"attribute_name": "adorable",
								"read": true,
								"insert": true,
								"update": true
							}, { "attribute_name": "owner_id", "read": false, "insert": true, "update": true }]
						},
						"breed": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "__createdtime__",
								"read": false,
								"insert": false,
								"update": true
							}, { "attribute_name": "__updatedtime__", "read": false, "insert": true, "update": true }]
						}
					}
				}
			}
		})
		.expect(200)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)
// Unmatched Postman assertion: postman.setEnvironmentVariable("role_id", responseData.id)})
});

it('Add test_user  with new role for schema error tests', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_user",
			"role": "test_schema_user",
			"username": "test_user",
			"password": "{{password}}",
			"active": true
		})
		.expect(200)
});

it('NoSQL - Non-SU search on schema that doesnt
exist
as
test_user - expect
error
', async () => {
const response = await request(envUrl)
	.post('')
	.set(headers)
	.send({
		"operation": "search_by_value",
		"schema": "rick_rolled",
		"table": "{{regi_tb}}",
		"hash_attribute": "id",
		"search_attribute": "id",
		"search_value": "*",
		"get_attributes": ["*"]
	})
	.expect(403)
	.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
	.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
	.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
	.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "database 'rick_rolled' does not exist"))
})
;

it('NoSQL - SU search on schema that doesnt
exist
as
test_user - expect
error
', async () => {
const response = await request(envUrl)
	.post('')
	.set(headers)
	.send({
		"operation": "search_by_value",
		"schema": "rick_rolled",
		"table": "{{regi_tb}}",
		"hash_attribute": "id",
		"search_attribute": "id",
		"search_value": "*",
		"get_attributes": ["*"]
	})
	.expect(404)
	.expect((r) => assert.ok(r.body.error == "database 'rick_rolled' does not exist"))
})
;

it('NoSQL - Non-SU search on table that doesnt exist as test_user - expect error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_value",
			"schema": "dev",
			"table": "rick_rolled",
			"hash_attribute": "id",
			"search_attribute": "id",
			"search_value": "*",
			"get_attributes": ["*"]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
		.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
		.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Table 'dev.rick_rolled' does not exist"))
});

it('NoSQL - SU search on table that doesnt
exist
as
test_user - expect
error
', async () => {
const response = await request(envUrl)
	.post('')
	.set(headers)
	.send({
		"operation": "search_by_value",
		"schema": "dev",
		"table": "rick_rolled",
		"hash_attribute": "id",
		"search_attribute": "id",
		"search_value": "*",
		"get_attributes": ["*"]
	})
	.expect(404)
	.expect((r) => assert.ok(r.body.error == "Table 'dev.rick_rolled' does not exist"))
})
;

it('SQL - Non-SU select on schema that doesnt
exist
as
test_user - expect
error
', async () => {
const response = await request(envUrl)
	.post('')
	.set(headers)
	.send({ "operation": "sql", "sql": "SELECT * FROM rick_rolled.{{regi_tb}}" })
	.expect(403)
	.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
	.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
	.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
	.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "database 'rick_rolled' does not exist"))
})
;

it('SQL - SU search on schema that doesnt
exist
as
test_user - expect
error
', async () => {
const response = await request(envUrl)
	.post('')
	.set(headers)
	.send({ "operation": "sql", "sql": "SELECT * FROM rick_rolled.{{regi_tb}}" })
	.expect(404)
	.expect((r) => assert.ok(r.body.error == "database 'rick_rolled' does not exist"))
})
;

it('SQL - Non-SU search on table that doesnt
exist
as
test_user - expect
error
', async () => {
const response = await request(envUrl)
	.post('')
	.set(headers)
	.send({ "operation": "sql", "sql": "SELECT * FROM dev.rick_rolled" })
	.expect(403)
	.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
	.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
	.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
	.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Table 'dev.rick_rolled' does not exist"))
})
;

it('SQL - SU search on table that doesnt
exist
as
test_user - expect
error
', async () => {
const response = await request(envUrl)
	.post('')
	.set(headers)
	.send({ "operation": "sql", "sql": "SELECT * FROM dev.rick_rolled" })
	.expect(404)
	.expect((r) => assert.ok(r.body.error == "Table 'dev.rick_rolled' does not exist"))
})
;

it('Drop test_user for search schema error checks', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_user", "username": "test_user" })
		.expect(200)
});

it('Drop role for search schema error checks', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_role", "id": "{{role_id}}" })
		.expect(200)
});

it('Insert record into table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"database": "system",
			"table": "hdb_nodes",
			"records": [{ "name": "my-node", "url": "lets-test" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "inserted 1 of 1 records"))
// Unmatched Postman assertion: pm.expect(jsonData.inserted_hashes[0]).to.eql("my-node"))
});

it('Update record into table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"database": "system",
			"table": "hdb_nodes",
			"records": [{ "name": "my-node", "url": "updated-url" }]
		})
		.expect((r) => assert.ok(r.body.message == 'updated 1 of 1 records', 'Expected response message to eql "updated 1 of 1 records"'))
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData.update_hashes[0]).to.eql("my-node"))
});

it('Confirm record in table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_id",
			"database": "system",
			"table": "hdb_nodes",
			"ids": ["my-node"],
			"get_attributes": ["*"]
		})
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData[0].name).to.eql("my-node")
// Unmatched Postman assertion: pm.expect(jsonData[0].url).to.eql("updated-url"))
});

it('Confirm table cant be dropped', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_table", "database": "system", "table": "hdb_nodes" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."))
});

it('Insert record into hdb cert doesnt work', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"database": "system",
			"table": "hdb_certificate",
			"records": [{ "name": "my-node", "url": "lets-test" }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
});

it('Add non-SU role to test with', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "add_role", "role": "important-role", "permission": { "structure_user": true } })
		.expect(200)
});

it('Create user with new role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_user",
			"role": "important-role",
			"username": "important-user",
			"password": "password",
			"active": true
		})
		.expect(200)
});

it('Update role table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"database": "system",
			"table": "hdb_role",
			"records": [{ "id": "important-role", "test": true }]
		})
		.expect((r) => assert.ok(r.body.message == 'updated 1 of 1 records', 'Expected response message to eql "updated 1 of 1 records"'))
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData.update_hashes[0]).to.eql("important-role"))
});

it('Update user table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"database": "system",
			"table": "hdb_user",
			"records": [{ "username": "important-user", "test": true }]
		})
		.expect((r) => assert.ok(r.body.message == 'updated 1 of 1 records', 'Expected response message to eql "updated 1 of 1 records"'))
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData.update_hashes[0]).to.eql("important-user"))
});

it('Test Update role table non-SU doesnt work', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"database": "system",
			"table": "hdb_role",
			"records": [{ "id": "important-role", "test": true }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."))
});

it('Test Update user table non-SU doesnt work', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"database": "system",
			"table": "hdb_user",
			"records": [{ "username": "important-user", "test": true }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."))
});

it('Test insert when non-SU doesnt work', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"database": "system",
			"table": "hdb_nodes",
			"records": [{ "name": "my-node", "url": "no-go" }]
		})
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
});

it('Test delete when non-SU doesnt work', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete", "database": "system", "table": "hdb_nodes", "ids": ["my-node"] })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."))
});

it('Delete record from table', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete", "database": "system", "table": "hdb_nodes", "ids": ["my-node"] })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "1 of 1 record successfully deleted"))
// Unmatched Postman assertion: pm.expect(jsonData.deleted_hashes[0]).to.eql("my-node"))
});

it('Drop user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_user", "username": "important-user" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "important-user successfully deleted"))
});

it('Drop role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_role", "id": "important-role" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "important-role successfully deleted"))
});

it('Add non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "test_dev_role",
			"permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"customers": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": []
						},
						"suppliers": {
							"read": false,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": []
						},
						"region": {
							"read": true,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "regiondescription",
								"read": true,
								"insert": false,
								"update": false
							}]
						},
						"territories": {
							"read": true,
							"insert": true,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "territorydescription",
								"read": true,
								"insert": true,
								"update": false
							}]
						},
						"categories": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": true,
								"insert": true,
								"update": true
							}]
						},
						"shippers": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "companyname",
								"read": false,
								"insert": false,
								"update": false
							}]
						}
					}
				}
			}
		})
		.expect(200)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)
// Unmatched Postman assertion: postman.setEnvironmentVariable("role_id", responseData.id)})
});

it('Add non-SU role w/ same name', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "add_role", "role": "test_dev_role", "permission": { "super_user": false } })
		.expect(409)

		.expect((r) => assert.ok(r.body.error == "A role with name 'test_dev_role' already exists"))
});

it('Query HDB as bad user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_value",
			"table": "hdb_user",
			"schema": "system",
			"search_attribute": "username",
			"search_value": "{{username}}",
			"get_attributes": ["*"]
		})
		.expect(401)
		.expect((r) => assert.ok(r.body.error == "Login failed"))
});

it('alter_role with bad data', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "alter_role",
			"role": "bad_user_2",
			"id": "{{role_id}}",
			"permission": {
				"super_user": false,
				"crapschema": {
					"tables": {
						"blahblah": {
							"read": false,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "name",
								"read": false,
								"insert": false,
								"update": true
							}]
						}
					}
				},
				"dev": {
					"tables": {
						"craptable": {
							"read": false,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "name",
								"read": false,
								"insert": false,
								"update": true
							}]
						},
						"dog": {
							"read": false,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "name",
								"read": false,
								"insert": false,
								"update": true
							}, { "attribute_name": "crapattribute", "read": false, "insert": false, "update": true }]
						}
					}
				}
			}
		})
		.expect(400)
// Unmatched Postman assertion: pm.expect(jsonResponse.main_permissions.length).to.eql(2)
// Unmatched Postman assertion: pm.expect(jsonResponse.main_permissions.includes("database 'crapschema' does not exist")).to.eql(true)
// Unmatched Postman assertion: pm.expect(jsonResponse.main_permissions.includes("Table 'dev.craptable' does not exist")).to.eql(true)

// Unmatched Postman assertion: pm.expect(jsonResponse.schema_permissions.dev_dog.length).to.eql(2)
// Unmatched Postman assertion: pm.expect(jsonResponse.schema_permissions.dev_dog.includes("Invalid attribute 'name' in 'attribute_permissions'")).to.eql(true)
// Unmatched Postman assertion: pm.expect(jsonResponse.schema_permissions.dev_dog.includes("Invalid attribute 'crapattribute' in 'attribute_permissions'")).to.eql(true))
});

it('list_roles ensure role not changed', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "list_roles" })
		.expect(200)

	Unmatched
	Postman
	assertion: pm.environment.set("found_role", undefined)
// Unmatched Postman assertion: for(let role of pm.response.json()) {
// Unmatched Postman assertion: if(role.role === "bad_user_2") {
// Unmatched Postman assertion: pm.environment.set("found_role", role)
// Unmatched Postman assertion: }
// Unmatched Postman assertion: }

// Unmatched Postman assertion: pm.expect(pm.environment.get("found_role")).to.eql(undefined))
});

it('alter_role good data', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "alter_role",
			"role": "user_role_update",
			"id": "{{role_id}}",
			"permission": {
				"super_user": false,
				"{{schema}}": {
					"tables": {
						"{{cust_tb}}": {
							"read": false,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "fax",
								"read": false,
								"insert": false,
								"update": false
							}]
						}
					}
				}
			}
		})
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonResponse.role).to.eql("user_role_update")
// Unmatched Postman assertion: pm.expect(jsonResponse.id).to.eql(pm.variables.get("role_id"))
// Unmatched Postman assertion: pm.expect(jsonResponse.permission.super_user).to.eql(false)
// Unmatched Postman assertion: pm.expect(jsonResponse.permission.northnwd.tables.customers).to.deep.eql({
// Unmatched Postman assertion: "read": false,
// Unmatched Postman assertion: "insert": false,
// Unmatched Postman assertion: "update": false,
// Unmatched Postman assertion: "delete": false,
// Unmatched Postman assertion: "attribute_permissions": [
// Unmatched Postman assertion: {
// Unmatched Postman assertion: "attribute_name": "fax",
// Unmatched Postman assertion: "read": false,
// Unmatched Postman assertion: "insert": false,
// Unmatched Postman assertion: "update": false
// Unmatched Postman assertion: }
// Unmatched Postman assertion: ]});
});

it('list_roles ensure role was updated', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "list_roles" })
		.expect(200)

	Unmatched
	Postman
	assertion: pm.environment.set("found_role", undefined)
// Unmatched Postman assertion: for(let role of pm.response.json()) {
// Unmatched Postman assertion: if(role.role === "user_role_update") {
// Unmatched Postman assertion: pm.environment.set("found_role", role)
// Unmatched Postman assertion: }
// Unmatched Postman assertion: }

// Unmatched Postman assertion: pm.expect(pm.environment.get("found_role").role).to.eql("user_role_update"))
});

it('Drop_role nonexistent role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_role", "id": "12345" })
		.expect(404)
		.expect((r) => assert.ok(r.body.error == "Role not found"))
});

it('Drop_role for non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_role", "id": "{{role_id}}" })
		.expect(200)
});

it('Add non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_role",
			"role": "developer_test_5",
			"permission": {
				"super_user": false,
				"northnwd": {
					"tables": {
						"customers": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": []
						},
						"suppliers": {
							"read": false,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": []
						},
						"region": {
							"read": true,
							"insert": false,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "regiondescription",
								"read": true,
								"insert": false,
								"update": false
							}]
						},
						"territories": {
							"read": true,
							"insert": true,
							"update": false,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "territorydescription",
								"read": true,
								"insert": true,
								"update": false
							}]
						},
						"categories": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": false,
							"attribute_permissions": [{
								"attribute_name": "description",
								"read": true,
								"insert": true,
								"update": true
							}]
						},
						"shippers": {
							"read": true,
							"insert": true,
							"update": true,
							"delete": true,
							"attribute_permissions": [{
								"attribute_name": "companyname",
								"read": false,
								"insert": false,
								"update": false
							}]
						}
					}
				}
			}
		})
		.expect(200)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)
// Unmatched Postman assertion: postman.setEnvironmentVariable("role_id", responseData.id)})
});

it('Add User with new Role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_user",
			"role": "developer_test_5",
			"username": "test_user",
			"password": "{{password}}",
			"active": true
		})
		.expect(200)
});

it('Alter User with empty role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "alter_user",
			"role": "",
			"username": "test_user",
			"password": "{{password}}",
			"active": true
		})
		.expect(500)
		.expect((r) => assert.ok(r.body.error == "If role is specified, it cannot be empty."))
});

it('Alter User set active to false.', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "alter_user", "username": "test_user", "password": "{{password}}", "active": false })
		.expect((r) => assert.ok(r.body.message == 'updated 1 of 1 records', 'Expected response message to eql "updated 1 of 1 records"'))
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData.update_hashes[0]).to.eql("test_user"))
});

it('Check for active=false', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "list_users" })
		.expect(200)

	Unmatched
	Postman
	assertion: for (let user of pm.response.json()) {
// Unmatched Postman assertion: if(user.username === "test_user") {
// Unmatched Postman assertion: pm.environment.set("found_user", user)
// Unmatched Postman assertion: }
// Unmatched Postman assertion: }

// Unmatched Postman assertion: let temp = pm.environment.get("found_user")
// Unmatched Postman assertion: pm.expect(temp.active).to.eql(false))
	}
)
	;

	it('Drop test user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ "operation": "drop_user", "username": "test_user" })
			.expect(200)
	});
});

it('Drop test non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_role", "id": "{{role_id}}" })
		.expect(200)
});

it('Create table for tests', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "schema": "dev", "table": "create_attr_test", "hash_attribute": "id" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('successfully created')))
});

it('Create Attribute for secondary indexing test', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_attribute", "schema": "dev", "table": "create_attr_test", "attribute": "owner_id" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "attribute 'dev.create_attr_test.owner_id' successfully created."))
});

it('Insert data for secondary indexing test', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"schema": "dev",
			"table": "create_attr_test",
			"records": [{ "id": 1, "dog_name": "Penny", "age": 5, "owner_id": 1 }, {
				"id": 2,
				"dog_name": "Harper",
				"age": 5,
				"owner_id": 3
			}, { "id": 3, "dog_name": "Alby", "age": 5, "owner_id": 1 }, {
				"id": 4,
				"dog_name": "Billy",
				"age": 4,
				"owner_id": 1
			}, { "id": 5, "dog_name": "Rose Merry", "age": 6, "owner_id": 2 }, {
				"id": 6,
				"dog_name": "Kato",
				"age": 4,
				"owner_id": 2
			}, { "id": 7, "dog_name": "Simon", "age": 1, "owner_id": 2 }, {
				"id": 8,
				"dog_name": "Gemma",
				"age": 3,
				"owner_id": 2
			}, { "id": 9, "dog_name": "Bode", "age": 8 }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "inserted 9 of 9 records"))
});

it('Confirm attribute secondary indexing works', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "sql", "sql": "select * from dev.create_attr_test where owner_id = 1" })
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData.length).to.eql(3))
});

it('Describe table DropAttributeTest', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_table", "table": "AttributeDropTest", "schema": "dev" })
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData.another_attribute).to.eql(undefined))
});

it('Create Attribute', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "create_attribute",
			"schema": "dev",
			"table": "AttributeDropTest",
			"attribute": "created_attribute"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "attribute 'dev.AttributeDropTest.created_attribute' successfully created."))
});

it('Confirm created attribute', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_table", "table": "AttributeDropTest", "schema": "dev" })
		.expect(200)
// Unmatched Postman assertion: let found = false;
// Unmatched Postman assertion: jsonData.attributes.forEach((attr) => {
// Unmatched Postman assertion: if (attr.attribute === 'created_attribute') {
// Unmatched Postman assertion: found = true;
// Unmatched Postman assertion: }Unmatched Postman assertion: pm.expect(found).to.be.true;})
});

it('Create existing attribute', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "create_attribute",
			"schema": "dev",
			"table": "AttributeDropTest",
			"attribute": "created_attribute"
		})
		.expect(400)
		.expect((r) => assert.ok(r.body.error == "attribute 'created_attribute' already exists in dev.AttributeDropTest"))
});

it('Drop Attribute', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "drop_attribute",
			"schema": "dev",
			"table": "AttributeDropTest",
			"attribute": "another_attribute"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted attribute 'another_attribute'"))
});

it('Describe table DropAttributeTest', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_table", "table": "AttributeDropTest", "schema": "dev" })
		.expect(200)
// Unmatched Postman assertion: let found = false;
// Unmatched Postman assertion: jsonData.attributes.forEach((attr) => {
// Unmatched Postman assertion: if (attr.attribute === 'another_attribute') {
// Unmatched Postman assertion: found = true;
// Unmatched Postman assertion: }Unmatched Postman assertion: pm.expect(found).to.be.false;})
});

it('Get Fingerprint', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_fingerprint" })
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData).to.haveOwnProperty('message')
// Unmatched Postman assertion: pm.expect(jsonData.message).to.not.be.null;})
});

it('Set License', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "set_license",
			"key": "uFFG7xAZG11ec9d335bfe27c4ec5555310bd4a27f",
			"company": "harperdb.io"
		})
		.expect(500)
		.expect((r) => assert.ok(r.body["error"] == "There was an error parsing the license key."))
});

it('Get Registration Info', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "registration_info" })
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData).to.have.ownProperty('registered')
// Unmatched Postman assertion: pm.expect(jsonData).to.have.ownProperty('version')
// Unmatched Postman assertion: pm.expect(jsonData).to.have.ownProperty('ram_allocation')
// Unmatched Postman assertion: pm.expect(jsonData).to.have.ownProperty('license_expiration_date'))
});

it('Set License Bad Key', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "set_license", "key": "", "company": "harperdb.io" })
		.expect(500)
		.expect((r) => assert.ok(r.body["error"] == "Invalid key or company specified for license file."))
});

it('Get Configuration', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_configuration" })
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData.clustering).to.not.be.undefined;
// Unmatched Postman assertion: pm.expect(jsonData.componentsRoot).to.not.be.undefined;
// Unmatched Postman assertion: pm.expect(jsonData.logging).to.not.be.undefined;
// Unmatched Postman assertion: pm.expect(jsonData.localStudio).to.not.be.undefined;
// Unmatched Postman assertion: pm.expect(jsonData.operationsApi).to.not.be.undefined;
// Unmatched Postman assertion: pm.expect(jsonData.operationsApi.network.port).to.not.be.undefined;
// Unmatched Postman assertion: pm.expect(jsonData.threads).to.not.be.undefined;
});

it('Cluster set routes hub', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "cluster_set_routes",
			"server": "hub",
			"routes": [{ "host": "dev.chicken", "port": 11334 }, { "host": "dev.wing", "port": 11335 }]
		})
		.expect(200)
		.expect((r) => assert.ok(JSON.stringify(r.body) == '{"message":"cluster routes successfully set","set":[{"host":"dev.chicken","port":11334},{"host":"dev.wing","port":11335}],"skipped":[]}'))
});

it('Cluster set routes leaf', async () => {
	const expected = '{"message":"cluster routes successfully set","set":[{"host":"dev.pie","port":11335}],"skipped":[{"host":"dev.chicken","port":11334}]}';
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "cluster_set_routes",
			"server": "leaf",
			"routes": [{ "host": "dev.chicken", "port": 11334 }, { "host": "dev.pie", "port": 11335 }]
		})
		.expect(200)
		.expect((r) => assert.ok(JSON.stringify(r.body) == expected))
});

it('Confirm routes set', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_configuration" })
		.expect(200)
		.expect((r) => assert.ok(JSON.stringify(r.body.clustering.hubServer.cluster.network.routes) == '[{"host":"dev.chicken","port":11334},{"host":"dev.wing","port":11335}]'))
		.expect((r) => assert.ok(JSON.stringify(r.body.clustering.leafServer.network.routes) == '[{"host":"dev.pie","port":11335}]'))
});

it('Cluster get routes', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "cluster_get_routes" })
		.expect(200)
		.expect((r) => assert.ok(JSON.stringify(r.body) == '{"hub":[{"host":"dev.chicken","port":11334},{"host":"dev.wing","port":11335}],"leaf":[{"host":"dev.pie","port":11335}]}'))
});

it('Cluster delete routes', async () => {
	const expected_result = `{
"message": "cluster routes successfully deleted",
"deleted": [ { "host": "dev.wing","port": 11335 },{"host": "dev.pie","port": 11335 }],
"skipped": [ { "host": "dev.pie", "port": 11221 }]
}`
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "cluster_delete_routes",
			"routes": [{ "host": "dev.wing", "port": 11335 }, { "host": "dev.pie", "port": 11335 }, {
				"host": "dev.pie",
				"port": 11221
			}]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body == expected_result))
});

it('Cluster get routes confirm delete', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "cluster_get_routes" })
		.expect(200)
		.expect((r) => assert.ok(JSON.stringify(r.body) == '{"hub":[{"host":"dev.chicken","port":11334}],"leaf":[]}'))
});

it('Cluster delete last route', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "cluster_delete_routes", "routes": [{ "host": "dev.chicken", "port": 11334 }] })
		.expect(200)
		.expect((r) => assert.ok(JSON.stringify(r.body) == '{"message":"cluster routes successfully deleted","deleted":[{"host":"dev.chicken","port":11334}],"skipped":[]}'))
});

it('Read log', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "read_log" })
		.expect(200)
// Unmatched Postman assertion: pm.expect(Array.isArray(json_data)).to.be.true;
// Unmatched Postman assertion: pm.expect(json_data[0].hasOwnProperty('level')).to.be.true;
// Unmatched Postman assertion: pm.expect(json_data[0].hasOwnProperty('message')).to.be.true;
// Unmatched Postman assertion: pm.expect(json_data[0].hasOwnProperty('timestamp')).to.be.true;})
});

it('Set Configuration', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "set_configuration", "logging_rotation_maxSize": "12M" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "Configuration successfully set. You must restart HarperDB for new config settings to take effect."))
});

it('Confirm Configuration', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "get_configuration" })
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData.logging.rotation.maxSize).to.equal("12M")
});

it('Set Configuration Bad Data', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "set_configuration", "http_cors": "spinach" })
		.expect(400)
		.expect((r) => assert.ok(r.body.error == "HarperDB config file validation error: 'http.cors' must be a boolean"))
});

it('Add non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "add_role", "role": "test_dev_role", "permission": { "super_user": false } })
		.expect(200)

	Unmatched
	Postman
	assertion: responseData = JSON.parse(responseBody)
// Unmatched Postman assertion: postman.setEnvironmentVariable("role_id", responseData.id)})
});

it('Add User with non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "add_user",
			"role": "test_dev_role",
			"username": "test_user",
			"password": "{{password}}",
			"active": true
		})
		.expect(200)
});

it('Configure Cluster non-SU', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "set_configuration", "clustering_port": 99999 })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Operation 'setConfiguration' is restricted to 'super_user' roles"))
});

it('Set Configuration non-SU', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "set_configuration", "clustering_port": 99999 })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Operation 'setConfiguration' is restricted to 'super_user' roles"))
});

it('Get Configuration non-SU', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "get_configuration" })
		.expect(403)
		.expect((r) => assert.ok(r.body.error == "This operation is not authorized due to role restrictions and/or invalid database items"))
		.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
		.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Operation 'getConfiguration' is restricted to 'super_user' roles"))
});

it('Drop test_user', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_user", "username": "test_user" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "test_user successfully deleted"))
});

it('Drop_role - non-SU role', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_role", "id": "{{role_id}}" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "test_dev_role successfully deleted"))
});

it('Test local studio HTML is returned', async () => {
	const response = await request(envUrl)
		.get('')
		.set(headers)
		.expect(200)
		.expect('header', 'text/html; charset=UTF-8', 'undefined')  // Unmatched Postman assertion: const response = pm.response.text()
// Unmatched Postman assertion: pm.expect(response).to.include('<!doctype html>')
// Unmatched Postman assertion: pm.expect(response).to.include('Studio :: HarperDB'))
});

it('Get all System Information', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "system_information" })
		.expect(200)

		// Unmatched Postman assertion: let attributes = ['system', 'time', 'cpu', 'memory', 'disk', 'network', 'harperdb_processes', 'table_size'];

		// Unmatched Postman assertion: attributes.forEach(attribute=>{
		.expect((r) => assert.ok(r.body[attribute] != undefined))
//Unmatched Postman assertion: }))
});

it('Get some System Information (time, memory)', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "system_information", "attributes": ["memory", "time"] })
		.expect(200)
		.expect((r) => assert.ok(!r.body.system))
		.expect((r) => assert.ok(!r.body.cpu))
		.expect((r) => assert.ok(!r.body.disk))
		.expect((r) => assert.ok(!r.body.network))
		.expect((r) => assert.ok(!r.body.harperdb_processes))
		.expect((r) => assert.ok(!r.body.table_size))
		.expect((r) => assert.ok(r.body.hasOwnProperty('time')))
		.expect((r) => assert.ok(r.body.hasOwnProperty('memory')))
		.expect((r) => assert.ok(r.body.time.hasOwnProperty('current')))
		.expect((r) => assert.ok(r.body.time.hasOwnProperty('uptime')))
		.expect((r) => assert.ok(r.body.time.hasOwnProperty('timezone')))
		.expect((r) => assert.ok(r.body.time.hasOwnProperty('timezoneName')))
		.expect((r) => assert.ok(r.body.memory.hasOwnProperty('total')))
		.expect((r) => assert.ok(r.body.memory.hasOwnProperty('free')))
		.expect((r) => assert.ok(r.body.memory.hasOwnProperty('used')))
		.expect((r) => assert.ok(r.body.memory.hasOwnProperty('active')))
		.expect((r) => assert.ok(r.body.memory.hasOwnProperty('swaptotal')))
		.expect((r) => assert.ok(r.body.memory.hasOwnProperty('swapused')))
		.expect((r) => assert.ok(r.body.memory.hasOwnProperty('swapfree')))
		.expect((r) => assert.ok(r.body.memory.hasOwnProperty('available')))
});

it('Call create_authentication_tokens no username/pw', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_authentication_tokens" })
		.expect(400)
		.expect((r) => assert.ok(r.body["error"] === 'username is required'))
});

it('Call create_authentication_tokens no pw', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_authentication_tokens", "username": "{{username}}" })
		.expect(400)
		.expect((r) => assert.ok(r.body["error"] === 'password is required'))
});

it('Call create_authentication_tokens bad credentials', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_authentication_tokens", "username": "baduser", "password": "bad" })
		.expect(401)
		.expect((r) => assert.ok(r.body["error"] === 'invalid credentials'))
});

it('Call create_authentication_tokens happy path', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_authentication_tokens", "username": "{{username}}", "password": "{{password}}" })
		.expect(200)

		// Unmatched Postman assertion: let attributes = ['operation_token', 'refresh_token'];

		// Unmatched Postman assertion: attributes.forEach(attribute=>{
		.expect((r) => assert.ok(r.body[attribute] != undefined))
//Unmatched Postman assertion: pm.collectionVariables.set("operation_token", jsonData.operation_token)
// Unmatched Postman assertion: pm.collectionVariables.set("refresh_token", jsonData.refresh_token))
});

it('test search_by_hash with valid jwt', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_hash",
			"schema": "{{schema}}",
			"table": "{{emps_tb}}",
			"hash_attribute": "{{emps_id}}",
			"hash_values": [1],
			"get_attributes": ["*"]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
// Unmatched Postman assertion: pm.expect(jsonData[0].employeeid).to.eql(1))
});

it('test search_by_hash with invalid jwt', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_hash",
			"schema": "{{schema}}",
			"table": "{{emps_tb}}",
			"hash_attribute": "{{emps_id}}",
			"hash_values": [1],
			"get_attributes": ["*"]
		})
		.expect(401)
		.expect((r) => assert.ok(r.body.error == 'invalid token'))
});

it('test refresh_operation_token with correct token', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "refresh_operation_token" })
		.expect(200)

		// Unmatched Postman assertion: let attributes = ['operation_token'];

		// Unmatched Postman assertion: attributes.forEach(attribute=>{
		.expect((r) => assert.ok(r.body[attribute] != undefined))
//Unmatched Postman assertion: pm.collectionVariables.set("operation_token", jsonData.operation_token))
});

it('test refresh_operation_token with incorrect token', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "refresh_operation_token" })
		.expect(401)
		.expect((r) => assert.ok(r.body.error == 'invalid token'))
});

it('deploy_component github package', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			"operation": "deploy_component",
			"project": "deploy-test-gh",
			"package": "HarperDB/application-template"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "Successfully deployed: deploy-test-gh"))

	setTimeout(15000)
});

it('deploy_component using tar payload', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			"operation": "deploy_component",
			"project": "deploy-test-payload",
			"payload": "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dHRyLmNvbS5hcHBsZS5tZXRhZGF0YTprTURJdGVtVGV4dENvbnRlbnRMYW5ndWFnZT1icGxpc3QwMFJlbggAAAAAAAABAQAAAAAAAAABAAAAAAAAAAAAAAAAAAAACwoxMjMgTElCQVJDSElWRS54YXR0ci5jb20uYXBwbGUubWV0YWRhdGE6a01ESXRlbUtleXBocmFzZVZlcnNpb249WW5Cc2FYTjBNREFRREFnQUFBQUFBQUFCQVFBQUFBQUFBQUFCQUFBQUFBQUFBQUFBQUFBQUFBQUFDZwoxMDQgU0NISUxZLnhhdHRyLmNvbS5hcHBsZS5tZXRhZGF0YTprTURJdGVtS2V5cGhyYXNlVmVyc2lvbj1icGxpc3QwMBAMCAAAAAAAAAEBAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAKCjIwMyBMSUJBUkNISVZFLnhhdHRyLmNvbS5hcHBsZS5tZXRhZGF0YTprTURJdGVtS2V5cGhyYXNlTGFiZWxzPVluQnNhWE4wTURDakFRSURYbVp5WldVZ2IyWWdZMmhoY21kbFh4QVRaRzlqZFcxbGJuUmhkR2x2YmlCbWFXeGxjMThRRUhCbGNuTnZiaUJ2WW5SaGFXNXBibWNJREJzeEFBQUFBQUFBQVFFQUFBQUFBQUFBQkFBQUFBQUFBQUFBQUFBQUFBQUFBRVEKMTY0IFNDSElMWS54YXR0ci5jb20uYXBwbGUubWV0YWRhdGE6a01ESXRlbUtleXBocmFzZUxhYmVscz1icGxpc3QwMKMBAgNeZnJlZSBvZiBjaGFyZ2VfEBNkb2N1bWVudGF0aW9uIGZpbGVzXxAQcGVyc29uIG9idGFpbmluZwgMGzEAAAAAAAABAQAAAAAAAAAEAAAAAAAAAAAAAAAAAAAARAoxNjkgTElCQVJDSElWRS54YXR0ci5jb20uYXBwbGUubWV0YWRhdGE6a01ESXRlbUtleXBocmFzZUNvbmZpZGVuY2VzPVluQnNhWE4wTURDakFRSURJei9VM1FVM1NMSkFJei9INGlnQUFBQUFJeitENXlBQUFBQUFDQXdWSGdBQUFBQUFBQUVCQUFBQUFBQUFBQVFBQUFBQUFBQUFBQUFBQUFBQUFBQW4KMTQwIFNDSElMWS54YXR0ci5jb20uYXBwbGUubWV0YWRhdGE6a01ESXRlbUtleXBocmFzZUNvbmZpZGVuY2VzPWJwbGlzdDAwowECAyM/1N0FN0iyQCM/x+IoAAAAACM/g+cgAAAAAAgMFR4AAAAAAAABAQAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAJwoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC4vTElDRU5TRQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwMDA2NDQgADAwMDc2NSAAMDAwMDI0IAAwMDAwMDAwMjA1NiAxNDQ3MDY3NDQ2MCAwMTQzNjEAIDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAdXN0YXIAMDBkYXZpZGNvY2tlcmlsbAAAAAAAAAAAAAAAAAAAAAAAAHN0YWZmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDAwMDAwIAAwMDAwMDAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATUlUIExpY2Vuc2UKCkNvcHlyaWdodCAoYykgMjAyMyBIYXJwZXJEQiwgSW5jLgoKUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGEgY29weQpvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSAiU29mdHdhcmUiKSwgdG8gZGVhbAppbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzCnRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwKY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdCBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzCmZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6CgpUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZCBpbiBhbGwKY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS4KClRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCAiQVMgSVMiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTIE9SCklNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0YgTUVSQ0hBTlRBQklMSVRZLApGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBB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IGJ1aWxkaW5nIGFwcGxpY2F0aW9ucyB3aXRoIEhhcnBlckRCLiBUbyBnZXQgc3RhcnRlZCwgbWFrZSBzdXJlIHlvdSBoYXZlIFtpbnN0YWxsZWQgSGFycGVyREJdKGh0dHBzOi8vZG9jcy5oYXJwZXJkYi5pby9kb2NzL2luc3RhbGwtaGFycGVyZGIpLCB3aGljaCBjYW4gYmUgcXVpY2tseSBkb25lIHdpdGggYG5wbSBpbnN0YWxsIC1nIGhhcnBlcmRiYC4gWW91IGNhbiBydW4geW91ciBhcHBsaWNhdGlvbiBmcm9tIHRoZSBkaXJlY3Rvcnkgd2hlcmUgeW91IGRvd25sb2FkZWQgdGhlIGNvbnRlbnRzIG9mIHRoaXMgcmVwb3NpdG9yeSB3aXRoOgoKYGhhcnBlcmRiIHJ1biAvcGF0aC90by95b3VyLWFwcGAKCihvciBpZiB5b3UgZW50ZXIgdGhhdCBkaXJlY3RvcnksIHlvdSBjYW4gcnVuIHRoZSBjdXJyZW50IGRpcmVjdG9yeSBhcyBgaGFycGVyZGIgcnVuIC5gKS4KCkZvciBtb3JlIGluZm9ybWF0aW9uIGFib3V0IGdldHRpbmcgc3RhcnRlZCB3aXRoIEhhcnBlckRCIGFuZCBidWlsZGluZyBhcHBsaWNhdGlvbnMsIHNlZSBvdXIgZ2V0dGluZyBzdGFydGVkIGd1aWRlLgoKVGhpcyB0ZW1wbGF0ZSBpbmNsdWRlcyB0aGUgW2RlZmF1bHQgY29uZmlndXJhdGlvbl0oLi9jb25maWcueWFtbCksIHdoaWNoIHNwZWNpZmllcyBob3cgZmlsZXMgYXJlIGhhbmRsZWQgaW4geW91ciBhcHBsaWNhdGlvbi4KClRoZSBbc2NoZW1hLmdyYXBocWxdKC4vc2NoZW1hLmdyYXBocWwpIGlzIHRoZSBzY2hlbWEgZGVmaW5pdGlvbi4gVGhpcyBpcyB0aGUgbWFpbiBzdGFydGluZyBwb2ludCBmb3IgZGVmaW5pbmcgeW91ciBkYXRhYmFzZSBzY2hlbWEsIHNwZWNpZnlpbmcgd2hpY2ggdGFibGVzIHlvdSB3YW50IGFuZCB3aGF0IGF0dHJpYnV0ZXMvZmllbGRzIHRoZXkgc2hvdWxkIGhhdmUuCgpUaGUgW3Jlc291cmNl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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "Successfully deployed: deploy-test-payload"))
});

it('deploy_component using tar.gz payload', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			"operation": "deploy_component",
			"project": "deploy-test-payload-tar-gz",
			"restart": true,
			"payload": "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"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "Successfully deployed: deploy-test-payload-tar-gz, restarting HarperDB"))

	setTimeout(30000)
});

it('call component tar payload', async () => {
	const response = await request(envUrlRest)
		.get('/GreetingTar')
		.expect(200)
		.expect((r) => assert.ok(r.body.greeting == "Hello world from a test for deploying a component with tar payload"))
});

it('call component tar.gz payload', async () => {
	const response = await request(envUrlRest)
		.get('/GreetingTarGz')
		.expect(200)
		.expect((r) => assert.ok(r.body.greeting == "Hello world from deploy test payload tar gz"))
});

it('set_component_file', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			"operation": "set_component_file",
			"project": "set-test",
			"file": "utils/test.js",
			"payload": "I am from inside a JS file",
			"encoding": "utf8"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "Successfully set component: utils/test.js"))
});

it('get_component_file', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "get_component_file", "project": "set-test", "file": "utils/test.js", "encoding": "utf8" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "I am from inside a JS file"))
});

it('add_component', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "add_component", "project": "add-test" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "Successfully added project: add-test"))
});

it('package_component', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "package_component", "project": "add-test" })
		.expect(200)
		.expect((r) => assert.ok(r.body.hasOwnProperty('project')))
		.expect((r) => assert.ok(r.body.hasOwnProperty('payload')))
});

it('get_components', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "get_components" })
		.expect(200)
		.expect((r) => {
			assert.ok(r.body.entries.length == 5);
			let gh_found = false;
			let payload_found = false;
			let add_test_found = false;
			let set_test_found = false;
			let deploy_tar_gz_found = false;
			r.body.entries.forEach((e) => {
				let name = e.name;
				if (name === 'deploy-test-gh') gh_found = true;
				if (name === 'deploy-test-payload') payload_found = false;
				if (name === 'add-test') add_test_found = true;
				if (name === 'set-test') set_test_found = true;
				if (name === 'deploy-test-payload-tar-gz' && e.entries.length === 6) deploy_tar_gz_found = true;
			})
			assert.ok(gh_found && !payload_found && add_test_found && set_test_found && deploy_tar_gz_found);
		})
});

it('drop_component', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "drop_component", "project": "add-test" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "Successfully dropped: add-test"))
});

it('get_components after drop', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "get_components" })
		.expect(200)
		.expect((r) => {
			assert.ok(r.body.entries.length == 4);
			let gh_found = false;
			let payload_found = false;
			let set_test_found = false;
			r.body.entries.forEach((e) => {
				let name = e.name;
				if (name === 'deploy-test-gh') gh_found = true;
				if (name === 'deploy-test-payload') payload_found = true;
				if (name === 'set-test') set_test_found = true;
			})
			assert.ok(gh_found && payload_found && set_test_found);
		})
});

it('drop_component set-test', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "drop_component", "project": "set-test" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "Successfully dropped: set-test"))
});

it('add custom function project', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "add_custom_function_project", "project": "test_project" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "Successfully added project: test_project"))
});

it('restart service', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "restart_service", "service": "http_workers" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "Restarting http_workers")
//Unmatched Postman assertion: // This timeout is here to give HDB time to restart before the next text is ran.
	setTimeout(60000)
});

it('get custom function status', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "custom_functions_status" })
		.expect(200)
		.expect((r) => assert.ok(r.body.hasOwnProperty('port')))
		.expect((r) => assert.ok(r.body.hasOwnProperty('directory')))
// Unmatched Postman assertion: pm.environment.set('cf_port', json_data.port))
});

it('call custom function', async () => {
	const response = await request(envUrlRest)
		.get('/Greeting')
		.expect(200)
		.expect((r) => assert.ok(r.body.hasOwnProperty('greeting')))
});

it('set custom function', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			"operation": "set_custom_function",
			"project": "test_project",
			"type": "routes",
			"file": "test2",
			"function_content": "hello world"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "Successfully updated custom function: test2.js"))
});

it('get custom function', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "get_custom_function", "project": "test_project", "type": "routes", "file": "test2" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "hello world"))
});

it('drop custom function', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "drop_custom_function", "project": "test_project", "type": "routes", "file": "test2" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "Successfully deleted custom function: test2.js"))
});

it('confirm function was dropped', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "get_custom_function", "project": "test_project", "type": "routes", "file": "test2" })
		.expect(400)  // Unmatched Postman assertion: const json_data = pm.response.json()
// Unmatched Postman assertion: pm.expect(json_data.error).to.equal("File does not exist"))
});

it('get custom functions', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "get_custom_functions" })
		.expect(200)

// Unmatched Postman assertion: const json_data = pm.response.json()
// Unmatched Postman assertion: pm.expect(json_data).to.have.property('test_project'))
});

it('drop custom functions project', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "drop_custom_function_project", "project": "test_project" })
		.expect(200)

		// Unmatched Postman assertion: const json_data = pm.response.json()
		.expect((r) => assert.ok(r.body.message == "Successfully deleted project: test_project"))
});

it('confirm project was dropped', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "get_custom_functions" })
		.expect(200)
		.expect((r) => assert.ok(JSON.stringify(r.body) == '{"deploy-test-payload":{"routes":[],"helpers":[]},"deploy-test-payload-tar-gz":{"routes":[],"helpers":[]}'))
};

.
expect((r) => assert.ok(r.body == expected_obj))
})
;

it('deploy custom function', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			"operation": "deploy_custom_function_project",
			"project": "test-deploy",
			"bypass_config": true,
			"payload": "LgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAwMDc1NSAAMDAwNzY1IAAwMDAwMjQgADAwMDAwMDAwMDAwIDE0NDIwMDQ3MDc2IDAwNzMzNiAANQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB1c3RhcgAwMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwMDAwMDAgADAwMDAwMCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwYWNrYWdlAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDAwNzU1IAAwMDA3NjUgADAwMDAyNCAAMDAwMDAwMDAwMDAgMTQ0MjAwNDcwNzYgMDEwNTc0IAA1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHVzdGFyADAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAwMDAwMCAAMDAwMDAwIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAgLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAACAAAAABAAAAQAAAAAEAAACAAAAAAQAAAQAAAAABAAACAAAAAAEAAAQAAAAAAAAAAAEAABAAAAAAAQAAIAAAAAABAABAAAAAAAEAAIAAAAAAAQABAAAAAAABAAIAAAAAAAEABAAAAAAAAQAIAAAAAAABABAAAAAAAAEAIAAAAAAAAQBAAAAAAAABAIAAAAAAAAEBAAAAAAAAAQIAAAAAAAABBAAAAAAAAAEIAAAAAAAAARAAAAAAAAABIAAAAAAAAAFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAEAsAAABFAAACCQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBERTREIAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAIAAAAGAAAAAAAAAAAQAAAIAAAAABAAABAAAAAAAAAAABAAAEAAAAAAIAAAgAAAAYAAAAAAAAAAABAAAgAAAAAAEAAEAAAAAAAQAAgAAAAAABAAEAAAAAAAEAAgAAAAAAAQAEAAAAAAABAAgAAAAAAAEAEAAAAAAAAQAgAAAAAAABAEAAAAAAAAEAgAAAAAAAAQEAAAAAAAABAgAAAAAAAAEEAAAAAAAAAQgAAAAAAAABEAAAAAAAAAEgAAAAAAAAAUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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aWxlcyAodGhlICJTb2Z0d2FyZSIpLCB0byBkZWFsCmluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMKdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLCBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbApjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMKZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczoKClRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluIGFsbApjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLgoKVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEICJBUyBJUyIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1MgT1IKSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksCkZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOIE5PIEVWRU5UIFNIQUxMIFRIRQpBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSCkxJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1IgT1RIRVJXSVNFLCBBUklTSU5HIEZST00sCk9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFClNPRlRXQVJFLgoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwYWNrYWdlL1JFQURNRS5tZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDAwNjQ0IAAwMDA3NjUgADAwMDAyNCAAMDAwMDAwMDc2NDUgMTQ0MjAwNDcwNzYgMDEyMTQ2IAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHVzdGFyADAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAwMDAwMCAAMDAwMDAwIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACMgSGFycGVyREIgQ3VzdG9tIEZ1bmN0aW9ucyBUZW1wbGF0ZQoKIFRoaXMgcmVwbyBjb21wcmlzZXMgYSBzZXQgb2YgRmFzdGlmeSByb3V0ZXMsIGhlbHBlcnMsIGFuZCBzdGF0aWMgY29udGVudCB0byBiZSBsb2FkZWQgYnkgSGFycGVyREIncyBDdXN0b20gRnVuY3Rpb25zIEZhc3RpZnkgU2VydmVyLgoKVG8gZGVwbG95IHRoaXMgdGVtcGxhdGUsIHNpbXBseSBjbG9uZSB0aGlzIHJlcG8gaW50byB5b3VyIGBjdXN0b21fZnVuY3Rpb25zYCBmb2xkZXIuIEJ5IGRlZmF1bHQsIHRoaXMgZm9sZGVyIGlzIGxvY2F0ZWQgaW4geW91ciBIYXJwZXJEQiB1c2VyIGZvbGRlciBgKH4vaGRiKWAuCgoqKlJvdXRlcyBhcmUgYXV0b21hdGljYWxseSBwcmVmaXhlZCB3aXRoIHRoZWlyIHBhcmVudCBmb2xkZXIgbmFtZS4qKgoKIyMgUm91dGVzCgotLS0KCiMjIyBHRVQgLwoKTk8gcHJlVmFsaWRhdGlvbiBBTkQgVVNJTkcgaGRiQ29yZS5yZXF1ZXN0V2l0aG91dEF1dGhlbnRpY2F0aW9uCkJZUEFTU0VTIEFMTCBDSEVDS1M6IERPIE5PVCBVU0UgUkFXIFVTRVItU1VCTUlUVEVEIFZBTFVFUyBJTiBTUUwgU1RBVEVNRU5UUwoKYGBgCiAgc2VydmVyLnJvdXRlKHsKICAgIHVybDogJy8nLAogICAgbWV0aG9kOiAnR0VUJywKICAgIGhhbmRsZXI6IChyZXF1ZXN0KSA9PiB7CiAgICAgIHJlcXVlc3QuYm9keT0gewogICAgICAgIG9wZXJhdGlvbjogJ3NxbCcsCiAgICAgICAgc3FsOiAnU0VMRUNUICogRlJPTSBkZXYuZG9ncyBPUkRFUiBCWSBkb2dfbmFtZScKICAgICAgfTsKICAgICAgcmV0dXJuIGhkYkNvcmUucmVxdWVzdFdpdGhvdXRBdXRoZW50aWNhdGlvbihyZXF1ZXN0KTsKICAgIH0KICB9KQpgYGAKCiMjIyBQT1NUIC8KClNUQU5EQVJEIFBBU1MtVEhST1VHSCBCT0RZLCBQQVlMT0FEIEFORCBIREIgQVVUSEVOVElDQVRJT04KCmBgYApzZXJ2ZXIucm91dGUoewogICAgdXJsOiAnLycsCiAgICBtZXRob2Q6ICdQT1NUJywKICAgIHByZVZhbGlkYXRpb246IGhkYkNvcmUucHJlVmFsaWRhdGlvbiwKICAgIGhhbmRsZXI6IGhkYkNvcmUucmVxdWVzdCwKICB9KQpgYGAKCiMjIyBHRVQgLzppZAoKV0lUSCBBU1lOQyBUSElSRC1QQVJUWSBBVVRIIFBSRVZBTElEQVRJT04KCmBgYAogIHNlcnZlci5yb3V0ZSh7CiAgICB1cmw6ICcvOmlkJywKICAgIG1ldGhvZDogJ0dFVCcsCiAgICBwcmVWYWxpZGF0aW9uOiAocmVxdWVzdCkgPT4gY3VzdG9tVmFsaWRhdGlvbihyZXF1ZXN0LCBsb2dnZXIpLAogICAgaGFuZGxlcjogKHJlcXVlc3QpID0+IHsKICAgICAgcmVxdWVzdC5ib2R5PSB7CiAgICAgICAgb3BlcmF0aW9uOiAnc3FsJywKICAgICAgICBzcWw6IGBTRUxFQ1QgKiBGUk9NIGRldi5kb2cgV0hFUkUgaWQgPSAke3JlcXVlc3QucGFyYW1zLmlkfWAKICAgICAgfTsKCiAgICAgIC8qCiAgICAgICAqIHJlcXVlc3RXaXRob3V0QXV0aGVudGljYXRpb24gYnlwYXNzZXMgdGhlIHN0YW5kYXJkIEhhcnBlckRCIGF1dGhlbnRpY2F0aW9uLgogICAgICAgKiBZT1UgTVVTVCBBREQgWU9VUiBPV04gcHJlVmFsaWRhdGlvbiBtZXRob2QgYWJvdmUsIG9yIHRoaXMgbWV0aG9kIHdpbGwgYmUgYXZhaWxhYmxlIHRvIGFueW9uZS4KICAgICAgICovCiAgICAgIHJldHVybiBoZGJDb3JlLnJlcXVlc3RXaXRob3V0QXV0aGVudGljYXRpb24ocmVxdWVzdCk7CiAgICB9CiAgfSk7CmBgYAoKIyMgSGVscGVycwoKLS0tClRIRSBBU1lOQ1JPTk9VUyBUSElSRCBQQVJUWSBWQUxJREFUSU9OLCBGUk9NIGhlbHBlcnMvZXhhbXBsZS5qczoKCmBgYApjb25zdCBjdXN0b21WYWxpZGF0aW9uID0gYXN5bmMgKHJlcXVlc3QsbG9nZ2VyKSA9PiB7CiAgY29uc3Qgb3B0aW9ucyA9IHsKICAgIGhvc3RuYW1lOiAnanNvbnBsYWNlaG9sZGVyLnR5cGljb2RlLmNvbScsCiAgICBwb3J0OiA0NDMsCiAgICBwYXRoOiAnL3RvZG9zLzEnLAogICAgbWV0aG9kOiAnR0VUJywKICAgIGhlYWRlcnM6IHsgYXV0aG9yaXphdGlvbjogcmVxdWVzdC5oZWFkZXJzLmF1dGhvcml6YXRpb24gfSwKICB9OwoKICBjb25zdCByZXN1bHQgPSBhd2FpdCBhdXRoUmVxdWVzdChvcHRpb25zKTsKCiAgLyoKICAgKiAgdGhyb3cgYW4gYXV0aGVudGljYXRpb24gZXJyb3IgYmFzZWQgb24gdGhlIHJlc3BvbnNlIGJvZHkgb3Igc3RhdHVzQ29kZQogICAqLwogIGlmIChyZXN1bHQuZXJyb3IpIHsKICAgIGNvbnN0IGVycm9yU3RyaW5nID0gcmVzdWx0LmVycm9yIHx8ICdTb3JyeSwgdGhlcmUgd2FzIGFuIGVycm9yIGF1dGhlbnRpY2F0aW5nIHlvdXIgcmVxdWVzdCc7CiAgICBsb2dnZXIuZXJyb3IoZXJyb3JTdHJpbmcpOwogICAgdGhyb3cgbmV3IEVycm9yKGVycm9yU3RyaW5nKTsKICB9CiAgcmV0dXJuIHJlcXVlc3Q7Cn07Cgptb2R1bGUuZXhwb3J0cyA9IGN1c3RvbVZhbGlkYXRpb247CmBgYAoKVEhFIEFDVFVBTCBIVFRQIENBTEwgVVNFRCBJTiBhdXRoUmVxdWVzdCwgYWxzbyBpbiBoZWxwZXJzL2V4YW1wbGUuanM6CgpgYGAKY29uc3QgYXV0aFJlcXVlc3QgPSAob3B0aW9ucykgPT4gewogIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7CiAgICBjb25zdCByZXEgPSBodHRwcy5yZXF1ZXN0KG9wdGlvbnMsIChyZXMpID0+IHsKICAgICAgcmVzLnNldEVuY29kaW5nKCd1dGY4Jyk7CiAgICAgIGxldCByZXNwb25zZUJvZHkgPSAnJzsKCiAgICAgIHJlcy5vbignZGF0YScsIChjaHVuaykgPT4gewogICAgICAgIHJlc3BvbnNlQm9keSArPSBjaHVuazsKICAgICAgfSk7CgogICAgICByZXMub24oJ2VuZCcsICgpID0+IHsKICAgICAgICByZXNvbHZlKEpTT04ucGFyc2UocmVzcG9uc2VCb2R5KSk7CiAgICAgIH0pOwogICAgfSk7CgogICAgcmVxLm9uKCdlcnJvcicsIChlcnIpID0+IHsKICAgICAgcmVqZWN0KGVycik7CiAgICB9KTsKCiAgICByZXEuZW5kKCk7CiAgfSk7Cn07CmBgYAoKIyMgU3RhdGljIEZpbGVzIChXZWIgVUkpCgotLS0KCkJ5IGFkZGluZyBhIGAvc3RhdGljYCBmb2xkZXIgdG8geW91ciBwcm9qZWN0LCB5b3UgY2FuIGFsc28gaG9zdCBzdGF0aWMgZmlsZXMuIFlvdSBtaWdodCwgZm9yIGV4YW1wbGUsIGNyZWF0ZSBhIGRhc2hib2FyZCB0aGF0IGRpc3BsYXlzIHN1bW1hcnkgZGF0YSBiYXNlZCBvbiBzdGFuZGFyZCBIYXJwZXJEQiBvcGVyYXRpb25zIG9yIEN1c3RvbSBGdW5jdGlvbnMgdGhhdCBwdWxsIGRhdGEgZnJvbSBIYXJwZXJEQi4KCi0gKipZb3VyIHN0YXRpYyBmb2xkZXIgTVVTVCBjb250YWluIGFuIGBpbmRleC5odG1sYCBmaWxlKioKLSAqKllvdSBtdXN0IHVzZSBhYnNvbHV0ZSBwYXRocyBmb3IgYXNzZXRzIChzdGFydCB3aXRoIGEgc2xhc2gpKioKCi0tLQoKSU5ERVguSFRNTAoKYGBgCjwhZG9jdHlwZSBodG1sPgo8aHRtbCBsYW5nPSJlbiI+CjxoZWFkPgogIDxtZXRhIGNoYXJzZXQ9InV0Zi04IiAvPgogIDxsaW5rIHJlbD0iaWNvbiIgaHJlZj0iL3Jlc291cmNlcy9pbWcvZmF2aWNvbi5wbmciIC8+CiAgPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCxpbml0aWFsLXNjYWxlPTEiIC8+CiAgPHRpdGxlPkhh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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwYWNrYWdlL3JvdXRlcwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDAwNzU1IAAwMDA3NjUgADAwMDAyNCAAMDAwMDAwMDAwMDAgMTQ0MjAwNDcwNzYgMDEyMTE1IAA1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHVzdGFyADAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAwMDAwMCAAMDAwMDAwIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHBhY2thZ2Uvc3RhdGljAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwMDA3NTUgADAwMDc2NSAAMDAwMDI0IAAwMDAwMDAwMDAwMCAxNDQyMDA0NzA3NiAwMTIwNjMgADUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAdXN0YXIAMDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDAwMDAwIAAwMDAwMDAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcGFja2FnZS9oZWxwZXJzL2V4YW1wbGUuanMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAwMDY0NCAAMDAwNzY1IAAwMDAwMjQgADAwMDAwMDAyMTI3IDE0NDIwMDQ3MDc2IDAxNDMxMCAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB1c3RhcgAwMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwMDAwMDAgADAwMDAwMCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAndXNlIHN0cmljdCc7Cgpjb25zdCBodHRwcyA9IHJlcXVpcmUoJ2h0dHBzJyk7Cgpjb25zdCBhdXRoUmVxdWVzdCA9IChvcHRpb25zKSA9PiB7CiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHsKICAgIGNvbnN0IHJlcSA9IGh0dHBzLnJlcXVlc3Qob3B0aW9ucywgKHJlcykgPT4gewogICAgICByZXMuc2V0RW5jb2RpbmcoJ3V0ZjgnKTsKICAgICAgbGV0IHJlc3BvbnNlQm9keSA9ICcnOwoKICAgICAgcmVzLm9uKCdkYXRhJywgKGNodW5rKSA9PiB7CiAgICAgICAgcmVzcG9uc2VCb2R5ICs9IGNodW5rOwogICAgICB9KTsKCiAgICAgIHJlcy5vbignZW5kJywgKCkgPT4gewogICAgICAgIHJlc29sdmUoSlNPTi5wYXJzZShyZXNwb25zZUJvZHkpKTsKICAgICAgfSk7CiAgICB9KTsKCiAgICByZXEub24oJ2Vycm9yJywgKGVycikgPT4gewogICAgICByZWplY3QoZXJyKTsKICAgIH0pOwoKICAgIHJlcS5lbmQoKTsKICB9KTsKfTsKCmNvbnN0IGN1c3RvbVZhbGlkYXRpb24gPSBhc3luYyAocmVxdWVzdCxsb2dnZXIpID0+IHsKICBjb25zdCBvcHRpb25zID0gewogICAgaG9zdG5hbWU6ICdqc29ucGxhY2Vob2xkZXIudHlwaWNvZGUuY29tJywKICAgIHBvcnQ6IDQ0MywKICAgIHBhdGg6ICcvdG9kb3MvMScsCiAgICBtZXRob2Q6ICdHRVQnLAogICAgaGVhZGVyczogeyBhdXRob3JpemF0aW9uOiByZXF1ZXN0LmhlYWRlcnMuYXV0aG9yaXphdGlvbiB9LAogIH07CgogIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGF1dGhSZXF1ZXN0KG9wdGlvbnMpOwoKICAvKgogICAqICB0aHJvdyBhbiBhdXRoZW50aWNhdGlvbiBlcnJvciBiYXNlZCBvbiB0aGUgcmVzcG9uc2UgYm9keSBvciBzdGF0dXND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CgogIC8vIFBPU1QsIFdJVEggU1RBTkRBUkQgUEFTUy1USFJPVUdIIEJPRFksIFBBWUxPQUQgQU5EIEhEQiBBVVRIRU5USUNBVElPTgogIHNlcnZlci5yb3V0ZSh7CiAgICB1cmw6ICcvJywKICAgIG1ldGhvZDogJ1BPU1QnLAogICAgcHJlVmFsaWRhdGlvbjogaGRiQ29yZS5wcmVWYWxpZGF0aW9uLAogICAgaGFuZGxlcjogaGRiQ29yZS5yZXF1ZXN0LAogIH0pOwoKICAvLyBHRVQsIFdJVEggQVNZTkMgVEhJUkQtUEFSVFkgQVVUSCBQUkVWQUxJREFUSU9OCiAgc2VydmVyLnJvdXRlKHsKICAgIHVybDogJy86aWQnLAogICAgbWV0aG9kOiAnR0VUJywKICAgIHByZVZhbGlkYXRpb246IChyZXF1ZXN0KSA9PiBjdXN0b21WYWxpZGF0aW9uKHJlcXVlc3QsIGxvZ2dlciksCiAgICBoYW5kbGVyOiAocmVxdWVzdCkgPT4gewogICAgICByZXF1ZXN0LmJvZHk9IHsKICAgICAgICBvcGVyYXRpb246ICdzcWwnLAogICAgICAgIHNxbDogYFNFTEVDVCAqIEZST00gZGV2LmRvZyBXSEVSRSBpZCA9ICR7cmVxdWVzdC5wYXJhbXMuaWR9YAogICAgICB9OwoKICAgICAgLyoKICAgICAgICogcmVxdWVzdFdpdGhvdXRBdXRoZW50aWNhdGlvbiBieXBhc3NlcyB0aGUgc3RhbmRhcmQgSGFycGVyREIgYXV0aGVudGljYXRpb24uCiAgICAgICAqIFlPVSBNVVNUIEFERCBZT1VSIE9XTiBwcmVWYWxpZGF0aW9uIG1ldGhvZCBhYm92ZSwgb3IgdGhpcyBtZXRob2Qgd2lsbCBiZSBhdmFpbGFibGUgdG8gYW55b25lLgogICAgICAgKi8KICAgICAgcmV0dXJuIGhkYkNvcmUucmVxdWVzdFdpdGhvdXRBdXRoZW50aWNhdGlvbihyZXF1ZXN0KTsKICAgIH0KICB9KTsKfTsKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "Successfully deployed: test-deploy"))
//Unmatched Postman assertion: // Deploy will restart, wait for that to complete.
	setTimeout(22000)
});

it('confirm deploy worked', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "get_custom_functions" })
		.expect(200)

// Unmatched Postman assertion: const json_data = pm.response.json()
// Unmatched Postman assertion: pm.expect(json_data).to.haveOwnProperty("test-deploy")
// Unmatched Postman assertion: pm.expect(json_data["test-deploy"]["routes"]).to.not.be.undefined;
// Unmatched Postman assertion: pm.expect(json_data["test-deploy"]["routes"][0]).to.equal('examples')
// Unmatched Postman assertion: pm.expect(json_data["test-deploy"]["helpers"]).to.not.be.undefined;
// Unmatched Postman assertion: pm.expect(json_data["test-deploy"]["helpers"][0]).to.equal('example')})
});

it('drop custom functions project deploy', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "drop_custom_function_project", "project": "test-deploy" })
		.expect(200)

		// Unmatched Postman assertion: const json_data = pm.response.json()
		.expect((r) => assert.ok(r.body.message == "Successfully deleted project: test-deploy"))
});

it('drop deploy-test-payload', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "drop_component", "project": "deploy-test-payload" })
		.expect(200)

		// Unmatched Postman assertion: const json_data = pm.response.json()
		.expect((r) => assert.ok(r.body.message == "Successfully dropped: deploy-test-payload"))
});

it('drop test-deploy from config', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "drop_component", "project": "test-deploy" })
		.expect(200)

		// Unmatched Postman assertion: const json_data = pm.response.json()
		.expect((r) => assert.ok(r.body.message == "Successfully dropped: test-deploy"))
});

it('drop deploy-test-gh', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "drop_component", "project": "deploy-test-gh" })
		.expect(200)

		// Unmatched Postman assertion: const json_data = pm.response.json()
		.expect((r) => assert.ok(r.body.message == "Successfully dropped: deploy-test-gh"))
});

it('create_database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_database", "schema": "tuckerdoodle" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "database 'tuckerdoodle' successfully created"))
});

it('create_table todo with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "database": "tuckerdoodle", "table": "todo", "hash_attribute": "id" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "table 'tuckerdoodle.todo' successfully created."))
});

it('create_table done with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "database": "tuckerdoodle", "table": "done", "hash_attribute": "id" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "table 'tuckerdoodle.done' successfully created."))
});

it('create_table friends without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "table": "friends", "hash_attribute": "id" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "table 'data.friends' successfully created."))
});

it('create_table frogs using primary_key', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "table": "frogs", "primary_key": "id" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "table 'data.frogs' successfully created."))
});

it('create_attribute with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_attribute", "database": "tuckerdoodle", "table": "todo", "attribute": "date" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "attribute 'tuckerdoodle.todo.date' successfully created."))
});

it('create_attribute without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_attribute", "table": "friends", "attribute": "name" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "attribute 'data.friends.name' successfully created."))
});

it('describe_database with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_database", "database": "tuckerdoodle" })
		.expect(200)

// Unmatched Postman assertion: pm.expect(pm.response.json()).to.haveOwnProperty('todo'))
});

it('describe_database without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_database" })
		.expect(200)

// Unmatched Postman assertion: pm.expect(pm.response.json()).to.haveOwnProperty('friends'))
});

it('describe_table with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_table", "database": "tuckerdoodle", "table": "todo" })
		.expect(200)

// Unmatched Postman assertion: pm.expect(pm.response.json().schema).to.equal("tuckerdoodle")
// Unmatched Postman assertion: pm.expect(pm.response.json().name).to.equal("todo"))
});

it('describe_table without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_table", "table": "friends" })
		.expect(200)
		.expect((r) => assert.ok(pm.response.json().schema == "data"))
// Unmatched Postman assertion: pm.expect(pm.response.json().name).to.equal("friends"))
});

it('insert with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"database": "tuckerdoodle",
			"table": "todo",
			"records": [{ "id": 1, "task": "Get bone" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'))
});

it('insert without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"table": "friends",
			"records": [{ "id": 1, "task": "Sheriff Woody" }, { "id": 2, "task": "Mr. Potato Head" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "inserted 2 of 2 records"))
});

it('insert table frog setup for describe', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "insert",
			"table": "frogs",
			"records": [{ "id": 1, "type": "bullfrog" }, { "id": 2, "type": "toad" }, { "id": 3, "type": "tree" }, {
				"id": 4,
				"type": "wood"
			}]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "inserted 4 of 4 records"))
});

it('delete table frog setup for describe', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete", "table": "frogs", "ids": [2] })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "1 of 1 record successfully deleted"))
	setTimeout(1000)
});

it('describe_table frog confirm record count', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_table", "table": "frogs" })
		.expect(200)
		.expect((r) => assert.ok(pm.response.json().schema == "data"))
// Unmatched Postman assertion: pm.expect(pm.response.json().name).to.equal("frogs")
// Unmatched Postman assertion: pm.expect(pm.response.json().record_count).to.equal(3))
});

it('search_by_id', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "search_by_id", "table": "friends", "ids": [1], "get_attributes": ["*"] })
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == 1))
});

it('search_by_hash with ids', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "search_by_hash", "table": "friends", "ids": [1], "get_attributes": ["*"] })
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == 1))
});

it('delete with ids', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete", "table": "friends", "ids": [2] })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "1 of 1 record successfully deleted"))
});

it('update with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "update",
			"database": "tuckerdoodle",
			"table": "todo",
			"records": [{ "id": 1, "task": "Get extra large bone" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "updated 1 of 1 records"))
});

it('update without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "update", "table": "friends", "records": [{ "id": 1, "task": "Mr Sheriff Woody" }] })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "updated 1 of 1 records"))
});

it('upsert with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "upsert",
			"database": "tuckerdoodle",
			"table": "todo",
			"records": [{ "id": 2, "task": "Chase cat" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "upserted 1 of 1 records"))
});

it('upsert without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "upsert", "table": "friends", "records": [{ "id": 2, "name": "Mr Potato Head" }] })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "upserted 1 of 1 records"))
});

it('search_by_hash without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "search_by_hash", "table": "friends", "hash_values": [1], "get_attributes": ["*"] })
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == 1))
});

it('search_by_hash with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_hash",
			"database": "tuckerdoodle",
			"table": "todo",
			"hash_values": [1],
			"get_attributes": ["*"]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == 1))
});

it('search_by_value without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_value",
			"table": "friends",
			"search_attribute": "task",
			"search_value": "*Sheriff Woody",
			"get_attributes": ["*"]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == 1))
});

it('search_by_value with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_value",
			"database": "tuckerdoodle",
			"table": "todo",
			"search_attribute": "task",
			"search_value": "Get*",
			"get_attributes": ["*"]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == 1))
});

it('search_by_conditions without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_conditions",
			"table": "friends",
			"get_attributes": ["*"],
			"conditions": [{ "search_attribute": "task", "search_type": "equals", "search_value": "Mr Sheriff Woody" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == 1))
});

it('search_by_conditions with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "search_by_conditions",
			"database": "tuckerdoodle",
			"table": "todo",
			"get_attributes": ["*"],
			"conditions": [{
				"search_attribute": "task",
				"search_type": "equals",
				"search_value": "Get extra large bone"
			}]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == 1))
});

it('delete with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete", "database": "tuckerdoodle", "table": "todo", "hash_values": [1] })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "1 of 1 record successfully deleted"))
});

it('delete without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete", "table": "friends", "hash_values": [1] })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "1 of 1 record successfully deleted"))
});

it('drop_attribute with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_attribute", "database": "tuckerdoodle", "table": "todo", "attribute": "date" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted attribute 'date'"))
});

it('drop_attribute without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_attribute", "table": "friends", "attribute": "name" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted attribute 'name'"))
});

it('drop_table with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_table", "database": "tuckerdoodle", "table": "todo" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted table 'tuckerdoodle.todo'"))
});

it('drop_database tuckerdoodle', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_database", "database": "tuckerdoodle" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted 'tuckerdoodle'"))
});

it('create_database '
job_guy
' for jobs', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_database", "database": "job_guy" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "database 'job_guy' successfully created"))
}
)
;

it('create_table '
working
' for jobs', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_table", "database": "job_guy", "table": "working", "hash_attribute": "id" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "table 'job_guy.working' successfully created."))
}
)
;

it('delete_records_before with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "delete_records_before",
			"database": "job_guy",
			"table": "working",
			"date": "2050-01-25T23:05:27.464"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("Starting job with id")))
});

it('delete_records_before without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete_records_before", "table": "friends", "date": "2050-01-25T23:05:27.464" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("Starting job with id")))
	setTimeout(2000)
});

it('delete_audit_logs_before with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "delete_audit_logs_before",
			"database": "job_guy",
			"table": "working",
			"timestamp": 1690553291764
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("Starting job with id")))
	setTimeout(5000)
});

it('delete_audit_logs_before without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "delete_audit_logs_before", "table": "friends", "timestamp": 1690553291764 })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("Starting job with id")))
	setTimeout(5000)
});

it('csv_file_load with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "csv_file_load",
			"database": "job_guy",
			"table": "working",
			"file_path": "{{files_location}}Suppliers.csv"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("Starting job with id")))
});

it('csv_file_load without database error', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "csv_file_load", "table": "todo", "file_path": "{{files_location}}Suppliers.csv" })
		.expect(400)
// Unmatched Postman assertion: pm.expect(pm.response.json().error).to.include("Table 'data.todo' does not exist")})
});

it('csv_file_load without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "csv_file_load", "table": "friends", "file_path": "{{files_location}}Suppliers.csv" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("Starting job with id")))
});

it('csv_data_load without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "csv_data_load",
			"table": "friends",
			"data": "id,name,section,country,image\n1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/001g07.jpg\n2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/002g07.jpg\n3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("Starting job with id")))
});

it('csv_data_load with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "csv_data_load",
			"database": "job_guy",
			"table": "working",
			"data": "id,name,section,country,image\n1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/001g07.jpg\n2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/002g07.jpg\n3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("Starting job with id")))
});

it('csv_url_load without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "csv_url_load",
			"action": "insert",
			"table": "friends",
			"csv_url": "https://harperdb-integration-test-data.s3.us-east-2.amazonaws.com/breeds.csv"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("Starting job with id")))
});

it('csv_url_load with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "csv_url_load",
			"action": "insert",
			"database": "job_guy",
			"table": "working",
			"csv_url": "https://harperdb-integration-test-data.s3.us-east-2.amazonaws.com/breeds.csv"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("Starting job with id")))
});

it('import_from_s3 without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "import_from_s3",
			"table": "friends",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/owners.json",
				"region": "us-east-2"
			}
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("Starting job with id")))
});

it('import_from_s3 with database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "import_from_s3",
			"database": "job_guy",
			"table": "working",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/owners.json",
				"region": "us-east-2"
			}
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("Starting job with id")))
});

it('Export to S3 search_by_hash with ids', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "export_to_s3",
			"format": "csv",
			"s3": {
				"aws_access_key_id": "{{s3_key}}",
				"aws_secret_access_key": "{{s3_secret}}",
				"bucket": "harperdb-integration-test-data",
				"key": "non_public_folder/test_export",
				"region": "us-east-2"
			},
			"search_operation": { "operation": "search_by_hash", "table": "friends", "ids": [1], "get_attributes": ["*"] }
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("Starting job with id")))
});

it('Export locally search_by_hash with ids', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			"operation": "export_local",
			"path": "./",
			"filename": "test_export_integration_test",
			"format": "json",
			"search_operation": { "operation": "search_by_hash", "table": "friends", "ids": [1], "get_attributes": ["*"] }
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("Starting job with id")))
});

it('drop_table without database', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_table", "table": "friends" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted table 'data.friends'"))
});

it('drop_database data', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_database", "database": "data" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted 'data'"))
});

it('drop_database job_guy', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_database", "database": "job_guy" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message == "successfully deleted 'job_guy'"))
});

it('drop schema northnwd', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "northnwd" })

// Unmatched Postman assertion: tests["Delete Schema"] = responseBody.has("successfully delete")
	setTimeout(1000)
});

it('confirm attribute count correct (disabled)', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_all" })
)
});

it('VALIDATION Check Schema not found.', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_all" })
// Unmatched Postman assertion: pm.expect(jsonData).to.not.haveOwnProperty('northnwd')})
});

it('drop schema dev', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "dev" })

// Unmatched Postman assertion: tests["Delete Schema"] = responseBody.has("successfully delete"))
});

it('drop schema other', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "other" })

// Unmatched Postman assertion: tests["Delete Schema"] = responseBody.has("successfully delete"))
});

it('drop schema another', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "another" })

// Unmatched Postman assertion: tests["Delete Schema"] = responseBody.has("successfully delete"))
});

it('drop schema call', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "call" })

// Unmatched Postman assertion: tests["Delete Schema"] = responseBody.has("successfully delete"))
});

it('drop schema test_delete_before (disabled)', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "drop_schema", "schema": "test_delete_before" })
)
});

it('Add component', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "add_component", "project": "computed" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('Successfully added project: computed')))
});

it('Set Component File schema.graphql', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			"operation": "set_component_file",
			"project": "computed",
			"file": "schema.graphql",
			"payload": "type Product @table @export { \n\t id: ID @primaryKey \n\t price: Float \n\t taxRate: Float \n\t totalPrice: Float @computed(from: \"price + (price * taxRate)\") @indexed \n\t notIndexedTotalPrice: Float @computed(from: \"price + (price * taxRate)\") \n\t jsTotalPrice: Float @computed @indexed \n } \n\n"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('Successfully set component: schema.graphql')))
});

it('Set Component File resources.js', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			"operation": "set_component_file",
			"project": "computed",
			"file": "resources.js",
			"payload": "tables.Product.setComputedAttribute('jsTotalPrice', (record) => { \n\t return record.price + (record.price * record.taxRate) \n }) \n\n"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('Successfully set component: resources.js')))
});

it('Restart service and wait', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "restart_service", "service": "http_workers" })
		.expect(200)

// Unmatched Postman assertion: //wait for 31 seconds
// Unmatched Postman assertion: console.log('waiting for 31 seconds for the restart of services')
	setTimeout(31000)
		// Unmatched Postman assertion: //retry request if needed with:
		// Unmatched Postman assertion: // pm.setNextRequest(pm.info.requestId)

		.expect((r) => assert.ok(r.body.message.includes("Restarting"))
});

it('Insert data', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "insert", "table": "Product", "records": [{ "id": "1", "price": 100, "taxRate": 0.19 }] })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('inserted 1 of 1 records')))
});

it('Search for attribute', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			"operation": "search_by_value",
			"schema": "data",
			"table": "Product",
			"search_attribute": "id",
			"search_value": "1"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == "1"))
		.expect((r) => assert.ok(r.body[0].price == 100))
// Unmatched Postman assertion: pm.expect(jsonData[0].taxRate).to.eql(0.19))
});

it('Search and get attributes', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			"operation": "search_by_value",
			"schema": "data",
			"table": "Product",
			"search_attribute": "id",
			"search_value": "1",
			"get_attributes": ["id", "price", "taxRate", "totalPrice", "notIndexedTotalPrice", "jsTotalPrice"]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == "1"))
		.expect((r) => assert.ok(r.body[0].price == 100))
		// Unmatched Postman assertion: pm.expect(jsonData[0].taxRate).to.eql(0.19)
		.expect((r) => assert.ok(r.body[0].totalPrice == 119))
		.expect((r) => assert.ok(r.body[0].notIndexedTotalPrice == 119))
		.expect((r) => assert.ok(r.body[0].jsTotalPrice == 119))
});

it('Search REST id', async () => {
	const response = await request(envUrlRest)
		.get('/Product/1')
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("inserted 1 of 1 records"))
			.expect((r) => assert.ok(r.body.price == 100))
// Unmatched Postman assertion: pm.expect(jsonData.taxRate).to.eql(0.19))
});

it('Search REST id select', async () => {
	const response = await request(envUrlRest)
		.get('/Product/1?select(id,price,taxRate,totalPrice,notIndexedTotalPrice,jsTotalPrice)')
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("inserted 1 of 1 records"))
			.expect((r) => assert.ok(r.body.price == 100))
// Unmatched Postman assertion: pm.expect(jsonData.taxRate).to.eql(0.19)
// Unmatched Postman assertion: pm.expect(jsonData.totalPrice).to.eql(119)
// Unmatched Postman assertion: pm.expect(jsonData.notIndexedTotalPrice).to.eql(119)
// Unmatched Postman assertion: pm.expect(jsonData.jsTotalPrice).to.eql(119))
});

it('Search REST attribute select', async () => {
	const response = await request(envUrlRest)
		.get('/Product/?jsTotalPrice=119&select(id,price,taxRate,totalPrice,notIndexedTotalPrice,jsTotalPrice)')
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == "1"))
		.expect((r) => assert.ok(r.body[0].price == 100))
		// Unmatched Postman assertion: pm.expect(jsonData[0].taxRate).to.eql(0.19)
		.expect((r) => assert.ok(r.body[0].totalPrice == 119))
		.expect((r) => assert.ok(r.body[0].notIndexedTotalPrice == 119))
		.expect((r) => assert.ok(r.body[0].jsTotalPrice == 119))
});

it('Search REST attribute 2 select', async () => {
	const response = await request(envUrlRest)
		.get('/Product/?totalPrice=119&select(id,price,taxRate,totalPrice,notIndexedTotalPrice,jsTotalPrice)')
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == "1"))
		.expect((r) => assert.ok(r.body[0].price == 100))
		// Unmatched Postman assertion: pm.expect(jsonData[0].taxRate).to.eql(0.19)
		.expect((r) => assert.ok(r.body[0].totalPrice == 119))
		.expect((r) => assert.ok(r.body[0].notIndexedTotalPrice == 119))
		.expect((r) => assert.ok(r.body[0].jsTotalPrice == 119))
});

it('Delete data', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "delete", "table": "Product", "ids": ["1"] })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('1 of 1 record successfully deleted')))
// Unmatched Postman assertion: pm.expect(response.deleted_hashes).to.eql(['1']))
});

it('Delete table', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "drop_table", "table": "Product" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes(`successfully deleted table 'data.Product'`)))
});

it('Delete schema', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "drop_schema", "schema": "data" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes(`successfully deleted 'data'`)))
});

it('Drop component', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "drop_component", "project": "computed" })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('Successfully dropped: computed')))
});

it('Add component', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "add_component", "project": "appGraphQL" })
		.expect((r) => {
			const res = JSON.stringify(r.body);
			assert.ok(res.includes('Successfully added project') || res.includes('Project already exists'))
		})
});

it('Set Component File schema.graphql', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			"operation": "set_component_file",
			"project": "appGraphQL",
			"file": "schema.graphql",
			"payload": "type VariedProps @table @export { \n\t id: ID @primaryKey \n\t name: String @indexed \n } \n\n type SimpleRecord @table @export { \n\t id: ID @primaryKey \n\t name: String @indexed \n } \n\n type FourProp @table(audit: \"1d\", replicated: false) @export { \n\t id: ID @primaryKey \n\t name: String @indexed \n\t age: Int @indexed \n\t title: String \n\t birthday: Date @indexed \n\t ageInMonths: Int @computed @indexed \n\t nameTitle: Int @computed(from: \"name + ' ' + title\") \n } \n\n type Related @table @export(rest: true, mqtt: false) { \n\t id: ID @primaryKey \n\t name: String @indexed \n\t otherTable: [SubObject] @relationship(to: relatedId) \n\t subObject: SubObject @relationship(from: \"subObjectId\") \n\t subObjectId: ID @indexed \n } \n\n type ManyToMany @table @export(mqtt: true, rest: false) { \n\t id: ID @primaryKey \n\t name: String @indexed \n\t subObjectIds: [ID] @indexed \n\t subObjects: [SubObject] @relationship(from: \"subObjectIds\") \n } \n\n type HasTimeStampsNoPK @table @export { \n\t created: Float @createdTime \n\t updated: Float @updatedTime \n } \n\n type SomeObject { \n\t name: String \n } \n\n type SubObject @table(audit: false) @export { \n\t id: ID @primaryKey \n\t subObject: SomeObject \n\t subArray: [SomeObject] \n\t any: Any \n\t relatedId: ID @indexed \n\t related: Related @relationship(from: \"relatedId\") \n\t manyToMany: [ManyToMany] @relationship(to: subObjectIds) \n } \n\n type NestedIdObject @table @export {  \n\t id: [ID]! @primaryKey \n\t name: String \n } \n\n type SimpleCache @table { \n\t id: ID @primaryKey \n } \n\n type HasBigInt @table @export { \n\t id: BigInt @primaryKey \n\t name: String @indexed \n\t anotherBigint: BigInt \n } \n\n type Conflicted1 @table @export(name: \"Conflicted\") { \n\t id: ID @primaryKey \n } \n\n type Conflicted2 @table @export(name: \"Conflicted\") { \n\t id: ID @primaryKey \n } \n\n"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('Successfully set component: schema.graphql')))
});

it('Set Component File config.yaml', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			"operation": "set_component_file",
			"project": "appGraphQL",
			"file": "config.yaml",
			"payload": "rest: true\ngraphqlSchema:\n  files: '*.graphql'\njsResource:\n  files: resources.js\nstatic:\n  root: web\n  files: web/**\nroles:\n  files: roles.yaml\ngraphql: true"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('Successfully set component: config.yaml')))
});

it('Restart service and wait', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "restart_service", "service": "http_workers" })
		.expect(200)

// Unmatched Postman assertion: //wait for 31 seconds
// Unmatched Postman assertion: console.log('waiting for 31 seconds for the restart of services')
	setTimeout(31000)
		// Unmatched Postman assertion: //retry request if needed with:
		// Unmatched Postman assertion: // pm.setNextRequest(pm.info.requestId)
		.expect((r) => assert.ok(r.body.message.includes("Restarting"))
});

it('Insert one null into SubObject', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "insert", "table": "SubObject", "records": [{ "id": "0", "relatedId": "1", "any": null }] })
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes('inserted 1 of 1 records')))
});

it('Insert into table Related', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			"operation": "insert",
			"table": "Related",
			"records": [{ "id": "1", "name": "name-1", "nestedIdObjectId": ["a", "1"], "subObjectId": "1" }, {
				"id": "2",
				"name": "name-2",
				"nestedIdObjectId": ["a", "2"],
				"subObjectId": "2"
			}, { "id": "3", "name": "name-3", "nestedIdObjectId": ["a", "3"], "subObjectId": "3" }, {
				"id": "4",
				"name": "name-4",
				"nestedIdObjectId": ["a", "4"],
				"subObjectId": "4"
			}, { "id": "5", "name": "name-5", "nestedIdObjectId": ["a", "5"], "subObjectId": "5" }]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("inserted 5 of 5 records"))
});

it('Insert into table SubObject', async () => {
	const response = await request(envUrl)
		.post('')
		.send({
			"operation": "insert",
			"table": "SubObject",
			"records": [{ "id": "1", "relatedId": "1", "any": "any-1" }, {
				"id": "2",
				"relatedId": "2",
				"any": "any-2"
			}, { "id": "3", "relatedId": "3", "any": "any-3" }, { "id": "4", "relatedId": "4", "any": "any-4" }, {
				"id": "5",
				"relatedId": "5",
				"any": "any-5"
			}]
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.message.includes("inserted 5 of 5 records"))
});

it('Shorthand query', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "{ Related { id name } }" })
		.expect(200)
		.expect((r) => assert.ok(r.body.data.Related.length == 5))
		// Unmatched Postman assertion: jsonData.data.Related.forEach((row, i) => {
		.expect((r) => assert.ok(row.id == (i + 1).toString()))
)
});

it('Named query', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "query GetRelated { Related { id name } }" })
		.expect(200)
		.expect((r) => assert.ok(r.body.data.Related.length == 5))
		// Unmatched Postman assertion: jsonData.data.Related.forEach((row, i) => {
		.expect((r) => assert.ok(row.id == (i + 1).toString()))
)
});

it('Named query with operationName', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "query GetRelated { Related { id, name } }", "operationName": "GetRelated" })
		.expect(200)
		.expect((r) => assert.ok(r.body.data.Related.length == 5))
		// Unmatched Postman assertion: jsonData.data.Related.forEach((row, i) => {
		.expect((r) => assert.ok(row.id == (i + 1).toString()))
)
});

it('Named query with operationName 2', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({
			"query": "query GetRelated { Related { id, name } } query GetSubObject { SubObject { id relatedId } }",
			"operationName": "GetSubObject"
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.data.SubObject.length == 6))
// Unmatched Postman assertion: jsonData.data.SubObject.forEach((row, i) => {
// Unmatched Postman assertion: pm.expect(row.id).to.equal((i).toString()))
});

it('Query by primary key field', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "{ Related(id: \"1\") { id name } }" })
		.expect(200)
		.expect((r) => assert.ok(r.body.data.Related[0].id == "1"))
});

it('Multi resource query', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "{ Related { id name } SubObject { id relatedId } }" })
		.expect(200)
		.expect((r) => assert.ok(r.body.data.Related.length == 5))
		// Unmatched Postman assertion: jsonData.data.Related.forEach((row, i) => {
		.expect((r) => assert.ok(row.id == (i + 1).toString()))
		// Unmatched Postman assertion: })
		.expect((r) => assert.ok(r.body.data.SubObject.length == 6))
// Unmatched Postman assertion: jsonData.data.SubObject.forEach((row, i) => {
// Unmatched Postman assertion: pm.expect(row.id).to.equal((i).toString()))
});

it('Query by variable non null no default', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "query Get($id: ID!) { Related(id: $id) { id name } }", "variables": { "id": "1" } })
		.expect(200)
		.expect((r) => assert.ok(r.body.data.Related[0].id == "1"))
});

it('Query by variable non null with default with var', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "query Get($id: ID! = \"1\") { Related(id: $id) { id name } }", "variables": { "id": "1" } })
		.expect(200)
		.expect((r) => assert.ok(r.body.data.Related[0].id == "1"))
});

it('Query by var nullable no default no var', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "query Get($any: Any) { SubObject(any: $any) { id any } }" })
		.expect(200)
		.expect((r) => assert.ok(r.body.data.SubObject[0].id == "0"))
});

it('Query by var nullable w default with var', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({
			"query": "query Get($any: Any = \"any-1\") { SubObject(any: $any) { id any } }",
			"variables": { "any": "any-2" }
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.data.SubObject[0].id == "2"))
});

it('Query by var w default with null var', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({
			"query": "query Get($any: Any = \"any-1\") { SubObject(any: $any) { id any } }",
			"variables": { "any": null }
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.data.SubObject[0].id == "0"))
});

it('Query by nested attribute', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "{ SubObject(related: { name: \"name-2\" }) { id any } }" })
		.expect(200)
		.expect((r) => assert.ok(r.body.data.SubObject[0].id == "2"))
});

it('Query by multiple nested attributes', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "{ SubObject(any: \"any-1\", related: { name: \"name-1\" }) { id any } }" })
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData.data.SubObject[0].id).to.eql("1"))
});

it('Query by nested attribute primary key', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "{ SubObject(related: { id: \"2\" }) { id any } }" })
		.expect(200)
		.expect((r) => assert.ok(r.body.data.SubObject[0].id == "2"))
});

it('Query by doubly nested attribute', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "{ SubObject(related: { subObject: { any: \"any-3\" } }) { id any } }" })
		.expect(200)
		.expect((r) => assert.ok(r.body.data.SubObject[0].id == "3"))
});

it('Query by doubly nested attribute as var sub level', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({
			"query": "query Get($subObject: Any) { SubObject(related: { subObject: $subObject }) { id any } }",
			"variables": { "subObject": { "any": "any-3" } }
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.data.SubObject[0].id == "3"))
});

it('Query by doubly nested attribute as var top-level', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({
			"query": "query Get($related: Any) { SubObject(related: $related) { id any } }",
			"variables": { "related": { "subObject": { "any": "any-3" } } }
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.data.SubObject[0].id == "3"))
});

it('Query by nested attribute as var sub level', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({
			"query": "query Get($name: String) { SubObject(related: { name: $name }) { id any } }",
			"variables": { "name": "name-2" }
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.data.SubObject[0].id == "2"))
});

it('Query by nested attribute as var top level', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({
			"query": "query Get($related: Any) { SubObject(related: $related) { id any } }",
			"variables": { "related": { "name": "name-2" } }
		})
		.expect(200)
		.expect((r) => assert.ok(r.body.data.SubObject[0].id == "2"))
});

it('Query with top level fragment', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "query Get { ...related } fragment related on Any { Related { id name } }" })
		.expect(200)
		.expect((r) => assert.ok(r.body.data.Related.length == 5))
		// Unmatched Postman assertion: jsonData.data.Related.forEach((row, i) => {
		.expect((r) => assert.ok(row.id == (i + 1).toString()))
)
});

it('Query with top level nested fragment', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "query Get { ...related } fragment related on Any { ...nested } fragment nested on Any { Related { id name } }" })
		.expect(200)
		.expect((r) => assert.ok(r.body.data.Related.length == 5))
		// Unmatched Postman assertion: jsonData.data.Related.forEach((row, i) => {
		.expect((r) => assert.ok(row.id == (i + 1).toString()))
)
});

it('Query w top level fragment multi resource', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "query Get { ...multiResourceFragment } fragment multiResourceFragment on Any { Related { id name } SubObject { id relatedId } }" })
		.expect(200)
		.expect((r) => assert.ok(r.body.data.Related.length == 5))
		// Unmatched Postman assertion: jsonData.data.Related.forEach((row, i) => {
		.expect((r) => assert.ok(row.id == (i + 1).toString()))
		// Unmatched Postman assertion: })
		.expect((r) => assert.ok(r.body.data.SubObject.length == 6))
// Unmatched Postman assertion: jsonData.data.SubObject.forEach((row, i) => {
// Unmatched Postman assertion: pm.expect(row.id).to.equal((i).toString()))
});

it('Query with inline fragment', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "query Get { Related(id: \"1\") { ...on Related { id name } } }" })
		.expect(200)
		.expect((r) => assert.ok(r.body.data.Related[0].id == "1"))
});

it('Query with nested fragments', async () => {
	const response = await request(envUrlRest)
		.post('/graphql')
		.send({ "query": "query Get { Related(id: \"2\") { ...relatedFields otherTable { ...id } } } fragment relatedFields on Related { ...id name } fragment id on Any { id }" })
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData.data.Related[0].id).to.eql("2"))
});

it('[rest] Named query Get Related', async () => {
	const response = await request(envUrlRest)
		.get('/Related/?select(id,name)')
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 5))
		// Unmatched Postman assertion: jsonData.forEach((row, i) => {
		.expect((r) => assert.ok(row.id == (i + 1).toString()))
)
});

it('[rest] Named query Get SubObject', async () => {
	const response = await request(envUrlRest)
		.get('/SubObject/?select(id,relatedId)')
		.expect(200)
		.expect((r) => assert.ok(r.body.length == 6))
// Unmatched Postman assertion: jsonData.forEach((row, i) => {
// Unmatched Postman assertion: pm.expect(row.id).to.equal((i).toString()))
});

it('[rest] Query by primary key field', async () => {
	const response = await request(envUrlRest)
		.get('/Related/?id==1&select(id,name)')
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData[0].id).to.eql("1"))
});

it('[rest] Query by variable non null', async () => {
	const response = await request(envUrlRest)
		.get('/Related/?id==2&select(id,name)')
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == "2"))
)
});

it('[rest] Query by var nullable', async () => {
	const response = await request(envUrlRest)
		.get('/SubObject/?any==any-2&select(id,any)')
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == "2"))
)
});

it('[rest] Query by var with null var', async () => {
	const response = await request(envUrlRest)
		.get('/SubObject/?any==null&select(id,any)')
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData[0].id).to.eql("0")
// Unmatched Postman assertion: pm.expect(jsonData[0].any).to.be.null;})
});

it('[rest] Query by nested attribute', async () => {
	const response = await request(envUrlRest)
		.get('/SubObject/?related.name==name-2&select(id,any)')
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == "2"))
)
});

it('[rest] Query by multiple nested attributes', async () => {
	const response = await request(envUrlRest)
		.get('/SubObject/?any==any-2&related.name==name-2&select(id,any)')
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == "2"))
)
});

it('[rest] Query by nested attribute primary key', async () => {
	const response = await request(envUrlRest)
		.get('/SubObject/?related.id==2&select(id,any)')
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == "2"))
)
});

it('[rest] Query by doubly nested attribute', async () => {
	const response = await request(envUrlRest)
		.get('/SubObject/?related.subObject.any==any-2&select(id,any)')
		.expect(200)
		.expect((r) => assert.ok(r.body[0].id == "2"))
)
});

it('[rest] Query with nested fragments', async () => {
	const response = await request(envUrlRest)
		.get('/Related/?id==3')
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData[0].id).to.eql("3"))
});

it('Describe all with valid credentials', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_all" })
		.expect(200)
});

it('Describe all with invalid password', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_all" })
		.expect(401)
	Unmatched
	Postman
	assertion: tests["Login failed"] = responseBody.has("Login failed")
)
});

it('Describe all with invalid username', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_all" })
		.expect(401)
	Unmatched
	Postman
	assertion: tests["Login failed"] = responseBody.has("Login failed")
)
});

it('Describe all with empty credentials', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_all" })
		.expect(401)
	Unmatched
	Postman
	assertion: tests["Must login"] = responseBody.has("Must login")
)
});

it('Describe all with long credentials', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_all" })
		.expect(401)
	Unmatched
	Postman
	assertion: tests["Login failed"] = responseBody.has("Login failed")
)
});

it('Describe all without auth', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "describe_all" })
		.expect(200)
		.expect(401)

// Unmatched Postman assertion: // this is only for dev config, not prod

// Unmatched Postman assertion: // })
// Unmatched Postman assertion: // this is only for prod config, not dev

// Unmatched Postman assertion: tests["Must login"] = responseBody.has("Must login"))
});

it('Create auth token with valid credentials', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_authentication_tokens", "username": "{{username}}", "password": "{{password}}" })
		.expect(200)
// Unmatched Postman assertion: pm.expect(jsonData).to.haveOwnProperty('operation_token')
// Unmatched Postman assertion: pm.expect(jsonData.operation_token).to.not.be.empty;
// Unmatched Postman assertion: pm.environment.set('my_operation_token', jsonData.operation_token)
// Unmatched Postman assertion: // console.log(pm.variables.get('my_operation_token')))
});

it('Describe all with valid auth token', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.set('Authorization', 'Bearer {{my_operation_token}}')
		.send({ "operation": "describe_all" })
		.expect(200)
		.expect((r) => assert.ok(r.body.length > 0))
});

it('Create auth token with invalid credentials', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_authentication_tokens", "username": "{{username}}", "password": "" })
		.expect(401)

		// Unmatched Postman assertion: var response = JSON.stringify(pm.response.json())
		.expect((r) => assert.ok(response.includes("invalid credentials")))
});

it('Create auth token with invalid credentials 2', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_authentication_tokens", "username": "", "password": "{{password}}" })
		.expect(401)

		// Unmatched Postman assertion: var response = JSON.stringify(pm.response.json())
		.expect((r) => assert.ok(response.includes("invalid credentials")))
});

it('Create auth token with invalid credentials 3', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_authentication_tokens", "username": "wrongusername", "password": "wrongpassword" })
		.expect(401)

		// Unmatched Postman assertion: var response = JSON.stringify(pm.response.json())
		.expect((r) => assert.ok(response.includes("invalid credentials")))
});

it('Create auth token with empty credentials', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ "operation": "create_authentication_tokens", "username": "", "password": "" })
		.expect(401)

		// Unmatched Postman assertion: var response = JSON.stringify(pm.response.json())
		.expect((r) => assert.ok(response.includes("invalid credentials")))
});

it('Add component', async () => {
	const response = await request(envUrl)
		.post('')
		.send({ "operation": "add_component", "project": "myApp111" })

// Unmatched Postman assertion: pm.})

	it('Add node success message', () => {
// Unmatched Postman assertion: const response = JSON.stringify(pm.response.json())
// Unmatched Postman assertion: pm.expect(response).to.contain.oneOf(['Successfully added project', 'Project already exists']))
	});

	it('Restart service and wait', async () => {
		const response = await request(envUrl)
			.post('')
			.send({ "operation": "restart_service", "service": "http_workers" })
			.expect(200)
			.expect((r) => assert.ok(r.body.message.includes("Restarting"))
// Unmatched Postman assertion: //wait for 31 seconds
// Unmatched Postman assertion: console.log('waiting for 31 seconds for the restart of services')
		await setTimeout(31000)
// Unmatched Postman assertion: //retry request if needed with:
// Unmatched Postman assertion: // pm.setNextRequest(pm.info.requestId)
	});

	it('Get open api', async () => {
		const response = await request(envUrlRest)
			.get('/openapi')
			.set(headers)
			.expect(200)
			.expect((r) => {
				let openapi_text = JSON.stringify(r.body.openapi)
				assert.ok(!openapi_text);
				assert.ok(r.body.info.title.includes('HarperDB HTTP REST interface'));
				assert.ok(r.body.paths);
				assert.ok(r.body.paths.hasOwnProperty('/TableName/'));
				assert.ok(r.body.paths.hasOwnProperty('/TableName/{id}'));
				assert.ok(r.body.paths.hasOwnProperty('/Greeting/'));

				let paths_text = JSON.stringify(r.body.paths);
				assert.ok(paths_text.includes('post'));
				assert.ok(paths_text.includes('get'));
				assert.ok(r.body.components);
				assert.ok(r.body.components.schemas);
				assert.ok(r.body.components.schemas.TableName);
				assert.ok(r.body.components.schemas.Greeting);
				assert.ok(r.body.components.securitySchemes);
				assert.ok(r.body.components.securitySchemes.basicAuth);
				assert.ok(r.body.components.securitySchemes.bearerAuth);
			})
	});