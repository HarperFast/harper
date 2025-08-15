const { describe, it } = require('mocha');
const { expect } = require('chai');
const ul = require('../../validation/usageLicensing.ts');
const { signTestLicense, signAnything } = require('../testLicenseUtils.js');

describe('usageLicensing', function () {
	describe('validateLicense', () => {
		it('should return license payload on valid license', () => {
			const payload = {
				id: 'test',
				level: 42,
				region: 'test',
				reads: 2000,
				writes: 3000,
				readBytes: -1,
				writeBytes: -1,
				realTimeMessages: 1000,
				realTimeBytes: -1,
				cpuTime: -1,
				storage: -1,
				expiration: '2030-01-01T00:00:00.000Z',
			};
			const license = signTestLicense(payload);
			const result = ul.validateLicense(license);
			expect(result).to.deep.equal(payload);
		});
		it('should throw on non-string license arg', () => {
			expect(() => ul.validateLicense({ not: 'a license' })).to.throw(
				ul.LicenseEncodingError,
				/License must be a string/i
			);
		});

		it('should throw InvalidBase64UrlEncodingError on invalid base64url encoding', () => {
			expect(() => ul.validateLicense(signAnything('foo!.$bar'))).to.throw(TypeError);
		});

		it('should throw InvalidLicenseError if more than three dot-seperated sections', () => {
			expect(() => ul.validateLicense('invalid.invalid.invalid.invalid')).to.throw(
				ul.InvalidLicenseError,
				/must have three/
			);
		});

		it('should throw InvalidLicenseError if less than three dot-seperated sections', () => {
			expect(() => ul.validateLicense('invalid.invalid')).to.throw(ul.InvalidLicenseError, /must have three/);
		});

		it('should throw InvalidHeaderError on non-JSON license header', () => {
			const invalidHeader = Buffer.from(JSON.stringify({ foo: 'bar' }) + 'oops!').toString('base64url');
			const payload = Buffer.from('invalid').toString('base64url');
			const invalidLicense = signAnything(invalidHeader + '.' + payload);
			expect(() => ul.validateLicense(invalidLicense)).to.throw(ul.InvalidHeaderError);
		});

		it('should throw InvalidLicensePayloadError on non-JSON license payload', () => {
			const header = Buffer.from(JSON.stringify({ typ: 'Harper-License', alg: 'EdDSA' })).toString('base64url');
			const invalidPayload = Buffer.from(JSON.stringify({ ima: 'payload' }) + 'oops!').toString('base64url');
			const invalidLicense = signAnything(header + '.' + invalidPayload);
			expect(() => ul.validateLicense(invalidLicense)).to.throw(ul.InvalidPayloadError);
		});
	});
});
