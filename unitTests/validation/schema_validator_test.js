'use strict';

const assert = require('assert');
const schema_validator = require('../../validation/schema_validator');


describe(`Test validateTableResidence`, function () {
    it('Pass in no argument, expect no error and return value of null', function () {
        assert.equal(schema_validator.validateTableResidence(), null);
    });
    it('Pass in string array, expect no error and return value of null', function () {
        assert.equal(schema_validator.validateTableResidence(["node1", "node2"]), null);
    });
    it('Pass in empty array, expect exception', function () {
        assert.throws(
            ()=>{
                schema_validator.validateTableResidence([]);
            },
            Error
        );
    });
    it('Pass in string, expect exception', function () {
        assert.throws(
            ()=>{
                schema_validator.validateTableResidence("[*]");
            },
            Error
        );
    });
    it('Pass in array with non-string value, expect exception', function () {
        assert.throws(
            ()=>{
                schema_validator.validateTableResidence(["node1", true, "node2"]);
            },
            Error
        );
    });
});

const expected_error_msgs = {
    schema: "Schema names cannot include backticks or forward slashes",
    table: "Table names cannot include backticks or forward slashes",
    hash_attr: "Hash attribute names cannot include backticks or forward slashes",
    attribute: "Attribute names cannot include backticks or forward slashes"
}

const test_schema_obj = (schema_val = 'test_schema') => ({
    schema: schema_val
});

const test_table_obj = (table_val = 'test_table', hash_val = 'test_id', schema_val = 'test_schema', ) => ({
    schema: schema_val,
    table: table_val,
    hash_attribute: hash_val
});

const test_attribute_obj  = (attr_val = 'test_attr', table_val = 'test_table', schema_val = 'test_schema') => ({
    schema: schema_val,
    table: table_val,
    attribute: attr_val
});

describe(`Test schema validators `, function () {
    describe(`schema_object `, function () {
        it('Pass in object with valid schema name', function () {
            assert.equal(schema_validator.schema_object(test_schema_obj()), null, "Schema object validation should return null for valid schema names")
        });

        it('Pass in object with another valid schema name', function () {
            const valid_schema = '~!@#$%^&*()_+-=;:?,.<>'
            assert.equal(schema_validator.schema_object(test_schema_obj(valid_schema)), null, "Schema object validation should return null for valid schema names")
        });

        it('Pass in object with invalid forward slash char in schema name', function () {
            const invalid_schema = 'test_/schema'
            const test_result = schema_validator.schema_object(test_schema_obj(invalid_schema));
            assert.equal(test_result.message, expected_error_msgs.schema, "Schema object validation should return schema validation error msg when a forward slash is included in schema name");
        });

        it('Pass in object with invalid backtick char in schema name', function () {
            const invalid_schema = 'test_`schema'
            const test_result = schema_validator.schema_object(test_schema_obj(invalid_schema));
            assert.equal(test_result.message, expected_error_msgs.schema, "Schema object validation should return schema validation error msg when a backtick is included in schema name");
        });
    });

    describe(`table_object`, function () {
        it('Pass in table_object with valid schema/table name values', function () {
            assert.equal(schema_validator.table_object(test_table_obj()), null, "Table object validation should return null for valid schema names")
        });

        it('Pass in object with another valid schema/table name', function () {
            const valid_table = '~!@#$%^&*()_+-=;:?,.<>'
            assert.equal(schema_validator.table_object(test_table_obj(valid_table)), null, "Schema object validation should return null for valid schema names")
        });

        it('Pass in object with no hash value included and expect no error msg', function () {
            const test_obj = test_table_obj();
            delete test_obj.hash_attribute
            assert.equal(schema_validator.table_object(test_obj), null, "Table object validation should not require a hash value");
        });

        it('Pass in object with invalid forward slash char in table name', function () {
            const invalid_table = 'test_/table'
            const test_result = schema_validator.table_object(test_table_obj(invalid_table));
            assert.equal(test_result.message, expected_error_msgs.table, "Table object validation should return schema validation error msg when a forward slash is included in schema name");
        });

        it('Pass in object with invalid backtick char in table name', function () {
            const invalid_table = 'test_`table'
            const test_result = schema_validator.table_object(test_table_obj(invalid_table));
            assert.equal(test_result.message, expected_error_msgs.table, "Table object validation should return schema validation error msg when a forward slash is included in schema name");
        });


    });

    describe(`create_table_object`, function () {
        it('Pass in create_table_object with valid schema/table values', function () {
            assert.equal(schema_validator.create_table_object(test_table_obj()), null, "Create table object validation should return null for valid table names")
        });

        it('Pass in object with another valid schema/table name', function () {
            const valid_table = '~!@#$%^&*()_+-=;:?,.<>'
            assert.equal(schema_validator.create_table_object(test_table_obj(valid_table)), null, "Create table object validation should return null for valid table names")
        });

        it('Pass in object with invalid forward slash char in table name', function () {
            const invalid_table = 'test_/table'
            const test_result = schema_validator.create_table_object(test_table_obj(invalid_table));
            assert.equal(test_result.message, expected_error_msgs.table, "Create table object validation should return table validation error msg when a forward slash is included in table name");
        });

        it('Pass in object with invalid backtick char in table name', function () {
            const invalid_table = 'test_`table'
            const test_result = schema_validator.create_table_object(test_table_obj(invalid_table));
            assert.equal(test_result.message, expected_error_msgs.table, "Create table object validation should return table validation error msg when a backtick is included in table name");
        });

        it('Pass in object with invalid forward slash char in table name', function () {
            const invalid_table = 'test_/table'
            const test_result = schema_validator.create_table_object(test_table_obj(invalid_table));
            assert.equal(test_result.message, expected_error_msgs.table, "Create table object validation should return table validation error msg when a forward slash is included in table name");
        });

        it('Pass in object with invalid backtick char in hash attr name', function () {
            const invalid_hash = 'test_`hash`'
            const test_result = schema_validator.create_table_object(test_table_obj('table', invalid_hash));
            assert.equal(test_result.message, expected_error_msgs.hash_attr, "Create table object validation should return hash attribute validation error msg when backticks are included in hash attribute name");
        });

        it('Pass in object with no hash attr value', function () {
            const test_obj = test_table_obj();
            delete test_obj.hash_attribute
            const test_result = schema_validator.create_table_object(test_obj);
            assert.equal(test_result.message, "Hash attribute is required", "Create table object validation should error msg when no hash attribute value is included");
        });
    });

    describe(`attribute_object`, function () {
        it('Pass in attribute_object with valid schema/table/attribute value', function () {
            assert.equal(schema_validator.attribute_object(test_attribute_obj()), null, "Attribute object validation should return null for valid schema/table/attr names")
        });

        it('Pass in object with another valid schema/table/attr name', function () {
            const valid_name = '~!@#$%^&*()_+-=;:?,.<>'
            assert.equal(schema_validator.attribute_object(test_attribute_obj(valid_name,valid_name,valid_name)), null, "Attribute object validation should return null for valid schema/table/attr names")
        });

        it('Pass in object with invalid forward slash char in attr name', function () {
            const invalid_attr = 'test_/attr'
            const test_result = schema_validator.attribute_object(test_attribute_obj(invalid_attr));
            assert.equal(test_result.message, expected_error_msgs.attribute, "Attribute object validation should return attr validation error msg when a forward slash is included in attr name");
        });

        it('Pass in object with invalid backtick char in attr name', function () {
            const invalid_attr = 'test_`attr'
            const test_result = schema_validator.attribute_object(test_attribute_obj(invalid_attr));
            assert.equal(test_result.message, expected_error_msgs.attribute, "Attribute object validation should return attr validation error msg when a backtick is included in attr name");
        });

        it('Pass in object with invalid forward slash char in table name', function () {
            const invalid_table = 'test_/attr'
            const test_result = schema_validator.attribute_object(test_attribute_obj("test_attr", invalid_table));
            assert.equal(test_result.message, expected_error_msgs.table, "Attribute object validation should return table validation error msg when a forward slash is included in table name");
        });
    });
});
