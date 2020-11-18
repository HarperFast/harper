'use strict'

const BASIC_AUTH = "Basic YWRtaW46QWJjMTIzNCE=";

const REG_INFO = { "operation": "registration_info" };
const DESCRIBE_ALL = { "operation": "describe_all" };
const DESCRIBE_SCHEMA = { "operation": "describe_schema", "schema": "benchmarks" };
const DESCRIBE_TABLE = { "operation": "describe_table", "schema": "benchmarks", "table": "dog" };
const SEARCH_BY_VAL = {
    "operation": "search_by_value", "schema": "benchmarks", "table": "dog",
    "search_attribute":"id",
    "search_value":"*",
    "get_attributes":["*"]
};
const SEARCH_BY_HASH = {
    "operation": "search_by_hash", "schema": "benchmarks", "table": "dog",
    "hash_values":[1,2,3,4,5,6,7,8,9,10],
    "get_attributes": ["adorable", "weight_lbs", "dog_name", "id", "owner_name", "age"]
};
const SQL_SIMPLE_SEARCH = {"operation": "sql", "sql": "SELECT * FROM benchmarks.dog"};
const SQL_SEARCH_WHERE_SORT = {"operation": "sql", "sql": "SELECT * FROM benchmarks.dog WHERE id < 10 ORDER BY dog_name"};

const REQUEST_JSON = {
    REG_INFO,
    DESCRIBE_ALL,
    DESCRIBE_SCHEMA,
    DESCRIBE_TABLE,
    SEARCH_BY_VAL,
    SEARCH_BY_HASH,
    SQL_SIMPLE_SEARCH,
    SQL_SEARCH_WHERE_SORT
};

const FUNC_INPUT = (data) => ({
    ...data,
    "hdb_user": {
        "__createdtime__": 1605289288279,
        "__updatedtime__": 1605289288279,
        "active": true,
        "auth_token": null,
        "role": {
            "__createdtime__": 1605289288277,
            "__updatedtime__": 1605289288277,
            "id": "fa852805-6b00-43d4-ad3e-e1ff96c82259",
            "permission": {
                "super_user": true
            },
            "role": "super_user"
        },
        "username": "admin"
    },
    "hdb_auth_header": BASIC_AUTH
});

const TEST_DOG_RECORDS = [
    {
        "adorable": true,
        "weight_lbs": 38,
        "dog_name": "Penny",
        "id": 1,
        "owner_name": "Kyle",
        "age": 7,
        "breed_id": 154
    },
    {
        "adorable": true,
        "weight_lbs": 55,
        "dog_name": "Harper",
        "id": 2,
        "owner_name": "Stephen",
        "age": 7,
        "breed_id": 346
    },
    {
        "adorable": true,
        "weight_lbs": 84,
        "dog_name": "Alby",
        "id": 3,
        "owner_name": "Kaylan",
        "age": 7,
        "breed_id": 348
    },
    {
        "adorable": true,
        "weight_lbs": 60,
        "dog_name": "Billy",
        "id": 4,
        "owner_name": "Zach",
        "age": 6,
        "breed_id": 347
    },
    {
        "adorable": true,
        "weight_lbs": 15,
        "dog_name": "Rose Merry",
        "id": 5,
        "owner_name": "Zach",
        "age": 8,
        "breed_id": 348
    },
    {
        "adorable": true,
        "weight_lbs": 32,
        "dog_name": "Kato",
        "id": 6,
        "owner_name": "Kyle",
        "age": 6,
        "breed_id": 154
    },
    {
        "adorable": true,
        "weight_lbs": 35,
        "dog_name": "Simon",
        "id": 7,
        "owner_name": "Fred",
        "age": 3,
        "breed_id": 349
    },
    {
        "adorable": true,
        "weight_lbs": 55,
        "dog_name": "Gemma",
        "id": 8,
        "owner_name": "Stephen",
        "age": 5,
        "breed_id": 250
    },
    {
        "adorable": true,
        "weight_lbs": 60,
        "dog_name": "Yeti",
        "id": 9,
        "owner_name": "Jaxon",
        "age": 12,
        "breed_id": 200
    },
    {
        "adorable": true,
        "weight_lbs": 35,
        "dog_name": "Monk",
        "id": 10,
        "owner_name": "Aron",
        "age": 7,
        "breed_id": 271
    },
    {
        "adorable": true,
        "weight_lbs": 75,
        "dog_name": "Bode",
        "id": 11,
        "owner_name": "Margo",
        "age": 8,
        "breed_id": 104
    },
    {
        "adorable": true,
        "weight_lbs": 60,
        "dog_name": "Tucker",
        "id": 12,
        "owner_name": "David",
        "age": 2,
        "breed_id": 346
    }
]


module.exports = {
    BASIC_AUTH,
    FUNC_INPUT,
    REQUEST_JSON,
    TEST_DOG_RECORDS
};
