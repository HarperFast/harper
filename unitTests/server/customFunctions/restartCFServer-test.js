'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const hdb_utils = require('../../../utility/common_utils');
const test_utils = require('../../test_utils');
const child_process = require('child_process');

describe('Test restartCFServer.js', () => {
    const sandbox = sinon.createSandbox();
    const test_error = 'Test error restart HDB server';
    let stop_process_stub;
    let console_err_stub;
    let fork_stub;
    let fake_child = {
        unref: () => {}
    };

    before(() => {
        stop_process_stub = sandbox.stub(hdb_utils, 'stopProcess').resolves();
        fork_stub = sandbox.stub(child_process, 'fork').returns(fake_child);
        console_err_stub = sandbox.stub(console, 'error');
    });

    after(() => {
        sandbox.restore();
    });

    afterEach(() => {
        sandbox.resetHistory();
    });

    it('Test stop process and fork are called as expected happy path', async () => {
        const process_exit_stub = sandbox.stub(process, 'exit');
        await test_utils.requireUncached('../server/customFunctions/restartCFServer');
        expect(stop_process_stub.args[0][0]).to.include('harperdb/server/customFunctions/customFunctionServer.js');
        expect(fork_stub.args[0][0]).to.include('harperdb/server/customFunctions/customFunctionServer.js');
        expect(fork_stub.args[0][1]).to.eql([undefined]);
        process_exit_stub.restore();
    });
});