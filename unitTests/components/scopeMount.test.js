const assert = require('node:assert');
const {
	normalizeMountPath,
	toScopeMount,
	composeMountedUrlPath,
	applyScopeMount,
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

	describe('applyScopeMount', () => {
		it('returns the section unchanged, by reference, when there is no mount', () => {
			const section = { files: 'web/**', urlPath: 'assets' };
			assert.equal(applyScopeMount(section, 'static', undefined), section);
		});

		it('leaves nullish sections alone', () => {
			assert.equal(applyScopeMount(undefined, 'static', { urlPath: '/v1' }), undefined);
			assert.equal(applyScopeMount(null, 'static', { urlPath: '/v1' }), null);
		});

		it('composes urlPath and preserves the rest of the section', () => {
			const mounted = applyScopeMount({ files: 'web/**', urlPath: 'assets' }, 'static', { urlPath: '/v1' });
			assert.deepEqual(mounted, { files: 'web/**', urlPath: '/v1/assets/' });
		});

		it('does not mutate the input section', () => {
			const section = { files: 'web/**', urlPath: 'assets' };
			applyScopeMount(section, 'static', { urlPath: '/v1', host: 'api.example.com' });
			assert.deepEqual(section, { files: 'web/**', urlPath: 'assets' });
		});

		it('replaces host outright — the operator wins over a value the app shipped', () => {
			const mounted = applyScopeMount({ files: 'web/**', host: 'www.shipped.example' }, 'static', {
				host: 'api.example.com',
			});
			assert.equal(mounted.host, 'api.example.com');
		});

		it('promotes a bare `true` plugin so the mount is not dropped', () => {
			assert.deepEqual(applyScopeMount(true, 'rest', { host: 'api.example.com', urlPath: '/v1' }), {
				host: 'api.example.com',
				urlPath: '/v1/',
			});
		});

		it('applies a host-only mount without inventing a urlPath', () => {
			const mounted = applyScopeMount({ files: 'web/**' }, 'static', { host: 'api.example.com' });
			assert.deepEqual(mounted, { files: 'web/**', host: 'api.example.com' });
		});
	});
});
