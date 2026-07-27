'use strict';

const assert = require('node:assert');
const { getDomainSocketPathMaxBytes, isDomainSocketPathTooLong } = require('#src/utility/domainSocket');

describe('domain socket path limits', () => {
	it('uses the platform sockaddr_un.sun_path capacity', () => {
		assert.strictEqual(getDomainSocketPathMaxBytes('darwin'), 103);
		assert.strictEqual(getDomainSocketPathMaxBytes('linux'), 107);
		assert.strictEqual(getDomainSocketPathMaxBytes('win32'), 107);
	});

	it('counts path bytes rather than JavaScript characters', () => {
		assert.strictEqual(isDomainSocketPathTooLong('a'.repeat(107), 'linux'), false);
		assert.strictEqual(isDomainSocketPathTooLong('a'.repeat(108), 'linux'), true);
		assert.strictEqual(isDomainSocketPathTooLong('é'.repeat(54), 'linux'), true);
	});
});
