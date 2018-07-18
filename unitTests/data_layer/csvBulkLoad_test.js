'use strict';

const test_utils = require('../test_utils');
// try to move to /bin directory so our properties reader doesn't explode.
test_utils.preTestPrep();
const assert = require('assert');
const sinon = require('sinon');
const rewire = require('rewire');
const csv_rewire = rewire('../../data_layer/csvBulkLoad');
const hdb_terms = require('../../utility/hdbTerms');

const VALID_CSV_DATA = "id,name,section,country,image\n1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/001g07.jpg\n2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/002g07.jpg\n3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n";

const DATA_LOAD_MESSAGE = {
    "operation":"",
    "schema":"dev",
    "table":"breed",
    "action":"insert",
    "data": ''
};

describe('Test csvDataLoad', function () {
    let test_msg = undefined;
    beforeEach(function () {
        test_msg = test_utils.deepClone(DATA_LOAD_MESSAGE);
        msg.operation = hdb_terms.OPERATION_NAMES.csv_data_load;
        msg.data = VALID_CSV_DATA;
    });
    afterEach(function () {
    });

    it('Test nominal case with valid file and valid column names/data', async function() {

    });
}