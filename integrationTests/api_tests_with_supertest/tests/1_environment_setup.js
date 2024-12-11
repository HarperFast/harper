import {describe, it, after, before} from 'node:test';
import assert from "node:assert";
import request from 'supertest';
import {check_table_in_schema, create_schema, describe_schema, drop_schema} from "../utils/schema.js";
import {global, headers, url} from "../config/env_config.js";
import {create_table, drop_table} from "../utils/table.js";
import {sleep} from "../utils/general.js";

describe('1. Environment Setup', () => {

    it(`Create schema ${global.schema}`, async () => {
        await create_schema(url, global.schema);
    });

    it('Create schema confirm schema exists', async () => {
        await request(url)
            .post('')
            .set(headers)
            .send({
                operation: 'describe_all'
            })
            .expect((r) => {
                // console.log(r.headers);
                const keys = Object.keys(r.body);
                assert.notEqual(keys.indexOf(global.schema), -1, `${global.schema} was not found`);
                assert.ok(keys.includes(global.schema), `${global.schema} was not found`);
            })
            .expect(200)
    });

    it('Create schema dev', async () => {
        await create_schema(url, 'dev');
    });

    it('Create schema call', async () => {
        await create_schema(url, 'call');
    });

    it('Create schema other', async () => {
        await create_schema(url, 'other');
    });

    it('Create schema another', async () => {
        await create_schema(url, 'another');
    });

    it('Create schema number 123', async () => {
        await create_schema(url, '123');
    });

    it('Create schema number 1123', async () => {
        await create_schema(url, 1123);
    });

    it('Create table customers', async () => {
        await create_table(url, global.schema, 'customers', 'customerid');
    });

    it('Search by hash empty table', async () => {
        await request(url)
            .post('')
            .send({
                operation: 'sql',
                sql: `select * from ${global.schema}.customers where customerid = 1`
            })
            .expect((r) => {
                assert.equal(r.body.length, 0);
            })
            .expect(200)
    });

    it('Create table confirm table exists', async () => {
        await check_table_in_schema(url, global.schema, 'customers')
    });

    it('Create table suppliers', async () => {
        await create_table(url, global.schema, 'suppliers', 'supplierid');
    });

    it('Create table region', async () => {
        await create_table(url, global.schema, 'region', 'regionid');
    });

    it('Create table employees', async () => {
        await create_table(url, global.schema, 'employees', 'employeeid');
    });

    it('Create table orders', async () => {
        await create_table(url, global.schema, 'orders', 'orderid');
    });

    it('Create table territories', async () => {
        await create_table(url, global.schema, 'territories', 'territoryid');
    });

    it('Create table categories', async () => {
        await create_table(url, global.schema, 'categories', 'categoryid');
    });

    it('Create table shippers', async () => {
        await create_table(url, global.schema, 'shippers', 'shipperid');
    });

    it('Create table employeeterritories', async () => {
        await create_table(url, global.schema, 'employeeterritories', 'employeeid');
    });

    it('Create table order_details', async () => {
        await create_table(url, global.schema, 'order_details', 'orderdetailid');
    });

    it('Create table products', async () => {
        await create_table(url, global.schema, 'products', 'productid');
    });

    it('Create table long_text in dev', async () => {
        await create_table(url, 'dev', 'long_text', 'id');
    });

    it('Create table aggr in call', async () => {
        await create_table(url, 'call', 'aggr', 'all');
    });

    it('Create table AttributeDropTest in dev', async () => {
        await create_table(url, 'dev', 'AttributeDropTest', 'hashid');
    });

    it(`Describe schema ${global.schema}`, async () => {
        await describe_schema(url, global.schema);
    });

    it('Create table invalid_attribute in dev', async () => {
        await create_table(url, 'dev', 'invalid_attribute', 'id');
    });

    it('Create table remarks_blob in dev', async () => {
        await create_table(url, 'dev', 'remarks_blob', 'id');
    });

    it('Create table books in dev', async () => {
        await create_table(url, 'dev', 'books', 'id');
    });

    it('Create table ratings in dev', async () => {
        await create_table(url, 'dev', 'ratings', 'id');
    });

    it('Create table time_functions in dev', async () => {
        await create_table(url, 'dev', 'time_functions', 'id');
    });

    it('Create table dog in dev', async () => {
        await create_table(url, 'dev', 'dog', 'id');
    });

    it('Create table breed in dev', async () => {
        await create_table(url, 'dev', 'breed', 'id');
    });

    it('Create table owner in dev', async () => {
        await create_table(url, 'dev', 'owner', 'id');
    });

    it('Create table movie in dev', async () => {
        await create_table(url, 'dev', 'movie', 'id');
    });

    it('Create table credits in dev', async () => {
        await create_table(url, 'dev', 'credits', 'movie_id');
    });

    it('Create table rando in dev', async () => {
        await create_table(url, 'dev', 'rando', 'id');
    });

    it('Create table owner in other', async () => {
        await create_table(url, 'other', 'owner', 'id');
    });

    it('Create table breed in another', async () => {
        await create_table(url, 'another', 'breed', 'id');
    });

    it('Create table sql_function in dev', async () => {
        await create_table(url, 'dev', 'sql_function', 'id');
    });

    it('Create table number "4" in 123', async () => {
        await create_table(url, '123', '4', 'id');
    });

    it('Create table number number 1 in 1123', async () => {
        await create_table(url, 1123, 1, 'id');
    });

    it('Describe schema 123 number', async () => {
        await request(url)
            .post('')
            .send({
                operation: 'describe_schema',
                schema: '123'
            })
            .expect((r) => {
                assert.ok(r.body.hasOwnProperty('4'));
                assert.equal(r.body['4'].schema, '123');
                assert.equal(r.body['4'].name, '4');
            })
            .expect(200)
    });

    it('Describe table number "4"', async () => {
        await request(url)
            .post('')
            .send({
                operation: 'describe_table',
                schema: '123',
                table: '4'
            })
            .expect((r) => {
                assert.equal(r.body.schema, '123');
                assert.equal(r.body.name, '4');
            })
            .expect(200)
    });

    it('Create table dog_conditions for conditions tests in dev', async () => {
        await create_table(url, 'dev', 'dog_conditions', 'id');
    });
});