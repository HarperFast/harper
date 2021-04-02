'use strict';

const rewire = require('rewire');
const path = require('path');
const chai = require('chai');
const fs = require('fs-extra');
const { expect } = chai;
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
chai.use(sinon_chai);
const test_utils = require('../../test_utils');
const logger = require('../../../utility/logging/harper_logger');
const env_mngr = require('../../../utility/environment/environmentManager');

const TMP_TEST_DIR = 'tmp_reindex_test';
const BASE_PATH_TEST = path.join(__dirname, TMP_TEST_DIR);
const SCHEMA_PATH_TEST = path.join(BASE_PATH_TEST, 'schema');
const TMP_PATH_TEST = path.join(BASE_PATH_TEST, 'tmp');
const TRANSACTIONS_PATH_TEST = path.join(BASE_PATH_TEST, 'transactions');

describe('Test reindex module', () => {
    const sandbox = sinon.createSandbox();
    let reindex_rw;
    let logger_notify_stub;
    let logger_error_stub;

    before(() => {
        // This stub and rewire need to be here as putting it in outer scope was messing interfering with other tests.
        sandbox.stub(env_mngr,'getHdbBasePath').returns(BASE_PATH_TEST);
        reindex_rw = rewire('../../../upgrade/lmdb/reindex');
        fs.mkdirsSync(BASE_PATH_TEST);
        logger_notify_stub = sandbox.stub(logger, 'notify');
        logger_error_stub = sandbox.stub(logger, 'error');
    });

    after(() => {
        sandbox.restore();
        //TODO add async dir cleanup
    });

    describe('Test reindexUpgrade function', () => {
        const get_tables_stub = sandbox.stub();
        let get_tables_rw;

        before(() => {
            get_tables_rw = reindex_rw.__set__('getTables', get_tables_stub);
        });

        after(() => {
            get_tables_rw();
        });

        it('Test logs and functions are called as expected happy path', async () => {
            await reindex_rw();

            expect(logger_notify_stub.getCall(0)).to.have.been.calledWith('Reindexing upgrade started for schemas');
            expect(logger_notify_stub.getCall(1)).to.have.been.calledWith('Reindexing upgrade started for transaction logs');
            expect(logger_notify_stub.getCall(2)).to.have.been.calledWith('Reindexing upgrade complete');
            expect(get_tables_stub.getCall(0)).to.have.been.calledWith(SCHEMA_PATH_TEST);
            expect(get_tables_stub.getCall(1)).to.have.been.calledWith(TRANSACTIONS_PATH_TEST);
        });
    });

    describe('Test getTables function', () => {
        let getTables;

        before(() => {
            getTables = reindex_rw.__get__('getTables');
        });
        
        it('Test ', () => {
            
        });


    });

});
