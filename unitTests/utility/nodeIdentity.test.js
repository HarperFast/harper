'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('assert');
const { bareHostViolation } = require('#src/utility/nodeIdentity');

describe('bareHostViolation (node identity must be a bare host)', () => {
	const valid = [
		'node1',
		'node1.example.com',
		'my-node',
		'MyNode',
		'localhost',
		'127.0.0.1',
		'10.0.0.5',
		'::1',
		'fe80::1',
		'2001:db8::1',
		'', // unset — the caller falls back to another source
	];
	for (const value of valid) {
		it(`accepts ${JSON.stringify(value)}`, () => {
			assert.strictEqual(bareHostViolation(value), undefined);
		});
	}

	const invalid = [
		['http://localhost:9926', /scheme/],
		['ws://host', /scheme/],
		['localhost:9925', /port/],
		['localhost:80', /port/], // default port is not normalized away
		['myhost:443', /port/], // :443 is the parse scheme's default port — still reported as a port
		['[::1]:9925', /unbracketed/], // a bracketed form is rejected before the port check
		['localhost/path', /path/],
		['localhost?q=1', /query/],
		['localhost#frag', /fragment/],
		['user:pass@localhost', /credentials/],
		['ws:host:9925', /not a valid hostname/], // scheme without "//" — unparseable authority
		['localhost:99999', /not a valid hostname/], // out-of-range port — unparseable authority
		['fe80::1%eth0', /not a valid hostname/], // a scoped IPv6 zone id has no valid URL authority
		['node%20', /not a valid hostname/], // a host the ws:// consumer rejects must not pass here
		['[::1]', /unbracketed/], // identity is stored unbracketed; bracketing belongs to URL construction
		['[2001:db8::1]', /unbracketed/],
		['[127.0.0.1]', /unbracketed/], // brackets around IPv4 are invalid too
		[9925, /must be a string/],
		[0, /must be a string/],
		[true, /must be a string/],
		[null, /must be a string/],
		[{}, /must be a string/],
	];
	for (const [value, matcher] of invalid) {
		it(`rejects ${JSON.stringify(value)}`, () => {
			const reason = bareHostViolation(value);
			assert.ok(reason, `expected a violation reason for ${JSON.stringify(value)}`);
			assert.ok(matcher.test(reason), `reason "${reason}" should match ${matcher}`);
		});
	}

	it('treats a bare IPv6 literal with a hex-group tail as a valid IPv6 address, not a port', () => {
		// "::1:9925" is a syntactically valid IPv6 address; an operator wanting a port must bracket it.
		assert.strictEqual(bareHostViolation('::1:9925'), undefined);
	});
});
