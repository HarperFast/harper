"use strict"
/**
 * Test the common_utils_test module.
 */

const assert = require('assert');
const cu = require('../../utility/common_utils');

const ALL_SPACES = '     ';

describe(`Test errorizeMessage`, function () {
    it('Nominal, pass message', function () {
        let err = cu.errorizeMessage('This is an error');
        assert.equal((err instanceof Error), true);
    });

    it('Pass in null', function () {
        let err = cu.errorizeMessage(null);
        assert.equal((err instanceof Error), true);
    });

    it('Pass in undefined', function () {
        let err = cu.errorizeMessage(null);
        assert.equal((err instanceof Error), true);
    });
});

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
    it('Pass in 0, expect true', function () {
        assert.equal(cu.isEmptyOrZeroLength(0), false);
    });
    it('Pass in string with all spaces, expect false', function () {
        assert.equal(cu.isEmptyOrZeroLength(ALL_SPACES), false);
    });
});

describe(`Test listHasEmptyValues`, function () {
    it('Pass in null value, expect true', function () {
        assert.equal(cu.arrayHasEmptyValues(null), true);
    });
    it('Pass in null value, expect true', function () {
        assert.equal(cu.arrayHasEmptyValues([null]), true);
    });
    it('Pass in undefined value, expect true', function () {
        assert.equal(cu.arrayHasEmptyValues([undefined]), true);
    });
    it('Pass in value, expect false', function () {
        assert.equal(cu.arrayHasEmptyValues([12]), false);
    });
    it('Pass in empty value, expect false', function () {
        assert.equal(cu.arrayHasEmptyValues(['']), false);
    });
});

describe(`Test listHasEmptyOrZeroLengthValues`, function () {
    it('Pass in null value, expect true', function () {
        assert.equal(cu.arrayHasEmptyOrZeroLengthValues([null]), true);
    });
    it('Pass in null value, expect true', function () {
        assert.equal(cu.arrayHasEmptyOrZeroLengthValues([null]), true);
    });
    it('Pass in undefined value, expect true', function () {
        assert.equal(cu.arrayHasEmptyOrZeroLengthValues([undefined]), true);
    });
    it('Pass in value, expect false', function () {
        assert.equal(cu.arrayHasEmptyOrZeroLengthValues([12]), false);
    });
    it('Pass in empty value, expect true', function () {
        assert.equal(cu.arrayHasEmptyOrZeroLengthValues(['']), true);
    });
});

describe(`Test buildFolderPath`, function(){
    it(`Pass in null, expect empty string`, function(){
        assert.equal(cu.buildFolderPath(null), "");
    });

    it(`Pass in empty string, expect empty string`, function(){
        assert.equal(cu.buildFolderPath(''), "");
    });

    it(`Pass in values with mixed null and empty string, expect double slashes where empty values would be`, function(){
        assert.equal(cu.buildFolderPath('opt', null, 'test', '', 'data'), "opt//test//data");
    });

    it(`Pass in values mixed with numbers and strings, expect a path`, function(){
        assert.equal(cu.buildFolderPath('opt', 1, 'test', 45, 'data', '333-55'), 'opt/1/test/45/data/333-55');
    });
});