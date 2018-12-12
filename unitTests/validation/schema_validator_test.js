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

