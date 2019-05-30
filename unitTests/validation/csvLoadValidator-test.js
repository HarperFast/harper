'use strict';
const test_util = require('../test_utils');
test_util.preTestPrep();

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);
const fs = require('fs');
const rewire = require('rewire');
const validator = require('../../validation/validationWrapper');
let csv_load_validator = rewire('../../validation/csvLoadValidator');
const common_utils = require('../../utility/common_utils');
const log = require('../../utility/logging/harper_logger');

const FAKE_FILE_PATH = '/thisfilepath/wont/exist.csv';
const LONG_STRING = "TheresolvedtechnologydisappearsThesynthesisperfectsanincompetenceTheprerequisiteremedypurchasesthe" +
    "reasonableantiqueThespeakerrainsdownupontheenergyoveranobtainablerainbowAdownhilltablestheauntTheintermediateoxygen" +
    "concedesthestrayThestandardsectcautionstheeaterThefootballfreezesbehindareceipt";

/**
 *  Unit tests for validation/csvLoadValidator.js
 */
describe('Test csvLoadValidator module', () => {

    let obj_no_schema = {
        operation: "csv_data_load",
        action: "insert",
        table: "fordogs",
        data: "id, type\n1, English Pointer\n"
    };

    let obj_no_table = {
        operation: "",
        action: "insert",
        schema: "hats",
        data: "id, type\n1, English Pointer\n"
    };

    let obj_non_alpha_numeric_table = {
        operation: "",
        action: "insert",
        schema: "hats",
        table: "#@fordogs",
        data: "id, type\n1, English Pointer\n"
    };

    let obj_non_alpha_numeric_schema = {
        operation: "",
        action: "insert",
        schema: "h@ts",
        table: "fordogs",
        data: "id, type\n1, English Pointer\n"
    };

    let obj_over_length_table = {
        operation: "csv_data_load",
        action: "insert",
        schema: "hats",
        table: LONG_STRING,
        data: "id, type\n1, English Pointer\n"
    };

    let obj_over_length_schema = {
        operation: "csv_data_load",
        action: "insert",
        schema: LONG_STRING,
        table: "fordogs",
        data: "id, type\n1, English Pointer\n"
    };

    let obj_wrong_action = {
        operation: "csv_data_load",
        action: "drop",
        schema: "hats",
        table: "fordogs",
        data: "id, type\n1, English Pointer\n"
    };

    let data_object = {
        operation: "csv_data_load",
        action: "insert",
        schema: "hats",
        table: "fordogs",
        data: "id, type\n1, English Pointer\n"
    };

    let file_object = {
        operation: "csv_file_load",
        action: "insert",
        schema: "hats",
        table: "fordogs",
        file_path: FAKE_FILE_PATH
    };

    let url_object = {
        operation: "csv_file_load",
        action: "insert",
        schema: "hats",
        table: "fordogs",
        csv_url: 'google.com'
    };

    before(() => {
        global.hdb_schema = {
            "hats": {}
        };
    });

    after(() => {
        delete global.hdb_schema['hats'];
        csv_load_validator = rewire('../../validation/csvLoadValidator');
        sinon.restore();
    });

    beforeEach(() => {
        sinon.resetHistory();
    });

    /**
     * Unit tests for validate module
     */
    context('Test validate module', () => {

        it('should return schema cant be blank error from dataObject', () => {
            let result = csv_load_validator.dataObject(obj_no_schema);

            expect(result).to.be.instanceof(Error);
            expect(result.message).to.equal("Schema can't be blank");
        });

        it('should return table cant be blank error from dataObject',() => {
            let result = csv_load_validator.dataObject(obj_no_table);

            expect(result).to.be.instanceof(Error);
            expect(result.message).to.equal("Table can't be blank");
        });
        
        it('should return must be alpha numeric error on table', () => {
            global.hdb_schema = {
                "hats": {
                    "fordogs": {}
                }
            };
            let result = csv_load_validator.dataObject(obj_non_alpha_numeric_table);

            expect(result).to.be.instanceof(Error);
            expect(result.message).to.equal('Table must be alpha numeric');
        });

        it('should return must be alpha numeric error on schema', () => {
            let result = csv_load_validator.dataObject(obj_non_alpha_numeric_schema);

            expect(result).to.be.instanceof(Error);
            expect(result.message).to.equal('Schema must be alpha numeric');
        });

        it('should return cannot exceed 250 characters error on schema', () => {
            let result = csv_load_validator.dataObject(obj_over_length_schema);

            expect(result).to.be.instanceof(Error);
            expect(result.message).to.equal('Schema cannot exceed 250 characters');
        });

        it('should return cannot exceed 250 characters error on table', () => {
            let result = csv_load_validator.dataObject(obj_over_length_table);

            expect(result).to.be.instanceof(Error);
            expect(result.message).to.equal('Table cannot exceed 250 characters');
        });

        it('should return action is required to be be either insert or update', () => {
            let result = csv_load_validator.dataObject(obj_wrong_action);

            expect(result).to.be.instanceof(Error);
            expect(result.message).to.equal('Action is required and must be either insert or update');
        });
    });

    /**
     * Unit tests for postValidateChecks function
     */
    context('Test postValidateChecks function', () => {
        let post_validate_checks;
        let validate_result = '';
        let check_glob_schema_stub;
        let file_size_stub;
        let max_csv_file_size_rewire;
        let fs_access_stub;
        let logger_stub;

        before(() => {
            logger_stub = sinon.stub(log, 'error');
            file_size_stub = sinon.stub(fs, 'statSync');
            max_csv_file_size_rewire = csv_load_validator.__get__('MAX_CSV_FILE_SIZE');
            check_glob_schema_stub = sinon.stub(common_utils, 'checkGlobalSchemaTable');
            post_validate_checks = csv_load_validator.__get__('postValidateChecks');
        });

        it('should return an error from common_utils.checkGlobalSchemaTable',() => {
            let check_glob_schema_err = `schema ${data_object.schema} does not exist`;
            check_glob_schema_stub.returns(check_glob_schema_err);
            let result = post_validate_checks(data_object, validate_result);

            expect(result).to.be.instanceOf(Error);
            expect(result.message).to.be.equal(check_glob_schema_err);
            expect(check_glob_schema_stub).to.have.been.calledOnce;
        });

        it('should return an error from accessSync', () => {
            check_glob_schema_stub.returns('');
            let result = post_validate_checks(file_object, validate_result);

            expect(result.message).to.equal(`ENOENT: no such file or directory, access '${FAKE_FILE_PATH}'`);
            expect(result).to.be.instanceOf(Error);
            expect(check_glob_schema_stub).to.have.been.calledOnce;
        });

        it('should throw an error from fs.statSync file size', () => {
            let fake_file_size = max_csv_file_size_rewire + 100;
            fs_access_stub = sinon.stub(fs, 'accessSync').resolves('');
            file_size_stub.returns({size: fake_file_size});
            let result = post_validate_checks(file_object, validate_result);

            expect(result.message).to.equal(`File size is ${fake_file_size} bytes, which exceeded the maximum size allowed of: ${max_csv_file_size_rewire} bytes`);
            expect(result).to.be.instanceOf(Error);
            expect(check_glob_schema_stub).to.have.been.calledOnce;
            expect(fs_access_stub).to.have.been.calledOnce;
            expect(file_size_stub).to.have.been.calledOnce;
        });

        it('should catch thrown error from fs.statSync', () => {
            let console_error_stub = sinon.stub(console, 'error');
            let fs_stat_sync_err = 'File dose not exist';
            fs_access_stub.resolves('');
            file_size_stub.throws(new Error(fs_stat_sync_err));
            post_validate_checks(file_object, validate_result);

            expect(logger_stub).to.have.been.calledOnce;
            expect(console_error_stub).to.have.been.calledOnce;

            console_error_stub.restore();
        });
    });

    /**
     * Unit tests for dataObject, urlObject and fileObject functions
     */
    context('Test dataObject, urlObject and fileObject functions', () => {
        let validator_stub;
        let post_validate_stub = sinon.stub();
        let post_validate_rewire;
        let validate_res_fake = 'Fake response from validate';

        before(() => {
            validator_stub = sinon.stub(validator, 'validateObject').returns(validate_res_fake);
            post_validate_rewire = csv_load_validator.__set__('postValidateChecks', post_validate_stub);
        });

        after(() => {
            post_validate_rewire();
            validator_stub.restore();
        });

        it('should call validateObject and postValidateChecks with dataObject', () => {
            let data_constraints = csv_load_validator.__get__('data_constraints');
            csv_load_validator.dataObject(data_object);

            expect(validator_stub).to.have.been.calledWith(data_object, data_constraints);
            expect(post_validate_stub).to.have.been.calledWith(data_object, validate_res_fake);
        });

        it('should call validateObject and postValidateChecks with urlObject', () => {
            let url_constraints = csv_load_validator.__get__('url_constraints');
            csv_load_validator.urlObject(url_object);

            expect(validator_stub).to.have.been.calledWith(url_object, url_constraints);
            expect(post_validate_stub).to.have.been.calledWith(url_object, validate_res_fake);
        });

        it('should call validateObject and postValidateChecks with fileObject', () => {
            let file_constraints = csv_load_validator.__get__('file_constraints');
            csv_load_validator.fileObject(file_object);

            expect(validator_stub).to.have.been.calledWith(file_object, file_constraints);
            expect(post_validate_stub).to.have.been.calledWith(file_object, validate_res_fake);
        });
    });
});