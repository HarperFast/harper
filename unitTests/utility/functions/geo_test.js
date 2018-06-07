'use strict';

/***
 * Test the utility/geo.js functions
 */

const assert = require('assert');
const geo = require('../../../utility/functions/geo');

describe(`Test geoArea`, function () {
    it('Pass in null geoJSON, expect error', function () {
        assert.fail(geo.geoArea(null), true);
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