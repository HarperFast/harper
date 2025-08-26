'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const config_utils = require('../../../config/configUtils');
const common_utils = require('../../../utility/common_utils');
const rewire = require('rewire');
const fs = require('fs');
const env_rw = rewire('../../../utility/environment/environmentManager');
const log = require('../../../utility/logging/harper_logger');

const TEST_PROP_1_NAME = 'root';
const TEST_PROP_2_NAME = 'path';
const TEST_PROP_1_VAL = 'I am root';
const TEST_PROP_2_VAL = '$HOME/users';

const TEST_PROPS_FILE_PATH = `${__dirname}/../../hdb_boot_properties.file`;

const LOWERCASE_ERR_MSG_1 = "Cannot read property 'toLowerCase' of null";
const LOWERCASE_ERR_MSG_2 = "Cannot read properties of null (reading 'toLowerCase')";

describe('Test environmentManager module', () => {
	const sandbox = sinon.createSandbox();

	after(() => {
		sandbox.restore();
	});

	describe('Test getHdbBasePath', () => {
		it('Test that getHdbBasePath and setHdbBasePath', () => {
			env_rw.setHdbBasePath('testpath');

			const result = env_rw.getHdbBasePath();

			expect(result).to.equal('testpath');
		});
	});

	describe('Test get function', () => {
		let get_config_value_stub;

		before(() => {
			get_config_value_stub = sandbox.stub(config_utils, 'getConfigValue');
		});

		afterEach(() => {
			sandbox.resetHistory();
		});

		it('Test expected value is returned', () => {
			get_config_value_stub.returns(TEST_PROP_1_VAL);

			const result = env_rw.get(TEST_PROP_1_NAME);
			expect(result).to.equal(TEST_PROP_1_VAL);
		});

		it('Test if value is undefined it returns undefined', () => {
			get_config_value_stub.returns(undefined);

			const result = env_rw.get('test-prop');
			expect(result).to.be.undefined;
		});
	});

	describe('Test setProperty function', () => {
		afterEach(() => {
			sandbox.resetHistory();
		});

		it('Test expected values are passed', () => {
			let update_config_object = sandbox.stub(config_utils, 'updateConfigObject');
			env_rw.setProperty(TEST_PROP_1_NAME, TEST_PROP_1_VAL);
			env_rw.setProperty(TEST_PROP_2_NAME, TEST_PROP_2_VAL);

			expect(update_config_object.firstCall.args[0]).to.eql(TEST_PROP_1_NAME);
			expect(update_config_object.firstCall.args[1]).to.eql(TEST_PROP_1_VAL);
			expect(update_config_object.secondCall.args[0]).to.eql(TEST_PROP_2_NAME);
			expect(update_config_object.secondCall.args[1]).to.eql(TEST_PROP_2_VAL);
			sandbox.restore();
		});

		it('Test with invalid property, expect exception', () => {
			let result = undefined;
			try {
				env_rw.setProperty(null, TEST_PROP_1_VAL);
			} catch (err) {
				result = err;
			}

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.be.oneOf([LOWERCASE_ERR_MSG_1, LOWERCASE_ERR_MSG_2]);
		});
	});

	describe('Test doesPropFileExist function', () => {
		let fs_access_stub;
		const does_prop_file_exist = env_rw.__get__('doesPropFileExist');

		before(() => {
			fs_access_stub = sandbox.stub(fs, 'accessSync').resolves();
		});

		afterEach(() => {
			sandbox.resetHistory();
		});

		it('Test it returns true', () => {
			sandbox.stub(common_utils, 'getPropsFilePath').returns(TEST_PROPS_FILE_PATH);
			const result = does_prop_file_exist();

			expect(result).to.be.true;
			sandbox.restore();
		});

		it('Test it catches error, logs trace message, and returns false', () => {
			sandbox.stub(common_utils, 'getPropsFilePath');
			const trace_stub = sandbox.stub(log, 'trace');
			const result = does_prop_file_exist();

			expect(result).to.be.false;
			expect(trace_stub.args[0]).to.eql(['Environment manager found no properties file at undefined']);
		});
	});

	describe('Test initSync function', () => {
		let does_prop_file_exist_stub;
		let init_config;
		let get_config_value;

		before(() => {
			does_prop_file_exist_stub = sandbox.stub().returns(true);
			init_config = sandbox.stub(config_utils, 'initConfig');
			get_config_value = sandbox.stub(config_utils, 'getConfigValue');
		});

		after(() => {
			sandbox.resetHistory();
		});

		it('Tests config env initialized', () => {
			env_rw.__set__('propFileExists', false);
			env_rw.__set__('doesPropFileExist', does_prop_file_exist_stub);

			env_rw.initSync();

			expect(init_config.called).to.be.true;
			expect(get_config_value.called).to.be.true;
		});
	});

	describe('Test initTestEnvironment function', () => {
		let set_property_rw;
		let set_property_stub;

		before(() => {
			set_property_stub = sandbox.stub();
			set_property_rw = env_rw.__set__('setProperty', set_property_stub);
		});

		afterEach(() => {
			sandbox.resetHistory();
		});
		// what is magically correct about 23 and 31?
		it.skip('Test properties are set with no test config obj', () => {
			env_rw.initTestEnvironment();

			expect(set_property_stub.called).to.be.true;
			expect(set_property_stub.callCount).to.equal(23);
		});

		it.skip('Test properties are set with test config obj', () => {
			const test_config_obj = {
				cors_accesslist: [],
				server_timeout: 120000,
				keep_alive_timeout: 5000,
				headers_timeout: 60000,
			};

			env_rw.initTestEnvironment(test_config_obj);

			expect(set_property_stub.called).to.be.true;
			expect(set_property_stub.callCount).to.equal(31);
		});
	});
});
