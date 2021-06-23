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
const hdb_utils = require('../../utility/common_utils');
const assert = require('assert');
const rewire = require('rewire');
const sinon = require('sinon');
const enterprise_initialization = rewire('../../utility/enterpriseInitialization');
let child_process = require('child_process');

let FAKE_CHILD = {
    send(payload) {
    }
};

const CLUSTER_USER_INFO = {
        "active": true,
        "role": {
            "id": "7237a0ec-417d-47a3-89bf-b7f1260e5654",
            "permission": {
                "cluster_user": true
            },
            "role": "cluster_user"
        },
        "username": "test_cluster_user",
        "hash":"1234567"
    };

const GLOBAL_USERS = new Map([
    [
        "HDB_ADMIN",
        {
            "active": true,
            "role": {
                "id": "09b16a62-0202-4328-b6ff-2b063e63b7f7",
                "permission": {
                    "super_user": true
                },
                "role": "super_user"
            },
            "username": "HDB_ADMIN"
        }
    ],
    [
        "test_cluster_user",
        {
            "active": true,
            "role": {
                "id": "7237a0ec-417d-47a3-89bf-b7f1260e5654",
                "permission": {
                    "cluster_user": true
                },
                "role": "cluster_user"
            },
            "username": "test_cluster_user"
        }
    ]
]);

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
    let get_cluster_user_stub = undefined;
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
        global.hdb_users = GLOBAL_USERS;

        // stub searchByValue to return 4 default cluster nodes
        search_nodes_stub = sandbox.stub().resolves(SEARCH_RESULT_OBJECT);
        let p_search_by_value_rw = enterprise_initialization.__set__('p_search_by_value', search_nodes_stub);
        get_cluster_user_stub = sandbox.stub(hdb_utils, 'getClusterUser').returns(CLUSTER_USER_INFO);

        env.append('CLUSTERING', 'TRUE');
        env.append('CLUSTERING_PORT', '1115');
        env.append('CLUSTERING_USER', 'test_cluster_user');
        env.append('NODE_NAME', 'node_1');
        env.append('HDB_ROOT', 'hdb');

        let revert = enterprise_initialization.__set__('fs', {
            writeFile: async()=>{
                return;
            }
        });
        await enterprise_initialization.kickOffEnterprise();
        assert.equal(fork_stub.called, true, 'Child fork should have been called');
        p_search_by_value_rw();
        revert();
    });
    it('No node data in hdb_nodes table, expect cluster server initiated', async function () {
        search_nodes_stub = sandbox.stub().resolves([]);
        let p_search_by_value_rw = enterprise_initialization.__set__('p_search_by_value', search_nodes_stub);
        get_cluster_user_stub = sandbox.stub(hdb_utils, 'getClusterUser').returns(CLUSTER_USER_INFO);

        env.append('CLUSTERING', 'TRUE');
        env.append('CLUSTERING_PORT', '1115');
        env.append('CLUSTERING_USER', 'test_cluster_user');
        env.append('NODE_NAME', 'node_1');
        env.append('HDB_ROOT', 'hdb');

        let revert = enterprise_initialization.__set__('fs', {
            writeFile: async()=>{
                return;
            }
        });

        await enterprise_initialization.kickOffEnterprise();
        assert.equal(fork_stub.called, true, 'Child fork should have been called');
        p_search_by_value_rw();
        revert();
    });
    it('No cluster config in properties, expect no cluster node initiated', async function () {
        search_nodes_stub = sandbox.stub(search, 'searchByValue').yields('', SEARCH_RESULT_OBJECT);

        if (env.get('CLUSTERING')) {
            env.append('CLUSTERING', '');
        }
        await enterprise_initialization.kickOffEnterprise();
        assert.equal(fork_stub.called, false, 'new ClusterServer(...) should have not been called');
        assert.equal(null, global.cluster_server, 'global.cluster_server should not be set');
    });
    it('fork throws exception, expect clustering false', async function () {
        search_nodes_stub = sandbox.stub().resolves(SEARCH_RESULT_OBJECT);
        let p_search_by_value_rw = enterprise_initialization.__set__('p_search_by_value', search_nodes_stub);

        env.append('CLUSTERING', 'TRUE');
        env.append('CLUSTERING_PORT', '1115');
        env.append('NODE_NAME', 'node_1');
        env.append('HDB_ROOT', 'hdb');

        let revert = enterprise_initialization.__set__('fs', {
            writeFile: async()=>{
                return;
            }
        });
        // Need to restore this before we can set it to a new stub;
        fork_stub = null;
        fork_stub = sandbox.stub().throws(new Error('Fork Failure'));
        enterprise_initialization.__set__('fork', fork_stub);
        await enterprise_initialization.kickOffEnterprise();
        assert.equal(fork_stub.called, true, 'Fork should have been called');
        p_search_by_value_rw();
        revert();
    });
});
