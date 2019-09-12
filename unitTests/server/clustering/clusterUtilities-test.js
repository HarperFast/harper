"use strict";

const assert = require('assert');
const chai = require('chai');
const rewire = require('rewire');
const cluster_utils = rewire('../../../server/clustering/clusterUtilities');
const cluster_utils_node_validation = cluster_utils.__get__('nodeValidation');
const test_util = require('../../test_utils');
test_util.preTestPrep();

const CLUSTERING_PORT = 12345;
const ADD_NODE = {name:'test', host:"localhost", port:12345};
const SUBSCRIPTIONS_OBJECT = {channel:'dev:dog', publish:true, subscribe:true};
const REMOVE_NODE = {name:'test'};

describe('Test clusterUtilities' , ()=> {
    describe('Test addNode', () => {
        it('Pass in invalid addNode, empty object', () => {
            assert.rejects(cluster_utils.addNode({}), {message: "Error: Name can't be blank,Port can't be blank,Host can't be blank"});
        });
        it('Pass in addNode with localhost and same port as server, expect error', () => {
            let revert = cluster_utils.__set__('CLUSTER_PORT', CLUSTERING_PORT);
            let add_node = test_util.deepClone(ADD_NODE);
            assert.rejects(cluster_utils.addNode(add_node), {message: "Cannot add a node that matches the hosts clustering config."});
            revert();
        });

        it('Pass in addNode with host 127.0.0.1 and same port as server, expect error', () => {
            let revert = cluster_utils.__set__('CLUSTER_PORT', CLUSTERING_PORT);
            let add_node = test_util.deepClone(ADD_NODE);
            add_node.host = '127.0.0.1';
            assert.rejects(cluster_utils.addNode(add_node), {message: "Cannot add a node that matches the hosts clustering config."});
            revert();
        });

        it('Pass in addNode simulate insert failure, expect error', async () => {
            let insert_error = new Error('An internal error occurred, please check the logs for more information.');
            let insert = {
                insert: async (insert_object) => {
                    throw insert_error;
                }
            };

            let port_revert = cluster_utils.__set__('CLUSTER_PORT', CLUSTERING_PORT);
            let insert_revert = cluster_utils.__set__('insert', insert);
            let add_node = test_util.deepClone(ADD_NODE);
            add_node.host = '192.168.0.100';

            try {
                let result = await cluster_utils.addNode(add_node);
                assert.equal(result, undefined);
            } catch (e) {
                assert.ok(e.message.length > 0, 'expected exception');
            }finally {
                port_revert();
                insert_revert();
            }
        });

        it('Pass in addNode simulate node already exists, expect error', async () => {
            let insert = {
                insert: async (insert_object) => {
                    return {skipped_hashes: ['test']};
                }
            };

            let port_revert = cluster_utils.__set__('CLUSTER_PORT', CLUSTERING_PORT);
            let insert_revert = cluster_utils.__set__('insert', insert);
            let add_node = test_util.deepClone(ADD_NODE);
            add_node.host = '192.168.0.100';

            try {
                let result = await cluster_utils.addNode(add_node);
                assert.equal(result, undefined);
            } catch (e) {
                assert.ok(e.message.length > 0, 'expected exception');
            } finally {
                port_revert();
                insert_revert();
            }
        });

        it('Pass in addNode simulate success, expect success', async () => {
            let insert = {
                insert: async (insert_object) => {
                    return {skipped_hashes: []};
                }
            };

            let port_revert = cluster_utils.__set__('CLUSTER_PORT', CLUSTERING_PORT);
            let insert_revert = cluster_utils.__set__('insert', insert);
            let add_node = test_util.deepClone(ADD_NODE);
            add_node.host = '192.168.0.100';

            let result = await cluster_utils.addNode(add_node);
            assert.ok(result.length > 0, 'success!');
            port_revert();
            insert_revert();
        });
    });

    describe('Test nodeValidation', () => {
        it('Pass in empty object, expect exception', ()=>{
            assert.throws(() => {
                cluster_utils_node_validation({});
            });
        });

        it('Pass in empty no host, expect exception', ()=>{
            let obj = test_util.deepClone(ADD_NODE);
            delete obj.host;
            assert.throws(() => {
                cluster_utils_node_validation(obj);
            });
        });

        it('Pass in empty no port, expect exception', ()=>{
            let obj = test_util.deepClone(ADD_NODE);
            delete obj.port;
            assert.throws(() => {
                cluster_utils_node_validation(obj);
            });
        });

        it('Pass in port as a non-numeric value, expect exception', ()=>{
            let obj = test_util.deepClone(ADD_NODE);
            obj.port = 'blerg';
            assert.throws(() => {
                cluster_utils_node_validation(obj);
            });
        });

        it('Pass in  subscription as string on node, get error', () => {
            let obj = test_util.deepClone(ADD_NODE);
            obj.subscriptions = 'blerg';
            assert.throws(() => {
                cluster_utils_node_validation(obj);
            });
        });

        it('Pass in  subscription as empty array on node, get success', () => {
            let obj = test_util.deepClone(ADD_NODE);
            obj.subscriptions = [];
            assert.doesNotThrow(() => {
                cluster_utils_node_validation(obj);
            });
        });

        it('Pass in no subscription, get success', () => {
            let obj = test_util.deepClone(ADD_NODE);
            delete obj.subscriptions;
            assert.doesNotThrow(() => {
                cluster_utils_node_validation(obj);
            });
        });

        it('Pass in one good subscription, get success', () => {
            let obj = test_util.deepClone(ADD_NODE);
            obj.subscriptions = [SUBSCRIPTIONS_OBJECT];
            assert.doesNotThrow(() => {
                cluster_utils_node_validation(obj);
            });
        });

        it('Pass in two good subscription, get success', () => {
            let second_object = test_util.deepClone(SUBSCRIPTIONS_OBJECT);
            second_object.channel = 'dev:breed';
            let obj = test_util.deepClone(ADD_NODE);
            obj.subscriptions = [SUBSCRIPTIONS_OBJECT, second_object];
            assert.doesNotThrow(() => {
                cluster_utils_node_validation(obj);
            });
        });

        it('Pass in empty subscription, get error', () => {
            let obj = test_util.deepClone(ADD_NODE);
            obj.subscriptions = {};
            assert.throws(() => {
                cluster_utils_node_validation(obj);
            });
        });
    });

    describe('Test updateNode', () => {
        it('Pass in invalid updateNode, empty object', () => {
            assert.rejects(cluster_utils.updateNode({}));
        });

        it('Pass in updateNode simulate update failure, expect error', async () => {
            let update_error = new Error('An internal error occurred, please check the logs for more information.');
            let insert = {
                update: async (insert_object) => {
                    throw update_error;
                }
            };

            let search = async function (search_object) {
                return [ADD_NODE];
            };

            let insert_revert = cluster_utils.__set__('insert', insert);

            let search_revert = cluster_utils.__set__('p_search_by_hash', search);
            let add_node = test_util.deepClone(ADD_NODE);
            add_node.host = '192.168.0.100';

            try {
                let result = await cluster_utils.updateNode(add_node);
                assert.equal(result, undefined);
            } catch (e) {
                assert.ok(e.message.length > 0, 'expected exception');
            } finally {
                insert_revert();
                search_revert();
            }
        });

        it('Pass in updateNode simulate node does not exist, expect error', async () => {
            let insert = {
                update: async (insert_object) => {
                    return {skipped_hashes: ['test']};
                }
            };

            let search = async function (search_object) {
                return [];
            };

            let insert_revert = cluster_utils.__set__('insert', insert);

            let search_revert = cluster_utils.__set__('p_search_by_hash', search);

            let add_node = test_util.deepClone(ADD_NODE);
            add_node.host = '192.168.0.100';

            try {
                let result = await cluster_utils.updateNode(add_node);
                assert.equal(result, undefined);
            } catch (e) {
                assert.ok(e.message.length > 0, 'expected exception');
            } finally {
                insert_revert();
                search_revert();
            }
        });

        it('Pass in addNode simulate success, expect success', async () => {
            let insert = {
                update: async (insert_object) => {
                    return {skipped_hashes: []};
                }
            };

            let search = async function (search_object) {
                return [ADD_NODE];
            };

            let insert_revert = cluster_utils.__set__('insert', insert);

            let search_revert = cluster_utils.__set__('p_search_by_hash', search);

            cluster_utils.__set__('insert', insert);
            let add_node = test_util.deepClone(ADD_NODE);
            add_node.host = '192.168.0.100';

            let result = await cluster_utils.updateNode(add_node);
            assert.ok(result.length > 0, 'success!');

            insert_revert();
            search_revert();
        });
    });

    describe('Test removeNode', () => {
        it('Pass in no name, expect error', () => {
            assert.rejects(cluster_utils.removeNode({}));
        });

        it('removeNode simulate delete failure, expect error', async () => {
            let p_delete = async (obj) => {
                throw new Error('fail!');
            };

            cluster_utils.__set__('p_delete_delete', p_delete);

            try {
                let result = await cluster_utils.removeNode(REMOVE_NODE);
                assert.equal(result, undefined);
            } catch (e) {
                assert.ok(e.message.length > 0, 'expected exception');
            }
        });

        it('removeNode simulate node does not exist, expect error', async () => {
            let p_delete = async (obj) => {
                return {skipped_hashes: ['test']};
            };

            cluster_utils.__set__('p_delete_delete', p_delete);

            try {
                let result = await cluster_utils.removeNode(REMOVE_NODE);
                assert.equal(result, undefined);
            } catch (e) {
                assert.ok(e.message.length > 0, 'expected exception');
            }
        });

        it('removeNode simulate success, expect success', async () => {
            let p_delete = async (obj) => {
                return {skipped_hashes: []};
            };

            cluster_utils.__set__('p_delete_delete', p_delete);

            let result = await cluster_utils.removeNode(REMOVE_NODE);
            assert.ok(result.length > 0, 'success!');

        });
    });
});

describe('Test configureCluster', () => {
    it(`Test nominal project dir`, async () => {
        let test_msg = {
            "operation": "configure_cluster",
            "PROJECT_DIR": "/Users/elipalmer/harperdb/bin"
        };
        let result = await cluster_utils.configureCluster(test_msg);
    });
});