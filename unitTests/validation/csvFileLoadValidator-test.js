'use strict';
const test_util = require('../test_utils');
test_util.preTestPrep();

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);
const rewire = require('rewire');
let csv_file_load_validator = rewire('../../validation/csvFileLoadValidator');
const csv_validator = require('../../validation/csvLoadValidator');

const FAKE_FILE_PATH = '/thisfilepath/wont/exist.csv';

/**
 *  Unit tests for validation/csvFileLoadValidator.js
 */
describe('Test csvFileLoadValidator module', () => {
    let max_csv_file_size_rewire;
    let p_fs_access_stub = sinon.stub().resolves();
    let file_size_stub = sinon.stub();
    let file_size_rewire;
    let csv_validator_stub;

    afterEach(function() {
        sinon.resetHistory();
    });
    
    after(() => {
        sinon.restore();
        file_size_rewire();
        csv_file_load_validator = rewire('../../validation/csvFileLoadValidator');
    });

    before(() => {
        max_csv_file_size_rewire = csv_file_load_validator.__get__('MAX_CSV_FILE_SIZE');
        file_size_rewire = csv_file_load_validator.__set__('fs.statSync', file_size_stub);
        csv_validator_stub = sinon.stub(csv_validator, 'fileObject') ;
    });

    context('Test csvFileLoadValidator function', () => {

        let json_message_fake = {
            operation: "csv_file_load",
            action: "insert",
            schema: "northnwd",
            table: "suppliers",
            file_path: FAKE_FILE_PATH
        }
        
        it('should throw a validation error', async () => {
            let csv_validator_err = 'Error validating file';
            csv_validator_stub.returns(new Error(csv_validator_err));
            let error;
            
            try {
                await csv_file_load_validator.csvFileLoadValidator(json_message_fake);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.be.equal(csv_validator_err);
            expect(csv_validator_stub).to.have.been.calledOnce;
        });

        it('should throw an error from p_fs_access', async () => {
            csv_validator_stub.returns();
            let error;

            try {
                await csv_file_load_validator.csvFileLoadValidator(json_message_fake);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.equal(`ENOENT: no such file or directory, access '${FAKE_FILE_PATH}'`);
            expect(csv_validator_stub).to.have.been.calledOnce;
        });

        it('should throw an error from file_size', async () => {
            let fake_file_size = max_csv_file_size_rewire + 100;
            let p_fs_access_rewire = csv_file_load_validator.__set__('p_fs_access', p_fs_access_stub);
            file_size_stub.returns({size: fake_file_size});
            let error;

            try {
                await csv_file_load_validator.csvFileLoadValidator(json_message_fake);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.equal(`File size is ${fake_file_size} bytes, which exceeded the maximum size allowed of: ${max_csv_file_size_rewire} bytes`);
            expect(csv_validator_stub).to.have.been.calledOnce;
            expect(p_fs_access_stub).to.have.been.calledOnce;
            expect(file_size_stub).to.have.been.calledOnce;

            p_fs_access_rewire();
        });
    });
});
