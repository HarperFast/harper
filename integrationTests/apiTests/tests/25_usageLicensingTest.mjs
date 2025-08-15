import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { req } from '../utils/request.mjs';
import * as utils from '../../../unitTests/testLicenseUtils.js';
import { randomUUID } from 'crypto';

describe('Usage license installation', () => {
	it('should install a valid license', async () => {
		const licensePayload = utils.generateValidLicensePayload();
		const uuid = randomUUID();
		const id = 'testy-mctestface-' + uuid;
		licensePayload.id = id;
		const license = utils.signTestLicense(licensePayload);
		const installOp = { operation: 'install_usage_license', license };
		await req()
			.send(installOp)
			.expect((r) => {
				assert.ok(r.body.message?.includes('Successfully installed usage license'), r.text);
			})
			.expect(200);
		const getLicensesOp = { operation: 'get_usage_licenses' };
		return req()
			.send(getLicensesOp)
			.expect(200)
			.expect((r) => {
				assert.ok(
					r.body.some((l) => l.id === id),
					r.text
				);
			});
	});

	it('should respond with an error with an invalid license', async () => {
		const licensePayload = JSON.stringify({ foo: 'bar', bar: 'baz' });
		const license = utils.signAnything(licensePayload);
		const installOp = { operation: 'install_usage_license', license };
		return req()
			.send(installOp)
			.expect((r) => {
				assert.ok(r.text.includes('Failed to install usage license'));
			})
			.expect(400);
	});

	it('should error if install is attempted with an existing id', async () => {
		const licenseId = 'test-license-' + randomUUID();
		const license1 = utils.generateTestLicense({ id: licenseId });
		const installOp1 = { operation: 'install_usage_license', license: license1 };
		await req().send(installOp1).expect(200);
		const license2Region = 'region-2-' + randomUUID();
		const license2 = utils.generateTestLicense({ id: licenseId, region: license2Region });
		const installOp2 = { operation: 'install_usage_license', license: license2 };
		return req().send(installOp2).expect(400);
	});
});

describe('Usage license expiration', () => {
	it('get_usage_licenses should return expired licenses', async () => {
		const expiration = new Date(Date.now() - 1000);
		const license = utils.generateTestLicense({ expiration });
		const installOp = { operation: 'install_usage_license', license };
		await req().send(installOp).expect(200);
		return req()
			.send({ operation: 'get_usage_licenses' })
			.expect((r) => {
				assert.ok(r.body.some((l) => l.expiration === expiration.toISOString()));
			});
	});

	it('should not record usage in expired licenses', () => {});
});
