'use strict';

const { promisify } = require('util');
const colors = require("colors/safe");
const axios = require('axios');
const instance = axios.create();
const lmdb_util = require('../../utility/lmdb/commonUtility');
const env_mngr = require('../../utility/environment/environmentManager');
const global_schema = require('../../utility/globalSchema');

const reg_info = require('../../utility/registration/registrationHandler');
const schema_describe = require('../../data_layer/schemaDescribe');
const search = require('../../data_layer/search');
const sql = require('../../sqlTranslator/index');
const p_search_search_by_hash = promisify(search.searchByHash);
const p_search_search_by_value = promisify(search.searchByValue);
const p_sql_evaluate_sql = promisify(sql.evaluateSQL);

const p_global_schema = promisify(global_schema.setSchemaDataToGlobal);
env_mngr.initSync();

const HTTP_PORT = 9925;//env_mngr.get('HTTP_PORT');
const BASE_ROUTE = `http://localhost:${HTTP_PORT}`;
const { BASIC_AUTH, FUNC_INPUT, REQUEST_JSON, TEST_DOG_RECORDS } = require('./testData');

const USE_JWTS = true;
const JWT_AUTH = "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6ImFkbWluIiwiaWF0IjoxNjA1NjUxMjMzLCJleHAiOjE2MDU3Mzc2MzMsInN1YiI6Im9wZXJhdGlvbiJ9.L8Az4Sha2cNA797OHhkAswm-aLkK9odXcn7t0MXJJoF2BtCb7RDYPOI1xcVS9JdmpxYRnCTvROnT7D6jkCs8ROWXJNYo7y0n6hudQpAaQQsiwVG7Vfj_6IRuClRTygMc122uM2KoaB4y4cYZHs-tDM8FWIyVwD0Vrj3gHOm8Tes4-RbjjCv2dJi_KpvjwwRi2dX3MMEuKrLo4zF3-w1n5zymkCdd890mk7lTS2ID29g8Kzth1hgbhBgzja6zoxSXOAAvrCJeP0kvhFfsBAvWslFZNnsjBYBcs9nMMHiFBd6JFenEK6nNc-ftud2EKxjjm135Z1gJdZZVnVfeFlSNTYJBL61LAe8bU55YzkhfbY8ejn0qpdGIQA0Ab6IihdacSNH8B7cb3UCw7vvO7haRv9JTc_0nf10uoA8R9vEfFSh9seRkJAKBTRrq6Nw4IUUx3cKB8WBHOeqnOrZtXzDKgSVnAYEzQeqETy5hlpIS31ZyoCYdiF0urN4R9j_Y1G0PKHAyBqzPQcJMSfwDkaP8_FMTdewIsUa-a8iXZglXIvdoxv3-vGCdRDTcfoKuHhBFqm75A0s5fLWaxwe85k66-gSVeBUPleOZ4w7ZrraYYMoYTXJyJ264zFWWhfxKUkasnOpHbMHKoa2BO4niOCRMFzV5wibDH7e5-DBgVLJ54No";
const test_auth_method = USE_JWTS ? JWT_AUTH : BASIC_AUTH;

const REQS_KEYS = Object.keys(REQUEST_JSON);
const REQS_LENGTH = REQS_KEYS.length

const OP_FUNC_MAP = {
    REG_INFO: reg_info.getRegistrationInfo,
    DESCRIBE_ALL: schema_describe.describeAll,
    DESCRIBE_SCHEMA: schema_describe.describeSchema,
    DESCRIBE_TABLE: schema_describe.describeTable,
    SEARCH_BY_VAL: p_search_search_by_value,
    SEARCH_BY_HASH: p_search_search_by_hash,
    SQL_SIMPLE_SEARCH: p_sql_evaluate_sql,
    SQL_SEARCH_WHERE_SORT: p_sql_evaluate_sql
};

instance.interceptors.request.use((config) => {
    config.headers['request-startTime'] = lmdb_util.getMicroTime();
    return config;
});

instance.interceptors.response.use((response) => {
    const end = lmdb_util.getMicroTime();
    const start = response.config.headers['request-startTime'];

    const milliseconds = end - start;
    response.headers['request-duration'] = milliseconds;
    return response;
});

const benchmark = () => ({
    api: null,
    data: null
});

const benchmarkResults = {
    REG_INFO: benchmark(),
    DESCRIBE_ALL: benchmark(),
    DESCRIBE_SCHEMA: benchmark(),
    DESCRIBE_TABLE: benchmark(),
    SEARCH_BY_VAL: benchmark(),
    SEARCH_BY_HASH: benchmark(),
    SQL_SIMPLE_SEARCH: benchmark(),
    SQL_SEARCH_WHERE_SORT: benchmark()
}

function pause() {
    return new Promise(resolve => setTimeout(resolve, 500));
}

async function setupBenchmarkData() {
    console.log(colors.blue(`Setting up benchmark data for ${JWT_AUTH ? 'TOKEN' : 'BASIC' } auth`));
    try {
        await instance.post(BASE_ROUTE,
            {
                operation: "create_schema",
                schema: "benchmarks"
            },
            {
                headers: {
                    'X-Custom-Header': 'foobar',
                    'Authorization': BASIC_AUTH,
                    'Content-Type': 'application/json'
                }
            });
    } catch(e) {
        console.log(colors.red('There was an error setting up benchmark schema - ', e));
    }

    await pause();
    try {
        await instance.post(BASE_ROUTE,
            {
                operation: "create_table",
                schema: "benchmarks",
                table: "dog",
                hash_attribute: "id"
            },
            {
                headers: {
                    'X-Custom-Header': 'foobar',
                    'Authorization': BASIC_AUTH,
                    'Content-Type': 'application/json'
                }
            });
    } catch(e) {
        console.log(colors.red('There was an error setting up benchmark table - ', e));
    }

    await pause();
    try {
        await instance.post(BASE_ROUTE,
            {
                "operation":"insert",
                "schema":"benchmarks",
                "table":"dog",
                "records": TEST_DOG_RECORDS
            },
            {
                headers: {
                    'X-Custom-Header': 'foobar',
                    'Authorization': BASIC_AUTH,
                    'Content-Type': 'application/json'
                }
            });
    } catch(e) {
        console.log(colors.red('There was an error inserting benchmark data - ', e));
    }

    await pause();
    console.log(colors.blue('Benchmark data setup COMPLETE'));
}

async function dropBenchmarkData() {
    console.log(colors.blue('Dropping benchmark data'));
    try {
        await instance.post(BASE_ROUTE,
            {
                operation: "drop_schema",
                schema: "benchmarks"
            },
            {
                headers: {
                    'X-Custom-Header': 'foobar',
                    'Authorization': BASIC_AUTH,
                    'Content-Type': 'application/json'
                }
            });
    } catch(e) {
        console.log(colors.red('There was an error dropping benchmark data - ', e));
    }
    console.log(colors.blue('Dropping benchmark data COMPLETE'));
}

async function rawDataFunctionBenchmark() {
    console.log("Raw data function benchmarks starting");
    for (let y = 0; y < REQS_LENGTH; y++) {
        const func_key = REQS_KEYS[y];
        const func = OP_FUNC_MAP[func_key];
        const input = FUNC_INPUT(REQUEST_JSON[func_key]);
        let x = 6000;
        let sum = 0;
        while (x-- > 3000) {

            try {
                const start = lmdb_util.getMicroTime();
                await func(input);
                const end = lmdb_util.getMicroTime();

                sum+= end-start;
            } catch(e){
                console.error(e);
            }
        }
        // console.log(`${func_key} average response time: ${sum / 1000}`);
        benchmarkResults[func_key].data = sum / 1000
    }
    console.log("Raw data function benchmarks completed");
}

async function httpBenchmark() {
    console.log("API benchmarks starting");
    for (let y = 0; y < REQS_LENGTH; y++) {
        const key = REQS_KEYS[y]
        const body_json = REQUEST_JSON[key];
        let x = 6000;
        let sum = 0;
        while (x-- > 3000) {
            try {
                const response = await instance.post(BASE_ROUTE,
                    body_json,
                    {
                        headers: {
                            'X-Custom-Header': 'foobar',
                            'Authorization': test_auth_method,
                            'Content-Type': 'application/json'
                        }
                    });
                const response_time = response.headers['request-duration'];

                sum+=response_time;
            }catch(e){
                console.error(e);
            }
        }
        benchmarkResults[key].api = sum / 1000
        // console.log(`${key} average response time: ${sum / 1000}`);
    }
    console.log("API benchmarks completed");
}

function evalBenchmarks() {
    for (const key in benchmarkResults) {
        const bench = benchmarkResults[key];
        console.log(colors.green.bold(`|------------- ${key} ------------|`));
        console.log(colors.magenta.italic(`API: ${bench.api}`));
        console.log(colors.magenta.italic(`Data: ${bench.data}`));
        console.log(colors.magenta(`Diff: ${bench.api - bench.data}`, '\n'));
        const diff = Math.round(((bench.api - bench.data)/bench.api) * 10000) / 100
        console.log(colors.magenta.bold(`DIFF %: ${diff}`, '\n'));
    }
}

async function run() {
    await setupBenchmarkData();
    await p_global_schema();
    await rawDataFunctionBenchmark();
    await httpBenchmark();
    evalBenchmarks();
    await dropBenchmarkData();
}

run().then(()=>{});


