"use strict"
/**
 * Test the hdb_license module.
 */

const assert = require('assert');
const rewire = require('rewire');
const sinon = require('sinon');
const search = require('../../data_layer/search');
const ClusterServer = rewire('../../server/clustering/ClusterServer');

const SEARCH_RESULT_OBJECT = [
    {
        "hdb_auth_header": "Basic YWRtaW46YWRtaW4h",
        "hdb_user": {
            "active": true,
            "role": {
                "id": "10edb35b-3f00-4eee-9684-32b1c054d59f",
                "permission": {
                    "super_user": true
                },
                "role": "super_user"
            },
            "username": "admin"
        },
        "host": "localhost",
        "name": "node_1",
        "operation": "add_node",
        "port": 1115
    },
    {
        "hdb_auth_header": "Basic YWRtaW46YWRtaW4h",
        "hdb_user": {
            "active": true,
            "role": {
                "id": "10edb35b-3f00-4eee-9684-32b1c054d59f",
                "permission": {
                    "super_user": true
                },
                "role": "super_user"
            },
            "username": "admin"
        },
        "host": "localhost",
        "name": "node_2",
        "operation": "add_node",
        "port": 1113
    },
    {
        "hdb_auth_header": "Basic YWRtaW46YWRtaW4h",
        "hdb_user": {
            "active": true,
            "role": {
                "id": "10edb35b-3f00-4eee-9684-32b1c054d59f",
                "permission": {
                    "super_user": true
                },
                "role": "super_user"
            },
            "username": "admin"
        },
        "host": "localhost",
        "name": "node_3",
        "operation": "add_node",
        "port": 1111
    },
    {
        "hdb_auth_header": "Basic YWRtaW46YWRtaW4h",
        "hdb_user": {
            "active": true,
            "role": {
                "id": "10edb35b-3f00-4eee-9684-32b1c054d59f",
                "permission": {
                    "super_user": true
                },
                "role": "super_user"
            },
            "username": "admin"
        },
        "host": "localhost",
        "name": "node_4",
        "operation": "add_node",
        "port": 1109
    }
];

describe(`Test kickOffEnterprise`, function () {
    let ClusterServerStub = undefined;
    let search_nodes_stub = undefined;
    let enterprise_initialization = undefined;

    beforeEach( function() {
        enterprise_initialization = rewire('../../utility/enterpriseInitialization');
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
        search_nodes_stub = sinon.stub(search, "searchByValue").yields("", SEARCH_RESULT_OBJECT);
        // stub ClusterServer class methods to yield callback without error
        ClusterServerStub.prototype.init = sinon.stub().yields(null);
        ClusterServerStub.prototype.establishConnections = sinon.stub().yields(null);
        // inject necessary properties for clustering
        let hdb_properties = enterprise_initialization.__get__('hdb_properties');        
        hdb_properties.set('CLUSTERING', 'TRUE');
        hdb_properties.set('CLUSTERING_PORT', '1115');
        hdb_properties.set('NODE_NAME', 'node_1');
        
        enterprise_initialization.kickOffEnterprise(function(result){
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
    it('No node data in hdb_nodes table, expect no cluster node initiated', function (done) {
        // stub searchByValue to return 4 default cluster nodes
        search_nodes_stub = sinon.stub(search, "searchByValue").yields("", []);
        // stub ClusterServer class methods to yield callback without error
        ClusterServerStub.prototype.init = sinon.stub().yields(null);
        ClusterServerStub.prototype.establishConnections = sinon.stub().yields(null);
        // inject necessary properties for clustering
        let hdb_properties = enterprise_initialization.__get__('hdb_properties');        
        hdb_properties.set('CLUSTERING', 'TRUE');
        hdb_properties.set('CLUSTERING_PORT', '1115');
        hdb_properties.set('NODE_NAME', 'node_1');
        
        enterprise_initialization.kickOffEnterprise(function(result){
            assert.deepEqual(ClusterServerStub.calledWithNew(), false, 'new ClusterServer(...) should have not been called');                
            assert.deepEqual(null, global.cluster_server, 'global.cluster_server should not be set');
            assert.deepEqual(result.clustering, false, 'function should return clustering = false');
            done();
        });
    });
    it('No cluster config in properties, expect no cluster node initiated', function (done) {
        // stub searchByValue to return 4 default cluster nodes
        search_nodes_stub = sinon.stub(search, "searchByValue").yields("", SEARCH_RESULT_OBJECT);
        // stub ClusterServer class methods to yield callback without error
        ClusterServerStub.prototype.init = sinon.stub().yields(null);
        ClusterServerStub.prototype.establishConnections = sinon.stub().yields(null);
        // inject necessary properties for clustering
        let hdb_properties = enterprise_initialization.__get__('hdb_properties');  
        // make sure no clustering config is there     
        if (hdb_properties.get('CLUSTERING')) {
            hdb_properties.set('CLUSTERING', '');
        }
        enterprise_initialization.kickOffEnterprise(function(result){
            assert.deepEqual(ClusterServerStub.calledWithNew(), false, 'new ClusterServer(...) should have not been called');                
            assert.deepEqual(null, global.cluster_server, 'global.cluster_server should not be set');
            assert.deepEqual(result.clustering, false, 'function should return clustering = false');
            done();
        });
    });
    it('Cluster config in properties is false, expect no cluster node initiated', function (done) {
        // stub searchByValue to return 4 default cluster nodes
        search_nodes_stub = sinon.stub(search, "searchByValue").yields("", SEARCH_RESULT_OBJECT);
        // stub ClusterServer class methods to yield callback without error
        ClusterServerStub.prototype.init = sinon.stub().yields(null);
        ClusterServerStub.prototype.establishConnections = sinon.stub().yields(null);
        // inject necessary properties for clustering
        let hdb_properties = enterprise_initialization.__get__('hdb_properties');  
        hdb_properties.set('CLUSTERING', 'FALSE');
        hdb_properties.set('CLUSTERING_PORT', '1115');
        hdb_properties.set('NODE_NAME', 'node_1');

        enterprise_initialization.kickOffEnterprise(function(result){
            assert.deepEqual(ClusterServerStub.calledWithNew(), false, 'new ClusterServer(...) should have not been called');                
            assert.deepEqual(null, global.cluster_server, 'global.cluster_server should not be set');
            assert.deepEqual(result.clustering, false, 'function should return clustering = false');
            done();
        });
    });
    it('Cluster Server failed to init, expect no cluster node initiated', function (done) {
        // stub searchByValue to return 4 default cluster nodes
        search_nodes_stub = sinon.stub(search, "searchByValue").yields("", SEARCH_RESULT_OBJECT);
        // stub ClusterServer class methods to yield callback with error for init but without error for establishConnections
        ClusterServerStub.prototype.init = sinon.stub().yields('error: unable to init');
        ClusterServerStub.prototype.establishConnections = sinon.stub().yields(null);
        // inject necessary properties for clustering
        let hdb_properties = enterprise_initialization.__get__('hdb_properties');  
        hdb_properties.set('CLUSTERING', 'TRUE');
        hdb_properties.set('CLUSTERING_PORT', '1115');
        hdb_properties.set('NODE_NAME', 'node_1');

        enterprise_initialization.kickOffEnterprise(function(result){
            assert.equal(ClusterServerStub.calledWithNew(), true, 'new ClusterServer(...) should have been called');           
            assert.notDeepEqual(null, global.cluster_server, 'global.cluster_server should be set and not be null');
            assert.deepEqual(result.clustering, false, 'function should return clustering = false');
            done();
        });
    });
    it('Cluster Server failed to establishConnections, expect no cluster node initiated', function (done) {
        // stub searchByValue to return 4 default cluster nodes
        search_nodes_stub = sinon.stub(search, "searchByValue").yields("", SEARCH_RESULT_OBJECT);
        // stub ClusterServer class methods to yield callback without error for init but error for establishConnections
        ClusterServerStub.prototype.init = sinon.stub().yields(null);
        ClusterServerStub.prototype.establishConnections = sinon.stub().yields('error: unable to establishConnections');
        // inject necessary properties for clustering
        let hdb_properties = enterprise_initialization.__get__('hdb_properties');  
        hdb_properties.set('CLUSTERING', 'TRUE');
        hdb_properties.set('CLUSTERING_PORT', '1115');
        hdb_properties.set('NODE_NAME', 'node_1');

        enterprise_initialization.kickOffEnterprise(function(result){
            assert.equal(ClusterServerStub.calledWithNew(), true, 'new ClusterServer(...) should have been called');           
            assert.notDeepEqual(null, global.cluster_server, 'global.cluster_server should be set and not be null');
            assert.deepEqual(result.clustering, false, 'function should return clustering = false');
            done();
        });
    });
});