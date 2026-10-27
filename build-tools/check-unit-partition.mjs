#!/usr/bin/env node
// CI runs unitTests/resources as three shard scripts (core:a-q, core:r-z, indexes) and nothing else
// runs that tree as a whole on the default engine, so a file the globs stop selecting silently loses
// its coverage. This resolves each script's file set with mocha's own option and file collection and
// requires the shards to be an exact partition of `test:unit:resources`, for both the compiled and the
// native type-strip scripts.
import { createRequire } from 'node:module';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(repo, 'package.json'));
const { loadOptions } = require('mocha/lib/cli/options.cjs');
const collectFiles = require('mocha/lib/cli/collect-files.cjs');
const { scripts } = require('./package.json');

process.chdir(repo);

function filesOf(name) {
	const command = scripts[name];
	const runner = /^(mocha|node unitTests\/runTypeStripTests\.mts --source-only) /;
	if (!runner.test(command ?? '')) throw new Error(`"${name}" is not a mocha or type-strip runner script: ${command}`);
	const args = command
		.replace(runner, '')
		.match(/"[^"]*"|\S+/g)
		.map((arg) => arg.replace(/^"|"$/g, ''));
	const options = loadOptions(args);
	return new Set(
		collectFiles({ ...options, spec: options._, file: [] }).files.map((file) => path.relative(repo, file))
	);
}

const errors = [];
const sets = {};
for (const prefix of ['test:unit', 'test:unit:typestrip']) {
	const all = filesOf(`${prefix}:resources`);
	const shards = ['core:a-q', 'core:r-z', 'indexes'].map((shard) => [shard, filesOf(`${prefix}:resources:${shard}`)]);
	const owners = new Map();
	for (const [shard, files] of shards) {
		if (files.size === 0) errors.push(`${prefix}:resources:${shard} selects no files`);
		for (const file of files) {
			if (!all.has(file)) errors.push(`${file} is in ${prefix}:resources:${shard} but not ${prefix}:resources`);
			if (owners.has(file)) errors.push(`${file} is in both ${prefix}:resources:${owners.get(file)} and :${shard}`);
			owners.set(file, shard);
		}
	}
	for (const file of all) if (!owners.has(file)) errors.push(`${file} is in no ${prefix}:resources shard`);
	sets[prefix] = shards;
}
for (const [index, [shard, compiled]] of sets['test:unit'].entries()) {
	const native = sets['test:unit:typestrip'][index][1];
	if (compiled.size !== native.size || [...compiled].some((file) => !native.has(file)))
		errors.push(`the compiled and type-strip resources:${shard} scripts select different files`);
}

if (errors.length) {
	for (const error of errors) console.error(`error: ${error}`);
	process.exit(1);
}
console.log(
	`unit partition: ${sets['test:unit'].map(([shard, files]) => `${shard} ${files.size}`).join(', ')} — exact, compiled and type-strip`
);
