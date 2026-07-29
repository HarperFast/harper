const assert = require('node:assert');
const {
	normalizeMountPath,
	normalizeMountHost,
	toScopeMount,
	composeMountedUrlPath,
	nestScopeMount,
	InvalidMountPathError,
	InvalidMountHostError,
} = require('#src/components/scopeMount');
const { InvalidBaseURLPathError } = require('#src/components/resolveBaseURLPath');

describe('scopeMount', () => {
	describe('normalizeMountPath', () => {
		it('adds a leading slash and strips trailing slashes', () => {
			assert.equal(normalizeMountPath('v1'), '/v1');
			assert.equal(normalizeMountPath('/v1'), '/v1');
			assert.equal(normalizeMountPath('/v1/'), '/v1');
			assert.equal(normalizeMountPath('/v1///'), '/v1');
			assert.equal(normalizeMountPath('api/v1/'), '/api/v1');
		});

		it('treats a mount that constrains nothing as no mount', () => {
			assert.equal(normalizeMountPath(undefined), undefined);
			assert.equal(normalizeMountPath(''), undefined);
			assert.equal(normalizeMountPath('/'), undefined);
			assert.equal(normalizeMountPath('///'), undefined);
		});

		it('rejects path traversal', () => {
			assert.throws(() => normalizeMountPath('../etc'), InvalidBaseURLPathError);
			assert.throws(() => normalizeMountPath('/v1/../..'), InvalidBaseURLPathError);
		});

		it('rejects dot-segment mounts — clients strip them, so the route would be unreachable', () => {
			assert.throws(() => normalizeMountPath('.'), InvalidMountPathError);
			assert.throws(() => normalizeMountPath('./'), InvalidMountPathError);
			assert.throws(() => normalizeMountPath('./v1'), InvalidMountPathError);
			assert.throws(() => normalizeMountPath('/v1/./x'), InvalidMountPathError);
		});

		it('does not reject a leading dot inside a segment name', () => {
			assert.equal(normalizeMountPath('/.well-known'), '/.well-known');
		});
	});

	describe('normalizeMountHost', () => {
		it('lowercases — hostnames are case-insensitive and clients send them lowercased', () => {
			assert.equal(normalizeMountHost('API.Example.COM'), 'api.example.com');
		});

		it('unwraps a bracketed IPv6 literal to match what the router extracts', () => {
			assert.equal(normalizeMountHost('[::1]'), '::1');
			assert.equal(normalizeMountHost('[FE80::1]'), 'fe80::1');
		});

		it('passes through undefined and empty', () => {
			assert.equal(normalizeMountHost(undefined), undefined);
			assert.equal(normalizeMountHost(''), undefined);
		});

		it('accepts a bare IPv6 literal', () => {
			assert.equal(normalizeMountHost('::1'), '::1');
			assert.equal(normalizeMountHost('FE80::1'), 'fe80::1');
		});

		// A hand-edited root config has no equivalent to the deploy_component operation's Joi
		// validator, so a value that could never match a Host/:authority header (a port, a scheme,
		// a path suffix, malformed IDN) must fail loudly here rather than mount unreachably.
		it('rejects a host carrying a port — never matches, since the router strips the header port separately', () => {
			assert.throws(() => normalizeMountHost('api.example.com:9926'), InvalidMountHostError);
		});

		it('rejects a scheme', () => {
			assert.throws(() => normalizeMountHost('https://api.example.com'), InvalidMountHostError);
		});

		it('rejects a path suffix', () => {
			assert.throws(() => normalizeMountHost('api.example.com/v1'), InvalidMountHostError);
		});

		it('rejects a malformed hostname', () => {
			assert.throws(() => normalizeMountHost('not a hostname'), InvalidMountHostError);
		});
	});

	describe('nestScopeMount', () => {
		it('returns whichever side is defined when only one is', () => {
			const child = { host: undefined, urlPath: '/child' };
			assert.equal(nestScopeMount(undefined, child), child);
			const parent = { host: 'api.example.com', urlPath: '/v1' };
			assert.equal(nestScopeMount(parent, undefined), parent);
		});

		it('nests the child path inside the parent path', () => {
			assert.deepEqual(nestScopeMount({ urlPath: '/v1' }, { urlPath: '/child' }), {
				host: undefined,
				urlPath: '/v1/child',
			});
		});

		it('keeps parent hostname authority — a child cannot escape its host', () => {
			assert.deepEqual(nestScopeMount({ host: 'parent.example.com' }, { host: 'child.example.com' }), {
				host: 'parent.example.com',
				urlPath: undefined,
			});
		});

		it('carries the parent path when the child declares only a host', () => {
			assert.deepEqual(nestScopeMount({ urlPath: '/v1' }, { host: 'child.example.com' }), {
				host: 'child.example.com',
				urlPath: '/v1',
			});
		});
	});

	describe('toScopeMount', () => {
		it('returns undefined when the entry declares no routing', () => {
			assert.equal(toScopeMount(undefined), undefined);
			assert.equal(toScopeMount(true), undefined);
			assert.equal(toScopeMount({ package: '@my/app' }), undefined);
			// a root mount constrains nothing, so it is not a mount
			assert.equal(toScopeMount({ package: '@my/app', urlPath: '/' }), undefined);
		});

		it('extracts and normalizes declared routing', () => {
			assert.deepEqual(toScopeMount({ package: '@my/app', urlPath: 'v1/' }), {
				host: undefined,
				urlPath: '/v1',
			});
			assert.deepEqual(toScopeMount({ host: 'api.example.com' }), {
				host: 'api.example.com',
				urlPath: undefined,
			});
			assert.deepEqual(toScopeMount({ host: 'api.example.com', urlPath: '/v1' }), {
				host: 'api.example.com',
				urlPath: '/v1',
			});
		});
	});

	describe('composeMountedUrlPath', () => {
		it('passes the plugin path through untouched when there is no mount', () => {
			assert.equal(composeMountedUrlPath(undefined, 'static', 'assets'), 'assets');
			assert.equal(composeMountedUrlPath(undefined, 'static', undefined), undefined);
		});

		it('prefixes the mount onto the resolved plugin path', () => {
			assert.equal(composeMountedUrlPath('/v1', 'static', 'assets'), '/v1/assets/');
			assert.equal(composeMountedUrlPath('/v1', 'static', '/assets/'), '/v1/assets/');
			assert.equal(composeMountedUrlPath('/v1', 'rest', undefined), '/v1/');
			assert.equal(composeMountedUrlPath('/v1', 'rest', '/'), '/v1/');
		});

		it('resolves plugin-name-relative paths before prefixing', () => {
			assert.equal(composeMountedUrlPath('/v1', 'static', '.'), '/v1/static/');
			assert.equal(composeMountedUrlPath('/v1', 'static', './'), '/v1/static/');
			assert.equal(composeMountedUrlPath('/v1', 'static', './assets'), '/v1/static/assets/');
		});

		it('is a fixed point — re-composing an already-mounted path does not compound the prefix', () => {
			const once = composeMountedUrlPath('/v1', 'static', 'assets');
			assert.equal(composeMountedUrlPath('/v1', 'static', once), '/v1/v1/assets/');
			// what actually matters: downstream consumers resolve the composed value again,
			// and resolveBaseURLPath must leave it alone
			const { resolveBaseURLPath } = require('#src/components/resolveBaseURLPath');
			assert.equal(resolveBaseURLPath('static', once), once);
		});

		it('rejects path traversal in the plugin path', () => {
			assert.throws(() => composeMountedUrlPath('/v1', 'static', '../secrets'), InvalidBaseURLPathError);
		});
	});
});
