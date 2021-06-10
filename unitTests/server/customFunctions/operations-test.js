'use strict';

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

    before(() => {
        env.setProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY, CF_DIR_ROOT);
        env.setProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY, true);
        // eslint-disable-next-line no-magic-numbers
        env.setProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_PORT_KEY, 9926);
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

    it('Test addCustomFunctionProject creates the project folder with the correct name', async () => {
        const response = await operations.addCustomFunctionProject({ project: 'test' });

        expect(response).to.equal('Successfully created custom function project: test');
    });

    it('Test getCustomFunctions returns object with proper length and content', async () => {
        const endpoints = await operations.getCustomFunctions();

        const projectName = Object.keys(endpoints)[0];

        expect(endpoints).to.be.instanceOf(Object);
        expect(Object.keys(endpoints)).to.have.length(1);
        expect(projectName).to.equal('test');
        expect(endpoints[projectName]).to.be.instanceOf(Object);
        expect(Object.keys(endpoints[projectName])).to.have.length(2);
        expect(Object.keys(endpoints[projectName])).to.include('routes');
        expect(endpoints[projectName].routes).to.be.instanceOf(Array);
        expect(endpoints[projectName].routes).to.have.length(1);
        expect(Object.keys(endpoints[projectName])).to.include('helpers');
        expect(endpoints[projectName].helpers).to.be.instanceOf(Array);
        expect(endpoints[projectName].helpers).to.have.length(1);
    });

    it('Test getCustomFunction generated file exists and has expected content', async () => {
        const response = await operations.getCustomFunction({ project: 'test', type: 'routes', file: 'examples' });

        expect(response).to.contain('use strict');
    });

    it('Test setCustomFunction creates a function file as expected', async () => {
        const response = await operations.setCustomFunction({ project: 'test', type: 'routes', file: 'example2', function_content: 'example2' });

        expect(response).to.equal('Successfully updated custom function: example2.js');

        const endpoints = await operations.getCustomFunction({ project: 'test', type: 'routes', file: 'example2' });

        expect(endpoints).to.contain('example2');
    });

    it('Test setCustomFunction updates a function file as expected', async () => {
        const response = await operations.setCustomFunction({ project: 'test', type: 'routes', file: 'example2', function_content: 'example3' });

        expect(response).to.equal('Successfully updated custom function: example2.js');

        const endpoints = await operations.getCustomFunction({ project: 'test', type: 'routes', file: 'example2' });

        expect(endpoints).to.contain('example3');
    });

    it('Test dropCustomFunction drops function as expected', async () => {
        const response = await operations.dropCustomFunction({ project: 'test', type: 'routes', file: 'examples' });

        expect(response).to.equal('Successfully deleted custom function: examples.js');

        const endpoints = await operations.getCustomFunctions();

        const projectName = Object.keys(endpoints)[0];

        expect(endpoints).to.be.instanceOf(Object);
        expect(Object.keys(endpoints)).to.have.length(1);
        expect(projectName).to.equal('test');
        expect(endpoints[projectName]).to.be.instanceOf(Object);
        expect(Object.keys(endpoints[projectName])).to.have.length(2);
        expect(Object.keys(endpoints[projectName])).to.include('routes');
        expect(endpoints[projectName].routes).to.be.instanceOf(Array);
        expect(endpoints[projectName].routes).to.have.length(1);
        expect(Object.keys(endpoints[projectName])).to.include('helpers');
        expect(endpoints[projectName].helpers).to.be.instanceOf(Array);
        expect(endpoints[projectName].helpers).to.have.length(1);
    });

    it('Test dropCustomFunctionProject drops project as expected', async () => {
        const response = await operations.dropCustomFunctionProject({ project: 'test' });

        expect(response).to.equal('Successfully deleted project: test');

        const endpoints = await operations.getCustomFunctions();

        expect(endpoints).to.be.instanceOf(Object);
        expect(Object.keys(endpoints)).to.have.length(0);
    });
});
