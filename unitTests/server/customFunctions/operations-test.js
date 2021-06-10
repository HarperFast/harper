'use strict';

const chai = require('chai');
const sinon = require('sinon');
const rewire = require('rewire');
const fs = require('fs-extra');
const path = require('path');

const test_utils = require('../../test_utils');
const operations = rewire('../../../server/customFunctions/operations');
const env = require('../../../utility/environment/environmentManager');
const terms = require('../../../utility/hdbTerms');
const { TEST_DATA_BASE64_CF_PROJECT } = require('../../test_data');
const { expect } = chai;

describe('Test custom functions operations', () => {
    let sandbox = sinon.createSandbox();
    let CF_DIR_ROOT = path.resolve(__dirname, 'custom_functions');
    const TEST_PROJECT_DIR = path.join(CF_DIR_ROOT, 'test2');

    before(() => {
        fs.ensureDirSync(CF_DIR_ROOT);
        env.initTestEnvironment();
    });

    after(() => {
        fs.removeSync(CF_DIR_ROOT);
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

    it('Test packageCustomFunctionProject properly tars up a project directory', async () => {
        const response = await operations.packageCustomFunctionProject({ project: 'test' });

        expect(response).to.be.instanceOf(Object);

        expect(Object.keys(response)).to.have.length(3);
        expect(Object.keys(response)).to.include('project');
        expect(Object.keys(response)).to.include('file');
        expect(Object.keys(response)).to.include('payload');

        expect(response.project).to.equal('test');
    }).timeout(5000);

    it('Test deployCustomFunctionProject properly deploys a project', async () => {
        const deploy_response = await operations.deployCustomFunctionProject({ project: 'test2', file: `${CF_DIR_ROOT}/test2.tar`, payload: TEST_DATA_BASE64_CF_PROJECT });

        expect(deploy_response).to.equal('Successfully deployed project: test2');
    }).timeout(5000);

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
        expect(Object.keys(endpoints)).to.have.length(2);
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
        expect(Object.keys(endpoints)).to.have.length(1);
    });


});
