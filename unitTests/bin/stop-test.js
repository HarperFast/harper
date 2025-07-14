'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const process_man = require('../../utility/processManagement/processManagement');
const sys_info = require('../../utility/environment/systemInformation');
const stop = require('../../bin/stop');

describe.skip('Test stop module', () => {
	const sandbox = sinon.createSandbox();
	let is_service_reg_stub;
	let get_services_list_stub;
	let process_stop_stub;
	let process_kill_stub;
	let get_hdb_process_stub;

	before(() => {
		is_service_reg_stub = sandbox.stub(process_man, 'isServiceRegistered').resolves(true);
		get_services_list_stub = sandbox.stub(process_man, 'getUniqueServicesList').resolves({ HarperDB: 1 });
		process_stop_stub = sandbox.stub(process_man, 'stop');
		process_kill_stub = sandbox.stub(process_man, 'kill');
		get_hdb_process_stub = sandbox.stub(sys_info, 'getHDBProcessInfo').resolves({ clustering: [], core: [] });
	});

	after(() => {
		sandbox.restore();
	});

	it('Test stop happy path ', async () => {
		await stop();
		expect(is_service_reg_stub.called).to.be.true;
		expect(process_stop_stub.args[0][0]).to.equal('HarperDB');
		expect(process_kill_stub.called).to.be.true;
		expect(get_hdb_process_stub.called).to.be.true;
	});
});
