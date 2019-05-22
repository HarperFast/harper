"use strict";

const test_util = require('../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const RequestDataValidMiddleware = require('../../../../server/socketcluster/middleware/RequestDataValidMiddleware');
const types = require('../../../../server/socketcluster/types');

const ROOM_NAME = 'dev.tester';
const WORKER_NAME = 'asdfesd';
const INTERNAL_ROOM_NAME = `internal:${WORKER_NAME}`;

const ORIGINATOR = 'ItsFromMe!';
const ORIGINATOR_NAME = '__originator';

const TEST_REQUEST = {
    channel: ROOM_NAME,
    data: {},
    hdb_header: {},
    socket: {}
};

describe('Test AuthMiddleware', function() {
    let test_instance = undefined;
    let sandbox = sinon.createSandbox();

    beforeEach(() => {
        test_instance = new RequestDataValidMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, null);
    });
    afterEach(() => {
        test_instance = undefined;
        sandbox.restore();
    });

    it('test constructor', () => {
        assert.notEqual(test_instance.id, undefined, 'expected id');
        assert.equal(test_instance.command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'expected default command order');
    });
    it('test constructor missing type', () => {
        let result = undefined;
        let instance = new RequestDataValidMiddleware(null, () => {});

        assert.equal(instance.middleware_type, types.MIDDLEWARE_TYPE.MIDDLEWARE_SUBSCRIBE);
    });
    it('test eval_function is defined.', () => {
        let result = undefined;
        let instance = new RequestDataValidMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, null);

        assert.notEqual(instance.eval_function.name, 'undef', 'expected default function assignment');
    });
});

describe('Test AuthMiddleware eval_function', function() {
    let test_instance = undefined;
    let sandbox = sinon.createSandbox();
    let next_stub = sinon.stub().returns();
    beforeEach(() => {
        test_instance = new RequestDataValidMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {
            console.log('Middleware!');
        });
    });
    afterEach(() => {
        test_instance = undefined;
        sandbox.restore();
    });
   it('Test evalFunction nominal', () => {
       let request = test_util.deepClone(TEST_REQUEST);
        let result = test_instance.eval_function(request, next_stub);
        assert.notEqual(next_stub.calledOnce, true, 'next should never be called by MiddlewareIF types');
        assert.notEqual(result, false, 'expected no false return');
   });
    it('Test evalFunction invalid data', () => {
        let request = test_util.deepClone(TEST_REQUEST);
        request.data = undefined;
        let result = test_instance.eval_function(request, next_stub);
        assert.notEqual(next_stub.calledOnce, true, 'next should never be called by MiddlewareIF types');
        assert.equal(result, types.ERROR_CODES.MIDDLEWARE_SWALLOW, 'expected swallow code');
    });
    it('Test evalFunction invalid request', () => {
        let request = test_util.deepClone(TEST_REQUEST);
        request = null;
        let result = test_instance.eval_function(request, next_stub);
        assert.notEqual(next_stub.calledOnce, true, 'next should never be called by MiddlewareIF types');
        assert.equal(result, types.ERROR_CODES.MIDDLEWARE_ERROR, 'expected swallow code');
    });
});