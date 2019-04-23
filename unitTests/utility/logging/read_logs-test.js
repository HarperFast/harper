// 'use strict';
//
// const test_utils = require('../../test_utils');
// test_utils.preTestPrep();
// const assert = require('assert');
// const sinon = require('sinon');
//
// const moment = require('moment');
// const basic_winston = require('winston');
// const winston = require('../../../utility/logging/winston_logger');
// const rewire = require('rewire');
// const read_logs = rewire('../../../utility/logging/read_logs');
// const validator = require('../../../validation/validationWrapper');
//
//
// const DEFAULT_WINSTON_OPTIONS = {
//     fields: ['level','message','timestamp'],
//     limit: 100
// }
//
// const TEST_READ_LOG_OBJECT = {
//     "operation": "read_log",
//     "from": "2017-07-10",
//     "until": "2019-07-11",
//     "limit": "1000",
//     "start": "0",
//     "order": "desc",
//     "level": "error"
// }
//
// describe("Test read_logs", function() {
//     let testReadLogObj;
//     let callbackSpy;
//     let winstonSpy;
//     let validatorStub;
//
//     before(function() {
//         callbackSpy = sinon.spy();
//         winstonSpy = sinon.spy(winston, "query");
//         validatorStub = sinon.stub(validator, "validateObject");
//     })
//
//     beforeEach(function() {
//         callbackSpy.resetHistory();
//         winstonSpy.resetHistory();
//         validatorStub.returns(null);
//
//         testReadLogObj = JSON.parse(JSON.stringify(TEST_READ_LOG_OBJECT));
//     });
//
//     it("Should call the query method if the validator does NOT return anything", function() {
//         read_logs.read_log(testReadLogObj, callbackSpy);
//
//         assert.strictEqual(winstonSpy.calledOnce, true);
//     });
//
//     it("Should call the callback method with the data returned from the validator if returned", function() {
//         const TEST_VALIDATOR_DATA = "Validator return data"
//         validatorStub.returns(TEST_VALIDATOR_DATA);
//
//         read_logs.read_log(testReadLogObj, callbackSpy);
//
//         assert.strictEqual(callbackSpy.args[0][0], TEST_VALIDATOR_DATA);
//     });
//
//     describe("setting Winston configuration", function() {
//         let basicWinstonSpy = sinon.spy(basic_winston, "configure");
//
//         beforeEach(function() {
//             basicWinstonSpy.resetHistory();
//         });
//
//         it("Should configure a basic_winston with the file name `install_log.log` when log equals install_log ", function() {
//             testReadLogObj.log = "install_log";
//             read_logs.read_log(testReadLogObj, callbackSpy);
//
//             assert.strictEqual(basicWinstonSpy.args[0][0].transports[0].filename, 'install_log.log')
//             assert.strictEqual(basicWinstonSpy.calledOnce, true);
//         });
//
//         it("Should configure a basic_winston with the file name `run_log.log` when log equals run_log ", function() {
//             testReadLogObj.log = "run_log";
//             read_logs.read_log(testReadLogObj, callbackSpy);
//
//             assert.strictEqual(basicWinstonSpy.args[0][0].transports[0].filename, 'run_log.log')
//             assert.strictEqual(basicWinstonSpy.calledOnce, true);
//         });
//
//         it("Should configure  winston when there is no log set in the read_log_object ", function() {
//             read_logs.read_log(testReadLogObj, callbackSpy);
//
//             assert.strictEqual(winstonSpy.calledOnce, true);
//         });
//     });
//
//     describe("bones.query() 'options' parameter ", function() {
//
//         it("Should include 'fields' and 'limit' properties by default ", function() {
//             testReadLogObj.limit = null;
//             read_logs.read_log(testReadLogObj, callbackSpy);
//             const winstonOptions = winstonSpy.args[0][0];
//
//             assert.deepStrictEqual(winstonOptions.fields, DEFAULT_WINSTON_OPTIONS.fields);
//             assert.strictEqual(winstonOptions.limit, DEFAULT_WINSTON_OPTIONS.limit);
//         });
//
//         it("Should include a 'from' property with formatted date value ", function() {
//             read_logs.read_log(testReadLogObj, callbackSpy);
//             const winstonOptions = winstonSpy.args[0][0];
//
//             assert.strictEqual(winstonOptions.from.isValid(), true);
//             assert.deepStrictEqual(winstonOptions.from, moment(testReadLogObj.from));
//         });
//
//         it("Should include a 'until' property with formatted date value ", function() {
//             read_logs.read_log(testReadLogObj, callbackSpy);
//             const winstonOptions = winstonSpy.args[0][0];
//
//             assert.strictEqual(winstonOptions.until.isValid(), true);
//             assert.deepStrictEqual(winstonOptions.until, moment(testReadLogObj.until));
//         });
//
//         it("Should include a 'level' property ", function() {
//             read_logs.read_log(testReadLogObj, callbackSpy);
//             const winstonOptions = winstonSpy.args[0][0];
//
//             assert.strictEqual(winstonOptions.level, testReadLogObj.level);
//         });
//
//         it("Should include a 'limit' property ", function() {
//             read_logs.read_log(testReadLogObj, callbackSpy);
//             const winstonOptions = winstonSpy.args[0][0];
//
//             assert.strictEqual(winstonOptions.limit, testReadLogObj.limit);
//         });
//
//         it("Should include a 'order' property ", function() {
//             read_logs.read_log(testReadLogObj, callbackSpy);
//             const winstonOptions = winstonSpy.args[0][0];
//
//             assert.strictEqual(winstonOptions.order, testReadLogObj.order);
//         });
//
//         it("Should include a 'start' property ", function() {
//             read_logs.read_log(testReadLogObj, callbackSpy);
//             const winstonOptions = winstonSpy.args[0][0];
//
//             assert.strictEqual(winstonOptions.start, testReadLogObj.start);
//         });
//     });
//
//     describe("queryCallback() for bones.query", function() {
//         const queryCallback = read_logs.__get__('queryCallback');
//         const queryResults = { results: [1, 2, 3] };
//         const queryError = { error: "There was an error" };
//
//         it("Should call the callback with the results if an error value is not passed in ", function() {
//             queryCallback(null, queryResults, callbackSpy);
//
//             assert.strictEqual(callbackSpy.calledOnce, true);
//             assert.strictEqual(callbackSpy.calledWith(null, queryResults), true);
//         });
//
//         it("Should call the callback with the error if an error value is passed in ", function() {
//             queryCallback(queryError, queryResults, callbackSpy);
//
//             assert.strictEqual(callbackSpy.calledOnce, true);
//             assert.strictEqual(callbackSpy.calledWith(queryError), true);
//         });
//     });
// });
