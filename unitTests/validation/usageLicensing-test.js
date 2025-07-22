const { describe, it } = require('mocha');
const { expect } = require('chai');
const ul = require('../../validation/usageLicensing');
const { createPrivateKey, sign } = require('node:crypto');

const LICENSE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIAAe+bdBWCbmzgPgfzf5L7L1npsgi+Wkz+uNb9lgcA/w
-----END PRIVATE KEY-----
`;

function generateTestLicense(payload) {
	const header = { typ: 'Harper-License', alg: 'EdDSA' };
	const license = [JSON.stringify(header), JSON.stringify(payload)]
		.map((e) => Buffer.from(e).toString('base64url'))
		.join('.');
	const privateKey = createPrivateKey(LICENSE_PRIVATE_KEY);
	return license + '.' + sign(null, Buffer.from(license, 'utf8'), privateKey).toString('base64url');
}

// for testing errors that get past signature verification
function signAnything(anything) {
	const privateKey = createPrivateKey(LICENSE_PRIVATE_KEY);
	return anything + '.' + sign(null, Buffer.from(anything, 'utf8'), privateKey).toString('base64url');
}

describe('usageLicensing', function () {
	describe('validateLicense', () => {
		it('should return license payload on valid license', () => {
			const payload = {
				id: 'test',
				level: 'test',
				region: 'test',
				reads: 2000,
				writes: 3000,
				readBytes: 'Infinity',
				writeBytes: 'Infinity',
				realTimeMessages: 1000,
				realTimeBytes: 'Infinity',
				cpuTime: 'Infinity',
				storage: 'Infinity',
				expiration: '2030-01-01T00:00:00.000Z',
			};
			const license = generateTestLicense(payload);
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
			expect(() => ul.validateLicense(signAnything('foo!.$bar'))).to.throw(ul.InvalidBase64UrlEncodingError);
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
