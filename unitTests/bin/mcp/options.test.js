const assert = require('node:assert/strict');
const { parseArgs } = require('#src/bin/mcp/options');

describe('bin/mcp/options.parseArgs', () => {
	it('defaults to bridge + operations + UDS + /mcp', () => {
		const o = parseArgs([]);
		assert.equal(o.subcommand, 'bridge');
		assert.equal(o.profile, 'operations');
		assert.equal(o.target, undefined);
		assert.equal(o.mountPath, '/mcp');
		assert.equal(o.rejectUnauthorized, true);
	});

	it('parses a positional subcommand', () => {
		assert.equal(parseArgs(['doctor']).subcommand, 'doctor');
		assert.equal(parseArgs(['print-config']).subcommand, 'print-config');
		assert.equal(parseArgs(['help']).subcommand, 'help');
		assert.equal(parseArgs(['bridge']).subcommand, 'bridge');
	});

	it('accepts --flag value and --flag=value forms', () => {
		const o1 = parseArgs(['--profile', 'operations']);
		assert.equal(o1.profile, 'operations');
		const o2 = parseArgs(['--profile=operations']);
		assert.equal(o2.profile, 'operations');
	});

	it('parses --target as a network endpoint', () => {
		const o = parseArgs(['--target', 'https://host:9926']);
		assert.equal(o.target, 'https://host:9926');
	});

	it('parses creds', () => {
		const o = parseArgs(['--username', 'alice', '--password', 'pw']);
		assert.equal(o.username, 'alice');
		assert.equal(o.password, 'pw');
	});

	it('--insecure flips rejectUnauthorized', () => {
		const o = parseArgs(['--insecure']);
		assert.equal(o.rejectUnauthorized, false);
	});

	it('rejects unknown profile values silently (default stays)', () => {
		const o = parseArgs(['--profile', 'bogus']);
		assert.equal(o.profile, 'operations');
	});

	it('print-config respects --client', () => {
		const o = parseArgs(['print-config', '--client', 'cursor']);
		assert.equal(o.subcommand, 'print-config');
		assert.equal(o.client, 'cursor');
	});

	it('--help / -h sets help', () => {
		assert.equal(parseArgs(['--help']).help, true);
		assert.equal(parseArgs(['-h']).help, true);
	});

	it('--bearer overrides username/password later', () => {
		const o = parseArgs(['--username', 'a', '--bearer', 'token']);
		assert.equal(o.bearer, 'token');
	});
});
