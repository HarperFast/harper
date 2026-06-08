'use strict';

const chai = require('chai');
const { expect } = chai;

const directivesController = require('#src/upgrade/directives/directivesController');
const { UpgradeObject } = require('#src/upgrade/UpgradeObjects');

// Regression coverage for the hdb_deployment upgrade-path bug: the deployment-recorder
// feature ships in 5.1.0 and depends on system.hdb_deployment, but its table-creation
// directive was mis-tagged 5.2.0. Because directives only run when
// current_version < directive_version <= upgrade_version, a 5.2.0-tagged directive is
// filtered out of every 5.0.x -> 5.1.x upgrade, so the table is never created and
// replicated deploy_component fails on peer nodes. These tests pin the directive to the
// release that actually ships the dependent code.
describe('directivesController — hdb_deployment table-creation directive', () => {
	it('runs on the 5.0.x -> 5.1.0 GA upgrade path', () => {
		const versions = directivesController.getVersionsForUpgrade(new UpgradeObject('5.0.22', '5.1.0'));
		expect(versions).to.include('5.1.0');
	});

	it('runs on the 5.0.x -> 5.1.0-beta.1 upgrade path (the reported failure)', () => {
		const versions = directivesController.getVersionsForUpgrade(new UpgradeObject('5.0.22', '5.1.0-beta.1'));
		expect(versions).to.include('5.1.0');
	});

	it('is not mis-tagged for a later release that would skip the 5.1 upgrade path', () => {
		const versions = directivesController.getVersionsForUpgrade(new UpgradeObject('5.0.22', '5.1.0'));
		expect(versions).to.not.include('5.2.0');
		expect(directivesController.getSortedVersions()).to.not.include('5.2.0');
	});

	it('registers a directive for 5.1.0 that provisions the table', () => {
		const directive = directivesController.getDirectiveByVersion('5.1.0');
		expect(directive, 'expected a directive registered for version 5.1.0').to.exist;
		expect(directive.version).to.equal('5.1.0');
		expect(directive.async_functions).to.be.an('array').that.is.not.empty;
		expect(directive.async_functions[0].name).to.equal('createHdbDeploymentIfMissing');
	});

	it('does not run when the install is already at or past the directive version', () => {
		// A 5.1.x install upgrading within 5.1 should not re-run the table creation.
		const versions = directivesController.getVersionsForUpgrade(new UpgradeObject('5.1.0', '5.1.3'));
		expect(versions).to.not.include('5.1.0');
	});
});
