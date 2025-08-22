const { describe, it, before } = require('mocha');
const { expect } = require('chai');
const sinon = require('sinon');
const ul = require('../../resources/usageLicensing.ts');
const vul = require('../../validation/usageLicensing.ts');
const { generateValidLicensePayload, signTestLicense } = require('../testLicenseUtils.js');
const { getMockLMDBPath } = require('../test_utils.js');
const env = require('../../utility/environment/environmentManager.js');
const terms = require('../../utility/hdbTerms.ts');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const { databases } = require('../../resources/databases');
const { isActiveLicense } = require('../../resources/usageLicensing');

async function setupTestEnv() {
	getMockLMDBPath();
	setMainIsWorker(true);
	env.setProperty(terms.CONFIG_PARAMS.LICENSE_REGION, 'test');
	await databases.system.hdb_license.delete({ conditions: [] });
	sinon.replace(vul, 'publicKey', new vul.PublicKey('test'));
}

describe('recordUsage', () => {
	before(setupTestEnv);
	after(sinon.restore);

	it('should record CPU usage from analytics object into valid license', async () => {
		const license = generateValidLicensePayload();
		await ul.installUsageLicense(signTestLicense(license));
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

		const licenses = ul.getUsageLicenses();
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

function licenseErrMsg(allLicenses, license, propName) {
	return `expected ${license[propName]} to be one of ${allLicenses.map((el) => el[propName])}`;
}

describe('getUsageLicenses', () => {
	before(setupTestEnv);
	after(sinon.restore);

	it('should return all licenses', async () => {
		const license1 = generateValidLicensePayload();
		const license2 = generateValidLicensePayload();
		const license3 = { ...generateValidLicensePayload(), expiration: new Date(Date.now() - 1000).toISOString() };
		const license4 = { ...generateValidLicensePayload(), expiration: new Date(Date.now() + 1000).toISOString() };
		const allLicenses = [license1, license2, license3, license4];

		const installations = allLicenses.map((l) =>
			ul.installUsageLicense(signTestLicense(l))
		);
		await Promise.all(installations);

		const licenses = ul.getUsageLicenses();
		let actualLicenses = new Map();
		for await (const l of licenses) {
			actualLicenses.set(l.id, l);
		}
		expect(actualLicenses.size).to.equal(allLicenses.length);
		allLicenses.forEach((license) => {
			const actualLicense = actualLicenses.get(license.id);
			expect(actualLicense.level, licenseErrMsg(allLicenses, actualLicense, 'level')).to.equal(license.level);
			expect(actualLicense.region, licenseErrMsg(allLicenses, actualLicense, 'region')).to.equal(license.region);
			expect(actualLicense.expiration, licenseErrMsg(allLicenses, actualLicense, 'expiration')).to.equal(license.expiration);
			expect(actualLicense.reads, licenseErrMsg(allLicenses, actualLicense, 'reads')).to.equal(license.reads);
			expect(actualLicense.readBytes, licenseErrMsg(allLicenses, actualLicense, 'readBytes')).to.equal(license.readBytes);
			expect(actualLicense.writes, licenseErrMsg(allLicenses, actualLicense, 'writes')).to.equal(license.writes);
			expect(actualLicense.writeBytes, licenseErrMsg(allLicenses, actualLicense, 'writeBytes')).to.equal(license.writeBytes);
			expect(actualLicense.realTimeMessages, licenseErrMsg(allLicenses, actualLicense, 'realTimeMessages')).to.equal(license.realTimeMessages);
			expect(actualLicense.realTimeBytes, licenseErrMsg(allLicenses, actualLicense, 'realTimeBytes')).to.equal(license.realTimeBytes);
			expect(actualLicense.cpuTime, licenseErrMsg(allLicenses, actualLicense, 'cpuTime')).to.equal(license.cpuTime);
			expect(actualLicense.storage, licenseErrMsg(allLicenses, actualLicense, 'storage')).to.equal(license.storage);
		});
	});

	});
});

describe('isActiveLicense', async () => {
	it('should accept a license with remaining capacity in all metrics', () => {
		const license = generateValidLicensePayload();
		expect(isActiveLicense(license)).to.be.true;
	});

	it('should reject a license with too many usedReads', () => {
		const license = generateValidLicensePayload();
		license.usedReads = license.reads;
		expect(isActiveLicense(license)).to.be.false;
	});
	it('should reject a license with too many usedReadBytes', () => {
		const license = generateValidLicensePayload();
		license.usedReadBytes = license.readBytes + 100;
		expect(isActiveLicense(license)).to.be.false;
	});
	it('should reject a license with too many usedWrites', () => {
		const license = generateValidLicensePayload();
		license.usedWrites = license.writes + 100;
		expect(isActiveLicense(license)).to.be.false;
	});
	it('should reject a license with too many usedWriteBytes', () => {
		const license = generateValidLicensePayload();
		license.usedWriteBytes = license.writeBytes;
		expect(isActiveLicense(license)).to.be.false;
	});
	it('should reject a license with too many usedRealTimeMessages', () => {
		const license = generateValidLicensePayload();
		license.usedRealTimeMessages = license.realTimeMessages + 1;
		expect(isActiveLicense(license)).to.be.false;
	});
	it('should reject a license with too many usedRealTimeBytes', () => {
		const license = generateValidLicensePayload();
		license.usedRealTimeBytes = license.realTimeBytes;
		expect(isActiveLicense(license)).to.be.false;
	});
	it('should reject a license with too many usedCpuTime', () => {
		const license = generateValidLicensePayload();
		license.usedCpuTime = license.cpuTime;
		expect(isActiveLicense(license)).to.be.false;
	});

	it('should accept an unlimited license', () => {
		const license = {
			...generateValidLicensePayload(),
			reads: -1,
			readBytes: -1,
			writes: -1,
			writeBytes: -1,
			realTimeMessages: -1,
			realTimeBytes: -1,
			cpuTime: -1,
			storage: -1,
		};
		expect(isActiveLicense(license)).to.be.true;
	});
});
