"use strict"
/**
 * Test the common_utils_test module.
 */

const assert = require('assert');
const cu = require('../../utility/common_utils');

describe(`Test isEmpty`, function () {
    it('Pass in null value, expect true', function () {
        assert.equal(cu.isEmpty(null), true);
    });
    it('Pass in undefined value, expect true', function () {
        assert.equal(cu.isEmpty(undefined), true);
    });
    it('Pass in value, expect false', function () {
        assert.equal(cu.isEmpty(12), false);
    });
    it('Pass in empty value, expect false', function () {
        assert.equal(cu.isEmpty(''), false);
    });
});

describe(`Test isEmptyOrZeroLength`, function () {
    it('Pass in null value, expect true', function () {
        assert.equal(cu.isEmptyOrZeroLength(null), true);
    });
    it('Pass in undefined value, expect true', function () {
        assert.equal(cu.isEmptyOrZeroLength(undefined), true);
    });
    it('Pass in value, expect false', function () {
        assert.equal(cu.isEmptyOrZeroLength(12), false);
    });
    it('Pass in empty value, expect true', function () {
        assert.equal(cu.isEmptyOrZeroLength(''), true);
    });
});

describe(`Test listHasEmptyValues`, function () {
    it('Pass in null value, expect true', function () {
        assert.equal(cu.listHasEmptyValues(null), true);
    });
    it('Pass in null value, expect true', function () {
        assert.equal(cu.listHasEmptyValues([null]), true);
    });
    it('Pass in undefined value, expect true', function () {
        assert.equal(cu.listHasEmptyValues([undefined]), true);
    });
    it('Pass in value, expect false', function () {
        assert.equal(cu.listHasEmptyValues([12]), false);
    });
    it('Pass in empty value, expect false', function () {
        assert.equal(cu.listHasEmptyValues(['']), false);
    });
});

describe(`Test listHasEmptyOrZeroLengthValues`, function () {
    it('Pass in null value, expect true', function () {
        assert.equal(cu.listHasEmptyOrZeroLengthValues([null]), true);
    });
    it('Pass in null value, expect true', function () {
        assert.equal(cu.listHasEmptyOrZeroLengthValues([null]), true);
    });
    it('Pass in undefined value, expect true', function () {
        assert.equal(cu.listHasEmptyOrZeroLengthValues([undefined]), true);
    });
    it('Pass in value, expect false', function () {
        assert.equal(cu.listHasEmptyOrZeroLengthValues([12]), false);
    });
    it('Pass in empty value, expect true', function () {
        assert.equal(cu.listHasEmptyOrZeroLengthValues(['']), true);
    });
});