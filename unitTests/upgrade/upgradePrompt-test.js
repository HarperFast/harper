'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;

const mock_stdin = require('mock-stdin');

const prompt = require('prompt');
const os = require('os');
const upgradePrompt = require('../../upgrade/upgradePrompt');

function buildProcessUpgradeArgs(yes_or_no) {
	return ['--CONFIRM_UPGRADE', yes_or_no];
}

function buildProcessDowngradeArgs(yes_or_no) {
	return ['--CONFIRM_DOWNGRADE', yes_or_no];
}

describe('Test upgradePrompt module', () => {
	let sandbox;
	let prompt_spy;
	let stdin_stubber;

	before(() => {
		sandbox = sinon.createSandbox();
		prompt_spy = sandbox.spy(prompt, 'get');
		stdin_stubber = mock_stdin.stdin();
	});

	after(() => {
		sandbox.restore();
		stdin_stubber.restore();
	});

	it('Should return true if user enters "yes"', async () => {
		process.nextTick(() => {
			stdin_stubber.send(`yes${os.EOL}`);
		});
		const result = await upgradePrompt.forceUpdatePrompt({});
		expect(result).to.be.true;
	});

	it('Should return false if user enters "no"', async () => {
		process.nextTick(() => {
			stdin_stubber.send(`no${os.EOL}`);
		});
		const result = await upgradePrompt.forceUpdatePrompt({});
		expect(result).to.be.false;
	});

	it('Should return true if "yes" passed as process arg', async () => {
		process.argv.push(...buildProcessUpgradeArgs('yes'));
		const result = await upgradePrompt.forceUpdatePrompt({});
		expect(result).to.be.true;
	});

	it('Should return false if "no" passed as process arg', async () => {
		process.argv.push(...buildProcessUpgradeArgs('no'));
		const result = await upgradePrompt.forceUpdatePrompt({});
		expect(result).to.be.false;
	});

	it('Downgrade should return true if user enters "yes"', async () => {
		process.nextTick(() => {
			stdin_stubber.send(`yes${os.EOL}`);
		});
		const result = await upgradePrompt.forceDowngradePrompt({});
		expect(result).to.be.true;
	});

	it('Downgrade should return false if user enters "no"', async () => {
		process.nextTick(() => {
			stdin_stubber.send(`no${os.EOL}`);
		});
		const result = await upgradePrompt.forceDowngradePrompt({});
		expect(result).to.be.false;
	});

	it('Downgrade should return true if "yes" passed as process arg', async () => {
		process.argv.push(...buildProcessDowngradeArgs('yes'));
		const result = await upgradePrompt.forceDowngradePrompt({});
		expect(result).to.be.true;
	});

	it('Downgrade should return false if "no" passed as process arg', async () => {
		process.argv.push(...buildProcessDowngradeArgs('no'));
		const result = await upgradePrompt.forceDowngradePrompt({});
		expect(result).to.be.false;
	});
});
