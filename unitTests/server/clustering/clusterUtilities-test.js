"use strict";

const assert = require('assert');
const chai = require('chai');
const rewire = require('rewire');
const cluster_utils = rewire('../../../server/clustering/clusterUtilities');
const cluster_utils_subscription_validation = cluster_utils.__get__('subscriptionsValidation');
const test_util = require('../../test_utils');
test_util.preTestPrep();

const CLUSTERING_PORT = 12345;
const ADD_NODE = {name:'test', host:"localhost", port:12345};
const SUBSCRIPTIONS_OBJECT = {channel:'dev:dog', publish:true, subscribe:true};
const REMOVE_NODE = {name:'test'};

describe('Test addNode', ()=>{
    it('Pass in invalid addNode, empty object', ()=>{
        assert.rejects(cluster_utils.addNode({}), {message:"Error: Name can't be blank,Port can't be blank,Host can't be blank"});
    });
    it('Pass in addNode with localhost and same port as server, expect error', ()=>{
        cluster_utils.__set__('CLUSTER_PORT', CLUSTERING_PORT);
        let add_node = test_util.deepClone(ADD_NODE);
        assert.rejects(cluster_utils.addNode(add_node), {message: "Cannot add a node that matches the hosts clustering config."});
    });

    it('Pass in addNode with host 127.0.0.1 and same port as server, expect error', ()=>{
        cluster_utils.__set__('CLUSTER_PORT', CLUSTERING_PORT);
        let add_node = test_util.deepClone(ADD_NODE);
        add_node.host = '127.0.0.1';
        assert.rejects(cluster_utils.addNode(add_node), {message: "Cannot add a node that matches the hosts clustering config."});
    });

    it('Pass in addNode simulate insert failure, expect error', async ()=>{
        let insert_error = new Error('An internal error occurred, please check the logs for more information.');
        let insert = {insert: async (insert_object)=>{
            throw insert_error;
        }};

        cluster_utils.__set__('CLUSTER_PORT', CLUSTERING_PORT);
        cluster_utils.__set__('insert', insert);
        let add_node = test_util.deepClone(ADD_NODE);
        add_node.host = '192.168.0.100';

        try {
            let result = await cluster_utils.addNode(add_node);
            assert.equal(result, undefined);
        } catch(e){
            assert.ok(e.message.length > 0, 'expected exception');
        }
    });

    it('Pass in addNode simulate node already exists, expect error', async ()=>{
        let insert = {insert: async (insert_object)=>{
                return {skipped_hashes: ['test']};
            }};

        cluster_utils.__set__('CLUSTER_PORT', CLUSTERING_PORT);
        cluster_utils.__set__('insert', insert);
        let add_node = test_util.deepClone(ADD_NODE);
        add_node.host = '192.168.0.100';

        try {
            let result = await cluster_utils.addNode(add_node);
            assert.equal(result, undefined);
        } catch(e){
            assert.ok(e.message.length > 0, 'expected exception');
        }
    });

    it('Pass in addNode simulate success, expect success', async ()=>{
        let insert = {insert: async (insert_object)=>{
                return {skipped_hashes: []};
            }};

        cluster_utils.__set__('CLUSTER_PORT', CLUSTERING_PORT);
        cluster_utils.__set__('insert', insert);
        let add_node = test_util.deepClone(ADD_NODE);
        add_node.host = '192.168.0.100';

        let result = await cluster_utils.addNode(add_node);
        assert.ok(result.length > 0, 'success!');

    });
});

describe('Test subscriptionsValidation', ()=>{
    it('Pass in  subscription as string on node, get error', ()=>{
        assert.throws(()=>{
            cluster_utils_subscription_validation({subscriptions:'hi'});
        });
    });

    it('Pass in  subscription as empty array on node, get success', ()=>{
        assert.doesNotThrow(()=>{
            cluster_utils_subscription_validation({subscriptions:[]});
        });
    });

    it('Pass in no subscription, get success', ()=>{
        assert.doesNotThrow(()=>{
            cluster_utils_subscription_validation({});
        });
    });

    it('Pass in one good subscription, get success', ()=>{
        assert.doesNotThrow(()=>{
            cluster_utils_subscription_validation({subscriptions: [SUBSCRIPTIONS_OBJECT]});
        });
    });

    it('Pass in two good subscription, get success', ()=>{
        let second_object = test_util.deepClone(SUBSCRIPTIONS_OBJECT);
        second_object.channel = 'dev:breed';
        assert.doesNotThrow(()=>{
            cluster_utils_subscription_validation({subscriptions: [SUBSCRIPTIONS_OBJECT, second_object]});
        });
    });

    it('Pass in empty subscription, get error', ()=>{
        assert.throws(()=>{
            cluster_utils_subscription_validation({subscriptions: [{}]});
        });
    });
});

describe('Test updateNode', ()=>{
    it('Pass in invalid updateNode, empty object', ()=>{
        assert.rejects(cluster_utils.updateNode({}));
    });

    it('Pass in updateNode simulate update failure, expect error', async ()=>{
        let update_error = new Error('An internal error occurred, please check the logs for more information.');
        let insert = {update: async (insert_object)=>{
                throw update_error;
            }};

        cluster_utils.__set__('insert', insert);
        let add_node = test_util.deepClone(ADD_NODE);
        add_node.host = '192.168.0.100';

        try {
            let result = await cluster_utils.updateNode(add_node);
            assert.equal(result, undefined);
        } catch(e){
            assert.ok(e.message.length > 0, 'expected exception');
        }
    });

    it('Pass in updateNode simulate node does not exist, expect error', async ()=>{
        let insert = {update: async (insert_object)=>{
                return {skipped_hashes: ['test']};
            }};

        cluster_utils.__set__('insert', insert);
        let add_node = test_util.deepClone(ADD_NODE);
        add_node.host = '192.168.0.100';

        try {
            let result = await cluster_utils.updateNode(add_node);
            assert.equal(result, undefined);
        } catch(e){
            assert.ok(e.message.length > 0, 'expected exception');
        }
    });

    it('Pass in addNode simulate success, expect success', async ()=>{
        let insert = {update: async (insert_object)=>{
                return {skipped_hashes: []};
            }};

        cluster_utils.__set__('insert', insert);
        let add_node = test_util.deepClone(ADD_NODE);
        add_node.host = '192.168.0.100';

        let result = await cluster_utils.updateNode(add_node);
        assert.ok(result.length > 0, 'success!');

    });
});

describe('Test removeNode', ()=>{
    it('Pass in no name, expect error', ()=>{
        assert.rejects(cluster_utils.removeNode({}));
    });

    it('removeNode simulate delete failure, expect error', async ()=>{
        let p_delete = async (obj)=>{
                throw new Error('fail!');
            };

        cluster_utils.__set__('p_delete_delete', p_delete);

        try {
            let result = await cluster_utils.removeNode(REMOVE_NODE);
            assert.equal(result, undefined);
        } catch(e){
            assert.ok(e.message.length > 0, 'expected exception');
        }
    });

    it('removeNode simulate node does not exist, expect error', async ()=>{
        let p_delete = async (obj)=>{
                return {skipped_hashes: ['test']};
            };

        cluster_utils.__set__('p_delete_delete', p_delete);

        try {
            let result = await cluster_utils.removeNode(REMOVE_NODE);
            assert.equal(result, undefined);
        } catch(e){
            assert.ok(e.message.length > 0, 'expected exception');
        }
    });

    it('removeNode simulate success, expect success', async ()=>{
        let p_delete = async (obj)=>{
            return {skipped_hashes: []};
        };

        cluster_utils.__set__('p_delete_delete', p_delete);

        let result = await cluster_utils.removeNode(REMOVE_NODE);
        assert.ok(result.length > 0, 'success!');

    });
});