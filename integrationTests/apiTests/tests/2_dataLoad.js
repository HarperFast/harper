import {after, describe, it} from 'node:test';
import assert from "node:assert";
import request from 'supertest';
import { envUrl, generic, getCsvPath, headers } from '../config/envConfig.js';
import {createTable} from "../utils/table.js";
import { csvDataLoad, csvFileUpload, csvUrlLoad } from '../utils/csv.js';
import {insert} from "../utils/insert.js";
import longTextJson from '../json/longText.json' with {type: "json"};
import dataBulkJson from '../json/dataBulk.json' with {type: "json"};
import remarksJson from '../json/remarks.json' with {type: "json"};
import dogJson from '../json/dog.json' with {type: "json"};
import breedJson from '../json/breed.json' with {type: "json"};
import ownerJson from '../json/owner.json' with {type: "json"};
import ownerOnlyJson from '../json/ownerOnly.json' with {type: "json"};
import {searchByHash} from "../utils/search.js";
import { checkJobCompleted, getJobId } from '../utils/jobs.js';





describe('2. Data Load', () => {

    //CSV Folder

    it('1 Upload Suppliers.csv', async () => {
        await csvFileUpload(generic.schema, generic.supp_tb,
            getCsvPath() + 'Suppliers.csv');
    });

    it('2 Upload Region.csv', async () => {
        await csvFileUpload(generic.schema, generic.regi_tb,
            getCsvPath() + 'Region.csv');
    });

    it('3 Upload Territories.csv', async () => {
        await csvFileUpload(generic.schema, generic.terr_tb,
            getCsvPath() + 'Territories.csv');
    });

    it('4 Upload EmployeeTerritories.csv', async () => {
        await csvFileUpload(generic.schema, generic.empt_tb,
            getCsvPath() + 'EmployeeTerritories.csv');
    });

    it('5 Upload Shippers.csv', async () => {
        await csvFileUpload(generic.schema, generic.ship_tb,
            getCsvPath() + 'Shippers.csv');
    });

    it('6 Upload Categories.csv', async () => {
        await csvFileUpload(generic.schema, generic.cate_tb,
            getCsvPath() + 'Categories.csv');
    });

    it('7 Upload Employees.csv', async () => {
        await csvFileUpload(generic.schema, generic.emps_tb,
            getCsvPath() + 'Employees.csv');
    });

    it('8 Upload Customers.csv', async () => {
        await csvFileUpload(generic.schema, generic.cust_tb,
            getCsvPath() + 'Customers.csv');
    });

    it('9 Upload Products.csv', async () => {
        await csvFileUpload(generic.schema, generic.prod_tb,
            getCsvPath() + 'Products.csv');
    });

    it('10 Upload Orderdetails.csv', async () => {
        await csvFileUpload(generic.schema, generic.ordd_tb,
            getCsvPath() + 'Orderdetails.csv');
    });

    it('11 Upload Orders.csv', async () => {
        await csvFileUpload(generic.schema, generic.ords_tb,
            getCsvPath() + 'Orders.csv');
    });

    it('12 Upload Books.csv', async () => {
        await csvFileUpload(generic.schema_dev, 'books',
            getCsvPath() + 'Books.csv');
    });

    it('13 Upload BooksRatings.csv', async () => {
        await csvFileUpload(generic.schema_dev, 'ratings',
            getCsvPath() + 'BooksRatings.csv');
    });

    it('14 Upload movies.csv', async () => {
        await csvFileUpload(generic.schema_dev, 'movie',
            getCsvPath() + 'movies.csv');
    });

    it('15 Upload credits.csv', async () => {
        await csvFileUpload(generic.schema_dev, 'credits',
            getCsvPath() + 'credits.csv');
    });


    //CSV URL Load Folder

    it('Create CSV data table', async () => {
        await createTable(generic.schema, generic.csv_tb, 'id');
    });

    it('CSV url load', async () => {
        await csvUrlLoad(generic.schema, generic.csv_tb,
            'https://harperdb-integration-test-data.s3.us-east-2.amazonaws.com/breeds.csv',
            '', 'successfully loaded 350 of 350 records');
    });

    it('Confirm all CSV records loaded', async () => {
        await request(envUrl)
            .post('')
            .set(headers)
            .send({
                operation: 'sql',
                sql: `select count(*)
                      from ${generic.schema}.${generic.csv_tb}`
            })
            .expect((r) => {
                assert.equal(r.body[0]['COUNT(*)'], 350, `${generic.csv_tb} count was not 350`);
            })
            .expect(200)
    });


    it('Create CSV data table empty', async () => {
        await createTable(generic.schema, generic.csv_tb_empty, 'id');
    });

    it('CSV url load empty file', async () => {
        await csvUrlLoad(generic.schema, generic.csv_tb_empty,
            'https://s3.amazonaws.com/complimentarydata/breedsEmpty.csv');
    });

    it('Confirm 0 CSV records loaded', async () => {
        await request(envUrl)
            .post('')
            .set(headers)
            .send({
                operation: 'sql',
                sql: `select count(*)
                      from ${generic.schema}.${generic.csv_tb_empty}`
            })
            .expect((r) => {
                assert.equal(r.body[0]['COUNT(*)'], 0, `${generic.csv_tb_empty} count was not 0`);
            })
            .expect(200)
    });

    it('CSV file load bad attribute', async () => {
        await csvUrlLoad(generic.schema, generic.csv_tb_empty,
            'https://s3.amazonaws.com/complimentarydata/breeds-bad-column-name.csv',
            `Invalid column name 'id/', cancelling load operation`);
    });



    //JSON Folder

    it('Import data bulk insert into dev.long_text table', async () => {
        await insert(generic.schema_dev, 'long_text',
          longTextJson.records, 'inserted 25');
    });

    it('Import data bulk confirm specific value exists', async () => {
        await searchByHash(generic.schema_dev, 'long_text',
          'id', [10], ['id', 'remarks'],
          '"id":10,"remarks":"Lovely updated home')
    });

    it('Import data bulk insert into call.aggr', async () => {
        await insert(generic.schema_call, 'aggr',
          dataBulkJson.records, 'inserted 10');
    });

    it('Insert dot & double dot data', async () => {
        await insert(generic.schema_call, 'aggr',
          [
              {
                  all: 11,
                  dog_name: ".",
                  owner_name: ".."
              }
          ],
          'inserted 1');
    });

    it('Insert confirm dot & double data', async () => {
        await searchByHash(generic.schema_call, 'aggr', 'all',
          [11], ['all', 'dog_name', 'owner_name'],
          '"all":11,"dog_name":".","owner_name":".."');

    });

    it('Insert attributes into DropAttributeTest', async () => {
        await insert(generic.schema_dev, 'AttributeDropTest',
          [
              {
                  hashid: 1,
                  some_attribute: "some_att1",
                  another_attribute: "1"
              },
              {
                  hashid: 2,
                  some_attribute: "some_att2",
                  another_attribute: "1"
              }
          ],
          'inserted 2');
    });

    it('Insert confirm attributes added', async () => {
        await searchByHash(generic.schema_dev, 'AttributeDropTest',
          'hashid', [1, 2],
          ['hashid', 'some_attribute', 'another_attribute'],
          '{"hashid":1,"some_attribute":"some_att1","another_attribute":"1"},' +
          '{"hashid":2,"some_attribute":"some_att2","another_attribute":"1"}');
    });

    it('Import data bulk insert into dev.remarks_blob table', async () => {
        await insert(generic.schema_dev, 'remarks_blob',
          remarksJson.records, 'inserted 11');
    });

    it('Insert data into dev.dog', async () => {
        await insert(generic.schema_dev, 'dog',
          dogJson.records, 'inserted 9');
    });

    it('Insert data into dev.breed', async () => {
        await insert(generic.schema_dev, 'breed',
          breedJson.records, 'inserted 350');
    });

    it('Insert data into dev.owner', async () => {
        await insert(generic.schema_dev, 'owner',
          ownerJson.records, 'inserted 4');
    });

    it('Insert data into other.owner', async () => {
        await insert(generic.schema_other, 'owner',
          ownerOnlyJson.records, 'inserted 4');
    });

    it('Insert data into another.breed', async () => {
        await insert(generic.schema_another, 'breed',
          breedJson.records, 'inserted 350');
    });


    //CSV Bulk Load Tests Folder

    it('csv_data_load with invalid attribute', async () => {
        const errorMsg = await csvDataLoad(headers, 'insert', 'dev', 'invalid_attribute',
          'id,s/ome=attribute\n1,cheeseburger\n2,hamburger with cheese\n3,veggie burger\n',
          'Invalid column name \'s/ome=attribute\'');
    });

    it('csv_file_load with invalid attributes', async () => {
        await csvFileUpload(generic.schema_dev, 'invalid_attribute',
          getCsvPath() + 'InvalidAttributes.csv', 'Invalid column name');
    });

    it('search for specific value from CSV load', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({
              'operation': 'search_by_hash',
              'schema': `${generic.schema}`,
              'table': `${generic.supp_tb}`,
              'hash_attribute': `${generic.supp_id}`,
              'hash_values': [10],
              'get_attributes': ['supplierid', 'companyname', 'contactname'],
          })
          .expect((r) => {
              assert.ok(r.body[0].companyname == 'Refrescos Americanas LTDA');
              assert.ok(r.body[0].supplierid == 10);
              assert.ok(r.body[0].contactname == 'Carlos Diaz');
          })
          .expect(200);
    });

    it('search for random value from CSV load', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({
              operation: 'sql', sql: `SELECT *
                              FROM ${generic.schema}.${generic.supp_tb}`,
          })
          .expect((r) => {
              let randomNumber = Math.floor(Math.random() * 29);
              assert.ok(r.body[randomNumber] != null);
              assert.ok(r.body.length == 29);
              let keys = Object.keys(r.body[randomNumber]);
              if (keys.indexOf('__updatedtime__') > -1 && keys.indexOf('__createdtime__') > -1) {
                  assert.ok(keys.length == 14);
              } else {
                  assert.ok(keys.length == 12);

              }
          })
          .expect(200);
    });

    it('check error on invalid file', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({
              'operation': 'csv_file_load',
              'action': 'insert',
              'schema': `${generic.schema}`,
              'table': `${generic.supp_tb}`,
              'file_path': `${getCsvPath()}Suppliers_wrong.csv`,
          })
          .expect((r) => assert.ok(r.body.error.includes('No such file or directory')))
          .expect(400);
    });

    it('csv bulk load update', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({
              'operation': 'csv_data_load',
              'action': 'update',
              'schema': `${generic.schema}`,
              'table': `${generic.supp_tb}`,
              'data': 'supplierid,companyname\n19,The Chum Bucket\n',
          })
          .expect((r) => assert.ok(r.body.message.indexOf('Starting job') == 0,
            'Expected to find "Starting job" in the response'));

        const id = await getJobId(response.body);
        await checkJobCompleted(id);
    });

    it('csv bulk load update confirm', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({
              'operation': 'search_by_hash',
              'schema': `${generic.schema}`,
              'table': `${generic.supp_tb}`,
              'hash_attribute': `${generic.supp_id}`,
              'hash_values': [19],
              'get_attributes': ['supplierid', 'companyname', 'contactname'],
          })
          .expect((r) => assert.ok(r.body[0].supplierid == 19))
          .expect((r) => assert.ok(r.body[0].contactname == 'Robb Merchant'))
          .expect((r) => assert.ok(r.body[0].companyname == 'The Chum Bucket'))
          .expect(200);
    });

    //Data Load Main Folder

    it('Insert object into table', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({
              'operation': 'insert',
              'schema': `${generic.schema}`,
              'table': `${generic.cust_tb}`,
              'records': [{ 'postalcode': { 'house': 30, 'street': 'South St' }, 'customerid': 'TEST1' }],
          })
          .expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'))
          .expect((r) => assert.ok(r.body.inserted_hashes[0] == 'TEST1'))
          .expect(200);
    });

    it('Insert object confirm ', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({
              'operation': 'search_by_hash',
              'schema': `${generic.schema}`,
              'table': `${generic.cust_tb}`,
              'hash_attribute': `${generic.supp_id}`,
              'hash_values': ['TEST1'],
              'get_attributes': ['postalcode', 'customerid'],
          })
          .expect((r) => assert.deepEqual(r.body[0].postalcode, { 'house': 30, 'street': 'South St' }))
          .expect((r) => assert.ok(r.body[0].customerid == 'TEST1'))
          .expect(200);
    });

    it('Insert array into table', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({
              'operation': 'insert',
              'schema': `${generic.schema}`,
              'table': `${generic.cust_tb}`,
              'records': [{ 'postalcode': [1, 2, 3], 'customerid': 'TEST2' }],
          })
          .expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'))
          .expect((r) => assert.ok(r.body.inserted_hashes[0] == 'TEST2'))
          .expect(200);
    });

    it('Insert array confirm ', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({
              'operation': 'search_by_hash',
              'schema': `${generic.schema}`,
              'table': `${generic.cust_tb}`,
              'hash_attribute': `${generic.supp_id}`,
              'hash_values': ['TEST2'],
              'get_attributes': ['postalcode', 'customerid'],
          })
          .expect((r) => assert.deepEqual(r.body[0].postalcode, [1, 2, 3]))
          .expect((r) => assert.ok(r.body[0].customerid == 'TEST2'))
          .expect(200);
    });

    it('Insert value into schema that doesnt exist', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({
              'operation': 'insert',
              'schema': 'not_a_schema',
              'table': `${generic.cust_tb}`,
              'records': [{ 'name': 'Harper', 'customerid': 1 }],
          })
          .expect((r) => assert.ok(r.body.error == 'database \'not_a_schema\' does not exist'))
          .expect(400);
    });

    it('Insert value into table that doesnt exist', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({
              'operation': 'insert',
              'schema': `${generic.schema}`,
              'table': 'not_a_table',
              'records': [{ 'name': 'Harper', 'customerid': 1 }],
          })
          .expect((r) => assert.ok(r.body.error == 'Table \'northnwd.not_a_table\' does not exist'))
          .expect(400);
    });

    it('Update value in schema that doesn\'t exist', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({
              'operation': 'update',
              'schema': 'not_a_schema',
              'table': `${generic.cust_tb}`,
              'records': [{ 'name': 'Harper', 'customerid': 1 }],
          })
          .expect((r) => assert.ok(r.body.error == 'database \'not_a_schema\' does not exist'))
          .expect(400);
    });

    it('Update value in table that doesn\'t exist', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({
              'operation': 'update',
              'schema': `${generic.schema}`,
              'table': 'not_a_table',
              'records': [{ 'name': 'Harper', 'customerid': 1 }],
          })
          .expect((r) => assert.ok(r.body.error == 'Table \'northnwd.not_a_table\' does not exist'))
          .expect(400);
    });

    it('Set attribute to number', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({
              'operation': 'insert',
              'schema': `${generic.schema}`,
              'table': `${generic.emps_tb}`,
              'records': [{ '4289': 'Mutt', 'firstname': 'Test for number attribute', 'employeeid': 25 }],
          })
          .expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'))
          .expect((r) => assert.ok(r.body.inserted_hashes[0] == 25))
          .expect(200);
    });

    it('Set attribute to number confirm', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({ 'operation': 'describe_table', 'table': `${generic.emps_tb}`, 'schema': `${generic.schema}` })
          .expect((r) => {
              let found = false;
              r.body.attributes.forEach((obj) => {
                  if (Object.values(obj)[0] === '4289') found = true;
              });
              assert.ok(found);
          })
          .expect(200);
    });

    it('Set attribute name greater than 250 bytes', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({
              'operation': 'insert',
              'schema': `${generic.schema}`,
              'table': `${generic.emps_tb}`,
              'records': [{
                  '4289': 'Mutt',
                  'firstname': 'Test for number attribute',
                  'employeeid': 31,
                  'IIetmyLabradorcomeoutsidewithmewhenIwastakingthebinsoutonemorningIlethimgoforawanderthinkinghewasjustgoingtopeeonthetelegraphpoleattheendofourdrivewaylikehealwaysdoesInsteadhesawhisopportunityandseizeditHekeptwalkingpastthetelegraphpolepasttheborderofour': 'a story about a dog',
              }],
          })
          .expect((r) => {
              let longAttribute = 'transaction aborted due to attribute name IIetmyLabradorcomeoutsidewithmewhenIwastakingthebinsoutonemorningIlethimgoforawanderthinkinghewasjustgoingtopeeonthetelegraphpoleattheendofourdrivewaylikehealwaysdoesInsteadhesawhisopportunityandseizeditHekeptwalkingpastthetelegraphpolepasttheborderofour being too long. Attribute names cannot be longer than 250 bytes.';
              assert.ok(r.body.error == longAttribute);
          })
          .expect(400);
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
          .expect((r) => assert.ok(r.body.message.includes('inserted 2')))
          .expect(200);
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
          .expect((r) => assert.ok(r.body.message.includes('inserted 3')))
          .expect((r) => assert.deepEqual(r.body.inserted_hashes, [0, '011', '00011']))
          .expect(200);
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
          .expect((r) => assert.ok(r.body.message.includes('inserted 4')))
          .expect(200);
    });

    it('test SQL updating with numeric hash in single quotes', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({
              'operation': 'sql',
              'sql': 'UPDATE dev.rando set active = true WHERE id IN (\'987654321\', \'987654322\')',
          })
          .expect((r) => assert.ok(r.body.message.includes('updated 2')))
          .expect((r) => assert.ok(r.body.update_hashes.includes(987654321) && r.body.update_hashes.includes(987654322)))
          .expect(200);
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
          .expect((r) => assert.ok(r.body.upserted_hashes.length == 11))
          .expect((r) => assert.ok(r.body.skipped_hashes == 'undefined'))
          .expect((r) => assert.ok(r.body.message == 'upserted 11 of 11 records'))
          .expect(200);
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
          .expect((r) => assert.ok(r.body.message.includes('inserted 4')))
          .expect(200);
    });

    it('Insert records into 123.4 number schema table', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({ 'operation': 'insert', 'schema': 123, 'table': 4, 'records': [{ 'name': 'Hot Dawg' }] })
          .expect((r) => assert.ok(r.body.message.includes('inserted 1')))
          .expect(200);
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
          .expect((r) => assert.ok(r.body.message.includes('updated 1')))
          .expect(200);
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
          .expect((r) => assert.ok(r.body.message.includes('updated 1')))
          .expect(200);
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
          .expect((r) => assert.ok(r.body.error == '\'table\' is required'))
          .expect(400);
    });

    it('Insert records missing records', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({ 'operation': 'insert', 'schema': '123', 'table': '4' })
          .expect((r) => assert.ok(r.body.error == '\'records\' is required'))
          .expect(400);
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
          .expect((r) => assert.ok(r.body.error == '\'table\' is required'))
          .expect(400);
    });

    it('Upsert records missing records', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({ 'operation': 'upsert', 'schema': '123', 'table': '4' })
          .expect((r) => assert.ok(r.body.error == '\'records\' is required'))
          .expect(400);
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
          .expect((r) => assert.ok(r.body.error == '\'table\' is required'))
          .expect(400);
    });

    it('Update records missing records', async () => {
        const response = await request(envUrl)
          .post('')
          .set(headers)
          .send({ 'operation': 'upsert', 'schema': '123', 'table': '4' })
          .expect((r) => assert.ok(r.body.error == '\'records\' is required'))
          .expect(400);
    });




});
