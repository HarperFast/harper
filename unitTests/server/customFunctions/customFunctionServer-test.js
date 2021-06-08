'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const mock_require = require('mock-require');
const os = require('os');
const test_utils = require('../../test_utils');
const env = require('../../../utility/environment/environmentManager');

describe('Test customFunctionServer module', () => {
    const sandbox = sinon.createSandbox();
    const server_parent_stub = sandbox.stub();
    const server_child_stub = sandbox.stub();

    before(() => {
        env.initTestEnvironment();
        mock_require('../../../server/customFunctions/serverParent', server_parent_stub);
        mock_require('./../../../server/customFunctions/serverChild', server_child_stub);
    });

    after(() => {
        mock_require.stopAll();
        sandbox.restore();
    });

    afterEach(() => {
        sandbox.resetHistory();
    });

    it('Test happy path serverParent', () => {
        test_utils.requireUncached('../server/customFunctions/customFunctionServer.js');

        expect(server_parent_stub.args[0][0]).to.equal(2);
        expect(global.isMaster).to.be.true;
        expect(global.clustering_on).to.be.false;
        expect(global.running_from_repo).to.be.undefined;
    });

    it('Test num workers greater than os_cpus path', () => {
        const cpus_stub = sandbox.stub(os, 'cpus').returns([1342]);
        test_utils.requireUncached('../server/customFunctions/customFunctionServer.js');
        expect(server_parent_stub.args[0][0]).to.equal(1);
        cpus_stub.restore();
    });

    it('Test error from os.cpus is handled as expected', () => {
        const cpus_stub = sandbox.stub(os, 'cpus').throws('ugh an error');
        test_utils.requireUncached('../server/customFunctions/customFunctionServer.js');
        expect(server_parent_stub.args[0][0]).to.equal(2);
        cpus_stub.restore();
    });

    it('Test happy path serverChild', () => {
        mock_require('cluster', {isMaster: false});
        test_utils.requireUncached('../server/customFunctions/customFunctionServer.js');
        expect(server_parent_stub.notCalled).to.be.true;
        expect(server_child_stub.called).to.be.true;
    });
});