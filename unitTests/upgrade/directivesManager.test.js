'use strict';

const sinon = require('sinon');
const chai = require('chai');
const { expect } = chai;

const directivesManager = require('#src/upgrade/directivesManager');
const directivesController = require('#src/upgrade/directives/directivesController');
const { UpgradeObject } = require('#src/upgrade/UpgradeObjects');

// Coverage for the upgrade log wording: the per-migration line must describe the actual
// data -> software transition and what each migration does, rather than printing the bare
// directive version (which is the release that *introduced* the migration, not the version
// being installed — e.g. "Running upgrade for version 5.1.0" while installing 5.1.7).
describe('directivesManager.processDirectives — upgrade log output', () => {
	const sandbox = sinon.createSandbox();
	let consoleLog_stub;
	let getVersions_stub;
	let getDirective_stub;

	const fakeDirective = {
		version: '5.1.0',
		description: 'create system.hdb_deployment table for deployment tracking',
		sync_functions: [],
		async_functions: [async function noop() {}],
	};

	beforeEach(() => {
		consoleLog_stub = sandbox.stub(console, 'log').returns();
		// log.notify receives the same text as console.log; stub best-effort to keep test output quiet.
		const loggerModule = require('#src/utility/logging/harper_logger');
		const logger = loggerModule.default ?? loggerModule;
		if (typeof logger.notify === 'function') sandbox.stub(logger, 'notify').returns();
		getVersions_stub = sandbox.stub(directivesController, 'getVersionsForUpgrade');
		getDirective_stub = sandbox.stub(directivesController, 'getDirectiveByVersion');
	});

	afterEach(() => sandbox.restore());

	const loggedLines = () => consoleLog_stub.getCalls().map((call) => call.args[0]);

	it('headers with the real data -> software transition, not the directive version', async () => {
		getVersions_stub.returns(['5.1.0']);
		getDirective_stub.withArgs('5.1.0').returns(fakeDirective);

		await directivesManager.processDirectives(new UpgradeObject('5.0.22', '5.1.7'));

		const lines = loggedLines();
		const header = lines.find((line) => line.startsWith('Starting upgrade process'));
		expect(header, 'expected a header line').to.exist;
		expect(header).to.include('5.0.22');
		expect(header).to.include('5.1.7');
		// the old, misleading bare-version line must be gone
		expect(lines).to.not.include('Running upgrade for version 5.1.0');
	});

	it('describes each migration as "introduced in <version>" with its description', async () => {
		getVersions_stub.returns(['5.1.0']);
		getDirective_stub.withArgs('5.1.0').returns(fakeDirective);

		await directivesManager.processDirectives(new UpgradeObject('5.0.22', '5.1.7'));

		const line = loggedLines().find((logged) => logged.startsWith('Applying migration'));
		expect(line, 'expected an "Applying migration" line').to.exist;
		expect(line).to.include('introduced in 5.1.0');
		expect(line).to.include('create system.hdb_deployment table for deployment tracking');
	});

	it('reports when there are no migrations to apply', async () => {
		getVersions_stub.returns([]);

		await directivesManager.processDirectives(new UpgradeObject('5.1.7', '5.1.7'));

		const lines = loggedLines();
		expect(lines.some((line) => line.includes('no data migrations to apply'))).to.be.true;
		expect(getDirective_stub.called, 'no directive should be looked up when none apply').to.be.false;
	});
});
