'use strict';

const path = require('path');
const fs = require('fs-extra');
const chai = require('chai');
const sinon = require('sinon');
const rewire = require('rewire');

const test_utils = require('../../test_utils');
const operations = rewire('../../../server/customFunctions/operations');
const env = require('../../../utility/environment/environmentManager');
const terms = require('../../../utility/hdbTerms');
const { expect } = chai;

describe('Test custom functions operations', () => {
    let sandbox = sinon.createSandbox();
    let ROOT_ORIGINAL = env.getProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
    let CF_DIR_ROOT = `${ROOT_ORIGINAL}/test`;
    let TEMPLATE_ROOT = path.join(__dirname, '../../../', 'server', 'customFunctions', 'template');

    /*
    console.log(ROOT_ORIGINAL);
    console.log(CF_DIR_ROOT);
    console.log(TEMPLATE_ROOT);
    */

    before(() => {
        env.setProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY, CF_DIR_ROOT);
        env.setProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY, true);
        // eslint-disable-next-line no-magic-numbers
        env.setProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_PORT_KEY, 9926);
        fs.copySync(TEMPLATE_ROOT, CF_DIR_ROOT);
    });

    after(() => {
        env.setProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY, ROOT_ORIGINAL);
        test_utils.cleanUpDirectories(CF_DIR_ROOT);
        sandbox.restore();
    });

    it('Test initial cf status values', async () => {
        const { is_enabled, port, directory } = await operations.customFunctionsStatus();

        expect(is_enabled).to.exist;
        expect(port).to.exist;
        expect(directory).to.equal(CF_DIR_ROOT);
    });

    it('Test getCustomFunctions returns object with proper length and content', async () => {
        const endpoints = await operations.getCustomFunctions();

        expect(endpoints).to.be.instanceOf(Object);
        expect(Object.keys(endpoints)).to.be.have.length(3);
        expect(Object.keys(endpoints)).to.include('helpers');
    });

    it('Test getCustomFunction generated file exists and has expected content', async () => {
        const response = await operations.getCustomFunction({ project: 'test', type: 'routes', file: 'examples' });

        expect(response).to.contain('use strict');
    });

    it('Test dropCustomFunction drops function as expected', async () => {
        const response = await operations.dropCustomFunction({ project: 'test', type: 'routes', file: 'examples' });
        const endpoints = await operations.getCustomFunctions();

        expect(response).to.equal('Successfully deleted custom function: dogs.js');
        expect(endpoints).to.be.instanceOf(Array);
        expect(endpoints).to.be.empty;
    });

    it('Test dropCustomFunction drops project as expected', async () => {
        const response = await operations.dropCustomFunction({ project: 'test', type: 'projects' });
        const endpoints = await operations.getCustomFunctions();

        expect(response).to.equal('Successfully deleted project: test');
        expect(endpoints).to.be.instanceOf(Array);
        expect(endpoints).to.be.empty;
    });
});
