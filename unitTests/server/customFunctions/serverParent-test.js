'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const cluster = require('cluster');

const test_utils = require('../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
const harper_logger = require('../../../utility/logging/harper_logger');
const user_schema = require('../../../security/user');

let serverParent_rw;
let launch_rw;
let check_jwt_tokens_stub;
let launch_stub;
let p_schema_to_global_stub;
let setUsersToGlobal_stub;
let logger_notify_stub;
let logger_info_stub;
let logger_error_stub;
let cluster_fork_stub;
const fake = () => {};
const test_error = new Error('This is a testy mctest error');

const test_worker_num = 3;

describe('Test serverParent.js', () => {

    before(() => {
        serverParent_rw = rewire('../../../server/customFunctions/serverParent');
        logger_notify_stub = sandbox.stub(harper_logger, 'notify').callsFake(fake);
        logger_info_stub = sandbox.stub(harper_logger, 'info').callsFake(fake);
        logger_error_stub = sandbox.stub(harper_logger, 'error').callsFake(fake);
        check_jwt_tokens_stub = sandbox.stub().callsFake();
        serverParent_rw.__set__('check_jwt_tokens', check_jwt_tokens_stub);
        launch_stub = sandbox.stub().resolves();
        serverParent_rw.__set__('launch', launch_stub);
    });

    afterEach(() => {
        sandbox.resetHistory();
    });

    after(() => {
        sandbox.restore();
        rewire('../../../server/customFunctions/serverParent');
    });

    describe('exported serverParent method', () => {
        afterEach(() => {
            const serverException = process.listeners('uncaughtException').pop();
            if (serverException.name === '') {
                process.removeListener('uncaughtException', serverException);
            }
        });

        it('should launch parent process', async() => {
            await serverParent_rw(test_worker_num);

            expect(check_jwt_tokens_stub.calledOnce).to.be.true;
            expect(launch_stub.calledOnce).to.be.true;
            expect(launch_stub.args[0][0]).to.eql(test_worker_num);
        });

        it('should catch and log error thrown from launch()', async() => {
            launch_stub.throws(test_error);
            await serverParent_rw(test_worker_num);

            expect(logger_error_stub.calledOnce).to.be.true;
            expect(logger_error_stub.args[0][0]).to.eql(test_error);
            launch_stub.resetBehavior();
        });

    });

    describe('launch() method', () => {
        const fake_fork = {
            on: () => {}
        };

        before(() => {
            serverParent_rw = rewire('../../../server/customFunctions/serverParent');
            cluster_fork_stub = sandbox.stub(cluster, 'fork').returns(fake_fork);
            p_schema_to_global_stub = sandbox.stub().resolves();
            serverParent_rw.__set__('p_schema_to_global', p_schema_to_global_stub);
            setUsersToGlobal_stub = sandbox.stub(user_schema, 'setUsersToGlobal').resolves();
            launch_rw = serverParent_rw.__get__('launch');
        });

        beforeEach(() => {
            global.clustering_on = undefined;
            global.lmdb_map = {};
        });

        it('should update/set global values for server', async() => {
            await launch_rw(test_worker_num);

            expect(setUsersToGlobal_stub.calledOnce).to.be.true;
            expect(p_schema_to_global_stub.calledOnce).to.be.true;
        });

        it('should log info about server launch', async() => {
            await launch_rw(test_worker_num);

            expect(logger_notify_stub.calledOnce).to.be.true;
            expect(logger_info_stub.calledThrice).to.be.true;
        });

        it('should configure custom_functions_forks correctly and set in global', async() => {
            await launch_rw(test_worker_num);

            expect(global.custom_functions_forks.length).to.eql(test_worker_num);
        });
    });
});
