'use strict';

const rewire = require('rewire');
const test_utils = require('../../test_utils');
const operations = rewire('../../../server/customFunctions/operations');
const env = require('../../../utility/environment/environmentManager');
const terms = require('../../../utility/hdbTerms');
const fs = require('fs-extra');
const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;

const CF_DIR_ROOT = `${__dirname}/custom_functions`;
const CF_DIR_ROUTES = `${__dirname}/custom_functions/routes`;

describe('Test custom functions operations', () => {
    let sandbox = sinon.createSandbox();
    let root_original;

    before(() => {
        root_original = env.getProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);
        env.setProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY, CF_DIR_ROOT);
        env.setProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY, true);
        // eslint-disable-next-line no-magic-numbers
        env.setProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_PORT_KEY, 9926);
        fs.mkdirSync(CF_DIR_ROUTES, { recursive: true });
    });

    after(() => {
        env.setProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY, root_original);
        test_utils.cleanUpDirectories(CF_DIR_ROOT);
        sandbox.restore();
    });

    it('Test initial cf status values', async () => {
        const { is_enabled, port, directory } = await operations.customFunctionsStatus();

        expect(is_enabled).to.exist;
        expect(port).to.exist;
        expect(directory).to.equal(CF_DIR_ROOT);
    });

    it('Test getCustomFunctions returns empty array when there are no endpoint files', async () => {
        const endpoints = await operations.getCustomFunctions();

        expect(endpoints).to.be.instanceOf(Array);
        expect(endpoints).to.be.empty;
    });

    it('Test setCustomFunction writes file into endpoint directory', async () => {
        const response = await operations.setCustomFunction({ function_name: 'dogs', function_content: 'return true' });

        expect(response).to.equal('Successfully updated custom function: dogs.js');
    });

    it('Test getCustomFunctions returns array with proper length and content', async () => {
        const endpoints = await operations.getCustomFunctions();

        expect(endpoints).to.be.instanceOf(Array);
        expect(endpoints).to.be.have.length(1);
        expect(endpoints).to.include('dogs');
    });

    it('Test getCustomFunction generated file exists and has expected content', async () => {
        const response = await operations.getCustomFunction({ function_name: 'dogs' });

        expect(response).to.equal('return true');
    });

    it('Test dropCustomFunction drops function as expected', async () => {
        const response = await operations.dropCustomFunction({ function_name: 'dogs' });
        const endpoints = await operations.getCustomFunctions();

        expect(response).to.equal('Successfully deleted custom function: dogs.js');
        expect(endpoints).to.be.instanceOf(Array);
        expect(endpoints).to.be.empty;
    });
});
