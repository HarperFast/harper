'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();

const test_utils = require('../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
const cluster = require('cluster');
const harper_logger = require('../../utility/logging/harper_logger');
const user_schema = require('../../security/user');

let serverParent_rw;
let launch_rw;
let check_jwt_tokens_stub;
let launch_stub;
let cluster_stub;
let fork_on_stub;
let p_schema_to_global_stub;
let closeEnv_stub;
let setUsersToGlobal_stub
let logger_notify_stub;
let logger_info_stub;
let logger_debug_stub;
let logger_fatal_stub;
let logger_error_stub;
const fake = () => {};
const test_error = new Error('This is a testy mctest error')

const test_worker_num = 3;

describe('Test serverParent.js', () => {
    before(() => {
        serverParent_rw = rewire('../../server/serverParent');
        logger_notify_stub = sandbox.stub(harper_logger, 'notify').callsFake(fake);
        logger_info_stub = sandbox.stub(harper_logger, 'info').callsFake(fake);
        logger_debug_stub = sandbox.stub(harper_logger, 'debug').callsFake(fake);
        logger_fatal_stub = sandbox.stub(harper_logger, 'fatal').callsFake(fake);
        logger_error_stub = sandbox.stub(harper_logger, 'error').callsFake(fake);
        check_jwt_tokens_stub = sandbox.stub().callsFake(fake);
        serverParent_rw.__set__('check_jwt_tokens', check_jwt_tokens_stub);
        launch_stub = sandbox.stub().resolves();
        serverParent_rw.__set__('launch', launch_stub);
    })

    afterEach(async() => {
        sandbox.resetHistory();
    })

    after(() => {
        sandbox.restore();
        rewire('../../server/serverParent');
    })

    describe('exported serverParent method', () => {

        it('should launch parent process', async() => {
            await serverParent_rw(test_worker_num);

            expect(check_jwt_tokens_stub.calledOnce).to.be.true;
            expect(launch_stub.calledOnce).to.be.true;
            expect(launch_stub.args[0][0]).to.eql(test_worker_num);
        })

        it('should catch and log error form launch()', async() => {
            launch_stub.throws(test_error);
            await serverParent_rw(test_worker_num);

            expect(logger_error_stub.calledOnce).to.be.true;
            expect(logger_error_stub.args[0][0]).to.eql(test_error);
            launch_stub.resetBehavior();
        })

        it('should set global.isMaster to true', async() => {
            await serverParent_rw(test_worker_num);

            expect(global.isMaster).to.be.true;
        })
    })

    describe('launch() method',async() => {

        before(() => {
            serverParent_rw = rewire('../../server/serverParent');
            closeEnv_stub = sandbox.stub().callsFake(fake);
            serverParent_rw.__set__('closeEnvironment', closeEnv_stub);
            fork_on_stub = sandbox.stub().callsFake(fake);
            p_schema_to_global_stub = sandbox.stub().resolves();
            serverParent_rw.__set__('p_schema_to_global', p_schema_to_global_stub);
            cluster_stub = sandbox.stub(cluster, 'fork').returns({ on: fork_on_stub });
            setUsersToGlobal_stub = sandbox.stub(user_schema, 'setUsersToGlobal').resolves();
            launch_rw = serverParent_rw.__get__('launch');
        })

        beforeEach(() => {
            global.clustering_on = undefined;
            global.lmdb_map = {};
        })

        it('should update/set global values for server', async() => {
            await launch_rw(test_worker_num);

            expect(global.clustering_on).to.eql("TRUE");
            expect(global.lmdb_map).to.be.undefined;
            expect(setUsersToGlobal_stub.calledOnce).to.be.true;
            expect(p_schema_to_global_stub.calledOnce).to.be.true;
            expect(global.forks.length).to.be.eql(3);
        })

        it('should log info about server launch', async() => {
            await launch_rw(test_worker_num);

            expect(logger_notify_stub.calledOnce).to.be.true;
            expect(logger_info_stub.calledThrice).to.be.true;
        })

        it('should close any remaining lmdb envs and remove them from global', async() => {
            const test_lmdb_envs = { one: [0], two: [1], three: [2]};
            const test_env_keys = Object.keys(test_lmdb_envs);
            global.lmdb_map = test_lmdb_envs;
            await launch_rw(test_worker_num);

            expect(closeEnv_stub.callCount).to.eql(test_env_keys.length);
            test_env_keys.forEach((key, i) => {
                expect(closeEnv_stub.args[i][0]).to.eql(test_lmdb_envs[key]);
            })
            expect(global.lmdb_map).to.be.undefined;
        })

        it('should configure forks correctly and set in global', async() => {
            await launch_rw(test_worker_num);

            expect(cluster_stub.callCount).to.eql(test_worker_num);
            expect(fork_on_stub.callCount).to.eql(test_worker_num * 5);
            expect(global.forks.length).to.eql(test_worker_num);
        })

        it('should catch and log an error thrown within fork loop', async() => {
            cluster_stub.throws(test_error);
            await launch_rw(test_worker_num);

            expect(logger_fatal_stub.calledThrice).to.be.true;
            logger_fatal_stub.args.forEach(call => {
                expect(call[0]).to.eql(`Had trouble kicking off new HDB processes.  ${test_error}`);
            })
        })
    })
})
