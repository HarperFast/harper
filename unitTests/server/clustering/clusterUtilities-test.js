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
const children_stopped_event = require('../../../events/AllChildrenStoppedEvent');
const hdb_logger = require('../../../utility/logging/harper_logger');
const util = require('util');

const { TEST_CLUSTER_MESSAGE_TYPE_ENUM } = test_util.COMMON_TEST_TERMS;

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
            }, /Channel invalid, channel cannot begin with reserved word: system/);
        });

        it('Pass in system table name hdb_internal, get error', () => {
            let obj = test_util.deepClone(ADD_NODE);
            let sub_obj = test_util.deepClone(SUBSCRIPTIONS_OBJECT);
            sub_obj.channel = 'hdb_internal:add_table';
            obj.subscriptions = [sub_obj];

            assert.throws(() => {
                cluster_utils_node_validation(obj);
            }, /Channel invalid, channel cannot begin with reserved word: hdb_internal/);
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
            "SERVER_PORT": "12345"
        };
        let result = await cluster_utils.configureCluster(test_msg);
        assert.strictEqual(result, CONFIGURE_SUCCESS_RESPONSE, 'Expected success message');
    });
    it(`Test http port non integer`, async () => {
        let test_msg = {
            "operation": "configure_cluster",
            "SERVER_PORT": "asdf"
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

    it(`Test nominal test for NODE_NAME, numbers strings hyphen and underscore`, async () => {
        let test_msg = {
            "operation": "configure_cluster",
            "NODE_NAME": '111-testie_23-good'
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

describe('clusterMessageHandler method', () => {
    const sandbox = sinon.createSandbox();
    const fake = () => {};
    let log_error_stub;
    let log_info_stub;
    let log_warn_stub;
    let log_debug_stub;
    let kickOffEnterprise_stub;
    let children_stopped_event_stub;
    let restartHDB_stub = sandbox.stub().callsFake(fake);
    let process_send_stub = sandbox.stub().callsFake(fake);

    const { CHILD_STARTED, CHILD_STOPPED, RESTART } = TEST_CLUSTER_MESSAGE_TYPE_ENUM;

    function generateProcessStubs(pids, start_bool = true) {
        const started_forks = {};
        const stub_processes = pids.reduce((acc, id) => {
            started_forks[id] = start_bool;
            acc.push({
                process: {
                    pid: id
                },
                send: process_send_stub
            });
            return acc;
        }, []);
        cluster_utils.__set__('started_forks', started_forks);
        return { stub_processes, started_forks };
    }

    before(() => {
        log_error_stub = sandbox.stub(hdb_logger, 'error').callsFake(fake);
        log_info_stub = sandbox.stub(hdb_logger, 'info').callsFake(fake);
        log_warn_stub = sandbox.stub(hdb_logger, 'warn').callsFake(fake);
        log_debug_stub = sandbox.stub(hdb_logger, 'debug').callsFake(fake);
        kickOffEnterprise_stub = sandbox.stub().resolves();
        children_stopped_event_stub = sandbox.stub(children_stopped_event.allChildrenStoppedEmitter, "emit").callsFake(fake);
        cluster_utils.__set__('kickOffEnterprise', kickOffEnterprise_stub);
        cluster_utils.__set__('restartHDB', restartHDB_stub);
    })

    beforeEach(() => {
        cluster_utils.__set__('child_event_count', 0);
        sandbox.resetHistory();
    })

    after(() => {
        rewire('../../../server/clustering/clusterUtilities');
        sandbox.restore();
    })

    it(`CHILD_STARTED msg - nominal - add new process id to started_forks obj`,() => {
        const test_ids = [123, 456];
        cluster_utils.__set__('child_event_count', test_ids.length);
        const test_pid = 789;
        generateProcessStubs(test_ids);
        const test_msg = {
            type: CHILD_STARTED,
            pid: test_pid
        }

        cluster_utils.clusterMessageHandler(test_msg);

        const expected_count = test_ids.length + 1;
        const test_child_event_count = cluster_utils.__get__('child_event_count');
        assert.equal(test_child_event_count, expected_count, 'Should add to child event count');
        assert.equal(log_info_stub.args[0][0], `Received ${expected_count} child started event(s).`,'Should log info msg with started child count');
        assert.ok(!kickOffEnterprise_stub.called, 'kickOffEnterprise method should not be called')
    });

    it(`CHILD_STARTED msg - nominal - add final process id to started_forks obj`,(done) => {
        const test_ids = [123, 456];
        cluster_utils.__set__('child_event_count', test_ids.length);
        const test_pid = 789;
        generateProcessStubs(test_ids);
        const test_msg = {
            type: CHILD_STARTED,
            pid: test_pid
        }
        global.forks = [...test_ids, test_pid];

        cluster_utils.clusterMessageHandler(test_msg);

        const expected_count = test_ids.length + 1;
        const test_child_event_count = cluster_utils.__get__('child_event_count');
        assert.equal(log_info_stub.args[0][0], `Received ${expected_count} child started event(s).`,'Should log info msg with final started child count');
        assert.equal(test_child_event_count, 0, 'Should reset child event count to 0');
        assert.ok(kickOffEnterprise_stub.calledOnce, 'kickOffEnterprise method should have been called once')
        //This timeout needs to be here to ensure the stubbed promise from kickOffEnterprise resolves before the log stub
        // is tested
        setTimeout(() => {
            assert.ok(log_info_stub.calledTwice, 'Clustering initiated info msg should be logged')
            assert.equal(log_info_stub.args[1][0], 'HDB server clustering initialized', 'Correct info msg logged')
            done();
        }, 5)
    });

    it(`CHILD_STARTED msg - error - log error if kickOffEnterprise throws an error`, (done) => {
        const test_ids = [123, 456];
        cluster_utils.__set__('child_event_count', test_ids.length);
        const test_pid = 789;
        generateProcessStubs(test_ids);
        const test_msg = {
            type: CHILD_STARTED,
            pid: test_pid
        }
        global.forks = [...test_ids, test_pid];

        const test_err = "This is an error"
        kickOffEnterprise_stub.rejects(test_err);

        cluster_utils.clusterMessageHandler(test_msg);

        const expected_count = test_ids.length + 1;
        const test_child_event_count = cluster_utils.__get__('child_event_count');
        assert.equal(log_info_stub.args[0][0], `Received ${expected_count} child started event(s).`,'Should log info msg with final started child count');
        assert.equal(test_child_event_count, 0, 'Should reset child event count to 0');
        assert.ok(kickOffEnterprise_stub.calledOnce, 'kickOffEnterprise method should have been called once');
        //This timeout needs to be here to ensure the stubbed promise from kickOffEnterprise resolves before the log stub
        // is tested
        setTimeout(() => {
            assert.ok(log_error_stub.calledOnce, 'Clustering initiated info msg should not be logged');
            assert.equal(log_error_stub.args[0][0], `HDB server clustering failed to start: ${test_err}`, 'Correct info msg logged');
            done();
        }, 5)
    });

    it(`CHILD_STARTED msg - error - process id already tracked in started_forks obj`,() => {
        const test_ids = [123, 456, 789];
        cluster_utils.__with__('started_forks', generateProcessStubs(test_ids));
        const test_msg = {
            type: CHILD_STARTED,
            pid: test_ids[0]
        }

        cluster_utils.clusterMessageHandler(test_msg);
        assert.ok(log_warn_stub.calledOnce, 'Warning should have been logged for dup process');
        assert.equal(log_warn_stub.args[0][0], `Got a duplicate child started event for pid ${test_msg.pid}`,'Dup process warning message should have been logged');
    });

    it(`CHILD_STOPPED msg - nominal - should NOT emit all children stopped msg if other processes are still running `, () => {
        const test_ids = [123, 456, 789];
        const test_started_forks = generateProcessStubs(test_ids).started_forks;
        const expected_started_forks = Object.assign({}, test_started_forks);
        const test_msg = {
            type: CHILD_STOPPED,
            pid: test_ids[0]
        }

        cluster_utils.clusterMessageHandler(test_msg);

        const expected_count = 1;
        const test_child_event_count = cluster_utils.__get__('child_event_count');
        assert.ok(log_info_stub.calledTwice, 'Log info should be called twice')
        assert.equal(log_info_stub.args[0][0], `Received ${expected_count} child stopped event(s).`,'Should log info msg with stopped child count');
        assert.equal(log_info_stub.args[1][0], `started forks: ${util.inspect(expected_started_forks)}`, 'Correct info msg logged')
        assert.equal(test_child_event_count, 1, 'Should NOT reset child event count to 0');
        assert.ok(!children_stopped_event_stub.called, 'children_stopped_event msg should not be emitted')
    });

    it(`Child Stopped msg - nominal - pid from message is final process to stop`,() => {
        const test_ids = [123, 456, 789];
        const test_pid = test_ids[2]
        const test_started_forks = generateProcessStubs(test_ids, false).started_forks
        test_started_forks[test_pid] = true;
        const expected_started_forks = Object.assign({}, test_started_forks);
        cluster_utils.__set__('child_event_count', test_ids.length - 1);
        const test_msg = {
            type: CHILD_STOPPED,
            pid: test_pid
        }

        cluster_utils.clusterMessageHandler(test_msg);

        const expected_count = test_ids.length;
        const test_child_event_count = cluster_utils.__get__('child_event_count');
        assert.ok(log_info_stub.calledTwice, 'Log info should be called twice')
        assert.equal(log_info_stub.args[0][0], `Received ${expected_count} child stopped event(s).`,'Should log info msg with stopped child count');
        assert.equal(log_info_stub.args[1][0], `started forks: ${util.inspect(expected_started_forks)}`, 'Correct info msg logged')
        assert.equal(test_child_event_count, 0, 'Should reset child event count to 0');
        assert.ok(children_stopped_event_stub.called, 'children_stopped_event msg should be emitted')
    });

    it(`Child Stopped msg - error - pid from message has false value in started_forks obj `,() => {
        const test_ids = [123, 456, 789];
        const test_pid = test_ids[2]
        generateProcessStubs(test_ids, false);
        const test_msg = {
            type: CHILD_STOPPED,
            pid: test_pid
        }

        cluster_utils.clusterMessageHandler(test_msg);

        const test_child_event_count = cluster_utils.__get__('child_event_count');
        assert.ok(log_warn_stub.calledOnce, 'Log warning should be called')
        assert.equal(log_warn_stub.args[0][0], `Got a duplicate child started event for pid ${test_pid}`,'Should log warning msg');
        assert.ok(!log_info_stub.called, 'Log info should not be called')
        assert.equal(test_child_event_count, 0, 'Should NOT be updated/added to');
        assert.ok(!children_stopped_event_stub.called, 'children_stopped_event msg should not be emitted')
    });

    it(`RESTART msg - nominal - soft shutdown w/ no forced_shutdown value`,() => {
        const test_ids = [123, 456, 789];
        const test_forks = generateProcessStubs(test_ids).stub_processes;
        global.forks = test_forks;
        const test_msg = {
            type: RESTART
        }

        cluster_utils.clusterMessageHandler(test_msg);

        assert.ok(log_info_stub.calledTwice, 'Log info should be called twice')
        assert.equal(log_info_stub.args[0][0], 'Received restart event.','Should log info msg about restart');
        assert.equal(log_info_stub.args[1][0], `Shutting down ${test_forks.length} process.`,'Should log info msg about # of processes to shutdown');
        assert.ok(log_debug_stub.calledThrice, 'Log debug should be called for each process')
        test_ids.forEach((pid, i) => {
            assert.equal(log_debug_stub.args[i][0], `Sending SIGTSTP signal to process with pid:${pid}`);
        })
        process_send_stub.args.forEach(arg => {
            assert.deepEqual(arg[0], test_msg);
        })
        assert.ok(!restartHDB_stub.called, 'restartHDB method should not be called')
    });

    it(`RESTART msg - nominal - soft shutdown w/ forced_shutdown value`,() => {
        const test_ids = [123, 456, 789];
        const test_forks = generateProcessStubs(test_ids).stub_processes;
        global.forks = test_forks;
        const test_msg = {
            type: RESTART,
            force_shutdown: false
        }

        cluster_utils.clusterMessageHandler(test_msg);

        assert.ok(log_info_stub.calledTwice, 'Log info should be called twice')
        assert.equal(log_info_stub.args[0][0], 'Received restart event.','Should log info msg about restart');
        assert.equal(log_info_stub.args[1][0], `Shutting down ${test_forks.length} process.`,'Should log info msg about # of processes to shutdown');
        assert.ok(log_debug_stub.calledThrice, 'Log debug should be called for each process')
        test_ids.forEach((pid, i) => {
            assert.equal(log_debug_stub.args[i][0], `Sending SIGTSTP signal to process with pid:${pid}`);
        })
        assert.ok(process_send_stub.calledThrice, 'Restart msg should be sent to each process')
        process_send_stub.args.forEach(arg => {
            assert.deepEqual(arg[0], test_msg);
        })
        assert.ok(!restartHDB_stub.called, 'restartHDB method should not be called')
    });

    it(`RESTART msg - nominal - forced shutdown`,() => {
        const test_ids = [123, 456, 789];
        const test_forks = generateProcessStubs(test_ids).stub_processes;
        global.forks = test_forks;
        const test_msg = {
            type: RESTART,
            force_shutdown: true
        }

        cluster_utils.clusterMessageHandler(test_msg);

        assert.ok(log_info_stub.calledThrice, 'Log info should be called 3 times')
        assert.equal(log_info_stub.args[0][0], 'Received restart event.','Should log info msg about restart');
        assert.equal(log_info_stub.args[1][0], `Shutting down ${test_forks.length} process.`,'Should log info msg about # of processes to shutdown');
        assert.equal(log_info_stub.args[2][0], 'Force shutting down processes.','Should log info msg about force shutdown');
        assert.ok(!log_debug_stub.called, 'Log debug should NOT be called')
        assert.ok(restartHDB_stub.calledOnce, 'restartHDB method should be called')
    });

    it(`RESTART msg - force shutdown with no forks set in global`,() => {
        global.forks = undefined;
        const test_msg = {
            type: RESTART,
            forced_shutdown: true
        }

        cluster_utils.clusterMessageHandler(test_msg);

        assert.ok(log_info_stub.calledTwice, 'Log info should be called 2 times')
        assert.equal(log_info_stub.args[0][0], 'Received restart event.','Should log info msg about restart');
        assert.equal(log_info_stub.args[1][0], 'No processes found','Should log info msg that no processes found');
        assert.ok(!log_debug_stub.called, 'Log debug should NOT be called')
        assert.ok(!restartHDB_stub.calledOnce, 'restartHDB method should NOT be called')
    });

    it(`RESTART msg - soft shutdown with no forks set in global`,() => {
        global.forks = undefined;
        const test_msg = {
            type: RESTART,
            force_shutdown: false
        }

        cluster_utils.clusterMessageHandler(test_msg);

        assert.ok(log_info_stub.calledTwice, 'Log info should be called 2 times')
        assert.equal(log_info_stub.args[0][0], 'Received restart event.','Should log info msg about restart');
        assert.equal(log_info_stub.args[1][0], 'No processes found','Should log info msg that no processes found');
        assert.ok(!log_debug_stub.called, 'Log debug should NOT be called')
        assert.ok(!process_send_stub.called, 'process.send should not be called')
        assert.ok(!restartHDB_stub.called, 'restartHDB method should NOT be called')
    });

    it(`RESTART msg - error - process.send error is caught`,() => {
        const test_ids = [123, 456, 789];
        const test_err = 'This is an error!';
        process_send_stub.throws(test_err);
        const test_forks = generateProcessStubs(test_ids).stub_processes;
        global.forks = test_forks;
        const test_msg = {
            type: RESTART,
            force_shutdown: false
        }

        cluster_utils.clusterMessageHandler(test_msg);

        assert.ok(log_info_stub.calledTwice, 'Log info should be called twice')
        assert.equal(log_info_stub.args[0][0], 'Received restart event.','Should log info msg about restart');
        assert.equal(log_info_stub.args[1][0], `Shutting down ${test_forks.length} process.`,'Should log info msg about # of processes to shutdown');
        assert.ok(log_debug_stub.calledThrice, 'Log debug should be called for each process')
        test_ids.forEach((pid, i) => {
            assert.equal(log_debug_stub.args[i][0], `Sending SIGTSTP signal to process with pid:${pid}`);
        })
        assert.ok(process_send_stub.calledThrice, 'Restart msg should be sent to each process')
        process_send_stub.args.forEach(arg => {
            assert.deepEqual(arg[0], test_msg);
        })
        assert.ok(log_error_stub.calledThrice, 'Error from process.send() should be caught for each process')
        test_ids.forEach((pid, i) => {
            assert.equal(log_error_stub.args[i][0], `Got an error trying to send SIGTSTP to process ${pid}.`);
        })
        assert.ok(!restartHDB_stub.called, 'restartHDB method should not be called')
    });
})
