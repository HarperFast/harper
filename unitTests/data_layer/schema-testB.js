'use strict';
const test_util = require('../test_utils');
test_util.preTestPrep();

const chai = require('chai');
const sinon = require('sinon');

let schema = require('../../data_layer/schema');
let signalling = require('../../utility/signalling');

const { expect } = chai;
const TEST_SCHEMA_NAME = 'dogsrule';
describe('Test schema module', function() {

    it('Should return valid stub from createSchemaStructure', async function() {

        let create_schema_structure_stub = sinon.stub(schema, 'createSchemaStructure').resolves('This is a stub');

        let signal_schema_change_stub = sinon.stub(signalling, 'signalSchemaChange');

        let schema_create_object_fake = {operation: 'create_schema', schema: TEST_SCHEMA_NAME};
        let result = await schema.createSchema(schema_create_object_fake);
    });
});



global.hdb_schema = {
    "system": {
        "hdb_table": {
            "hash_attribute": "id",
            "name": "hdb_table",
            "schema": "system",
            "residence": [
                "*"
            ],
            "attributes": [
                {
                    "attribute": "id"
                },
                {
                    "attribute": "name"
                },
                {
                    "attribute": "hash_attribute"
                },
                {
                    "attribute": "schema"
                }
            ]
        },
        "hdb_drop_schema": {
            "hash_attribute": "id",
            "name": "hdb_drop_schema",
            "schema": "system",
            "residence": [
                "*"
            ]
        },
        "hdb_attribute": {
            "hash_attribute": "id",
            "name": "hdb_attribute",
            "schema": "system",
            "residence": [
                "*"
            ]
        },
        "hdb_schema": {
            "hash_attribute": "name",
            "name": "hdb_schema",
            "schema": "system",
            "residence": [
                "*"
            ],
            "attributes": [
                {
                    "attribute": "name"
                },
                {
                    "attribute": "createddate"
                }
            ]
        },
        "hdb_user": {
            "hash_attribute": "username",
            "name": "hdb_user",
            "schema": "system",
            "residence": [
                "*"
            ]
        },
        "hdb_role": {
            "hash_attribute": "id",
            "name": "hdb_user",
            "schema": "system",
            "residence": [
                "*"
            ]
        },
        "hdb_license": {
            "hash_attribute": "license_key",
            "name": "hdb_license",
            "schema": "system"
        },
        "hdb_nodes": {
            "hash_attribute": "name",
            "residence": [
                "*"
            ]
        },
        "hdb_queue": {
            "hash_attribute": "id",
            "name": "hdb_queue",
            "schema": "system",
            "residence": [
                "*"
            ]
        }
    }
};

