"use strict";

const test_util = require('../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const MiddlewareIF = require('../../../../server/socketcluster/middleware/MiddlewareIF');
const types = require('../../../../server/socketcluster/types');

describe('Test MiddlewareIF', function() {
    let test_instance = undefined;
    let sandbox = sinon.createSandbox();

    beforeEach(() => {
        test_instance = new MiddlewareIF(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {
            console.log('Middleware!');
        });
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
        let instance = new MiddlewareIF(null, () => {});

        assert.equal(instance.middleware_type, types.MIDDLEWARE_TYPE.MIDDLEWARE_SUBSCRIBE);
    });
    it('test constructor missing function', () => {
        let result = undefined;
        let instance = new MiddlewareIF(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, null);

        assert.equal(instance.eval_function.name, 'undef', 'expected default function assignment');
    });
});

describe('Test setMiddlewareOrder', function() {
    let test_instance = undefined;
    let sandbox = sinon.createSandbox();

    beforeEach(() => {
        test_instance = new MiddlewareIF(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {
            console.log('Middleware!');
        });
    });
    afterEach(() => {
        test_instance = undefined;
        sandbox.restore();
    });

    it('test constructor', () => {
        assert.equal(test_instance.command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'expected default command order');
        test_instance.setMiddlewareOrder(types.COMMAND_EVAL_ORDER_ENUM.VERY_FIRST);
        assert.equal(test_instance.command_order, types.COMMAND_EVAL_ORDER_ENUM.VERY_FIRST, 'expected very first command order');
    });
    it('test setting to null', () => {
        assert.equal(test_instance.command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'expected default command order');
        test_instance.setMiddlewareOrder(null);
        assert.equal(test_instance.command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'expected very first command order');
    });
    it('test setting to string', () => {
        assert.equal(test_instance.command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'expected default command order');
        test_instance.setMiddlewareOrder('blah blah');
        assert.equal(test_instance.command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'expected very first command order');
    });
    it('test setting to our of range number', () => {
        assert.equal(test_instance.command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'expected default command order');
        test_instance.setMiddlewareOrder(7777);
        assert.equal(test_instance.command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'expected very first command order');
    });
});