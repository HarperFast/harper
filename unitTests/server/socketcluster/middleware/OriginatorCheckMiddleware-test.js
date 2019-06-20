"use strict";

const test_util = require('../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const OriginatorCheckMiddleware = require('../../../../server/socketcluster/middleware/OriginatorCheckMiddleware');
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
        test_instance = new OriginatorCheckMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, null);
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
        let instance = new OriginatorCheckMiddleware(null, () => {});

        assert.equal(instance.type, types.PREMADE_MIDDLEWARE_TYPES.ORIGINATOR);
    });
    it('test eval_function is defined.', () => {
        let result = undefined;
        let instance = new OriginatorCheckMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, null);

        assert.notEqual(instance.eval_function.name, 'undef', 'expected default function assignment');
    });
});

describe('Test AuthMiddleware eval_function', function() {
    let test_instance = undefined;
    let sandbox = sinon.createSandbox();
    let next_stub = sinon.stub().returns();
    beforeEach(() => {
        test_instance = new OriginatorCheckMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {
            console.log('Middleware!');
        });
    });
    afterEach(() => {
        test_instance = undefined;
        sandbox.restore();
    });
   it('Test evalFunction nominal', () => {
       let request = test_util.deepClone(TEST_REQUEST);
       request.data[ORIGINATOR_NAME] = ORIGINATOR;
       request.socket.id = 'some other guy';
        let result = test_instance.eval_function(request, next_stub);
        assert.notEqual(next_stub.calledOnce, true, 'next should never be called by MiddlewareIF types');
        assert.notEqual(result, false, 'expected no false return');
   });
    it('Test evalFunction match originator', () => {
        let request = test_util.deepClone(TEST_REQUEST);
        request.data[ORIGINATOR_NAME] = ORIGINATOR;
        request.socket.id = ORIGINATOR;
        let result = test_instance.eval_function(request, next_stub);
        assert.notEqual(next_stub.calledOnce, true, 'next should never be called by MiddlewareIF types');
        assert.equal(result, types.ERROR_CODES.MIDDLEWARE_SWALLOW, 'expected swallow message');
    });
    it('Test evalFunction throws exception', () => {
        let request = test_util.deepClone(TEST_REQUEST);
        request.data = null;
        request.socket.id = ORIGINATOR;
        let result = test_instance.eval_function(request, next_stub);
        assert.notEqual(next_stub.calledOnce, true, 'next should never be called by MiddlewareIF types');
        assert.equal(result, types.ERROR_CODES.MIDDLEWARE_ERROR, 'expected swallow message');
    });
});