'use strict';

const test_utils = require('../test_utils');
test_utils.preTestPrep();
const chai = require('chai');
const { expect } = chai;
const insertValidator = require('../../validation/insertValidator');

/**
 *  Unit tests for validation/insertValidator.js
 */
describe('Test insertValidator', () => {
    it('Test validator happy path result is undefined', () => {
        const test_insert_obj = {
            "operation": "insert",
            "schema": "test-schema",
            "table": "test-table",
            "records": [
                {
                    "id": "123abc",
                    "customer": "Jerry"
                },
                {
                    "id": "123qwe",
                    "customer": "Perry"
                }
            ]
        };
        const result = insertValidator(test_insert_obj);

        expect(result).to.be.undefined;
    });

    it('Test validator happy path result is undefined with number schema/table', () => {
        const test_insert_obj = {
            "operation": "insert",
            "schema": 123,
            "table": 4,
            "records": [
                {
                    "id": "123abc",
                    "customer": "Jerry"
                }
            ]
        };
        const result = insertValidator(test_insert_obj);

        expect(result).to.be.undefined;
    });

    it('Test validator returns missing schema message', () => {
        const test_insert_obj = {
            "operation": "insert",
            "table": "test-table",
            "records": [
                {
                    "id": "123abc",
                    "customer": "Jerry"
                }
            ]
        };
        const result = insertValidator(test_insert_obj);

        expect(result.message).to.be.equal("'schema' is required");
    });

    it('Test validator returns missing table message', () => {
        const test_insert_obj = {
            "operation": "insert",
            "schema": "test-schema",
            "records": [
                {
                    "id": "123abc",
                    "customer": "Jerry"
                }
            ]
        };
        const result = insertValidator(test_insert_obj);

        expect(result.message).to.be.equal("'table' is required");
    });

    it('Test validator returns missing records message', () => {
        const test_insert_obj = {
            "operation": "insert",
            "schema": "test-schema",
            "table": "test-table"
        };
        const result = insertValidator(test_insert_obj);

        expect(result.message).to.be.equal("'records' is required");
    });

    it('Test validator returns no slashes or backticks message', () => {
        const test_insert_obj = {
            "operation": "insert",
            "schema": "test/schema",
            "table": "`testtable`",
            "records": [
                {
                    "id": "123abc",
                    "customer": "Jerry"
                }
            ]
        };
        const result = insertValidator(test_insert_obj);

        expect(result.message).to.be.equal("'schema' names cannot include backticks or forward slashes. 'table' names cannot include backticks or forward slashes");
    });

    it('Test validator returns not allowed to be empty message', () => {
        const test_insert_obj = {
            "operation": "insert",
            "schema": "",
            "table": "",
            "records": [
                {
                    "id": "123abc",
                    "customer": "Jerry"
                }
            ]
        };
        const result = insertValidator(test_insert_obj);

        expect(result.message).to.be.equal("'schema' is not allowed to be empty. 'table' is not allowed to be empty");
    });

    it('Test validator returns records must contain item message', () => {
        const test_insert_obj = {
            "operation": "insert",
            "schema": "test-schema",
            "table": "test-table",
            "records": []
        };
        const result = insertValidator(test_insert_obj);

        expect(result.message).to.be.equal("'records' must contain at least 1 items");
    });

    it('Test validator returns too long message', () => {
        const test_insert_obj = {
            "operation": "insert",
            "schema": "nr5p8aPdtyjRiZl4i4HbIIyBBJywRoOzvzanwJtpA5H5wZ1bv1PPgrccdUXvZSvh5pDikXHbRb3yMWFS7sWKs34nrv1vDM8E6REq" +
                "YBMxoSSnnC0d1Ecep1Kid7VzuARKhc2giMR47IsHx2EIceqsvVcIOTwJry77X7mqjSjK58rgK6q2aZozCSFkcQOjO9LAvKENddtMsTHLBVilgZpdRr" +
                "Wiqfeqpu4w1C1VKbY7EgfDptq6TPe2OzidPNO",
            "table": "nr5p8aPdtyjRiZl4i4HbIIyBBJywRoOzvzanwJtpA5H5wZ1bv1PPgrccdUXvZSvh5pDikXHbRb3yMWFS7sWKs34nrv1vDM8E6REq" +
                "YBMxoSSnnC0d1Ecep1Kid7VzuARKhc2giMR47IsHx2EIceqsvVcIOTwJry77X7mqjSjK58rgK6q2aZozCSFkcQOjO9LAvKENddtMsTHLBVilgZpdRr" +
                "Wiqfeqpu4w1C1VKbY7EgfDptq6TPe2OzidPNO",
            "records": [
                {
                    "id": "123abc",
                    "customer": "Jerry"
                }
            ]
        };
        const result = insertValidator(test_insert_obj);

        expect(result.message).to.be.equal("'schema' length must be less than or equal to 250 characters long. 'table' length must be less than or equal to 250 characters long");
    });

    it('Test validator returns invalid attribute name message with empty attribute', () => {
        const test_insert_obj = {
            "operation": "insert",
            "schema": "test-schema",
            "table": "test-table",
            "records": [
                {
                    "": "123abc",
                    "customer": "Jerry"
                }
            ]
        };
        const result = insertValidator(test_insert_obj);

        expect(result.message).to.be.equal("Invalid attribute name: ''");
    });

    it('Test validator returns invalid attribute name message multiple', () => {
        const test_insert_obj = {
            "operation": "insert",
            "schema": "test-schema",
            "table": "test-table",
            "records": [
                {
                    "id": "123abc",
                    "undefined": "Jerry"
                },
                {
                    "id": "123abc",
                    "null": "Jerry"
                }
            ]
        };
        const result = insertValidator(test_insert_obj);

        expect(result.message).to.be.equal("Invalid attribute name: 'undefined'. Invalid attribute name: 'null'");
    });

    it('Test validator returns at least one record message', () => {
        const test_insert_obj = {
            "operation": "insert",
            "schema": "test-schema",
            "table": "test-table",
            "records": [
                {}
            ]
        };
        const result = insertValidator(test_insert_obj);

        expect(result.message).to.be.equal("'records' must contain at least one record");
    });
});
