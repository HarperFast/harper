'use strict';
/**
 * Test the enterprise init module.
 */
const test_util = require('../test_utils');
test_util.preTestPrep();
// The insert and schema defs below are not used but need to happen here because of an existing circular dependency
const insert = require('../../data_layer/insert');
const schema = require('../../data_layer/schema');

const env = require('../../utility/environment/environmentManager');
const search = require('../../data_layer/search');
const assert = require('assert');
const rewire = require('rewire');
const sinon = require('sinon');
const enterprise_initialization = rewire('../../utility/enterpriseInitialization');
let child_process = require('child_process');

let FAKE_CHILD = {
    send(payload) {
    }
};

const SEARCH_RESULT_OBJECT = [
    {
        'hdb_auth_header': 'Basic YWRtaW46YWRtaW4h',
        'hdb_user': {
            'active': true,
            'role': {
                'id': '10edb35b-3f00-4eee-9684-32b1c054d59f',
                'permission': {
                    'super_user': true
                },
                'role': 'super_user'
            },
            'username': 'admin'
        },
        'host': 'localhost',
        'name': 'node_1',
        'operation': 'add_node',
        'port': 1115
    },
    {
        'hdb_auth_header': 'Basic YWRtaW46YWRtaW4h',
        'hdb_user': {
            'active': true,
            'role': {
                'id': '10edb35b-3f00-4eee-9684-32b1c054d59f',
                'permission': {
                    'super_user': true
                },
                'role': 'super_user'
            },
            'username': 'admin'
        },
        'host': 'localhost',
        'name': 'node_2',
        'operation': 'add_node',
        'port': 1113
    },
    {
        'hdb_auth_header': 'Basic YWRtaW46YWRtaW4h',
        'hdb_user': {
            'active': true,
            'role': {
                'id': '10edb35b-3f00-4eee-9684-32b1c054d59f',
                'permission': {
                    'super_user': true
                },
                'role': 'super_user'
            },
            'username': 'admin'
        },
        'host': 'localhost',
        'name': 'node_3',
        'operation': 'add_node',
        'port': 1111
    },
    {
        'hdb_auth_header': 'Basic YWRtaW46YWRtaW4h',
        'hdb_user': {
            'active': true,
            'role': {
                'id': '10edb35b-3f00-4eee-9684-32b1c054d59f',
                'permission': {
                    'super_user': true
                },
                'role': 'super_user'
            },
            'username': 'admin'
        },
        'host': 'localhost',
        'name': 'node_4',
        'operation': 'add_node',
        'port': 1109
    }
];

describe('Test kickOffEnterprise', function () {
    let sandbox = undefined;
    let fork_stub = undefined;
    let child_send_spy = undefined;
    let search_nodes_stub = undefined;
    let fork_orig = undefined;
    before(function() {
        fork_orig = enterprise_initialization.__get__('fork');
    });
    beforeEach( function() {
        sandbox = sinon.createSandbox();
        child_send_spy = sandbox.spy(FAKE_CHILD, 'send');
         // stub 'fork' class as we don't want to test its functionality here
        fork_stub = sandbox.stub(child_process, 'fork').returns(FAKE_CHILD).withArgs(null);

        // since 'fork' is destructured, we need to set it explicitly;
        enterprise_initialization.__set__('fork', fork_stub);
    });
    afterEach( function() {
        sandbox.restore();
        global.cluster_server = null;
    });
    after(() => {
        enterprise_initialization.__set__('fork', fork_orig);
    });

    it('Nominal, expect clusters are successfully established', async function () {
        // stub searchByValue to return 4 default cluster nodes
        search_nodes_stub = sandbox.stub(search, 'searchByValue').yields('', SEARCH_RESULT_OBJECT);

        env.append('CLUSTERING', 'TRUE');
        env.append('CLUSTERING_PORT', '1115');
        env.append('NODE_NAME', 'node_1');
        
        let result = await enterprise_initialization.kickOffEnterprise();
        assert.equal(fork_stub.called, true, 'Child fork should have been called');
        assert.equal(child_send_spy.called, true, 'Child send() should have been called.');
        assert.equal(result.clustering, true, 'function should return clustering = true');
    });
    it('No node data in hdb_nodes table, expect cluster server initiated', async function () {
        search_nodes_stub = sandbox.stub(search, 'searchByValue').yields('', []);
        env.append('CLUSTERING', 'TRUE');
        env.append('CLUSTERING_PORT', '1115');
        env.append('NODE_NAME', 'node_1');
        
        let result = await enterprise_initialization.kickOffEnterprise();
        assert.equal(fork_stub.called, true, 'Child fork should have been called');
        assert.equal(child_send_spy.called, true, 'Child send() should have been called.');
        assert.equal(result.clustering, true, 'function should return clustering = true');
    });
    it('No cluster config in properties, expect no cluster node initiated', async function () {
        search_nodes_stub = sandbox.stub(search, 'searchByValue').yields('', SEARCH_RESULT_OBJECT);

        if (env.get('CLUSTERING')) {
            env.append('CLUSTERING', '');
        }
        let result = await enterprise_initialization.kickOffEnterprise();
        assert.equal(fork_stub.called, false, 'new ClusterServer(...) should have not been called');
        assert.equal(null, global.cluster_server, 'global.cluster_server should not be set');
        assert.equal(result.clustering, false, 'function should return clustering = false');
    });
    it('fork throws exception, expect clustering false', async function () {
        search_nodes_stub = sandbox.stub(search, 'searchByValue').yields('', SEARCH_RESULT_OBJECT);
        env.append('CLUSTERING', 'TRUE');
        env.append('CLUSTERING_PORT', '1115');
        env.append('NODE_NAME', 'node_1');
        // Need to restore this before we can set it to a new stub;
        fork_stub = null;
        fork_stub = sandbox.stub().throws(new Error('Fork Failure'));
        enterprise_initialization.__set__('fork', fork_stub);
        let result = await enterprise_initialization.kickOffEnterprise();
        assert.equal(fork_stub.called, true, 'Fork should have been called');
        assert.equal(result.clustering, false, 'function should return clustering = false');
    });
});