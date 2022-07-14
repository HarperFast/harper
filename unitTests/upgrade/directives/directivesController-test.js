'use strict';

const test_util = require('../../test_utils');
const { generateUpgradeObj } = test_util;
test_util.preTestPrep();

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
// const fs = require('fs');
// const hdb_utils = require('../../../../utility/common_utils');

const test_vers3_1_0 = require('./testDirectives/3-1-0_stub');
const test_vers4_1_1 = require('./testDirectives/4-1-1_stub');

const rewire = require('rewire');
const directivesController_rw = rewire('../../../upgrade/directives/directivesController');

let test_map = new Map();
test_map.set(test_vers4_1_1.version, test_vers4_1_1);
test_map.set(test_vers3_1_0.version, test_vers3_1_0);

describe('directivesController Module', () => {
	let sandbox;

	before(() => {
		sandbox = sinon.createSandbox();
	});

	beforeEach(function () {
		directivesController_rw.__set__('versions', test_map);
	});

	after(function () {
		rewire('../../../upgrade/directives/directivesController');
	});

	describe('test getSortedVersions()', function () {
		it('Test returns properly sorted array', () => {
			let sorted_versions = directivesController_rw.getSortedVersions();
			expect(sorted_versions.length).to.equal(2);
			expect(sorted_versions[0]).to.equal(test_vers3_1_0.version);
			expect(sorted_versions[1]).to.equal(test_vers4_1_1.version);
		});
	});

	describe('test getVersionsForUpgrade()', function () {
		it('Nominal case - upgrade to next version', () => {
			const test_upgrade_obj = generateUpgradeObj(test_vers3_1_0.version, test_vers4_1_1.version);
			const valid_versions = directivesController_rw.getVersionsForUpgrade(test_upgrade_obj);
			expect(valid_versions.length).to.equal(1);
			expect(valid_versions[0]).to.equal(test_vers4_1_1.version);
		});

		it('Nominal case - initial upgrade to most recent version', () => {
			const test_upgrade_obj = generateUpgradeObj('2.9.9', test_vers4_1_1.version);
			const valid_versions = directivesController_rw.getVersionsForUpgrade(test_upgrade_obj);
			expect(valid_versions.length).to.equal(2);
			expect(valid_versions[0]).to.equal(test_vers3_1_0.version);
			expect(valid_versions[1]).to.equal(test_vers4_1_1.version);
		});

		it('Test with non-existent new_version, expect 0 directives returned', () => {
			const test_upgrade_obj = generateUpgradeObj(test_vers3_1_0.version, '3.0.1');
			const valid_versions = directivesController_rw.getVersionsForUpgrade(test_upgrade_obj);
			expect(valid_versions.length).to.equal(0);
		});

		it('Test with non-existent new_version greater than an existing upgrade version, expect 1 directives returned', () => {
			const test_upgrade_obj = generateUpgradeObj(test_vers3_1_0.version, '4.1.1111');
			const valid_versions = directivesController_rw.getVersionsForUpgrade(test_upgrade_obj);
			expect(valid_versions.length).to.equal(1);
		});

		it('Test with new version but with most up-to-date data version, expect 0 directives returned', () => {
			const test_upgrade_obj = generateUpgradeObj(test_vers4_1_1.version, '5.1.1');
			const valid_versions = directivesController_rw.getVersionsForUpgrade(test_upgrade_obj);
			expect(valid_versions.length).to.equal(0);
		});

		it('Test with no data version - expect empty array returned', () => {
			const test_upgrade_obj = generateUpgradeObj(null, test_vers4_1_1.version);
			const valid_versions = directivesController_rw.getVersionsForUpgrade(test_upgrade_obj);
			expect(valid_versions.length).to.equal(0);
		});

		it('Test with no new version - expect empty array returned', () => {
			const test_upgrade_obj = generateUpgradeObj(test_vers3_1_0.version, null);
			const valid_versions = directivesController_rw.getVersionsForUpgrade(test_upgrade_obj);
			expect(valid_versions.length).to.equal(0);
		});
	});

	describe('hasUpgradesRequired()', () => {
		it('Should return true if there is a tracked upgrade directive w/ version between data/new versions', () => {
			const test_upgrade_obj = generateUpgradeObj(test_vers3_1_0.version, test_vers4_1_1.version);
			const upgrade_required = directivesController_rw.hasUpgradesRequired(test_upgrade_obj);
			expect(upgrade_required).to.be.true;
		});

		it('Should return false if there are no tracked upgrade directive w/ version between data/new versions', () => {
			const test_upgrade_obj = generateUpgradeObj(test_vers4_1_1.version, '4.2.0');
			const upgrade_required = directivesController_rw.hasUpgradesRequired(test_upgrade_obj);
			expect(upgrade_required).to.be.false;
		});

		it('Should return false if versions are the same', () => {
			const test_upgrade_obj = generateUpgradeObj(test_vers4_1_1.version, test_vers4_1_1.version);
			const upgrade_required = directivesController_rw.hasUpgradesRequired(test_upgrade_obj);
			expect(upgrade_required).to.be.false;
		});
	});

	describe('test getDirectiveByVersion()', function () {
		it('Test nominal - returns upgrade directive for valid version', () => {
			const upgrade_directive = directivesController_rw.getDirectiveByVersion(test_vers3_1_0.version);
			expect(upgrade_directive.functions).to.deep.equal(test_vers3_1_0.functions);
			expect(upgrade_directive.settings_file_function).to.deep.equal(test_vers3_1_0.settings_file_function);
		});

		it('Returns null if non-tracked version is passed in', () => {
			const upgrade_directive = directivesController_rw.getDirectiveByVersion('3.0.111');
			expect(upgrade_directive).to.be.null;
		});

		it('Returns null if no version is passed in', () => {
			const upgrade_directive = directivesController_rw.getDirectiveByVersion();
			expect(upgrade_directive).to.be.null;
		});
	});
});
