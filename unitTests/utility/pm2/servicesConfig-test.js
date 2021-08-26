'use strict';

const chai = require('chai');
const sinon = require('sinon');
const path = require('path');
const os = require('os');
const rewire = require('rewire');
const { expect } = chai;
const hdb_license = require('../../../utility/registration/hdb_license');
const env_mangr = require('../../../utility/environment/environmentManager');
const services_config = rewire('../../../utility/pm2/servicesConfig');
const hdb_terms = require('../../../utility/hdbTerms');
const BYTENODE_MOD_CLI = path.resolve(__dirname, '../../../node_modules/bytenode/cli.js');
const LAUNCH_SCRIPTS_DIR = path.resolve(__dirname, '../../../launchServiceScripts');
const SCRIPTS_DIR = path.resolve(__dirname, '../../../utility/scripts');
const RESTART_SCRIPT = path.join(SCRIPTS_DIR, hdb_terms.HDB_RESTART_SCRIPT);

describe('Test pm2 servicesConfig module', () => {
    const sandbox = sinon.createSandbox();
    const getInstanceCount = services_config.__get__('getInstanceCount');
    let os_cpus_stub;

    before(() => {
        os_cpus_stub = sandbox.stub(os, 'cpus').returns([1, 2, 3, 4, 5, 6]);
        sandbox.stub(hdb_license, 'licenseSearch').returns({ ram_allocation: 512 });
        env_mangr.initTestEnvironment();
    });

    after(() => {
        sandbox.restore();
        process.env.HDB_COMPILED = 'false';
    });

    it('Test result from generateIPCServerConfig function is correct for non compiled', () => {
        process.env.HDB_COMPILED = 'false';
        const expected_result = {
            "name": "IPC",
            "script": hdb_terms.SERVICE_SERVERS.IPC,
            "exec_mode": "fork",
            "out_file": "/dev/null",
            "error_file": "/dev/null",
            "instances": 1,
            "cwd":  hdb_terms.SERVICE_SERVERS_CWD.IPC
        };
        const result = services_config.generateIPCServerConfig();
        expect(result).to.eql(expected_result);
    });

    it('Test result from generateIPCServerConfig function is correct for compiled', () => {
        process.env.HDB_COMPILED = 'true';
        const expected_result = {
            "name": "IPC",
            "script": BYTENODE_MOD_CLI,
            "args": hdb_terms.SERVICE_SERVERS.IPC,
            "exec_mode": "fork",
            "out_file": "/dev/null",
            "error_file": "/dev/null",
            "instances": 1,
            "cwd":  hdb_terms.SERVICE_SERVERS_CWD.IPC
        };
        const result = services_config.generateIPCServerConfig();
        expect(result).to.eql(expected_result);
    });


    it('Test result from generateClusteringConnectorConfig function is correct non compiled', () => {
        process.env.HDB_COMPILED = 'false';
        const expected_result = {
            "name": "Clustering Connector",
            "script": hdb_terms.SERVICE_SERVERS.CLUSTERING_CONNECTOR,
            "exec_mode": "fork",
            "out_file": "/dev/null",
            "error_file": "/dev/null",
            "instances": 1,
            "cwd": hdb_terms.SERVICE_SERVERS_CWD.CLUSTERING
        };
        const result = services_config.generateClusteringConnectorConfig();
        expect(result).to.eql(expected_result);
    });

    it('Test result from generateClusteringConnectorConfig function is correct compiled', () => {
        process.env.HDB_COMPILED = 'true';
        const expected_result = {
            "name": "Clustering Connector",
            "script": BYTENODE_MOD_CLI,
            "args": hdb_terms.SERVICE_SERVERS.CLUSTERING_CONNECTOR,
            "exec_mode": "fork",
            "out_file": "/dev/null",
            "error_file": "/dev/null",
            "instances": 1,
            "cwd": hdb_terms.SERVICE_SERVERS_CWD.CLUSTERING
        };
        const result = services_config.generateClusteringConnectorConfig();
        expect(result).to.eql(expected_result);
    });

    it('Test result from generateClusteringServerConfig function is correct non compiled', () => {
        process.env.HDB_COMPILED = 'false';
        const expected_result = {
            "name": "Clustering",
            "script": hdb_terms.SERVICE_SERVERS.CLUSTERING,
            "exec_mode": "fork",
            "out_file": "/dev/null",
            "error_file": "/dev/null",
            "instances": 1,
            "cwd": hdb_terms.SERVICE_SERVERS_CWD.CLUSTERING
        };
        const result = services_config.generateClusteringServerConfig();
        expect(result).to.eql(expected_result);
    });

    it('Test result from generateClusteringServerConfig function is correct compiled', () => {
        process.env.HDB_COMPILED = 'true';
        const expected_result = {
            "name": "Clustering",
            "script": BYTENODE_MOD_CLI,
            "args": hdb_terms.SERVICE_SERVERS.CLUSTERING,
            "exec_mode": "fork",
            "out_file": "/dev/null",
            "error_file": "/dev/null",
            "instances": 1,
            "cwd": hdb_terms.SERVICE_SERVERS_CWD.CLUSTERING
        };
        const result = services_config.generateClusteringServerConfig();
        expect(result).to.eql(expected_result);
    });

    it('Test result from generateHDBServerConfig function is correct non compiled', () => {
        process.env.HDB_COMPILED = 'false';
        const expected_result = {
            "error_file": "/dev/null",
            "exec_mode": "cluster",
            "instances": 4,
            "name": "HarperDB",
            "node_args": "--max-old-space-size=512",
            "out_file": "/dev/null",
            "script": path.join(LAUNCH_SCRIPTS_DIR, 'launchHarperDB.js'),
            "cwd": LAUNCH_SCRIPTS_DIR
        };
        const result = services_config.generateHDBServerConfig();
        expect(result).to.eql(expected_result);
    });

    it('Test result from generateCFServerConfig function is correct non compiled', () => {
        process.env.HDB_COMPILED = 'false';
        const expected_result = {
            "error_file": "/dev/null",
            "exec_mode": "cluster",
            "instances": 2,
            "name": "Custom Functions",
            "node_args": "--max-old-space-size=512",
            "out_file": "/dev/null",
            "script": path.join(LAUNCH_SCRIPTS_DIR, 'launchCustomFunctions.js'),
            "cwd": LAUNCH_SCRIPTS_DIR
        };
        const result = services_config.generateCFServerConfig();
        expect(result).to.eql(expected_result);
    });

    it('Test result from generateRestart function is correct non compiled', () => {
        process.env.HDB_COMPILED = 'false';
        const expected_result = {
            "name": "Restart HDB",
            "script": RESTART_SCRIPT,
            "exec_mode": "fork",
            "out_file": "/dev/null",
            "error_file": "/dev/null",
            "instances": 1,
            "cwd": SCRIPTS_DIR,
            "autorestart": false
        };
        const result = services_config.generateRestart();
        expect(result).to.eql(expected_result);
    });

    it('Test result from generateRestart function is correct compiled', () => {
        process.env.HDB_COMPILED = 'true';
        const expected_result = {
            "name": "Restart HDB",
            "script": BYTENODE_MOD_CLI,
            "args": RESTART_SCRIPT,
            "exec_mode": "fork",
            "out_file": "/dev/null",
            "error_file": "/dev/null",
            "instances": 1,
            "cwd": SCRIPTS_DIR,
            "autorestart": false
        };
        const result = services_config.generateRestart();
        expect(result).to.eql(expected_result);
    });

    it('Test getInstanceCount returns set number of services', () => {
        const result = getInstanceCount('HarperDB');
        expect(result).to.equal(4);
    });

    it('Test getInstanceCount returns max cpus number of services', () => {
        os_cpus_stub.returns([1, 2]);
        const result = getInstanceCount('HarperDB');
        expect(result).to.equal(2);
    });
});