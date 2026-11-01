import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { formatOutline, outlineSource, sourceFiles } from '../../build-tools/outline.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(REPO_ROOT, 'build-tools/outline.mjs');

const FACTORY = `import { Base } from './base.ts';
export const LIMIT = 5;
// #section: setup
export function makeThing(options) {
	const local = options.local;
	let counter = 0;
	function helper() {
		const insideHelper = 1;
		return insideHelper;
	}
	class Inner extends Base {
		static kind = 'inner';
		#secret = 1;
		// #section: reads
		get(id: string): string;
		get(id: number): number;
		get(id) {
			const value = id;
			function nested() {}
			return value;
		}
		// #section: writes
		get size() {
			return 1;
		}
		static [Symbol.iterator]() {}
	}
	return Inner;
}
export function plain() {
	const notListed = 1;
	return notListed;
}
export const handlers = {
	open() {},
	close: () => {},
	retries: 3,
	nested: { depth: 1 },
};
export const { first, second: [, third] } = load();
export const arrow = async () => {};
export const Anonymous = class {
	method() {}
};
interface Shape {
	area(): number;
}
type Alias = string;
export { LIMIT as MAX, plain as default2 };
`;

const outlineOf = (text, file = 'thing.ts') => outlineSource(file, text);
const find = (node, ...names) => {
	for (const name of names) {
		node = node.children.find((child) => child.name === name);
		assert.ok(node, `no ${name}`);
	}
	return node;
};

describe('build-tools/outline.mjs', function () {
	it('nests factory declarations, class members and methods with line ranges', function () {
		const tree = outlineOf(FACTORY);
		const factory = find(tree, 'makeThing');
		assert.deepStrictEqual([factory.kind, factory.start, factory.end], ['function', 4, 29]);
		assert.deepStrictEqual(
			factory.children.map((child) => `${child.kind} ${child.name}`),
			['variable local', 'variable counter', 'function helper', 'class Inner']
		);
		assert.deepStrictEqual(find(tree, 'makeThing', 'helper').children, []);
		const inner = find(tree, 'makeThing', 'Inner');
		assert.deepStrictEqual(
			inner.children.map((child) => `${child.static ? 'static ' : ''}${child.kind} ${child.name}`),
			[
				'static property kind',
				'property #secret',
				'section reads',
				'method get',
				'section writes',
				'get size',
				'static method [Symbol.iterator]',
			]
		);
		const method = find(inner, 'get');
		assert.deepStrictEqual([method.start, method.end], [17, 21], 'overload signatures fold into the implementation');
		assert.deepStrictEqual(
			method.children.map((child) => child.name),
			['nested'],
			'method locals are not listed; nested functions are'
		);
	});

	it('places #section markers in their container with a range ending at the next marker', function () {
		const tree = outlineOf(FACTORY);
		const setup = find(tree, 'setup');
		assert.deepStrictEqual([setup.kind, setup.start, setup.end], ['section', 3, 13]);
		const reads = find(tree, 'makeThing', 'Inner', 'reads');
		assert.deepStrictEqual([reads.start, reads.end], [14, 21]);
		const writes = find(tree, 'makeThing', 'Inner', 'writes');
		assert.deepStrictEqual([writes.start, writes.end], [22, 27], 'the last marker ends with its container');
	});

	it('lists module declarations, object members, bindings and re-exports, but not plain function locals', function () {
		const tree = outlineOf(FACTORY);
		assert.deepStrictEqual(find(tree, 'plain').children, []);
		assert.deepStrictEqual(
			find(tree, 'handlers').children.map((child) => `${child.kind} ${child.name}`),
			['method open', 'method close', 'property retries', 'property nested']
		);
		assert.deepStrictEqual(
			find(tree, 'handlers', 'nested').children.map((child) => child.name),
			['depth']
		);
		assert.deepStrictEqual(
			tree.children.map((child) => `${child.kind} ${child.name}`),
			[
				'variable LIMIT',
				'section setup',
				'function makeThing',
				'function plain',
				'variable handlers',
				'variable first',
				'variable third',
				'function arrow',
				'class Anonymous',
				'interface Shape',
				'type Alias',
				'export MAX',
				'export default2',
			]
		);
		assert.deepStrictEqual(
			find(tree, 'Anonymous').children.map((child) => child.name),
			['method']
		);
	});

	it('treats a module-level arrow function that declares a class as a factory', function () {
		const tree = outlineOf(
			'export const makeIt = () => {\n\tconst cache = new Map();\n\tclass It {}\n\treturn It;\n};\n'
		);
		assert.deepStrictEqual(
			find(tree, 'makeIt').children.map((child) => `${child.kind} ${child.name}`),
			['variable cache', 'class It']
		);
	});

	it('parses JavaScript and CommonJS without types', function () {
		const tree = outlineOf(
			'function legacy(a) { function inner() {} return inner; }\nmodule.exports = { legacy };\n',
			'legacy.js'
		);
		assert.deepStrictEqual(
			tree.children.map((child) => child.name),
			['legacy']
		);
		assert.deepStrictEqual(
			find(tree, 'legacy').children.map((child) => child.name),
			['inner']
		);
	});

	it('formats one indented line per symbol', function () {
		const lines = formatOutline(outlineOf(FACTORY));
		assert.ok(lines.includes('  function makeThing  4-29'), lines.join('\n'));
		assert.ok(lines.includes('      #section: reads  14-21'), lines.join('\n'));
		assert.ok(lines.includes('      method get  17-21'), lines.join('\n'));
		assert.ok(lines.includes('      static property kind  12'), lines.join('\n'));
	});

	it('outlines resources/Table.ts, including the methods nested in makeTable()', function () {
		const file = join(REPO_ROOT, 'resources/Table.ts');
		const tree = outlineSource(file, readFileSync(file, 'utf8'));
		const resource = find(tree, 'makeTable', 'TableResource');
		const writeUpdate = find(resource, '_writeUpdate');
		assert.strictEqual(writeUpdate.kind, 'method');
		assert.ok(writeUpdate.end > writeUpdate.start);
		assert.ok(resource.children.some((child) => child.kind === 'section' && child.name === 'write-path-internals'));
	});

	describe('CLI', function () {
		let dir;
		beforeEach(function () {
			dir = mkdtempSync(join(tmpdir(), 'outline-'));
			mkdirSync(join(dir, 'lib/node_modules'), { recursive: true });
			writeFileSync(join(dir, 'lib/a.ts'), 'export function alpha() {}\n');
			writeFileSync(join(dir, 'lib/b.mjs'), 'export class Beta {}\n');
			writeFileSync(join(dir, 'lib/notes.md'), '# not source\n');
			writeFileSync(join(dir, 'lib/node_modules/dep.js'), 'export function skipped() {}\n');
		});
		afterEach(function () {
			rmSync(dir, { recursive: true, force: true });
		});
		const run = (...args) =>
			spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });

		it('prints every source file under a directory, skipping node_modules', function () {
			const result = run('lib');
			assert.strictEqual(result.status, 0, result.stderr);
			assert.strictEqual(result.stdout, 'lib/a.ts\n  function alpha  1\nlib/b.mjs\n  class Beta  1\n');
			assert.deepStrictEqual(
				[...sourceFiles(join(dir, 'lib'))].map((file) => file.slice(dir.length + 1)),
				['lib/a.ts', 'lib/b.mjs']
			);
		});

		it('fails on a missing path and without arguments', function () {
			assert.strictEqual(run('missing.ts').status, 1);
			assert.strictEqual(run().status, 2);
		});
	});
});
