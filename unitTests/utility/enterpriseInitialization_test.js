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
    let ClusterServerStub = undefined;
    let search_nodes_stub = undefined;
    beforeEach( function() {
         // stub ClusterServer class as we don't want to test its functionalities here
        ClusterServerStub = sinon.spy(sinon.stub().withArgs(null));  
        enterprise_initialization.__set__('ClusterServer', ClusterServerStub);
    });
    afterEach( function() {
        search_nodes_stub.restore();
        global.cluster_server = null;
    });

    it('Nominal, expect clusters are successfully estabished', function (done) {
        // stub searchByValue to return 4 default cluster nodes
        search_nodes_stub = sinon.stub(search, 'searchByValue').yields('', SEARCH_RESULT_OBJECT);
        // stub ClusterServer class methods to yield callback without error
        ClusterServerStub.prototype.init = sinon.stub().yields(null);
        ClusterServerStub.prototype.establishAllConnections = sinon.stub().yields(null);
        // inject necessary properties for clustering
        //let hdb_properties = enterprise_initialization.__get__('hdb_properties');
        env.append('CLUSTERING', 'TRUE');
        env.append('CLUSTERING_PORT', '1115');
        env.append('NODE_NAME', 'node_1');
        
        enterprise_initialization.kickOffEnterprise(function(err, result){
            assert.equal(ClusterServerStub.calledWithNew(), true, 'new ClusterServer(...) should have been called');

            // get arg of new ClusterServer(..) and validate
            let cluster_server_arg = ClusterServerStub.getCall(0).args[0];
            assert.deepEqual('node_1', cluster_server_arg.name, 'name of node arg of new ClusterServer(..) should match to hdb_properties');
            assert.deepEqual(1115, cluster_server_arg.port, 'port of node arg of new ClusterServer(..) should match to hdb_properties');
            assert.deepEqual(4, cluster_server_arg.other_nodes.length, 'other_nodes amount of node arg of new ClusterServer(..) should match to nodes from hdb_nodes table');

            assert.notDeepEqual(null, global.cluster_server, 'global.cluster_server should be set and not be null');
            assert.deepEqual(result.clustering, true, 'function should return clustering = true');
            done();
        });
    });
    it('No node data in hdb_nodes table, expect cluster server initiated', function (done) {
        // stub searchByValue to return 4 default cluster nodes
        search_nodes_stub = sinon.stub(search, 'searchByValue').yields('', []);
        // stub ClusterServer class methods to yield callback without error
        ClusterServerStub.prototype.init = sinon.stub().yields(null);
        ClusterServerStub.prototype.establishAllConnections = sinon.stub().yields(null);
        // inject necessary properties for clustering
        //let hdb_properties = enterprise_initialization.__get__('hdb_properties');
        env.append('CLUSTERING', 'TRUE');
        env.append('CLUSTERING_PORT', '1115');
        env.append('NODE_NAME', 'node_1');
        
        enterprise_initialization.kickOffEnterprise(function(err, result){
            assert.deepEqual(ClusterServerStub.calledWithNew(), true, 'new ClusterServer(...) should have been called');
            assert.notEqual(null, global.cluster_server, 'global.cluster_server should be set');
            assert.deepEqual(result.clustering, true, 'function should return clustering = true');
            done();
        });
    });
    it('No cluster config in properties, expect no cluster node initiated', function (done) {
        // stub searchByValue to return 4 default cluster nodes
        search_nodes_stub = sinon.stub(search, 'searchByValue').yields('', SEARCH_RESULT_OBJECT);
        // stub ClusterServer class methods to yield callback without error
        ClusterServerStub.prototype.init = sinon.stub().yields(null);
        ClusterServerStub.prototype.establishAllConnections = sinon.stub().yields(null);
        // inject necessary properties for clustering
        //let hdb_properties = enterprise_initialization.__get__('hdb_properties');
        // make sure no clustering config is there     
        if (env.get('CLUSTERING')) {
            env.append('CLUSTERING', '');
        }
        enterprise_initialization.kickOffEnterprise(function(err, result){
            assert.deepEqual(ClusterServerStub.calledWithNew(), false, 'new ClusterServer(...) should have not been called');                
            assert.deepEqual(null, global.cluster_server, 'global.cluster_server should not be set');
            assert.deepEqual(result.clustering, false, 'function should return clustering = false');
            done();
        });
    });
    it('Cluster config in properties is false, expect no cluster node initiated', function (done) {
        // stub searchByValue to return 4 default cluster nodes
        search_nodes_stub = sinon.stub(search, 'searchByValue').yields('', SEARCH_RESULT_OBJECT);
        // stub ClusterServer class methods to yield callback without error
        ClusterServerStub.prototype.init = sinon.stub().yields(null);
        ClusterServerStub.prototype.establishAllConnections = sinon.stub().yields(null);
        // inject necessary properties for clustering
        //let hdb_properties = enterprise_initialization.__get__('hdb_properties');
        env.append('CLUSTERING', 'FALSE');
        env.append('CLUSTERING_PORT', '1115');
        env.append('NODE_NAME', 'node_1');

        enterprise_initialization.kickOffEnterprise(function(err, result){
            assert.deepEqual(ClusterServerStub.calledWithNew(), false, 'new ClusterServer(...) should have not been called');                
            assert.deepEqual(null, global.cluster_server, 'global.cluster_server should not be set');
            assert.deepEqual(result.clustering, false, 'function should return clustering = false');
            done();
        });
    });
    it('Cluster Server failed to init, expect no cluster node initiated', function (done) {
        // stub searchByValue to return 4 default cluster nodes
        search_nodes_stub = sinon.stub(search, 'searchByValue').yields('', SEARCH_RESULT_OBJECT);
        // stub ClusterServer class methods to yield callback with error for init but without error for establishAllConnections
        ClusterServerStub.prototype.init = sinon.stub().yields('error: unable to init');
        ClusterServerStub.prototype.establishAllConnections = sinon.stub().yields(null);
        // inject necessary properties for clustering
        //let hdb_properties = enterprise_initialization.__get__('hdb_properties');
        env.append('CLUSTERING', 'TRUE');
        env.append('CLUSTERING_PORT', '1115');
        env.append('NODE_NAME', 'node_1');

        enterprise_initialization.kickOffEnterprise(function(err, result){
            assert.equal(ClusterServerStub.calledWithNew(), true, 'new ClusterServer(...) should have been called');           
            assert.notDeepEqual(null, global.cluster_server, 'global.cluster_server should be set and not be null');
            assert.deepEqual(result.clustering, false, 'function should return clustering = false');
            done();
        });
    });
    it('Cluster Server failed to establishAllConnections, expect no cluster node initiated', function (done) {
        // stub searchByValue to return 4 default cluster nodes
        search_nodes_stub = sinon.stub(search, 'searchByValue').yields('', SEARCH_RESULT_OBJECT);
        // stub ClusterServer class methods to yield callback without error for init but error for establishAllConnections
        ClusterServerStub.prototype.init = sinon.stub().yields('error: unable to establishAllConnections');
        ClusterServerStub.prototype.establishAllConnections = sinon.stub().yields('error: unable to establishAllConnections');
        // inject necessary properties for clustering
        //let hdb_properties = enterprise_initialization.__get__('hdb_properties');
        env.append('CLUSTERING', 'TRUE');
        env.append('CLUSTERING_PORT', '1115');
        env.append('NODE_NAME', 'node_1');

        enterprise_initialization.kickOffEnterprise(function(err, result){
            assert.equal(ClusterServerStub.calledWithNew(), true, 'new ClusterServer(...) should have been called');           
            assert.notDeepEqual(null, global.cluster_server, 'global.cluster_server should be set and not be null');
            assert.deepEqual(result.clustering, false, 'function should return clustering = false');
            done();
        });
    });
});