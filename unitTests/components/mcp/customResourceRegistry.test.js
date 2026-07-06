const assert = require('node:assert/strict');
const {
	addCustomResource,
	clearProfileCustomResources,
	snapshotProfileCustomResources,
	listCustomResources,
	listCustomResourceTemplates,
	matchCustomResource,
	customResourceCompletionValues,
	compileUriTemplate,
} = require('#src/components/mcp/customResourceRegistry');

const read = async () => 'content';

describe('mcp/customResourceRegistry (#1609)', () => {
	afterEach(() => {
		clearProfileCustomResources('application');
	});

	describe('compileUriTemplate', () => {
		it('matches {name} within a single segment only', () => {
			const { regex, paramNames } = compileUriTemplate('docs:///{section}/index');
			assert.deepEqual(paramNames, ['section']);
			assert.ok(regex.test('docs:///guides/index'));
			assert.ok(!regex.test('docs:///guides/nested/index'));
		});

		it('matches {+name} across segments (reserved expansion)', () => {
			const { regex, paramNames } = compileUriTemplate('docs:///{+path}');
			assert.deepEqual(paramNames, ['path']);
			assert.ok(regex.test('docs:///getting-started/install.md'));
		});

		it('escapes regex metacharacters in literal parts', () => {
			const { regex } = compileUriTemplate('notes+v2://a.b/{id}');
			assert.ok(regex.test('notes+v2://a.b/42'));
			assert.ok(!regex.test('notesXv2://aXb/42'));
		});

		it('throws on unterminated braces, invalid names, parameterless templates, and duplicate params', () => {
			assert.throws(() => compileUriTemplate('docs:///{path'));
			assert.throws(() => compileUriTemplate('docs:///{bad-name}'));
			assert.throws(() => compileUriTemplate('docs:///static'));
			assert.throws(() => compileUriTemplate('docs:///{name}/{name}'), /duplicate template parameter/);
		});
	});

	describe('matchCustomResource', () => {
		it('fixed URIs match exactly and win over templates', () => {
			addCustomResource({ uriTemplate: 'docs:///{+path}', name: 'page', profile: 'application', read });
			addCustomResource({ uri: 'docs:///index', name: 'index', profile: 'application', read });
			const match = matchCustomResource('application', 'docs:///index');
			assert.equal(match.def.name, 'index');
			assert.deepEqual(match.params, {});
		});

		it('template match extracts and decodes params', () => {
			addCustomResource({ uriTemplate: 'docs:///{+path}', name: 'page', profile: 'application', read });
			const match = matchCustomResource('application', 'docs:///guides/getting%20started.md');
			assert.equal(match.def.name, 'page');
			assert.deepEqual(match.params, { path: 'guides/getting started.md' });
		});

		it('a stray percent in the URI does not throw (URIError safety)', () => {
			addCustomResource({ uriTemplate: 'docs:///{+path}', name: 'page', profile: 'application', read });
			const match = matchCustomResource('application', 'docs:///100%valid');
			assert.deepEqual(match.params, { path: '100%valid' });
		});

		it('returns undefined for unknown URIs and other profiles', () => {
			addCustomResource({ uri: 'docs:///index', name: 'index', profile: 'application', read });
			assert.equal(matchCustomResource('application', 'docs:///missing'), undefined);
			assert.equal(matchCustomResource('operations', 'docs:///index'), undefined);
		});
	});

	describe('listing', () => {
		it('separates fixed URIs (resources/list) from templates (templates/list)', () => {
			addCustomResource({
				uri: 'docs:///index',
				name: 'index',
				title: 'Docs index',
				description: 'All pages',
				mimeType: 'text/markdown',
				profile: 'application',
				read,
			});
			addCustomResource({ uriTemplate: 'docs:///{+path}', name: 'page', profile: 'application', read });
			const fixed = listCustomResources('application');
			assert.deepEqual(fixed, [
				{
					uri: 'docs:///index',
					name: 'index',
					title: 'Docs index',
					description: 'All pages',
					mimeType: 'text/markdown',
				},
			]);
			const templates = listCustomResourceTemplates('application');
			assert.equal(templates.length, 1);
			assert.equal(templates[0].uriTemplate, 'docs:///{+path}');
		});
	});

	describe('completions', () => {
		it('returns author-declared values for a template param, undefined otherwise', () => {
			addCustomResource({
				uriTemplate: 'docs:///{section}/{page}',
				name: 'page',
				profile: 'application',
				completions: { section: ['guides', 'reference'] },
				read,
			});
			assert.deepEqual(customResourceCompletionValues('application', 'docs:///{section}/{page}', 'section'), [
				'guides',
				'reference',
			]);
			assert.equal(customResourceCompletionValues('application', 'docs:///{section}/{page}', 'page'), undefined);
			assert.equal(customResourceCompletionValues('application', 'docs:///{other}', 'section'), undefined);
		});
	});

	describe('snapshot / clear (rebuild support)', () => {
		it('snapshot returns defs that re-register cleanly after a clear', () => {
			addCustomResource({ uri: 'docs:///index', name: 'index', profile: 'application', read });
			const snapshot = snapshotProfileCustomResources('application');
			clearProfileCustomResources('application');
			assert.equal(matchCustomResource('application', 'docs:///index'), undefined);
			for (const def of snapshot) addCustomResource(def);
			assert.ok(matchCustomResource('application', 'docs:///index'));
		});
	});
});
