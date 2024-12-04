import {describe, it, after, before} from 'node:test';
import  assert from "node:assert";
import request from 'supertest';
import {check_table_in_schema, create_schema, drop_schema} from "../utils/schema.js";
import {global, headers, url} from "../config/env_config.js";
import {create_table, drop_table} from "../utils/table.js";

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
                assert.notEqual(keys.indexOf(global.schema), 1, `${global.schema} was not found`)
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
        await create_schema(url, '1123');
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
});

// Problem in Node Test Runner:
// after hook and before hook does not work
// alternative is to to use another describe() instead of after()
// or to export a function that cleans everything in harperdb

describe('Environment cleanup', () => {
    it('should cleanup', async () => {
        try {
            await drop_table(url, global.schema, 'customers', false);
            await new Promise(r => setTimeout(r, 500));
            await drop_schema(url, global.schema, false);
            await drop_schema(url, 'dev', false);
            await drop_schema(url, 'call', false);
            await drop_schema(url, 'other', false);
            await drop_schema(url, 'another', false);
            await drop_schema(url, '123', false);
            await drop_schema(url, '1123', false);
        } catch (error) {
            console.error(error);
        }
    });
});