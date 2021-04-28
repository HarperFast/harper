"use strict"

const test_util = require('../test_utils');
test_util.preTestPrep();

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const rewire = require('rewire');

const mock_stdin = require('mock-stdin');

const prompt = require('prompt');
const os = require('os');

describe('Test installer module', () => {
    let sandbox;
    let prompt_spy;
    let stdin_stubber;
    let tcAgreement_rw;
    let callback_stub;
    let test_result;
    let installer_rw;
    let install_log_fake = {
        error: () => {},
        info: () => {}
    }

    before(() => {
        installer_rw = rewire('../../utility/install/installer');
        installer_rw.__set__('install_logger', install_log_fake);
        sandbox = sinon.createSandbox();
        prompt_spy = sandbox.spy(prompt, 'get');
        stdin_stubber = mock_stdin.stdin();
        tcAgreement_rw = installer_rw.__get__('termsAgreement');
        callback_stub = (err, data) => {
            test_result = {err, data};
        };
    })

    afterEach(() => {
        test_result = undefined;
        stdin_stubber.end();
        stdin_stubber.reset();
    })

    after(() => {
        sandbox.restore();
        rewire('../../utility/install/installer');
    })

    it('Should return true if user enters "yes"',() => {
        process.nextTick(() => {
            stdin_stubber.send(`yes${os.EOL}`);
        })
        tcAgreement_rw(callback_stub);
        process.nextTick(() => {
            expect(test_result.err).to.be.null;
            expect(test_result.data).to.be.true;
        })
    })

    it('Should return false if user enters "no"',() => {
        process.nextTick(() => {
            stdin_stubber.send(`no${os.EOL}`);
        })
        tcAgreement_rw(callback_stub);
        process.nextTick(() => {
            expect(test_result.err).to.equal('REFUSED');
            expect(test_result.data).to.be.false;
        })
    })

    it('Should return false if user enters "YES"',() => {
        process.nextTick(() => {
            stdin_stubber.send(`YES${os.EOL}`);
        })
        tcAgreement_rw(callback_stub);
        process.nextTick(() => {
            expect(test_result.err).to.equal('REFUSED');
            expect(test_result.data).to.be.false;
        })
    })

    it('Should return false if user enters "y"',() => {
        process.nextTick(() => {
            stdin_stubber.send(`y${os.EOL}`);
        })
        tcAgreement_rw(callback_stub);
        process.nextTick(() => {
            expect(test_result.err).to.equal('REFUSED');
            expect(test_result.data).to.be.false;
        })
    })

    it('Should return false if user enters "Yes"',() => {
        process.nextTick(() => {
            stdin_stubber.send(`Yes${os.EOL}`);
        })
        tcAgreement_rw(callback_stub);
        process.nextTick(() => {
            expect(test_result.err).to.equal('REFUSED');
            expect(test_result.data).to.be.false;
        })
    })
})
