'use strict';

const chai = require('chai');
const rewire = require('rewire');
const { expect } = chai;
const pm2 = require('pm2');
const sinon = require('sinon');
const os = require('os');
const path = require('path');
const test_utils = require('../../test_utils');
const env_mngr = require('../../../utility/environment/environmentManager');
const services_config = require('../../../utility/pm2/servicesConfig');
const hdb_terms = require('../../../utility/hdbTerms');
const utility_functions = rewire('../../../utility/pm2/utilityFunctions');

/**
 * Deletes a process from pm2
 * @param proc
 * @returns {Promise<unknown>}
 */
function pm2Delete(proc) {
    return new Promise(async (resolve, reject) => {
        await utility_functions.connect();
        pm2.delete( proc,(err, res) => {
            if(err){
                reject(err);
            }

            pm2.disconnect();
            resolve(res);
        });
    });
}

/**
 * Stops a process then deletes it from pm2.
 * @param service_name
 * @returns {Promise<void>}
 */
async function stopDeleteProcess(service_name) {
    try {
        await utility_functions.stop(service_name);
        await pm2Delete(service_name);
    } catch(err) {}
}

/**
 * Calls stop/delete for all services
 * @returns {Promise<void>}
 */
async function stopDeleteAllServices() {
    await stopDeleteProcess('HarperDB');
    await stopDeleteProcess('IPC');
    await stopDeleteProcess('Clustering');
    await stopDeleteProcess('Custom Functions');
    await stopDeleteProcess('Clustering Connector');
}

describe('Test pm2 utilityFunctions module', () => {
    const sandbox = sinon.createSandbox();
    const test_err = 'Utility functions test error';
    let os_cpus_stub;

    before(() => {
        os_cpus_stub = sandbox.stub(os, 'cpus').returns([1, 2, 3, 4, 5, 6]);
        env_mngr.initTestEnvironment();
    });

    beforeEach(async () => {
        await stopDeleteAllServices();
    });

    after(() => {
        sandbox.restore();
    });

    describe('Test start function', () => {
        afterEach(async () => {
            await stopDeleteAllServices();
        });

        it('Test the IPC server is started on one process', async () => {
            await utility_functions.start(services_config.generateIPCServerConfig());
            const process_meta = await utility_functions.describe('IPC');
            expect(process_meta.length).to.equal(1);
            expect(process_meta[0].name).to.equal('IPC');
            expect(process_meta[0].pm2_env.status).to.equal('online');
            expect(process_meta[0].pm2_env.exec_mode).to.equal('fork_mode');
        });

        it('Test the HarperDB server is started on multiple processes', async () => {
            await utility_functions.start(services_config.generateHDBServerConfig());
            const process_meta = await utility_functions.describe('HarperDB');
            expect(process_meta.length).to.equal(4);
            expect(process_meta[0].name).to.equal('HarperDB');
            expect(process_meta[1].name).to.equal('HarperDB');
            expect(process_meta[2].name).to.equal('HarperDB');
            expect(process_meta[3].name).to.equal('HarperDB');
            expect(process_meta[0].pm2_env.status).to.equal('online');
            expect(process_meta[1].pm2_env.status).to.equal('online');
            expect(process_meta[2].pm2_env.status).to.equal('online');
            expect(process_meta[3].pm2_env.status).to.equal('online');
            expect(process_meta[0].pm2_env.exec_mode).to.equal('cluster_mode');
            expect(process_meta[1].pm2_env.exec_mode).to.equal('cluster_mode');
            expect(process_meta[2].pm2_env.exec_mode).to.equal('cluster_mode');
            expect(process_meta[3].pm2_env.exec_mode).to.equal('cluster_mode');
            expect(process_meta[0].pm2_env.node_args[0]).includes('--max-old-space-size=');
            expect(process_meta[1].pm2_env.node_args[0]).includes('--max-old-space-size=');
            expect(process_meta[2].pm2_env.node_args[0]).includes('--max-old-space-size=');
            expect(process_meta[3].pm2_env.node_args[0]).includes('--max-old-space-size=');
        });

        it('Test error is handled as expected', async () => {
            const test_script_path = `${__dirname}/imnothere.js`;
            let test_options = {
                name: 'unit test',
                script: test_script_path,
                out_file: '/dev/null',
                error_file: '/dev/null',
                instances: 1
            };

            let error;
            try {
                await utility_functions.start(test_options);
            } catch(err) {
                error = err;
            }

            expect(error[0].message).to.equal(`Script not found: ${test_script_path}`);
        });

        it('Test error from connect causes promise to reject', async () => {
            const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
            await test_utils.assertErrorAsync(utility_functions.start, [], new Error(test_err));
            connect_rw();
        });
    });

    describe('Test stop function', () => {
        it('Test that a single online process is stopped', async () => {
            await utility_functions.start(services_config.generateIPCServerConfig());
            await utility_functions.stop('IPC');
            const process_meta = await utility_functions.list('IPC');
            expect(process_meta.length).to.equal(0);
        });

        it('Test that multiple processes are stopped', async () => {
            await utility_functions.start(services_config.generateHDBServerConfig());
            await utility_functions.stop('HarperDB');
            const process_meta = await utility_functions.list('HarperDB');
            expect(process_meta.length).to.equal(0);
        });

        it('Test error is handled as expected', async () => {
            await test_utils.assertErrorAsync(utility_functions.stop, ['HarperACDC'], new Error('process or namespace not found'));
        });

        it('Test error from connect causes promise to reject', async () => {
            const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
            await test_utils.assertErrorAsync(utility_functions.stop, ['test'], new Error(test_err));
            connect_rw();
        });
    });

    describe('Test reload function', () => {
        afterEach(async () => {
            await stopDeleteAllServices();
        });

        it('Test clustered processes are reloaded', async () => {
            await utility_functions.start(services_config.generateHDBServerConfig());
            await utility_functions.reload('HarperDB');
            const process_meta = await utility_functions.describe('HarperDB');
            expect(process_meta[0].name).to.equal('HarperDB');
            expect(process_meta[1].name).to.equal('HarperDB');
            expect(process_meta[2].name).to.equal('HarperDB');
            expect(process_meta[3].name).to.equal('HarperDB');
            expect(process_meta[0].pm2_env.status).to.equal('online');
            expect(process_meta[1].pm2_env.status).to.equal('online');
            expect(process_meta[2].pm2_env.status).to.equal('online');
            expect(process_meta[3].pm2_env.status).to.equal('online');
        }).timeout(30000);

        it('Test error is handled as expected', async () => {
            await test_utils.assertErrorAsync(utility_functions.reload, ['HarperACDC'], new Error('process or namespace not found'));
        });

        it('Test error from connect causes promise to reject', async () => {
            await utility_functions.start(services_config.generateHDBServerConfig());
            const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
            await test_utils.assertErrorAsync(utility_functions.reload, ['Test'], new Error(test_err));
            connect_rw();
        });
    });

    describe('Test restart function', () => {
        afterEach(async () => {
            await stopDeleteAllServices();
        });

        it('Test clustered processes are restarted', async () => {
            await utility_functions.start(services_config.generateHDBServerConfig());
            await utility_functions.restart('HarperDB');
            const process_meta = await utility_functions.describe('HarperDB');
            expect(process_meta[0].name).to.equal('HarperDB');
            expect(process_meta[1].name).to.equal('HarperDB');
            expect(process_meta[2].name).to.equal('HarperDB');
            expect(process_meta[3].name).to.equal('HarperDB');
            expect(process_meta[0].pm2_env.status).to.equal('online');
            expect(process_meta[1].pm2_env.status).to.equal('online');
            expect(process_meta[2].pm2_env.status).to.equal('online');
            expect(process_meta[3].pm2_env.status).to.equal('online');
        }).timeout(30000);

        it('Test error is handled as expected', async () => {
            await test_utils.assertErrorAsync(utility_functions.restart, ['HarperACDC'], new Error('process or namespace not found'));
        });

        it('Test error from connect causes promise to reject', async () => {
            const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
            await test_utils.assertErrorAsync(utility_functions.restart, ['test'], new Error(test_err));
            connect_rw();
        });
    });

    describe('Test list function', () => {
        afterEach(async () => {
            await stopDeleteAllServices();
        });

        it('Test all pm2 managed processes are listed', async () => {
            await utility_functions.start(services_config.generateHDBServerConfig());
            await utility_functions.start(services_config.generateIPCServerConfig());
            const list = await utility_functions.list();
            let hdb_name_found = false;
            let ipc_name_found = false;
            list.forEach((proc) => {
                if (proc.name === 'HarperDB') hdb_name_found = true;
                if (proc.name === 'IPC') ipc_name_found = true;
            });

            expect(list.length).to.equal(5);
            expect(hdb_name_found).to.be.true;
            expect(ipc_name_found).to.be.true;
        });

        it('Test error from connect causes promise to reject', async () => {
            const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
            await test_utils.assertErrorAsync(utility_functions.list, [], new Error(test_err));
            connect_rw();
        });
    });

    describe('Test describe function', () => {
        afterEach(async () => {
            await stopDeleteAllServices();
        });

        it('Test process meta details are returned', async () => {
            await utility_functions.start(services_config.generateIPCServerConfig());
            const process_meta = await utility_functions.describe('IPC');
            expect(process_meta.length).to.equal(1);
            expect(process_meta[0].name).to.equal('IPC');
            expect(process_meta[0].pm2_env.status).to.equal('online');
            expect(process_meta[0].pm2_env.exec_mode).to.equal('fork_mode');
        });

        it('Test empty array returned if service does not exist', async () => {
            const result = await utility_functions.describe('HarperACDC');
            expect(result).to.eql([]);
        });

        it('Test error from connect causes promise to reject', async () => {
            const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
            await test_utils.assertErrorAsync(utility_functions.describe, ['test'], new Error(test_err));
            connect_rw();
        });
    });

    describe('Test start all services function', () => {
        afterEach(async () => {
            await stopDeleteAllServices();
        });

        it('Test all services are started', async () => {
            await utility_functions.startAllServices();
            const list = await utility_functions.list();
            let hdb_name_found = false;
            let ipc_name_found = false;
            let sc_name_found = false;
            let cf_name_found = false;
            let cc_name_found = false;
            list.forEach((proc) => {
                if (proc.name === 'HarperDB') hdb_name_found = true;
                if (proc.name === 'IPC') ipc_name_found = true;
                if (proc.name === 'Clustering') sc_name_found = true;
                if (proc.name === 'Custom Functions') cf_name_found = true;
                if (proc.name === 'Clustering Connector') cc_name_found = true;
            });

            expect(list.length).to.equal(9);
            expect(hdb_name_found).to.be.true;
            expect(ipc_name_found).to.be.true;
            expect(sc_name_found).to.be.true;
            expect(cf_name_found).to.be.true;
            expect(cc_name_found).to.be.true;
        }).timeout(20000);
    });

    describe('Test startService function', () => {
        afterEach(async () => {
            await stopDeleteAllServices();
        });

        it('Test starts IPC service', async () => {
            await utility_functions.startService('IpC');
            const process_meta = await utility_functions.describe('IPC');
            expect(process_meta.length).to.equal(1);
            expect(process_meta[0].name).to.equal('IPC');
            expect(process_meta[0].pm2_env.status).to.equal('online');
        });

        it('Test starts clustering connector service', async () => {
            await utility_functions.startService('clustering connector');
            const process_meta = await utility_functions.describe('Clustering Connector');
            expect(process_meta.length).to.equal(1);
            expect(process_meta[0].name).to.equal('Clustering Connector');
            expect(process_meta[0].pm2_env.status).to.equal('online');
        });

        it('Test starts Clustering service', async () => {
            await utility_functions.startService('clustering');
            const process_meta = await utility_functions.describe('Clustering');
            expect(process_meta.length).to.equal(1);
            expect(process_meta[0].name).to.equal('Clustering');
            expect(process_meta[0].pm2_env.status).to.equal('online');
        });

        it('Test starts HarperDB service', async () => {
            afterEach(async () => {
                await stopDeleteAllServices();
            });

            await utility_functions.startService('harperdb');
            const process_meta = await utility_functions.describe('HarperDB');
            expect(process_meta.length).to.equal(4);
            expect(process_meta[0].name).to.equal('HarperDB');
            expect(process_meta[1].name).to.equal('HarperDB');
            expect(process_meta[2].name).to.equal('HarperDB');
            expect(process_meta[3].name).to.equal('HarperDB');
            expect(process_meta[0].pm2_env.status).to.equal('online');
            expect(process_meta[1].pm2_env.status).to.equal('online');
            expect(process_meta[2].pm2_env.status).to.equal('online');
            expect(process_meta[3].pm2_env.status).to.equal('online');
        });

        it('Test starts custom function service', async () => {
            await utility_functions.startService('custom FUNCTIONS');
            const process_meta = await utility_functions.describe('Custom Functions');
            expect(process_meta.length).to.equal(2);
            expect(process_meta[0].name).to.equal('Custom Functions');
            expect(process_meta[1].name).to.equal('Custom Functions');
            expect(process_meta[0].pm2_env.status).to.equal('online');
            expect(process_meta[1].pm2_env.status).to.equal('online');
        });

        it('Test error handled as expected', async () => {
            await test_utils.assertErrorAsync(utility_functions.startService, ['DarperDB'], new Error('Start service called with unknown service config: DarperDB'));
        });
    });
    
    describe('Test getUniqueServicesList function', () => {
        afterEach(async () => {
            await stopDeleteAllServices();
        });

        it('Test a unique set of services is returned', async () => {
            const expected_obj = {
                "IPC": {
                    "name": "IPC",
                    "exec_mode": "fork_mode"
                },
                "Clustering": {
                    "name": "Clustering",
                    "exec_mode": "fork_mode"
                },
                "HarperDB": {
                    "name": "HarperDB",
                    "exec_mode": "cluster_mode"
                },
                "Custom Functions": {
                    "name": "Custom Functions",
                    "exec_mode": "cluster_mode"
                },
                "Clustering Connector":
                {
                    "name": "Clustering Connector",
                    "exec_mode": "fork_mode"
                }
            };
            await utility_functions.startAllServices();
            const list = await utility_functions.getUniqueServicesList();
            expect(list).to.eql(expected_obj);
        });
    });

    describe('Test stopAllServices function', () => {
        afterEach(async () => {
            await stopDeleteAllServices();
        });

        it('Test all services are stopped', async () => {
            await utility_functions.startAllServices();
            await utility_functions.stopAllServices();
            const list = await utility_functions.list();
            let service_still_online = false;
            list.forEach((proc) => {
                if (proc.pm2_env.status === 'online') service_still_online = true;
            });

            expect(service_still_online).to.be.false;
        }).timeout(30000);
    });

    describe('Test isServiceRegistered', () => {
        afterEach(async () => {
            await stopDeleteAllServices();
        });

        it('Test false is returned if service no registered to pm2', async () => {
            const result = await utility_functions.isServiceRegistered('harperdb');
            expect(result).to.be.false;
        });

        it('Test true is returned if service is registered to pm2', async () => {
            await utility_functions.startService('harperdb');
            const result = await utility_functions.isServiceRegistered('harperdb');
            expect(result).to.be.false;
        });
    });

    describe('Test restartAllServices function', () => {
        let reload_stub = sandbox.stub();
        let restart_stub = sandbox.stub();
        let reload_rw;
        let restart_rw;

        before(() => {
            reload_rw = utility_functions.__set__('reloadStopStart', reload_stub);
            restart_rw = utility_functions.__set__('restart', restart_stub);
        });

        after(() => {
            reload_rw();
            restart_rw();
        });

        afterEach(async () => {
            await stopDeleteAllServices();
        });

        after(() => {
            sandbox.restore();
        });

        it('Test all services are restarted', async () => {
            await utility_functions.startAllServices();
            await utility_functions.restartAllServices();
            expect(reload_stub.getCall(1).args[0]).to.equal('HarperDB');
            expect(reload_stub.getCall(0).args[0]).to.equal('Custom Functions');
            expect(restart_stub.getCall(0).args[0]).to.equal('IPC');
            expect(restart_stub.getCall(1).args[0]).to.equal('Clustering');
        });
    });

    describe('Test reloadStopStart function', () => {
        let reload_stub = sandbox.stub();
        let stop_stub = sandbox.stub();
        let start_service_stub = sandbox.stub();
        let describe_stub = sandbox.stub();
        let restart_hdb_stub = sandbox.stub();
        let describe_rw;
        let reload_rw;
        let stop_rw;
        let start_service_rw;
        let restart_hdb_rw;

        before(() => {
            reload_rw = utility_functions.__set__('reload', reload_stub);
            stop_rw = utility_functions.__set__('stop', stop_stub);
            start_service_rw = utility_functions.__set__('startService', start_service_stub);
            describe_rw = utility_functions.__set__('describe', describe_stub);
            restart_hdb_rw = utility_functions.__set__('restartHdb', restart_hdb_stub);
        });

        after(() => {
            reload_rw();
            stop_rw();
            start_service_rw();
            restart_hdb_rw();
            describe_rw();
        });

        it('Test service is stopped and started if there is a change in max process setting', async () => {
            const env_stub = sandbox.stub();
            const env_rw = utility_functions.__set__('env_mangr.initSync', env_stub);
            env_mngr.setProperty('MAX_HDB_PROCESSES', 2);
            await utility_functions.reloadStopStart('Custom Functions');
            env_rw();
            env_mngr.initTestEnvironment();
            expect(stop_stub.getCall(0).args[0]).to.equal('Custom Functions');
            expect(start_service_stub.getCall(0).args[0]).to.equal('Custom Functions');
        });

        it('Test service is reloaded if no change in process setting', async () => {
            const env_stub = sandbox.stub();
            const env_rw = utility_functions.__set__('env_mangr.initSync', env_stub);
            describe_stub.resolves([1, 2]);
            env_mngr.setProperty('MAX_HDB_PROCESSES', 2);
            await utility_functions.reloadStopStart('Custom Functions');
            env_rw();
            env_mngr.initTestEnvironment();
            expect(reload_stub.getCall(0).args[0]).to.equal('Custom Functions');
        });

        it('Test restartHdb is called if service is HarperDB', async () => {
            const env_stub = sandbox.stub();
            const env_rw = utility_functions.__set__('env_mangr.initSync', env_stub);
            describe_stub.resolves([1, 2]);
            env_mngr.setProperty('MAX_HDB_PROCESSES', 2);
            await utility_functions.reloadStopStart('HarperDB');
            env_rw();
            env_mngr.initTestEnvironment();
            expect(restart_hdb_rw.called);
        });
    });

    describe('Test kill function', () => {
        after(async () => {
            await stopDeleteAllServices();
        });

        it('Test pm2 is killed', async () => {
            await utility_functions.startService('HarperDB');
            await utility_functions.stop('HarperDB');
            await utility_functions.kill();
            const result = await utility_functions.list();
            expect(result).to.eql([]);
        });

        it('Test error from connect causes promise to reject', async () => {
            const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
            await test_utils.assertErrorAsync(utility_functions.kill, [], new Error(test_err));
            connect_rw();
        });
    });

    describe('Test restartHdb function', () => {
        it('Test start is called with restart config', async () => {
            const expected_result = {
                "name": "Restart HDB",
                "exec_mode": "fork",
                "out_file": "/dev/null",
                "error_file": "/dev/null",
                "instances": 1,
                "autorestart": false,
                "cwd": path.resolve(__dirname, '../../../utility/scripts'),
                "script": path.join(__dirname, '../../../utility/scripts', hdb_terms.HDB_RESTART_SCRIPT)
            };
            const start_stub = sandbox.stub().resolves();
            const start_rw = utility_functions.__set__('start', start_stub);
            await utility_functions.restartHdb();
            expect(start_stub.getCall(0).args[0]).to.eql(expected_result);
            start_rw();
        });
    });

    describe('Test deleteProcess function', () => {
        after(async () => {
            await stopDeleteAllServices();
        });

        it('Test process is deleted', async () => {
            await utility_functions.startService('IPC');
            await utility_functions.deleteProcess('IPC');
            const process_meta = await utility_functions.describe('IPC');
            expect(process_meta.length).to.equal(0);
        });

        it('Test error from connect causes promise to reject', async () => {
            const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
            await test_utils.assertErrorAsync(utility_functions.deleteProcess, ['IPC'], new Error(test_err));
            connect_rw();
        });
    });
});