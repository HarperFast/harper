'use strict';
const test_util = require('../test_utils');
test_util.preTestPrep();

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);
const rewire = require('rewire');
let csv_validator = rewire('../../validation/csvValidator');
const csv_load_validator = require('../../validation/csvLoadValidator');
const common_utils = require('../../utility/common_utils');

const FAKE_FILE_PATH = '/thisfilepath/wont/exist.csv';

/**
 *  Unit tests for validation/csvValidator.js
 */
describe('Test csvValidator module', () => {
    let max_csv_file_size_rewire;
    let p_fs_access_stub = sinon.stub().resolves();
    let file_size_stub = sinon.stub();
    let file_size_rewire;
    let csv_file_load_val_stub = sinon.stub();
    let csv_file_load_val_rewire;
    let csv_file_obj_val_stub;
    let csv_url_obj_val_stub;
    let csv_data_obj_val_stub;
    let csv_load_validator_err = 'Error validating object';

    let json_body_file_fake = {
        operation: "csv_file_load",
        action: "insert",
        schema: "hats",
        table: "fordogs",
        file_path: FAKE_FILE_PATH
    };

    let json_body_url_fake = {
        operation: "csv_url_load",
        action: "insert",
        schema: "hats",
        table: "fordogs",
        csv_url: "https://s3.amazonaws.com/complimentarydata/breeds.csv"
    };

    let json_body_data_fake = {
        operation: "csv_data_load",
        action: "insert",
        schema: "hats",
        table: "fordogs",
        csv_url: "id, type\n1, English Pointer"
    };

    beforeEach(function() {
        sinon.resetHistory();
    });
    
    after(() => {
        sinon.restore();
        file_size_rewire();
        csv_validator = rewire('../../validation/csvValidator');

    });

    before(() => {
        max_csv_file_size_rewire = csv_validator.__get__('MAX_CSV_FILE_SIZE');
        file_size_rewire = csv_validator.__set__('fs.statSync', file_size_stub);
        csv_file_obj_val_stub = sinon.stub(csv_load_validator, 'fileObject');
        csv_url_obj_val_stub = sinon.stub(csv_load_validator, 'urlObject');
        csv_data_obj_val_stub = sinon.stub(csv_load_validator, 'dataObject');
        csv_file_load_val_rewire = csv_validator.__set__('csvFileLoadValidator', csv_file_load_val_stub);
    });

    /**
     * Unit tests for csvValidator function
     */
    context('Test csvValidator function', () => {

        it('should throw a validation error from csv file load validation', async () => {
            csv_file_obj_val_stub.returns(new Error(csv_load_validator_err));
            let error;
            
            try {
                await csv_validator.csvValidator(json_body_file_fake);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.be.equal(csv_load_validator_err);
            expect(csv_file_obj_val_stub).to.have.been.calledOnce;
        });

        it('should catch an error message thrown from csvFileLoadValidator', async () => {
            let csv_file_load_val_err = 'File size exceeded';
            csv_file_obj_val_stub.returns();
            csv_file_load_val_stub.throws(csv_file_load_val_err);
            let error;

            try {
                await csv_validator.csvValidator(json_body_file_fake);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.be.equal(csv_file_load_val_err);
            expect(csv_file_obj_val_stub).to.have.been.calledOnce;
        });

        it('should throw a validation error from url load validation', async () => {
            csv_url_obj_val_stub.returns(new Error(csv_load_validator_err));
            let error;

            try {
                await csv_validator.csvValidator(json_body_url_fake);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.be.equal(csv_load_validator_err);
            expect(csv_url_obj_val_stub).to.have.been.calledOnce;
        });

        it('should throw a validation error from data load validation', async () => {
            csv_data_obj_val_stub.returns(new Error(csv_load_validator_err));
            let error;

            try {
                await csv_validator.csvValidator(json_body_data_fake);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.be.equal(csv_load_validator_err);
            expect(csv_data_obj_val_stub).to.have.been.calledOnce;
        });

        it('should throw an error from common_utils.checkGlobalSchemaTable', async () => {
            csv_data_obj_val_stub.returns('');
            let check_glob_schema_err = `schema ${json_body_data_fake.schema} does not exist`;
            let check_glob_schema_stub = sinon.stub(common_utils, 'checkGlobalSchemaTable').throws(check_glob_schema_err);
            let error;

            try {
                await csv_validator.csvValidator(json_body_data_fake);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.be.equal(check_glob_schema_err);
            expect(csv_data_obj_val_stub).to.have.been.calledOnce;
            expect(check_glob_schema_stub).to.have.been.calledOnce;
        });
    });

    /**
     * Unit tests for csvFileLoadValidator function
     */
    context('Test csvFileLoadValidator function', () => {
        let csv_file_load_validator;

        before(() => {
            csv_file_load_val_rewire();
            csv_file_load_validator = csv_validator.__get__('csvFileLoadValidator');
        });

        it('should throw an error from p_fs_access', async () => {
            let error;

            try {
                await csv_file_load_validator(json_body_file_fake);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.equal(`ENOENT: no such file or directory, access '${FAKE_FILE_PATH}'`);
        });

        it('should throw an error from file_size', async () => {
            let fake_file_size = max_csv_file_size_rewire + 100;
            let p_fs_access_rewire = csv_validator.__set__('p_fs_access', p_fs_access_stub);
            file_size_stub.returns({size: fake_file_size});
            let error;

            try {
                await csv_file_load_validator(json_body_file_fake);
            } catch(err) {
                error = err;
            }

            expect(error).to.equal(`File size is ${fake_file_size} bytes, which exceeded the maximum size allowed of: ${max_csv_file_size_rewire} bytes`);
            expect(p_fs_access_stub).to.have.been.calledOnce;
            expect(file_size_stub).to.have.been.calledOnce;

            p_fs_access_rewire();
        });
    });
});
