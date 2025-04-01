import {describe, it, after, before} from 'node:test';
import assert from "node:assert";
import request from 'supertest';
import {checkTableInSchema, createSchema, describeSchema, dropSchema} from "../utils/schema.js";
import {generic, headers, envUrl} from "../config/envConfig.js";
import {createTable, dropTable} from "../utils/table.js";


describe('1. Environment Setup', () => {

    it(`Create schema ${generic.schema}`, async () => {
        await createSchema(generic.schema);
    });

    it('Create schema confirm schema exists', async () => {
        await request(envUrl)
            .post('')
            .set(headers)
            .send({
                operation: 'describe_all'
            })
            .expect((r) => {
                // console.log(r.headers);
                const keys = Object.keys(r.body);
                assert.notEqual(keys.indexOf(generic.schema), -1, `${generic.schema} was not found`);
                assert.ok(keys.includes(generic.schema), `${generic.schema} was not found`);
            })
            .expect(200)
    });

    it(`Create schema ${generic.schema_dev}`, async () => {
        await createSchema(generic.schema_dev);
    });

    it(`Create schema ${generic.schema_call}`, async () => {
        await createSchema(generic.schema_call);
    });

    it(`Create schema ${generic.schema_other}`, async () => {
        await createSchema(generic.schema_other);
    });

    it(`Create schema ${generic.schema_another}`, async () => {
        await createSchema(generic.schema_another);
    });

    it(`Create schema number as string ${generic.schema_number_string}`, async () => {
        await createSchema(generic.schema_number_string);
    });

    it(`Create schema number as another string ${generic.schema_number}`, async () => {
        await createSchema(generic.schema_number);
    });

    it(`Create schema as number - expect error`, async () => {
        await request(envUrl)
          .post('')
          .set(headers)
          .send({
              operation: 'create_schema',
              schema: 1123,
          })
          .expect((r) => {
              const body = JSON.stringify(r.body);
              assert.ok(body.includes("'schema' must be a string"));

          })
          .expect(400)
    });

    it(`Create table ${generic.cust_tb}`, async () => {
        await createTable(generic.schema, generic.cust_tb, generic.cust_id);
    });

    it('Search by hash empty table', async () => {
        await request(envUrl)
            .post('')
            .set(headers)
            .send({
                operation: 'sql',
                sql: `select *
                      from ${generic.schema}.${generic.cust_tb}
                      where ${generic.cust_id} = 1`
            })
            .expect((r) => {
                assert.equal(r.body.length, 0);
            })
            .expect(200)
    });

    it('Create table confirm table exists', async () => {
        await checkTableInSchema(generic.schema, generic.cust_tb)
    });

    it(`Create table ${generic.supp_tb}`, async () => {
        await createTable(generic.schema, generic.supp_tb, generic.supp_id);
    });

    it(`Create table ${generic.regi_tb}`, async () => {
        await createTable(generic.schema, generic.regi_tb, generic.regi_id);
    });

    it(`Create table ${generic.emps_tb}`, async () => {
        await createTable(generic.schema, generic.emps_tb, generic.emps_id);
    });

    it(`Create table ${generic.ords_tb}`, async () => {
        await createTable(generic.schema, generic.ords_tb, generic.ords_id);
    });

    it(`Create table ${generic.terr_tb}`, async () => {
        await createTable(generic.schema, generic.terr_tb, generic.terr_id);
    });

    it(`Create table ${generic.cate_tb}`, async () => {
        await createTable(generic.schema, generic.cate_tb, generic.cate_id);
    });

    it(`Create table ${generic.ship_tb}`, async () => {
        await createTable(generic.schema, generic.ship_tb, generic.ship_id);
    });

    it(`Create table ${generic.empt_tb}`, async () => {
        await createTable(generic.schema, generic.empt_tb, generic.empt_id);
    });

    it(`Create table ${generic.ordd_tb}`, async () => {
        await createTable(generic.schema, generic.ordd_tb, generic.ordd_id);
    });

    it(`Create table ${generic.prod_tb}`, async () => {
        await createTable(generic.schema, generic.prod_tb, generic.prod_id);
    });

    it(`Create table long_text in ${generic.schema_dev}`, async () => {
        await createTable(generic.schema_dev, 'long_text', 'id');
    });

    it(`Create table aggr in ${generic.schema_call}`, async () => {
        await createTable(generic.schema_call, 'aggr', 'all');
    });

    it(`Create table AttributeDropTest in ${generic.schema_dev}`, async () => {
        await createTable(generic.schema_dev, 'AttributeDropTest', 'hashid');
    });

    it(`Describe schema ${generic.schema}`, async () => {
        await describeSchema(generic.schema);
    });

    it(`Create table invalid_attribute in ${generic.schema_dev}`, async () => {
        await createTable(generic.schema_dev, 'invalid_attribute', 'id');
    });

    it(`Create table remarks_blob in ${generic.schema_dev}`, async () => {
        await createTable(generic.schema_dev, 'remarks_blob', 'id');
    });

    it(`Create table books in ${generic.schema_dev}`, async () => {
        await createTable(generic.schema_dev, 'books', 'id');
    });

    it(`Create table ratings in ${generic.schema_dev}`, async () => {
        await createTable(generic.schema_dev, 'ratings', 'id');
    });

    it(`Create table time_functions in ${generic.schema_dev}`, async () => {
        await createTable(generic.schema_dev, 'time_functions', 'id');
    });

    it(`Create table dog in ${generic.schema_dev}`, async () => {
        await createTable(generic.schema_dev, 'dog', 'id');
    });

    it(`Create table breed in ${generic.schema_dev}`, async () => {
        await createTable(generic.schema_dev, 'breed', 'id');
    });

    it(`Create table owner in ${generic.schema_dev}`, async () => {
        await createTable(generic.schema_dev, 'owner', 'id');
    });

    it(`Create table movie in ${generic.schema_dev}`, async () => {
        await createTable(generic.schema_dev, 'movie', 'id');
    });

    it(`Create table credits in ${generic.schema_dev}`, async () => {
        await createTable(generic.schema_dev, 'credits', 'movie_id');
    });

    it(`Create table rando in ${generic.schema_dev}`, async () => {
        await createTable(generic.schema_dev, 'rando', 'id');
    });

    it(`Create table owner in ${generic.schema_other}`, async () => {
        await createTable(generic.schema_other, 'owner', 'id');
    });

    it(`Create table breed in ${generic.schema_another}`, async () => {
        await createTable(generic.schema_another, 'breed', 'id');
    });

    it(`Create table sql_function in ${generic.schema_dev}`, async () => {
        await createTable(generic.schema_dev, 'sql_function', 'id');
    });

    it(`Create table leading_zero in ${generic.schema_dev}`, async () => {
        await createTable(generic.schema_dev, 'leading_zero', 'id');
    });

    it(`Create table number "4" in ${generic.schema_number_string}`, async () => {
        await createTable(generic.schema_number_string, '4', 'id');
    });

    it(`Create table number 1 as string in ${generic.schema_number}`, async () => {
        await createTable(generic.schema_number, '1', 'id');
    });

    it(`Create table as number - expect error`, async () => {
        await request(envUrl)
          .post('')
          .set(headers)
          .send({
              operation: 'create_table',
              database: 1123,
              table: 1,
              hash_attribute: 'id'
          })
          .expect((r) => {
              const body = JSON.stringify(r.body);
              assert.ok(body.includes("'schema' must be a string. 'table' must be a string"));

          })
          .expect(400)
    });

    it('Describe schema ${generic.schema_number_string}', async () => {
        await request(envUrl)
            .post('')
            .set(headers)
            .send({
                operation: 'describe_schema',
                schema: generic.schema_number_string
            })
            .expect((r) => {
                assert.ok(r.body.hasOwnProperty('4'));
                assert.equal(r.body['4'].schema, generic.schema_number_string);
                assert.equal(r.body['4'].name, '4');
            })
            .expect(200)
    });

    it('Describe table number "4"', async () => {
        await request(envUrl)
            .post('')
            .set(headers)
            .send({
                operation: 'describe_table',
                schema: generic.schema_number_string,
                table: '4'
            })
            .expect((r) => {
                assert.equal(r.body.schema, generic.schema_number_string);
                assert.equal(r.body.name, '4');
            })
            .expect(200)
    });

    it(`Create table dog_conditions for conditions tests in ${generic.schema_dev}`, async () => {
        await createTable(generic.schema_dev, 'dog_conditions', 'id');
    });
});