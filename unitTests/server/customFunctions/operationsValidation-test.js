'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const hdb_utils = require('../../../utility/common_utils');
const test_utils = require('../../test_utils');
const env_mangr = require('../../utility/environment/environmentManager-test');

describe('Test operationsValidation module', () => {
    const sandbox = sinon.createSandbox();


    after(() => {
        sandbox.restore();
    });

});