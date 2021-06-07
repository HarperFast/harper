'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const hdb_utils = require('../../utility/common_utils');
const hdb_license = require('../../utility/registration/hdb_license');
const child_process = require('child_process');

function requireUncached(module) {
    delete require.cache[require.resolve(module)];
    return require(module);
}

describe('Test restartHDBServer.js', () => {
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
        sandbox.stub(hdb_license, 'licenseSearch').returns({ ram_allocation: 2048});
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
        const exe_arg = {
            "detached": true,
            "stdio": "ignore",
            "execArgv": [
                "--max-old-space-size=2048"
            ]
        };
        await requireUncached('../../server/restartHDBServer');

        expect(stop_process_stub.args[0][0]).to.include('harperdb/server/hdbServer.js');
        expect(fork_stub.args[0][0]).to.include('harperdb/server/hdbServer.js');
        expect(fork_stub.args[0][1]).to.eql([undefined]);
        expect(fork_stub.args[0][2]).to.eql(exe_arg);
        process_exit_stub.restore();
    });

    it('Error from stopProcess is handled correctly', async () => {
        const process_exit_stub = sandbox.stub(process, 'exit');
        stop_process_stub.throws(test_error);
        await requireUncached('../../server/restartHDBServer');
        stop_process_stub.resolves();
        expect(console_err_stub.getCall(0).args[0]).to.equal("Restart had an error trying to stop HDB server.");
        expect(console_err_stub.getCall(1).args[0].name).to.equal(test_error);
        process_exit_stub.restore();
    });
    
    it('Error from for is handled correctly', async () => {
        const process_exit_stub = sandbox.stub(process, 'exit');
        fork_stub.throws(test_error);
        await requireUncached('../../server/restartHDBServer');
        expect(console_err_stub.args[0][0].name).to.equal(test_error);
        process_exit_stub.restore();
    });
});