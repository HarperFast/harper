const test_util = require('../test_utils');

test_util.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');
const signal = require('../../utility/signalling');
const stop = require('../../bin/stop');

const TEST_MESSAGE = {
    operation: 'restart',
    force: false
};

describe('test restart', () => {
    let sandbox = sinon.createSandbox();
    let signal_stub = undefined;
    beforeEach( () => {

    });
    afterEach( () => {
        sandbox.restore();
    });
   it('Nominal test', async () => {
       signal_stub = sandbox.stub(signal, signal.signalRestart.name).resolves('done');
       let error = undefined;
       let result = null;
       try {
           result = await stop.restartProcesses(TEST_MESSAGE);
       } catch(err) {
           error = err;
       }
       assert.equal(result, 'Restarting HarperDB.', 'expected restart message');
       assert.equal(error, undefined, 'expected no errors back');
       assert.equal(signal_stub.called, true, 'expected signalRestart to be called.');
   });
    it('Signal throws exception', async () => {
        signal_stub = sandbox.stub(signal, signal.signalRestart.name).throws('this is bad');
        let error = undefined;
        let result = null;
        try {
            result = await stop.restartProcesses(TEST_MESSAGE);
        } catch(err) {
            error = err;
        }
        assert.equal(result.indexOf('There was an error restarting HarperDB.') > -1, true, 'expected exception');
        assert.equal(error, undefined, 'expected no errors back');
        assert.equal(signal_stub.called, true, 'expected signalRestart to be called.');
    });
});