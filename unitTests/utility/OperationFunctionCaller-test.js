"use strict";
// LEAVING THESE IN AND COMMENTED OUT TO FACILITATE FIXING CORE-471.  When these are uncommented, mocha will hang
// after the tests complete.  The tests will hang even if we only import test_utils, preTestPrep does not need to be invoked.
//const test_utils = require('../test_utils');
//test_utils.preTestPrep();
const assert = require('assert');
const op_func_caller = require('../../utility/OperationFunctionCaller');
const sinon = require('sinon');
const {promisify} = require('util');

class TestInputObject {
    constructor() {
        this.was_run = false;
        this.followup_run = false;
    }
}

function test_function_as_callback(input, callback) {
    input.was_run = true;
    callback(null, input);
}

const p_test_function = promisify(test_function_as_callback);

async function followup_function(input) {
    input.followup_run = true;
    return input;
}

describe(`Test callOperationFunctionAsCallback`, function () {
    it('Nominal with no followup function, expect pass', function (done) {
        let test_input = new TestInputObject();
        op_func_caller.callOperationFunctionAsCallback(test_function_as_callback, test_input, null).then((result) => {
            assert.strictEqual(result.was_run, true);
            done();
        });
    });

    it('Nominal with followup function, expect pass', function () {
        let test_input = new TestInputObject();
        op_func_caller.callOperationFunctionAsCallback(test_function_as_callback, test_input, followup_function).then((result) => {
            assert.strictEqual(result.was_run, true);
            assert.strictEqual(result.followup_run, true);
        });
    });

    it('Error in test function, expect exception & followup not run', function (done) {
        let test_func_exception = function (input, callback) {
            throw new Error('This is bad!');
        };
        let test_input = new TestInputObject();
        let res = undefined;
        op_func_caller.callOperationFunctionAsCallback(test_func_exception, test_input, followup_function).then((result) => {
            res = result;
        }).catch((err) => {
            res = err;
        }).finally(() => {
            assert.strictEqual((res instanceof Error), true);
            assert.strictEqual(test_input.followup_run, false);
            done();
        });
    });

    it('Error in followup function, expect exception & was_run to be true', function (done) {
        let followup_func_exception = async function (input) {
            throw new Error('This is bad!');
        };
        let test_input = new TestInputObject();
        let res = undefined;
        op_func_caller.callOperationFunctionAsCallback(test_function_as_callback, test_input, followup_func_exception).then((result) => {
            res = result;
        }).catch((err) => {
            res = err;
        }).finally(() => {
            assert.strictEqual((res instanceof Error), true);
            assert.strictEqual(test_input.followup_run, false);
            assert.strictEqual(test_input.was_run, true);
            done();
        });
    });

    it('Pass invalid function, expect exception', function (done) {
        let test_input = new TestInputObject();
        let res = undefined;
        op_func_caller.callOperationFunctionAsCallback(null, test_input, null).then((result) => {
            res = result;
        }).catch((err) => {
            res = err;
        }).finally(() => {
            assert.strictEqual((res instanceof Error), true);
            assert.strictEqual(test_input.followup_run, false);
            assert.strictEqual(test_input.was_run, false);
            done();
        });
    });

    it('Pass variable instead of function, expect exception', function (done) {
        let not_a_function = 'blah blah';
        let test_input = new TestInputObject();
        let res = undefined;
        op_func_caller.callOperationFunctionAsCallback(not_a_function, test_input, null).then((result) => {
            res = result;
        }).catch((err) => {
            res = err;
        }).finally(() => {
            assert.strictEqual((res instanceof Error), true);
            assert.strictEqual(test_input.followup_run, false);
            assert.strictEqual(test_input.was_run, false);
            done();
        });
    });
});

describe(`Test callOperationFunctionAsAwait`, function () {
    it('Nominal with no followup function, expect pass', async function () {
        let test_input = new TestInputObject();
        let result = await op_func_caller.callOperationFunctionAsAwait(p_test_function, test_input, null);
        assert.strictEqual(result.was_run, true);
        assert.strictEqual(result.followup_run, false);
        return true;
    });

    it('Nominal with followup function, expect pass', async function () {
        let test_input = new TestInputObject();
        let result = await op_func_caller.callOperationFunctionAsAwait(p_test_function, test_input, followup_function);
        assert.strictEqual(result.was_run, true);
        assert.strictEqual(result.followup_run, true);
    });

    it('Error in test function, expect exception & followup not run', async function () {
        let test_func_exception = async function (input) {
            throw new Error('This is bad!');
        };
        let test_input = new TestInputObject();
        let res = undefined;
        try {
            res = await op_func_caller.callOperationFunctionAsAwait(test_func_exception, test_input, followup_function);
        } catch(err) {
            res = err;
        } finally {
            assert.strictEqual((res instanceof Error), true);
            assert.strictEqual(test_input.followup_run, false);
        }
    });

    it('Error in followup function, expect exception & was_run to be true', async function () {
        let followup_func_exception = async function (input) {
            throw new Error('This is bad!');
        };
        let test_input = new TestInputObject();
        let res = undefined;
        try {
            res = await op_func_caller.callOperationFunctionAsAwait(p_test_function, test_input, followup_func_exception);
        } catch(err) {
            res = err;
        } finally {
            assert.strictEqual((res instanceof Error), true);
            assert.strictEqual(test_input.followup_run, false);
            assert.strictEqual(test_input.was_run, true);
        }
    });

    it('Pass invalid function, expect exception', async function () {
        let test_input = new TestInputObject();
        let res = undefined;
        try {
            res = await op_func_caller.callOperationFunctionAsAwait(null, test_input, null);
        } catch(err) {
            res = err;
        } finally {
            assert.strictEqual((res instanceof Error), true);
            assert.strictEqual(test_input.followup_run, false);
            assert.strictEqual(test_input.was_run, false);
        }
    });

    it('Pass variable instead of function, expect exception', async function () {
        let not_a_function = 'blah blah';
        let test_input = new TestInputObject();
        let res = undefined;
        try {
            res = await op_func_caller.callOperationFunctionAsAwait(not_a_function, test_input, null);
        } catch(err) {
            res = err;
        } finally {
            assert.strictEqual((res instanceof Error), true);
            assert.strictEqual(test_input.followup_run, false);
            assert.strictEqual(test_input.was_run, false);
        }
    });
});