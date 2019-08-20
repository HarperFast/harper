'use strict';

const test_utils = require('../../../../test_utils');
const moveFolderToTrash = require('../../../../../data_layer/harperBridge/fsBridge/fsUtility/moveFolderToTrash');
const log = require('../../../../../utility/logging/harper_logger');
const fs = require('fs-extra');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const TRASH_PATH_TEST = `${__dirname}/trashTest`;
const ORIGIN_PATH_TEST = `${__dirname}/thisIsAFolder`;
const TEST_DIR = `${__dirname}/thisIsAFolder/andAnother`;

describe('Tests for fsUtility function moveFolderToTrash', () => {
    let sandbox = sinon.createSandbox();
    let log_error_spy;

    before(async () => {
        log_error_spy = sandbox.spy(log, 'error');

        try {
            await fs.mkdirp(TEST_DIR);
        } catch(err) {
            console.log(err);
        }
    });

    after(() => {
        test_utils.cleanUpDirectories(TRASH_PATH_TEST);
        sandbox.restore();
    });

    it('Test empty parameter causes false boolean to be returned', async () => {
        let result = await moveFolderToTrash(ORIGIN_PATH_TEST, '');

        expect(result).to.be.false;
    });

    it('Test that a created folder is moved to a nominated path', async () => {
        let result = await moveFolderToTrash(ORIGIN_PATH_TEST, TRASH_PATH_TEST);

        expect(result).to.be.true;
        expect(fs.existsSync(`${TRASH_PATH_TEST}/andAnother`)).to.be.true;
        expect(fs.existsSync(`${ORIGIN_PATH_TEST}`)).to.be.false;
    });

    it('Test fs move throws an error and message is logged', async () => {
        let error;
        try {
            await moveFolderToTrash(ORIGIN_PATH_TEST, TRASH_PATH_TEST);
        } catch(err) {
            error = err;
        }

        expect(error).to.be.an.instanceOf(Error);
        expect(log_error_spy).to.have.been.calledWith(`Got an error moving path ${ORIGIN_PATH_TEST} to trash path: ${TRASH_PATH_TEST}`);
    });

    it('Test fs mkdirp throws an error and message is logged', async () => {
        sandbox.stub(fs, 'mkdirp').throws(new Error('We got an error!'));
        let test_err_result = await test_utils.testError(moveFolderToTrash(ORIGIN_PATH_TEST, TRASH_PATH_TEST), 'We got an error!');

        expect(test_err_result).to.be.true;
        expect(log_error_spy).to.have.been.calledWith(`Failed to create the trash directory.`);
    });
});
