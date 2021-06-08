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
const all_children_stopped_event = require('../../events/AllChildrenStoppedEvent');
const sio_server_stopped_event = require('../../events/SioServerStoppedEvent');
const cluster_utilities = require('../../server/clustering/clusterUtilities');
const RestartEventObject = require('../../server/RestartEventObject');

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
let console_error_stub;
let process_exit_stub;
let restart_stub;
let restart_hdb_rw;
let RestartEventObject_stub;
let restart_ready_stub;
let ipc_client_stub;
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
        restart_stub = sandbox.stub();
        restart_hdb_rw = serverParent_rw.__set__('restartHDB', restart_stub);
        check_jwt_tokens_stub = sandbox.stub().callsFake();
        serverParent_rw.__set__('check_jwt_tokens', check_jwt_tokens_stub);
        launch_stub = sandbox.stub().resolves();
        serverParent_rw.__set__('launch', launch_stub);
        console_error_stub = sandbox.stub(console, 'error').callsFake(fake);
        process_exit_stub = sandbox.stub(process, 'exit');
        restart_ready_stub = sandbox.stub().returns(true);
        RestartEventObject_stub = sandbox.stub(RestartEventObject.prototype, 'isReadyForRestart')
            .callsFake(restart_ready_stub);
        ipc_client_stub = sandbox.stub();
        serverParent_rw.__set__('IPCClient', ipc_client_stub);
    })

    afterEach(() => {
        sandbox.resetHistory();
    })

    after(() => {
        sandbox.restore();
        rewire('../../server/serverParent');
    })

    describe('exported serverParent method', () => {
        beforeEach(() => {
            const serverException = process.listeners('uncaughtException').pop()
            if (serverException.name === '') {
                process.removeListener('uncaughtException', serverException);
            }
            all_children_stopped_event.allChildrenStoppedEmitter.removeAllListeners();
            sio_server_stopped_event.sioServerStoppedEmitter.removeAllListeners();
        })

        it('should launch parent process', async() => {
            await serverParent_rw(test_worker_num);

            expect(check_jwt_tokens_stub.calledOnce).to.be.true;
            expect(launch_stub.calledOnce).to.be.true;
            expect(launch_stub.args[0][0]).to.eql(test_worker_num);
        })

        //Test event handlers set in serverParent()
        it('should catch uncaughtException to log error and exit process', async function() {
            const originalException = process.listeners('uncaughtException').pop()
            process.removeListener('uncaughtException', originalException);
            process_exit_stub.callsFake(fake);
            const test_error = "Test exception";

            await serverParent_rw(test_worker_num);

            process.emit('uncaughtException', new Error(test_error));

            expect(process_exit_stub.calledOnce).to.be.true;
            expect(process_exit_stub.args[0][0]).to.eql(1);

            process_exit_stub.resetBehavior();
        })

        it('check that all serverHandlers listeners are added to process', async function() {
            process_exit_stub.callsFake(fake);
            await serverParent_rw(test_worker_num);
            const before_exit_listeners = process.listeners('beforeExit').map(func => func.name);
            expect(before_exit_listeners).to.include('handleBeforeExit');
            const exit_listeners = process.listeners('exit').map(func => func.name);
            expect(exit_listeners).to.include('handleExit');
            const signit_listeners = process.listeners('SIGINT').map(func => func.name);
            expect(signit_listeners).to.include('handleSigint');
            const sigquit_listeners = process.listeners('SIGQUIT').map(func => func.name);
            expect(sigquit_listeners).to.include('handleSigquit');
            const sigterm_listeners = process.listeners('SIGTERM').map(func => func.name);
            expect(sigterm_listeners).to.include('handleSigterm');
            process_exit_stub.resetBehavior();
        });

        it('should catch allChildrenStoppedEmitter event and restart if ready', async function() {
            const test_msg = "Test msg";
            await serverParent_rw(test_worker_num);

            all_children_stopped_event.allChildrenStoppedEmitter.emit(all_children_stopped_event.EVENT_NAME, test_msg);

            expect(logger_info_stub.calledOnce).to.be.true;
            expect(logger_info_stub.args[0][0]).to.eql('Got all children stopped event.');
            expect(restart_stub.calledOnce).to.be.true;
        })

        it('should catch allChildrenStoppedEmitter event and NOT restart if connections still open', async function() {
            restart_ready_stub.returns(false);
            const test_msg = "Test msg";
            await serverParent_rw(test_worker_num);

            all_children_stopped_event.allChildrenStoppedEmitter.emit(all_children_stopped_event.EVENT_NAME, test_msg);

            expect(logger_info_stub.calledOnce).to.be.true;
            expect(logger_info_stub.args[0][0]).to.eql('Got all children stopped event.');
            expect(restart_stub.called).to.be.false;
        })

        it('should catch and log error thrown from launch()', async() => {
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

        it('should catch and log error thrown from IPCClient', async () => {
            ipc_client_stub.throws(test_error);
            await test_utils.assertErrorAsync(serverParent_rw, [test_worker_num], test_error);
            expect(logger_error_stub.getCall(0).args[0]).to.equal('Error instantiating new instance of IPC client in HDB server parent');
        });
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
            expect(fork_on_stub.callCount).to.eql(test_worker_num * 4);
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
