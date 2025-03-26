import {after, describe, it} from 'node:test';
import assert from "node:assert";
import request from 'supertest';
import {checkTableInSchema, createSchema, describeSchema, dropSchema} from "../utils/schema.js";
import { envUrl, generic, getCsvPath, headers } from '../config/envConfig.js';
import {createTable, dropTable} from "../utils/table.js";
import {csvFileUpload, csvUrlLoad} from "../utils/csv.js";
import {setTimeout as sleep} from 'node:timers/promises';
import * as path from "node:path";
import {fileURLToPath} from 'url';

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
});
