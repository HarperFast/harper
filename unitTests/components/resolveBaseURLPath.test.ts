import { resolveBaseURLPath, InvalidBaseURLPathError } from '@/components/resolveBaseURLPath';
import assert from 'node:assert/strict';

describe('resolveBaseURLPath', () => {
	const componentName = 'test-component';
	it('should resolve to / when no path, or an empty path is provided', () => {
		[undefined, '', '/'].forEach((path) => {
			assert.equal(resolveBaseURLPath(componentName, path), '/');
		});
	});

	it('should resolve to `/<path>/` when a path is provided without a leading `.` character', () => {
		['static', '/static', 'static/', '/static/'].forEach((path) => {
			assert.equal(resolveBaseURLPath(componentName, path), '/static/');
		});

		['v1/static', '/v1/static', 'v1/static/', '/v1/static/'].forEach((path) => {
			assert.equal(resolveBaseURLPath(componentName, path), '/v1/static/');
		});
	});

	it('should resolve `.` to `<component-name>`', () => {
		['./static', './static/'].forEach((path) => {
			assert.equal(resolveBaseURLPath(componentName, path), `/${componentName}/static/`);
		});

		['./v1/static', './v1/static/'].forEach((path) => {
			assert.equal(resolveBaseURLPath(componentName, path), `/${componentName}/v1/static/`);
		});

		['.', './'].forEach((path) => {
			assert.equal(resolveBaseURLPath(componentName, path), `/${componentName}/`);
		});
	});

	it('should error when path starts with `..`', () => {
		['..', '../', '../static', './..', './static/../'].forEach((path) => {
			assert.throws(() => resolveBaseURLPath(componentName, path), new InvalidBaseURLPathError(path));
		});
	});
});
