import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const RULE_CODE = 'harper(no-literal-true-assertion)';

// Lines ending in `// flagged` are the calls the rule must report; every other line must stay clean.
const FIXTURE = `import assert, { ok, ok as check, strict } from 'node:assert';
import * as assertNamespace from 'node:assert';
import strictAssert from 'node:assert/strict';
import { test, beforeEach, before } from 'node:test';
import * as testNamespace from 'node:test';
const { ok: destructured } = assert;
const required = require('assert');
const aliased = assert;
const okAlias = ok;
const memberAlias = assert.ok;
const { ['ok']: computedKey } = assert;

ok(true); // flagged
check(true, 'aliased import'); // flagged
assert(true); // flagged
assert.ok(true); // flagged
assert['ok'](true); // flagged
assert.strict(true); // flagged
assert.strict.ok(true); // flagged
strict(true); // flagged
assertNamespace.ok(true); // flagged
strictAssert.ok(true); // flagged
destructured(true); // flagged
required.ok(true); // flagged
aliased(true); // flagged
okAlias(true); // flagged
memberAlias(true); // flagged
ok(true as const); // flagged
computedKey(true); // flagged
ok( // flagged
	true,
	'multi-line call'
);
test('context assert', (t) => {
	t.assert.ok(true); // flagged
	const contextOk = t.assert.ok;
	contextOk(true); // flagged
	const { ok: contextDestructured } = t.assert;
	contextDestructured(true); // flagged
	const { assert: contextAssert } = t;
	contextAssert.ok(true); // flagged
	t.test('subtest', (subtest) => {
		subtest.assert.ok(true); // flagged
	});
});
test.skip('skipped context assert', (t) => {
	t.assert.ok(true); // flagged
});
testNamespace.test('namespace import', (t) => {
	t.assert.ok(true); // flagged
});
beforeEach((t) => {
	t.assert.ok(true); // flagged
});
before((t) => {
	t.assert.ok(true); // flagged
});

const observed = true;
ok(observed);
ok(1 > 0, 'computed');
assert.strictEqual(observed, true);
ok(false);
// ok(true) in a comment
const text = 'ok(true) in a string';
const response = { ok(_value) {} };
response.ok(true);
function shadowed(ok) {
	ok(true);
}
shadowed(() => {});
const local = { assert: { ok(_value) {} } };
local.assert.ok(true);
var selfReference = selfReference;
selfReference = (_value) => {};
selfReference(true);
console.log(text);
`;

function flaggedLines(source) {
	return source
		.split('\n')
		.flatMap((line, index) => (line.endsWith('// flagged') ? [index + 1] : []))
		.sort((a, b) => a - b);
}

describe('oxlint harper/no-literal-true-assertion', function () {
	this.timeout(60_000);
	let workDir;
	let diagnostics;

	before(function () {
		workDir = mkdtempSync(join(tmpdir(), 'oxlint-harper-plugin-'));
		const config = JSON.parse(readFileSync(join(REPO_ROOT, '.oxlintrc.json'), 'utf8'));
		delete config.$schema;
		config.jsPlugins = config.jsPlugins.map((plugin) => resolve(REPO_ROOT, plugin));
		writeFileSync(join(workDir, '.oxlintrc.json'), JSON.stringify(config));
		for (const directory of ['integrationTests', 'unitTests']) {
			mkdirSync(join(workDir, directory));
			writeFileSync(join(workDir, directory, 'fixture.test.ts'), FIXTURE);
		}
		const result = spawnSync(
			process.execPath,
			[join(REPO_ROOT, 'node_modules/oxlint/bin/oxlint'), '--format', 'json', '-c', '.oxlintrc.json', '.'],
			{ cwd: workDir, encoding: 'utf8', timeout: 30_000 }
		);
		assert.ifError(result.error);
		assert.ok(result.stdout, `oxlint produced no output (status ${result.status}): ${result.stderr}`);
		diagnostics = JSON.parse(result.stdout).diagnostics.filter((diagnostic) => diagnostic.code === RULE_CODE);
	});

	after(function () {
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	it('reports every literal-true assertion form under integrationTests', function () {
		const reported = diagnostics
			.filter((diagnostic) => diagnostic.filename.replaceAll('\\', '/').startsWith('integrationTests/'))
			.map((diagnostic) => diagnostic.labels[0].span.line)
			.sort((a, b) => a - b);
		assert.deepStrictEqual(reported, flaggedLines(FIXTURE));
	});

	it('is scoped to integrationTests', function () {
		const outside = diagnostics.filter(
			(diagnostic) => !diagnostic.filename.replaceAll('\\', '/').startsWith('integrationTests/')
		);
		assert.deepStrictEqual(outside, []);
	});
});
