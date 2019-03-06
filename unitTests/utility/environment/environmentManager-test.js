'use strict'

const sinon = require('sinon');
const assert = require('assert');
const rewire = require('rewire');
const env_rw = rewire('../../../utility/environment/environmentManager');
const test_utils = require('../../test_utils');
test_utils.preTestPrep();
const terms = require('../../../utility/hdbTerms');
const PropertiesReader = require('properties-reader');
const fs = require('fs-extra');

const TEST_PROP_1_NAME = 'root';
const TEST_PROP_2_NAME = 'path';
const TEST_PROP_1_VAL = 'I am root';
const TEST_PROP_2_VAL = '$HOME/users';

const TEST_PROPS_FILE_PATH = `${__dirname}/../../hdb_boot_properties.file`;
const TEST_SETTINGS_FILE_PATH = `${__dirname}/../../settings.tstFile`;

const ACCESS_RESPONSE = {
    'stats': 'true'
};

//These are used to restore the promisified functions.  sandbox.restore isn't working for these cases.
let read_props_orig = env_rw.__get__('readPropsFile');
let cert_path_orig = env_rw.__get__('readRootPath');
let private_path_orig = env_rw.__get__('readCertPath');
let root_path_orig = env_rw.__get__('readPrivateKeyPath');

describe('Test getProperty', () => {
    let test_properties = {};
    beforeEach(() => {
    });
    afterEach(() => {
        test_properties = {};
        env_rw.__set__('property_values', test_properties);
    });
    it('Nominal, return property', () => {
        test_properties[TEST_PROP_1_NAME] = TEST_PROP_1_VAL;
        test_properties[TEST_PROP_2_NAME] = TEST_PROP_2_VAL;

        env_rw.__set__('property_values', test_properties);

        let prop1 = env_rw.getProperty(TEST_PROP_1_NAME);
        let prop2 = env_rw.getProperty(TEST_PROP_2_NAME);

        assert.equal(prop1, TEST_PROP_1_VAL);
        assert.equal(prop2, TEST_PROP_2_VAL);
    });
    it('Get on invalid property, expect null back', () => {
        test_properties[TEST_PROP_1_NAME] = TEST_PROP_1_VAL;
        test_properties[TEST_PROP_2_NAME] = TEST_PROP_2_VAL;

        env_rw.__set__('property_values', test_properties);

        let prop1 = env_rw.getProperty('bad_name');
        let prop2 = env_rw.getProperty(TEST_PROP_2_NAME);

        assert.equal(prop1, null);
        assert.equal(prop2, TEST_PROP_2_VAL);
    });
});

describe('Test setProperty', () => {
    let test_properties = {};

    let props = undefined;

    beforeEach(() => {
        props = new PropertiesReader();
    });
    afterEach(() => {
        test_properties = {};
        env_rw.__set__('property_values', test_properties);
    });
    it('Nominal, set properties', () => {
        env_rw.__set__('hdb_properties', props);

        env_rw.setProperty(TEST_PROP_1_NAME, TEST_PROP_1_VAL);
        env_rw.setProperty(TEST_PROP_2_NAME, TEST_PROP_2_VAL);

        test_properties = env_rw.__get__('property_values');

        assert.equal(props.get(TEST_PROP_1_NAME), TEST_PROP_1_VAL);
        assert.equal(props.get(TEST_PROP_2_NAME), TEST_PROP_2_VAL);
        assert.equal(test_properties[TEST_PROP_1_NAME], TEST_PROP_1_VAL);
        assert.equal(test_properties[TEST_PROP_2_NAME], TEST_PROP_2_VAL);
    });
    it('Set with invalid property, expect exception', () => {
        env_rw.__set__('hdb_properties', props);
        let result = undefined;
        try {
            env_rw.setProperty(null, TEST_PROP_1_VAL);
        } catch(err) {
            result = err;
        }
        assert.equal(result, undefined, 'expected exception');
    });
});

describe('Test storeVariableValue', () => {
    let test_properties = {};
    let storeVariableValue = env_rw.__get__('storeVariableValue');
    beforeEach(() => {
    });
    afterEach(() => {
        test_properties = {};
        env_rw.__set__('property_values', test_properties);
    });
    it('Nominal, store property', () => {
        test_properties[TEST_PROP_1_NAME] = TEST_PROP_1_VAL;
        test_properties[TEST_PROP_2_NAME] = TEST_PROP_2_VAL;

        env_rw.__set__('property_values', test_properties);

        storeVariableValue(TEST_PROP_1_NAME, 'updated');

        let prop1 = env_rw.getProperty(TEST_PROP_1_NAME);
        let prop2 = env_rw.getProperty(TEST_PROP_2_NAME);

        assert.equal(prop1, 'updated');
        assert.equal(prop2, TEST_PROP_2_VAL);
    });
    it('Nominal, store new property', () => {
        test_properties[TEST_PROP_1_NAME] = TEST_PROP_1_VAL;
        test_properties[TEST_PROP_2_NAME] = TEST_PROP_2_VAL;

        env_rw.__set__('property_values', test_properties);

        storeVariableValue('NEW_PROP', 'new');

        let prop1 = env_rw.getProperty(TEST_PROP_1_NAME);
        let prop2 = env_rw.getProperty(TEST_PROP_2_NAME);
        let prop3 = env_rw.getProperty('NEW_PROP');


        assert.equal(prop1, TEST_PROP_1_VAL);
        assert.equal(prop2, TEST_PROP_2_VAL);
        assert.equal(prop3, 'new');
    });
    it('test with null prop name', () => {
        test_properties[TEST_PROP_1_NAME] = TEST_PROP_1_VAL;
        test_properties[TEST_PROP_2_NAME] = TEST_PROP_2_VAL;

        env_rw.__set__('property_values', test_properties);

        storeVariableValue(null, 'new');

        let prop1 = env_rw.getProperty(TEST_PROP_1_NAME);
        let prop2 = env_rw.getProperty(TEST_PROP_2_NAME);
        let prop3 = env_rw.getProperty('NEW_PROP');


        assert.equal(prop1, TEST_PROP_1_VAL);
        assert.equal(prop2, TEST_PROP_2_VAL);
        assert.equal(prop3, null);
    });
});

describe('Test readEnvVariable', () => {
    let test_properties = {};
    let readEnvVariable = env_rw.__get__('readEnvVariable');
    let props = undefined;
    beforeEach(() => {
        props = new PropertiesReader();
        env_rw.__set__('hdb_properties', props);
    });
    afterEach(() => {
        test_properties = {};
        env_rw.__set__('property_values', test_properties);
    });
    it('Nominal, return property', () => {
        props.set(terms.HDB_SETTINGS_NAMES.PROPS_ENV_KEY, 'blob');
        env_rw.__set__('hdb_properties', props);
        readEnvVariable(terms.HDB_SETTINGS_NAMES.PROPS_ENV_KEY);
        let prop1 = env_rw.getProperty(terms.HDB_SETTINGS_NAMES.PROPS_ENV_KEY);

        assert.equal(prop1, 'blob');
    });
    it('NODE_ENV not set, expect default set.', () => {
        env_rw.__set__('hdb_properties', props);
        readEnvVariable(terms.HDB_SETTINGS_NAMES.PROPS_ENV_KEY);
        let prop1 = env_rw.getProperty(terms.HDB_SETTINGS_NAMES.PROPS_ENV_KEY);

        assert.equal(prop1, 'production');
    });
    it('invalid variable, expect null back.', () => {
        env_rw.__set__('hdb_properties', props);
        readEnvVariable('bad');
        let prop1 = env_rw.getProperty('bad');

        assert.equal(prop1, null);
    });
});

//
describe('Test readSettingsFile', () => {
    let test_properties = {};
    let readSettingsFile = env_rw.__get__('readSettingsFile');
    let props = undefined;
    let sandbox = null;
    let access_stub = undefined;
    beforeEach(() => {
        props = new PropertiesReader();
        sandbox = sinon.createSandbox();
        access_stub = undefined;
        env_rw.__set__('hdb_properties', props);
    });
    afterEach(() => {
        test_properties = {};
        env_rw.__set__('property_values', test_properties);
        sandbox.restore();
    });
    it('Nominal, store key path', () => {
        props.set(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, TEST_SETTINGS_FILE_PATH);
        env_rw.__set__('PROPS_FILE_PATH', TEST_SETTINGS_FILE_PATH);
        env_rw.__set__('hdb_properties', props);
        try {
            readSettingsFile();
        } catch(e) {
            throw e;
        }
        let prop1 = props.get(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY);

        assert.equal(prop1, TEST_SETTINGS_FILE_PATH);
        assert.equal(props.get(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY), 'node_name');
    });
    it('invalid key path', () => {
        access_stub = sandbox.stub(fs, 'accessSync').throws(new Error('INVALID PATH'));
        props.set(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, './thisisabadpath');
        env_rw.__set__('PROPS_FILE_PATH', TEST_PROPS_FILE_PATH);
        env_rw.__set__('hdb_properties', props);

        let err = undefined;
        try {
            readSettingsFile();
        } catch(e) {
            err = e;
        }
        let prop1 = env_rw.getProperty(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY);

        assert.equal(prop1, './thisisabadpath');
        assert.equal((err instanceof Error), true, 'expected exception');
        assert.equal(props.get(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY), null);
    });
});

describe('Test readPropsFile', () => {
    let test_properties = {};
    let readPropsFile = env_rw.__get__('readPropsFile');
    let props = undefined;
    let sandbox = null;
    let access_stub = undefined;
    let read_settings_stub = undefined;
    beforeEach(() => {
        props = new PropertiesReader();
        sandbox = sinon.createSandbox();
        access_stub = undefined;
        read_settings_stub = undefined;
        env_rw.__set__('hdb_properties', props);
    });
    afterEach(() => {
        test_properties = {};
        env_rw.__set__('property_values', test_properties);
        sandbox.restore();
    });
    it('Nominal, store key path', () => {
        access_stub = sandbox.stub(fs, 'accessSync').resolves(ACCESS_RESPONSE);
        read_settings_stub = sandbox.stub().resolves('');
        props.set(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, './thisisavalidpath');
        env_rw.__set__('PROPS_FILE_PATH', TEST_PROPS_FILE_PATH);
        env_rw.__set__('hdb_properties', props);
        env_rw.__set__('readSettingsFile', read_settings_stub);
        try {
            readPropsFile();
        } catch(e) {
            throw e;
        }
        let prop1 = env_rw.getProperty(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY);

        assert.equal(prop1, './settings.tstFile');
    });
    it('invalid key path', () => {
        access_stub = sandbox.stub(fs, 'accessSync').throws(new Error('INVALID PATH'));
        props.set(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, './thisisabadpath');
        read_settings_stub = sandbox.stub().resolves('');
        env_rw.__set__('PROPS_FILE_PATH', TEST_PROPS_FILE_PATH);
        env_rw.__set__('hdb_properties', props);
        env_rw.__set__('readSettingsFile', read_settings_stub);
        let err = undefined;
        try {
            readPropsFile();
        } catch(e) {
            err = e;
        }
        let prop1 = env_rw.getProperty(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY);

        assert.equal(prop1, './thisisabadpath');
        assert.equal(err, undefined, 'expected no exception');
        assert.equal(read_settings_stub.called, false);
    });
});

describe('Test readRootPath', () => {
    let test_properties = {};
    let readRootPath = env_rw.__get__('readRootPath');
    let props = undefined;
    let sandbox = null;
    let access_stub = undefined;
    beforeEach(() => {
        props = new PropertiesReader();
        sandbox = sinon.createSandbox();
        env_rw.__set__('hdb_properties', props);
    });
    afterEach(() => {
        test_properties = {};
        env_rw.__set__('property_values', test_properties);
        sandbox.restore();
    });
    it('Nominal, store key path', () => {
        props.set(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, './');
        env_rw.__set__('hdb_properties', props);
        try {
            readRootPath();
        } catch(e) {
            throw e;
        }
        let prop1 = env_rw.getProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY);

        assert.equal(prop1, './');
    });
    it('invalid key path', () => {
        props.set(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, './blahblahblah');
        env_rw.__set__('hdb_properties', props);
        let err = undefined;
        try {
            readRootPath();
        } catch(e) {
            err = e;
        }
        let prop1 = env_rw.getProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY);

        assert.equal(prop1, './blahblahblah');
        assert.equal((err instanceof Error), true, 'expected exception');
    });
});


describe('Test readPrivateKeyPath', () => {
    let test_properties = {};
    let readPrivateKeyPath = env_rw.__get__('readPrivateKeyPath');
    let props = undefined;
    let sandbox = null;
    let access_stub = undefined;
    beforeEach(() => {
        props = new PropertiesReader();
        sandbox = sinon.createSandbox();
        env_rw.__set__('hdb_properties', props);
    });
    afterEach(() => {
        test_properties = {};
        env_rw.__set__('property_values', test_properties);
        sandbox.restore();
    });
    it('Nominal, store key path', () => {
        access_stub = sandbox.stub(fs, 'accessSync').resolves(ACCESS_RESPONSE);
        props.set(terms.HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY, './thisisavalidpath');
        env_rw.__set__('hdb_properties', props);
        try {
            readPrivateKeyPath();
        } catch(e) {
            throw e;
        }
        let prop1 = env_rw.getProperty(terms.HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY);

        assert.equal(prop1, './thisisavalidpath');
    });
    it('invalid key path', () => {
        access_stub = sandbox.stub(fs, 'accessSync').throws(new Error('INVALID PATH'));
        props.set(terms.HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY, './thisisabadpath');
        env_rw.__set__('hdb_properties', props);
        let err = undefined;
        try {
            readPrivateKeyPath();
        } catch(e) {
            err = e;
        }
        let prop1 = env_rw.getProperty(terms.HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY);

        assert.equal(prop1, './thisisabadpath');
        assert.equal(err, undefined, 'expected exception');
    });
});

describe('Test readCertPath', () => {
    let test_properties = {};
    let readCertPath = env_rw.__get__('readCertPath');
    let props = undefined;
    let sandbox = null;
    let access_stub = undefined;
    beforeEach(() => {
        props = new PropertiesReader();
        sandbox = sinon.createSandbox();
        env_rw.__set__('hdb_properties', props);
    });
    afterEach(() => {
        test_properties = {};
        env_rw.__set__('property_values', test_properties);
        sandbox.restore();
    });
    it('Nominal, store key path', () => {
        access_stub = sandbox.stub(fs, 'accessSync').resolves(ACCESS_RESPONSE);
        props.set(terms.HDB_SETTINGS_NAMES.CERT_KEY, './thisisavalidpath');
        env_rw.__set__('hdb_properties', props);
        try {
            readCertPath();
        } catch(e) {
            throw e;
        }
        let prop1 = env_rw.getProperty(terms.HDB_SETTINGS_NAMES.CERT_KEY);

        assert.equal(prop1, './thisisavalidpath');
    });
    it('invalid key path', () => {
        access_stub = sandbox.stub(fs, 'accessSync').throws(new Error('INVALID PATH'));
        props.set(terms.HDB_SETTINGS_NAMES.CERT_KEY, './thisisabadpath');
        env_rw.__set__('hdb_properties', props);
        let err = undefined;
        try {
            readCertPath();
        } catch(e) {
            err = e;
        }
        let prop1 = env_rw.getProperty(terms.HDB_SETTINGS_NAMES.CERT_KEY);

        assert.equal(prop1, './thisisabadpath');
        assert.equal(err, undefined, 'expected exception');
    });
});

describe('Test initSync', () => {
    let test_properties = {};
    let props = undefined;
    let sandbox = null;
    let access_stub = undefined;
    let read_props_stub = undefined;
    let cert_path_stub = undefined;
    let private_path_stub = undefined;
    let root_path_stub = undefined;

    beforeEach(() => {
        props = new PropertiesReader();
        sandbox = sinon.createSandbox();
        env_rw.__set__('hdb_properties', props);
    });
    afterEach(() => {
        test_properties = {};
        sandbox.restore();
        env_rw.__set__('property_values', test_properties);
        env_rw.__set__('readPropsFile', read_props_orig);
        env_rw.__set__('readRootPath', root_path_orig);
        env_rw.__set__('readCertPath', cert_path_orig);
        env_rw.__set__('readPrivateKeyPath', private_path_orig);
    });
    // There is no good way to inject a value for the settings path during the initSync run, so just replacing
    // readPropsFile with this function that will point to a valid path.
    function loadThisInstead() {
        let props = env_rw.__get__('hdb_properties');
        let found = new PropertiesReader(TEST_SETTINGS_FILE_PATH);
        found.each((key, value) => {
            props.set(key, value);
        });
    }
    it('Nominal, load up environment variables', async () => {

        read_props_stub = sandbox.stub().resolves('');
        cert_path_stub = sandbox.stub().resolves('');
        private_path_stub = sandbox.stub().resolves('');
        root_path_stub = sandbox.stub().resolves('');
        access_stub = sandbox.stub(fs, 'accessSync').resolves(ACCESS_RESPONSE);
        props.set(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, TEST_SETTINGS_FILE_PATH);
        env_rw.__set__('PROPS_FILE_PATH', TEST_PROPS_FILE_PATH);
        env_rw.__set__('readPropsFile', loadThisInstead);
        env_rw.__set__('readRootPath', root_path_stub);
        env_rw.__set__('readCertPath', cert_path_stub);
        env_rw.__set__('readPrivateKeyPath', private_path_stub);
        env_rw.setPropsFilePath(TEST_PROPS_FILE_PATH);
        try {
            await env_rw.initSync();
        } catch(e) {
            throw e;
        }
        let prop1 = env_rw.getProperty(terms.HDB_SETTINGS_NAMES.HTTP_PORT_KEY);
        let prop2 = env_rw.getProperty(terms.HDB_SETTINGS_NAMES.LOG_LEVEL_KEY);
        let prop3 = env_rw.getProperty(terms.HDB_SETTINGS_NAMES.LOGGER_KEY);
        assert.equal(prop1, 9925);
        assert.equal(prop2, 'trace');
        assert.equal(prop3, '1');
    });
});

describe('Test writeSettingsFileSync', () => {
    let test_properties = {};
    let writeSettingsFile = env_rw.__get__('writeSettingsFileSync');
    let props = undefined;
    let sandbox = null;
    let copy_stub = undefined;
    let write_stub = undefined;
    beforeEach(() => {
        props = new PropertiesReader();
        sandbox = sinon.createSandbox();
        env_rw.__set__('hdb_properties', props);
    });
    afterEach(() => {
        test_properties = {};
        sandbox.restore();
        env_rw.__set__('property_values', test_properties);
    });
    it('Nominal, write to file, copy not called', () => {
        copy_stub = sandbox.stub(fs, 'copyFileSync').resolves('');
        write_stub = sandbox.stub(fs, 'writeFileSync').resolves('');
        props.set(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, './thisisavalidpath');
        env_rw.__set__('hdb_properties', props);
        try {
            writeSettingsFile(false);
        } catch(e) {
            throw e;
        }
        assert.equal(write_stub.called, true, 'expected write to be called');
        assert.equal(copy_stub.called, false, 'copy should not have been called');
    });
    it('Nominal, write to file, copy called', () => {
        copy_stub = sandbox.stub(fs, 'copyFileSync').resolves('');
        write_stub = sandbox.stub(fs, 'writeFileSync').resolves('');
        props.set(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, './thisisavalidpath');
        env_rw.__set__('hdb_properties', props);
        try {
            writeSettingsFile(true);
        } catch(e) {
            throw e;
        }
        assert.equal(write_stub.called, true, 'expected write to be called');
        assert.equal(copy_stub.called, true, 'copy should not have been called');
    });
    it('Exception expected, no path defined.', () => {
        copy_stub = sandbox.stub(fs, 'copyFileSync').throws(new Error('BAD COPY'));
        write_stub = sandbox.stub(fs, 'writeFileSync').resolves('');
        env_rw.__set__('hdb_properties', props);
        let result = undefined;
        try {
            writeSettingsFile(true);
        } catch(e) {
            result = e;
        }
        assert.equal(write_stub.called, false, 'expected write not to be called');
        assert.equal(copy_stub.called, false, 'copy should have been called');
        assert.equal((result instanceof Error), true, 'expected exception');
    });
    it('write to file, exception during copy', () => {
        copy_stub = sandbox.stub(fs, 'copyFileSync').throws(new Error('BAD COPY'));
        write_stub = sandbox.stub(fs, 'writeFileSync').resolves('');
        props.set(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, './thisisavalidpath');
        env_rw.__set__('hdb_properties', props);
        let result = undefined;
        try {
            writeSettingsFile(true);
        } catch(e) {
            result = e;
        }
        assert.equal(write_stub.called, false, 'expected write not to be called');
        assert.equal(copy_stub.called, true, 'copy should have been called');
        assert.equal((result instanceof Error), true, 'expected exception');
    });
});