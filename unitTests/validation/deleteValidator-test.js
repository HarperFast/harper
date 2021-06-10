'use strict';

const chai = require('chai');
const { expect } = chai;
const deleteValidator = require('../../validation/deleteValidator');

describe('Test deleteValidator module', () => {
    it('Test schema required returned', () => {
        const test_del_obj = {
            "table": "test",
            "hash_values": ["1a", 1, "3vs"]
        };
        const result = deleteValidator(test_del_obj);
        expect(result.message).to.equal("'schema' is required");
    });

    it('Test table required returned', () => {
        const test_del_obj = {
            "schema": "unit",
            "hash_values": ["1a", 1, "3vs"]
        };
        const result = deleteValidator(test_del_obj);
        expect(result.message).to.equal("'table' is required");
    });

    it('Test hash_values required returned', () => {
        const test_del_obj = {
            "schema": "unit",
            "table": "test"
        };
        const result = deleteValidator(test_del_obj);
        expect(result.message).to.equal("'hash_values' is required");
    });

    it('Test hash_values invalid returned', () => {
        const test_del_obj = {
            "schema": "unit",
            "table": "test",
            "hash_values": "1abc"
        };
        const result = deleteValidator(test_del_obj);
        expect(result.message).to.equal("'hash_values' must be an array");
    });
});