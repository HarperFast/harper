'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
let fs_delete_records = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDeleteRecords');
const log = require('../../../../../utility/logging/harper_logger');
const hdb_terms = require('../../../../../utility/hdbTerms');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

describe('Tests for file system module fsDeleteRecords', () => {

    let delete_obj = {

    };

    before(() => {
        fs_delete_records.__set__('BASE_PATH', 'fooBar');
    });

    it('Test RW works', async () => {
        await fs_delete_records(delete_obj);
    });

});