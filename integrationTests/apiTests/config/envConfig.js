import { fileURLToPath } from 'node:url';
import path from 'node:path';
import 'dotenv/config';

export let testData = {
    host: 'http://localhost',
    port: '9925',
    portRest: '9926',
    username: 'admin',
    password: 'Abc1234!',
    schema: "northnwd",
    schema_dev: "dev",
    schema_call: "call",
    schema_other: "other",
    schema_another: "another",
    schema_number_string: "123",
    schema_number: '1123',
    emps_tb: "employees",
    emps_id: "employeeid",
    ords_tb: "orders",
    ords_id: "orderid",
    ordd_tb: "order_details",
    ordd_id: "orderid",
    prod_tb: "products",
    prod_id: "productid",
    cust_tb: "customers",
    cust_id: "customerid",
    cate_tb: "categories",
    cate_id: "categoryid",
    supp_tb: "suppliers",
    supp_id: "supplierid",
    ship_tb: "shippers",
    ship_id: "shipperid",
    empt_tb: "employeeterritories",
    empt_id: "employeeid",
    terr_tb: "territories",
    terr_id: "territoryid",
    regi_tb: "region",
    regi_id: "regionid",
    user_id: "",
    test_user_name: "test_user",
    job_id: "",
    next_request: "",
    "function:getJobId": "",
    cluster_user_role_id: "",
    insert_timestamp: "0",
    csv_tb: "url_csv_data",
    csv_tb_empty: "url_csv_no_data",
    drop_schema: "drop_schema",
    drop_table: "drop_table",
    s3_key: process.env.S3_KEY,
    s3_secret: process.env.S3_SECRET,
    operation_token: "",
    refresh_token: "",
    my_operation_token: "",
    rootPath: "",
    restartTimeout: 45000,
		jobErrorMessage: ""
}

export const envUrl = `${testData.host}:${testData.port}`;
export const envUrlRest = `${testData.host}:${testData.portRest}`;


export const headers = createHeaders(testData.username, testData.password);
export const headersBulkLoadUser = createHeaders('bulk_load_user', testData.password);
export const headersTestUser = createHeaders(testData.test_user_name, testData.password);
export const headersNoPermsUser = createHeaders('no_perms_user', testData.password);
export const headersOnePermUser = createHeaders('one_perm_user', testData.password);
export const headersImportantUser = createHeaders('important-user', 'password');

export function createHeaders(username, password) {
    const headers = {
        'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    }
    return headers;
}

export const dateYesterday = new Date(new Date().getTime() - 86400000).toISOString();
export const dateTomorrow = new Date(new Date().getTime() + 86400000).toISOString();


export function getCsvPath() {
    let myPath = '';
    if(process.env.FILES_LOCATION) {
        myPath = process.env.FILES_LOCATION;
    } else {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        myPath = path.resolve(__dirname + '/../../../test/data/integrationTestsCsvs/') + '/';
    }
    console.log(myPath);
    return myPath;

}