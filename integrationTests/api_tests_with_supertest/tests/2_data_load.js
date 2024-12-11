import {after, describe, it} from 'node:test';
import assert from "node:assert";
import request from 'supertest';
import {check_table_in_schema, create_schema, describe_schema, drop_schema} from "../utils/schema.js";
import {global, headers, url} from "../config/env_config.js";
import {create_table, drop_table} from "../utils/table.js";
import {csv_file_upload, csv_url_load} from "../utils/csv.js";
import {sleep} from "../utils/general.js";
import * as path from "node:path";

describe('2. Data Load', () => {

    //CSV Folder

    it('1 Upload Suppliers.csv', async () => {
        await csv_file_upload(url, global.schema, global.supp_tb,
            process.cwd() + '/../../test/data/integrationTestsCsvs/Suppliers.csv');
    });

    it('2 Upload Region.csv', async () => {
        await csv_file_upload(url, global.schema, global.regi_tb,
            process.cwd() + '/../../test/data/integrationTestsCsvs/Region.csv');
    });

    it('3 Upload Territories.csv', async () => {
        await csv_file_upload(url, global.schema, global.terr_tb,
            process.cwd() + '/../../test/data/integrationTestsCsvs/Territories.csv');
    });

    it('4 Upload EmployeeTerritories.csv', async () => {
        await csv_file_upload(url, global.schema, global.empt_tb,
            process.cwd() + '/../../test/data/integrationTestsCsvs/EmployeeTerritories.csv');
    });

    it('5 Upload Shippers.csv', async () => {
        await csv_file_upload(url, global.schema, global.ship_tb,
            process.cwd() + '/../../test/data/integrationTestsCsvs/Shippers.csv');
    });

    it('6 Upload Categories.csv', async () => {
        await csv_file_upload(url, global.schema, global.cate_tb,
            process.cwd() + '/../../test/data/integrationTestsCsvs/Categories.csv');
    });

    it('7 Upload Employees.csv', async () => {
        await csv_file_upload(url, global.schema, global.emps_tb,
            process.cwd() + '/../../test/data/integrationTestsCsvs/Employees.csv');
    });

    it('8 Upload Customers.csv', async () => {
        await csv_file_upload(url, global.schema, global.cust_tb,
            process.cwd() + '/../../test/data/integrationTestsCsvs/Customers.csv');
    });

    it('9 Upload Products.csv', async () => {
        await csv_file_upload(url, global.schema, global.prod_tb,
            process.cwd() + '/../../test/data/integrationTestsCsvs/Products.csv');
    });

    it('10 Upload Orderdetails.csv', async () => {
        await csv_file_upload(url, global.schema, global.ordd_tb,
            process.cwd() + '/../../test/data/integrationTestsCsvs/Orderdetails.csv');
    });

    it('11 Upload Orders.csv', async () => {
        await csv_file_upload(url, global.schema, global.ords_tb,
            process.cwd() + '/../../test/data/integrationTestsCsvs/Orders.csv');
    });

    it('12 Upload Books.csv', async () => {
        await csv_file_upload(url, 'dev', 'books',
            process.cwd() + '/../../test/data/integrationTestsCsvs/Books.csv');
    });

    it('13 Upload BooksRatings.csv', async () => {
        await csv_file_upload(url, 'dev', 'ratings',
            process.cwd() + '/../../test/data/integrationTestsCsvs/BooksRatings.csv');
    });

    it('14 Upload movies.csv', async () => {
        await csv_file_upload(url, 'dev', 'movie',
            process.cwd() + '/../../test/data/integrationTestsCsvs/movies.csv');
    });

    it('15 Upload credits.csv', async () => {
        await csv_file_upload(url, 'dev', 'credits',
            process.cwd() + '/../../test/data/integrationTestsCsvs/credits.csv');
    });


    //CSV URL Load Folder

    it('Create CSV data table', async () => {
        await create_table(url, global.schema, global.csv_tb, 'id');
    });

    it('CSV url load', async () => {
        await csv_url_load(url, global.schema, global.csv_tb,
            'https://harperdb-integration-test-data.s3.us-east-2.amazonaws.com/breeds.csv',
            '', 'successfully loaded 350 of 350 records');
    });

    it('Confirm all CSV records loaded', async () => {
        await request(url)
            .post('')
            .send({
                operation: 'sql',
                sql: `select count(*) from ${global.schema}.${global.csv_tb}`
            })
            .expect((r) => {
                assert.equal(r.body[0]['COUNT(*)'], 350, `${global.csv_tb} count was not 350`);
            })
            .expect(200)
    });


    it('Create CSV data table empty', async () => {
        await create_table(url, global.schema, global.csv_tb_empty, 'id');
    });

    it('CSV url load empty file', async () => {
        await csv_url_load(url, global.schema, global.csv_tb_empty,
            'https://s3.amazonaws.com/complimentarydata/breedsEmpty.csv');
    });

    it('Confirm 0 CSV records loaded', async () => {
        await request(url)
            .post('')
            .send({
                operation: 'sql',
                sql: `select count(*) from ${global.schema}.${global.csv_tb_empty}`
            })
            .expect((r) => {
                assert.equal(r.body[0]['COUNT(*)'], 0, `${global.csv_tb_empty} count was not 0`);
            })
            .expect(200)
    });

    it('CSV file load bad attribute', async () => {
        await csv_url_load(url, global.schema, global.csv_tb_empty,
            'https://s3.amazonaws.com/complimentarydata/breeds-bad-column-name.csv',
            `Invalid column name 'id/', cancelling load operation`);
    });


    // after(async () => { try {} catch (error) {} });
});
