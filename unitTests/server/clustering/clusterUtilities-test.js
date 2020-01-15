"use strict";

const assert = require('assert');
const chai = require('chai');
const rewire = require('rewire');
const sinon = require('sinon');
const cluster_utils = rewire('../../../server/clustering/clusterUtilities');
const cluster_utils_node_validation = cluster_utils.__get__('nodeValidation');
const test_util = require('../../test_utils');
test_util.preTestPrep();
const path = require(`path`);
const hdb_license = require('../../../utility/registration/hdb_license');
const settings_test_file = require('../../settingsTestFile');

const CLUSTERING_PORT = 12345;
const ADD_NODE = {name:'test', host:"192.161.0.1", port:12345};
const SUBSCRIPTIONS_OBJECT = {channel:'dev:dog', publish:true, subscribe:true};
const REMOVE_NODE = {name:'test'};
const CONFIGURE_SUCCESS_RESPONSE = 'Successfully configured and loaded clustering configuration.  Some configurations may require a restart of HarperDB to take effect.';

const LICENSE = {
    valid_machine: true,
    valid_date: true,
    exp_date: '01/01/2099',
    api_call: 2000,
    enterprise: true
};

describe('Test clusterUtilities' , ()=> {
    describe('Test addNode', () => {
        let sandbox = undefined;
        let license_stub = undefined;
        beforeEach(() => {
            sandbox = sinon.createSandbox();
            license_stub = sandbox.stub(hdb_license, 'getLicense').resolves(LICENSE);
        });
        afterEach( () => {
            sandbox.restore();
            license_stub = undefined;
        });
        it('Pass in invalid addNode, empty object', () => {
            assert.rejects(cluster_utils.addNode({}), {message: "Error: Name can't be blank,Port can't be blank,Host can't be blank"});
        });
        it('Pass in addNode with localhost and same port as server, expect error', () => {
            let revert = cluster_utils.__set__('CLUSTER_PORT', CLUSTERING_PORT);
            let add_node = test_util.deepClone(ADD_NODE);
            add_node.host = 'localhost';
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
            let port_revert = cluster_utils.__set__('CLUSTER_PORT', CLUSTERING_PORT);

            let obj = test_util.deepClone(ADD_NODE);
            obj.subscriptions = [];
            assert.doesNotThrow(() => {
                cluster_utils_node_validation(obj);
            });

            port_revert();
        });

        it('Pass in no subscription, get success', () => {
            let port_revert = cluster_utils.__set__('CLUSTER_PORT', CLUSTERING_PORT);
            let obj = test_util.deepClone(ADD_NODE);
            delete obj.subscriptions;
            assert.doesNotThrow(() => {
                cluster_utils_node_validation(obj);
            });
            port_revert();
        });

        it('Pass in one good subscription, get success', () => {
            let port_revert = cluster_utils.__set__('CLUSTER_PORT', CLUSTERING_PORT);
            let obj = test_util.deepClone(ADD_NODE);
            obj.subscriptions = [SUBSCRIPTIONS_OBJECT];
            assert.doesNotThrow(() => {
                cluster_utils_node_validation(obj);
            });
            port_revert();
        });

        it('Pass in two good subscription, get success', () => {
            let port_revert = cluster_utils.__set__('CLUSTER_PORT', CLUSTERING_PORT);
            let second_object = test_util.deepClone(SUBSCRIPTIONS_OBJECT);
            second_object.channel = 'dev:breed';
            let obj = test_util.deepClone(ADD_NODE);
            obj.subscriptions = [SUBSCRIPTIONS_OBJECT, second_object];
            assert.doesNotThrow(() => {
                cluster_utils_node_validation(obj);
            });
            port_revert();
        });

        it('Pass in empty subscription, get error', () => {
            let obj = test_util.deepClone(ADD_NODE);
            obj.subscriptions = {};
            assert.throws(() => {
                cluster_utils_node_validation(obj);
            });
        });

        it('Pass in system table name system, get error', () => {
            let obj = test_util.deepClone(ADD_NODE);
            let sub_obj = test_util.deepClone(SUBSCRIPTIONS_OBJECT);
            sub_obj.channel = 'system:hdb_info';
            obj.subscriptions = [sub_obj];

            assert.throws(() => {
                cluster_utils_node_validation(obj);
            }, (err) => {
                assert.deepStrictEqual(err, 'Error: Channel invalid, channel cannot begin with reserved word: system:hdb_info');
            });
        });

        it('Pass in system table name hdb_internal, get error', () => {
            let obj = test_util.deepClone(ADD_NODE);
            obj.subscriptions = {};
            assert.throws(() => {
                cluster_utils_node_validation(obj);
            }, (err) => {
                assert.deepStrictEqual(err, 'this');
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

/**
 * Since there are common validators across most settings values, only testing a subset of the validators.
 */
describe('Test configureCluster', () => {

    // Builds a temporary settings file to be used by upgrade tests.
    before(() => {
        settings_test_file.buildFile();
    });

    // Remove temporary settings file.
    after(() => {
        settings_test_file.deleteFile();
    });

    it(`Test nominal project dir path`, async () => {
        let test_msg = {
            'operation': 'configure_cluster',
            'PROJECT_DIR': __dirname
        };
        let result = await cluster_utils.configureCluster(test_msg);
        assert.strictEqual(result, CONFIGURE_SUCCESS_RESPONSE, 'Expected success message');
    });
    it(`Test bad windows path`, async () => {
        let test_msg = {
            "operation": "configure_cluster",
            "PROJECT_DIR": "\\LOLWindows"
        };
        let result = undefined;
        try {
            result = await cluster_utils.configureCluster(test_msg);
        } catch(err) {
            result = err;
        }
        assert.strictEqual(result instanceof Error, true, 'Expected error');
    });
    it(`Test nominal integer validation for HTTP Port`, async () => {
        let test_msg = {
            "operation": "configure_cluster",
            "HTTP_PORT": "12345"
        };
        let result = await cluster_utils.configureCluster(test_msg);
        assert.strictEqual(result, CONFIGURE_SUCCESS_RESPONSE, 'Expected success message');
    });
    it(`Test http port non integer`, async () => {
        let test_msg = {
            "operation": "configure_cluster",
            "HTTP_PORT": "asdf"
        };
        let result = undefined;
        try {
            result = await cluster_utils.configureCluster(test_msg);
        } catch(err) {
            result = err;
        }
        assert.strictEqual(result instanceof Error, true, 'Expected error');
    });
    it(`Test nominal pem file path`, async () => {
        let cert_path = path.join(__dirname, `envDir`, `utilities`, `keys`, 'certificate.pem');
        let test_msg = {
            "operation": "configure_cluster",
            "CERTIFICATE": `${cert_path}`
        };
        let result = await cluster_utils.configureCluster(test_msg);
        assert.strictEqual(result, CONFIGURE_SUCCESS_RESPONSE, 'Expected success message');
    });
    it(`Test non pem file path`, async () => {
        let cert_path = path.join(__dirname, `settings.test`);
        let test_msg = {
            "operation": "configure_cluster",
            "CERTIFICATE": `${cert_path}`
        };
        let result = undefined;
        try {
            result = await cluster_utils.configureCluster(test_msg);
        } catch(err) {
            result = err;
        }
        assert.strictEqual(result instanceof Error, true, 'Expected error');
    });
    it(`Test nominal true false validation for ALLOW_SELF_SIGNED_SSL_CERTS`, async () => {
        let test_msg = {
            "operation": "configure_cluster",
            "ALLOW_SELF_SIGNED_SSL_CERTS": `true`
        };
        let result = await cluster_utils.configureCluster(test_msg);
        assert.strictEqual(result, CONFIGURE_SUCCESS_RESPONSE, 'Expected success message');
    });
    it(`Test invalid true false validation for ALLOW_SELF_SIGNED_SSL_CERTS`, async () => {
        let test_msg = {
            "operation": "configure_cluster",
            "ALLOW_SELF_SIGNED_SSL_CERTS": 1234
        };
        let result = undefined;
        try {
            result = await cluster_utils.configureCluster(test_msg);
        } catch(err) {
            result = err;
        }
        assert.strictEqual(result instanceof Error, true, 'Expected error');
    });
    it(`Test nominal test for NODE_NAME, all numbers`, async () => {
        let test_msg = {
            "operation": "configure_cluster",
            "NODE_NAME": 12314123123
        };
        let result = await cluster_utils.configureCluster(test_msg);
        assert.strictEqual(result, CONFIGURE_SUCCESS_RESPONSE, 'Expected success message');
    });
    it(`Test nominal test for NODE_NAME, mix of numbers, chars`, async () => {
        let test_msg = {
            "operation": "configure_cluster",
            "NODE_NAME": "1231412de213"
        };
        let result = await cluster_utils.configureCluster(test_msg);
        assert.strictEqual(result, CONFIGURE_SUCCESS_RESPONSE, 'Expected success message');
    });
    it(`Test nominal test lower case field being replaced with upper case`, async () => {
        let field_name = "node_name";
        let test_msg = {
            "operation": "configure_cluster",
            "node_name": "1231412de213"
        };
        let result = await cluster_utils.configureCluster(test_msg);
        assert.strictEqual(result, CONFIGURE_SUCCESS_RESPONSE, 'Expected success message');
        assert.strictEqual(test_msg[field_name], undefined, 'expected lower case field to be deleted');
        assert.strictEqual(test_msg[field_name.toUpperCase()], "1231412de213", 'expected lower case field to be deleted');
    });
    it(`Test nominal test mix of lower and upper case field being replaced with upper case`, async () => {
        let field_name = "nodE_nAme";
        let test_msg = {
            "operation": "configure_cluster",
            "nodE_nAme": "1231412de213"
        };
        let result = await cluster_utils.configureCluster(test_msg);
        assert.strictEqual(result, CONFIGURE_SUCCESS_RESPONSE, 'Expected success message');
        assert.strictEqual(test_msg[field_name], undefined, 'expected lower case field to be deleted');
        assert.strictEqual(test_msg[field_name.toUpperCase()], "1231412de213", 'expected lower case field to be deleted');
    });
});