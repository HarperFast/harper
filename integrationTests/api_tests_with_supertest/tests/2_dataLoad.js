import {after, describe, it} from 'node:test';
import assert from "node:assert";
import request from 'supertest';
import {checkTableInSchema, createSchema, describeSchema, dropSchema} from "../utils/schema.js";
import {envUrl, generic, headers} from "../config/envConfig.js";
import {createTable, dropTable} from "../utils/table.js";
import {csvFileUpload, csvUrlLoad} from "../utils/csv.js";
import {sleep} from "../utils/general.js";
import * as path from "node:path";
import { fileURLToPath } from 'url';

describe('2. Data Load', () => {

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const myPath = path.resolve(__dirname + '/..' + generic.files_location) + '/';
    // const myPath = path.resolve(process.cwd() + generic.files_location);


    //CSV Folder

    it('1 Upload Suppliers.csv', async () => {
        await csvFileUpload(generic.schema, generic.supp_tb,
            myPath + 'Suppliers.csv');
    });

    it('2 Upload Region.csv', async () => {
        await csvFileUpload(generic.schema, generic.regi_tb,
            myPath + 'Region.csv');
    });

    it('3 Upload Territories.csv', async () => {
        await csvFileUpload(generic.schema, generic.terr_tb,
            myPath + 'Territories.csv');
    });

    it('4 Upload EmployeeTerritories.csv', async () => {
        await csvFileUpload(generic.schema, generic.empt_tb,
            myPath + 'EmployeeTerritories.csv');
    });

    it('5 Upload Shippers.csv', async () => {
        await csvFileUpload(generic.schema, generic.ship_tb,
            myPath + 'Shippers.csv');
    });

    it('6 Upload Categories.csv', async () => {
        await csvFileUpload(generic.schema, generic.cate_tb,
            myPath + 'Categories.csv');
    });

    it('7 Upload Employees.csv', async () => {
        await csvFileUpload(generic.schema, generic.emps_tb,
            myPath + 'Employees.csv');
    });

    it('8 Upload Customers.csv', async () => {
        await csvFileUpload(generic.schema, generic.cust_tb,
            myPath + 'Customers.csv');
    });

    it('9 Upload Products.csv', async () => {
        await csvFileUpload(generic.schema, generic.prod_tb,
            myPath + 'Products.csv');
    });

    it('10 Upload Orderdetails.csv', async () => {
        await csvFileUpload(generic.schema, generic.ordd_tb,
            myPath + 'Orderdetails.csv');
    });

    it('11 Upload Orders.csv', async () => {
        await csvFileUpload(generic.schema, generic.ords_tb,
            myPath + 'Orders.csv');
    });

    it('12 Upload Books.csv', async () => {
        await csvFileUpload(generic.schema_dev, 'books',
            myPath + 'Books.csv');
    });

    it('13 Upload BooksRatings.csv', async () => {
        await csvFileUpload(generic.schema_dev, 'ratings',
            myPath + 'BooksRatings.csv');
    });

    it('14 Upload movies.csv', async () => {
        await csvFileUpload(generic.schema_dev, 'movie',
            myPath + 'movies.csv');
    });

    it('15 Upload credits.csv', async () => {
        await csvFileUpload(generic.schema_dev, 'credits',
            myPath + 'credits.csv');
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
            .send({
                operation: 'sql',
                sql: `select count(*) from ${generic.schema}.${generic.csv_tb}`
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
            .send({
                operation: 'sql',
                sql: `select count(*) from ${generic.schema}.${generic.csv_tb_empty}`
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
