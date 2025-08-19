const { describe, it, before } = require('mocha');
const { expect } = require('chai');
const ul = require('../../resources/usageLicensing.ts');
const { generateValidLicensePayload, signTestLicense } = require('../testLicenseUtils.js');
const { getMockLMDBPath } = require('../test_utils.js');
const env = require('../../utility/environment/environmentManager.js');
const terms = require('../../utility/hdbTerms.ts');

describe('recordUsage', () => {
	before(() => {
		getMockLMDBPath();
		env.setProperty(terms.CONFIG_PARAMS.LICENSE_REGION, 'test');
	});

	it('should record CPU usage from analytics object into valid license', async () => {
		const license = generateValidLicensePayload();
		await ul.installUsageLicenseOp({ operation: 'install_usage_license', license: signTestLicense(license) });
		const analytics = [
			{
				metric: 'db-read',
				count: 42,
				mean: 2,
			},
			{
				metric: 'db-write',
				count: 43,
				mean: 3,
			},
			{
				metric: 'db-message',
				count: 44,
				mean: 4,
			},
			{
				metric: 'cpu-usage',
				path: 'user',
				mean: 6,
				count: 7,
			},
		];

		await ul.recordUsage(analytics);
		// give the transaction time to settle; TODO: Is there a better way to do this?
		await new Promise((resolve) => setTimeout(resolve, 100));

		const licenses = ul.getUsageLicensesOp({ operation: 'get_usage_licenses' });
		let licenseWithUsage;
		for await (const l of licenses) {
			if (l.id === license.id) {
				licenseWithUsage = l;
				break;
			}
		}

		expect(licenseWithUsage).to.not.be.undefined;
		expect(licenseWithUsage.usedReads).to.equal(42);
		expect(licenseWithUsage.usedReadBytes).to.equal(84);
		expect(licenseWithUsage.usedWrites).to.equal(43);
		expect(licenseWithUsage.usedWriteBytes).to.equal(129);
		expect(licenseWithUsage.usedRealTimeMessages).to.equal(44);
		expect(licenseWithUsage.usedRealTimeBytes).to.equal(176);
		expect(licenseWithUsage.usedCpuTime).to.equal(42);
	});
});
