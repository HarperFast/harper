'use strict';
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const expect = chai.expect;
const ps_list = require('../../utility/psList');
const os = require('os');
chai.use(sinon_chai);

let stop = require('../../bin/stop');
let sandbox = sinon.createSandbox();

describe('Test stop.js' , () => {
   let find_ps_stub;
   let process_kill_stub;
   let os_user_stub;
   let console_log_spy;
   let instances;

   beforeEach(() => {
       console_log_spy = sandbox.spy(console, 'log');
   });

   afterEach(() => {
       sandbox.restore();
   });

   after(() => {
       sandbox.restore();
       sandbox.resetBehavior();
       sandbox.resetHistory();

   })

    context('stop', () => {
        it('should log no instances running message', (done) => {
            instances = [];
            find_ps_stub = sandbox.stub(ps_list, 'findPs').resolves(instances);

            stop.stop((err) => {
                expect(err).to.be.null;
                expect(find_ps_stub).to.have.been.calledOnce;
                expect(console_log_spy).to.have.been.calledWith("Stopping HarperDB.");
                expect(console_log_spy).to.have.been.calledWith("No instances of HarperDB are running.");
            });

            done();
        });

        it('should kill running harperdb processes', (done) => {
            instances = [{
                    pid: 2235,
                    name: 'node',
                    cmd:'Desktop/harperdb/server/hdb_express.js',
                    ppid: 1,
                    uid: 501,
                    cpu: 0,
                    memory: 0.6 },
                {
                    pid: 2245,
                    name: 'node',
                    cmd: '/Desktop/harperdb/server/hdb_express.js',
                    ppid: 2235,
                    uid: 501,
                    cpu: 0,
                    memory: 0.6 }];
            let curr_user = { uid: 501 };

            find_ps_stub = sandbox.stub(ps_list, 'findPs').resolves(instances);
            process_kill_stub = sandbox.stub(process, 'kill');
            os_user_stub = sandbox.stub(os, 'userInfo').returns(curr_user);

            stop.stop((err) => {
                expect(find_ps_stub).to.have.been.calledOnce;
                expect(process_kill_stub).to.have.been.calledTwice;
                expect(os_user_stub).to.have.been.calledOnce;
                expect(console_log_spy).to.have.been.calledWith("Stopping HarperDB.");
                expect(err).to.be.null;
            });

            done();
        });

        it('should catch error thrown from ps_list', (done) => {
            find_ps_stub = sandbox.stub(ps_list, 'findPs').throws('catch me');

            try {
                stop.stop();
                expect(find_ps_stub).to.have.been.calledOnce;
            } catch(err) {
                expect(err.name).to.equal('catch me');
            }

            done();
        });
    });
});
