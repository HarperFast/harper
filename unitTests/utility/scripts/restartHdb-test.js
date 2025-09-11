'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const rewire = require('rewire');
const pm2_utils = require('../../../utility/processManagement/processManagement');

describe.skip('Test restartHdb scripts', () => {
	const sandbox = sinon.createSandbox();
	let reload_stub;
	let delete_stub;
	let process_meta_fake = [{ pm_id: 1 }, { pm_id: 2 }];

	before(() => {
		sandbox.stub(pm2_utils, 'describe').resolves(process_meta_fake);
		reload_stub = sandbox.stub(pm2_utils, 'reload');
		delete_stub = sandbox.stub(pm2_utils, 'deleteProcess');
	});

	after(() => {
		sandbox.restore();
	});

	it('Test reload and then delete are called as expected', async () => {
		await rewire('../../../utility/scripts/restartHdb');
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(reload_stub.getCall(0).args[0]).to.equal(1);
		expect(reload_stub.getCall(1).args[0]).to.equal(2);
		expect(delete_stub.getCall(0).args[0]).to.equal('Restart HDB');
	});
});
