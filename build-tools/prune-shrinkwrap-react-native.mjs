#!/usr/bin/env node
// Remove unused optional subtrees from the shrinkwrap that ships in the published package.
//
// alasql declares `optionalDependencies: { "react-native-fs": "^2.20.0" }`, and
// react-native-fs peer-depends on react-native *without* marking it optional. npm 7+
// auto-installs peer dependencies, so resolving alasql drags in react-native, react,
// hermes, metro and react-devtools-core — ~140MB and ~200 packages of code that cannot
// execute under Node: every `require('react-native-fs')` in alasql/dist/alasql.fs.js sits
// behind an `isReactNative` guard, and Harper only uses alasql.parse plus its function
// extensions. See #1937.
//
// This has to happen here rather than via an `overrides` entry in package.json, because
// npm honours `overrides` only for the root project — they have no effect on a consumer
// installing harper. The published shrinkwrap, by contrast, IS authoritative for registry
// installs: npm learns it exists from the `_hasShrinkwrap` flag in the packument and
// installs exactly the tree it describes. So pruning here is what actually reaches users.
//
// Same invariant as prune-shrinkwrap-dev.mjs — the published shrinkwrap should describe
// only the production tree a consumer needs — so this runs alongside it.
//
// ws also declares an optional utf-8-validate peer. All Node versions Harper supports
// provide buffer.isUtf8, which ws uses instead of that addon. A development dependency
// can install the addon into a shared location that ws keeps reachable after dev pruning.
// Sever only optional peer references: an explicit dependency or optionalDependency on
// the addon is preserved, since that consumer may actually use it.
//
// Deliberately surgical: it computes the set of packages reachable *with* the
// dispensable edges and the set reachable *without* them, and deletes only the
// difference, so the removed set is derived rather than a hardcoded list of directory
// names that would silently rot as alasql's tree shifts.
//
// For react-native-fs, only edges declared as an `optionalDependency` are severed. A package
// that hard-depends on react-native-fs keeps it alive for the whole tree — otherwise
// severing every edge by name would delete a package another dependent still requires and
// leave that requirement dangling. Belt and braces, the result is checked for unresolved
// *required* edges before it is written, so a bad prune fails the build instead of
// shipping a broken shrinkwrap to every consumer.
//
// Retire the React Native rule when alasql no longer installs the unused subtree.
// Retire the UTF-8 rule after the dev framework's Harper peer updates to a release without
// the addon and the full lock has no explicit dependency or required peer producing it.
//
// Usage: node build-tools/prune-shrinkwrap-react-native.mjs [npm-shrinkwrap.json]
import { readFileSync, writeFileSync } from 'node:fs';

const SEVER = 'react-native-fs';
const OPTIONAL_PEER = 'utf-8-validate';
const TARGETS = `${SEVER} or optional ${OPTIONAL_PEER} peers`;

const file = process.argv[2] ?? 'npm-shrinkwrap.json';
const lock = JSON.parse(readFileSync(file, 'utf8'));

if (lock.lockfileVersion !== 3 || !lock.packages) {
	throw new Error(`unsupported lockfileVersion ${lock.lockfileVersion}; expected 3 with a "packages" map`);
}

// Resolve `name` as required by the package at `from`, following node_modules lookup:
// <from>/node_modules/<name>, then the same at each ancestor, ending at the root.
function resolve(from, name) {
	const segments = from === '' ? [] : from.split('/node_modules/');
	for (let depth = segments.length; depth >= 0; depth--) {
		const prefix = segments.slice(0, depth).join('/node_modules/');
		const candidate = `${prefix ? `${prefix}/` : ''}node_modules/${name}`;
		if (lock.packages[candidate]) return candidate;
	}
	return null;
}

function requiredBy(key) {
	const entry = lock.packages[key] ?? {};
	return Object.keys({ ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies });
}

// An optional utf-8-validate peer is dispensable only without any explicit dependency
// declaration on the same consumer. All required peers and other optional peers survive.
function isSeverableEdge(key, name) {
	const entry = lock.packages[key] ?? {};
	if (name === SEVER) {
		return entry.optionalDependencies?.[name] !== undefined && entry.dependencies?.[name] === undefined;
	}
	return (
		name === OPTIONAL_PEER &&
		entry.peerDependencies?.[name] !== undefined &&
		entry.peerDependenciesMeta?.[name]?.optional === true &&
		entry.dependencies?.[name] === undefined &&
		entry.optionalDependencies?.[name] === undefined
	);
}

// Walk the tree from the root manifest, skipping dispensable edges named in `sever`.
function reachableFromRoot(sever = new Set()) {
	const seen = new Set();
	const queue = [''];
	while (queue.length > 0) {
		const key = queue.pop();
		for (const name of requiredBy(key)) {
			if (sever.has(name) && isSeverableEdge(key, name)) continue;
			const target = resolve(key, name);
			if (target && !seen.has(target)) {
				seen.add(target);
				queue.push(target);
			}
		}
	}
	return seen;
}

// Required edges that already fail to resolve before we touch anything. A published
// shrinkwrap can legitimately carry some (npm omits platform-specific entries), and they
// are not ours to fail the build over — only edges *we* break are.
function danglingRequiredEdges() {
	const dangling = new Set();
	for (const [key, entry] of Object.entries(lock.packages)) {
		for (const name of Object.keys(entry.dependencies ?? {})) {
			if (!resolve(key, name)) dangling.add(`${key || '<root>'} -> ${name}`);
		}
	}
	return dangling;
}

const withEdge = reachableFromRoot();
const withoutReactNative = reachableFromRoot(new Set([SEVER]));
const withoutEdge = reachableFromRoot(new Set([SEVER, OPTIONAL_PEER]));
const danglingBefore = danglingRequiredEdges();

let removed = 0;
for (const key of withEdge) {
	if (withoutEdge.has(key)) continue; // reachable another way — leave it alone
	delete lock.packages[key];
	removed++;
}

// No package reachable from the root can trip this: anything a surviving package requires
// is reachable without the severed edge, so it is never removed. Entries the root walk
// never reaches can, though — most usefully when this runs on a shrinkwrap that still has
// its devDependencies, since the walk only follows production edges and dev entries
// pointing into the react-native subtree then look newly broken. That is why build.sh
// prunes dev first, and why this fails the build rather than writing the file.
const introduced = [...danglingRequiredEdges()].filter((edge) => !danglingBefore.has(edge));
if (introduced.length > 0) {
	throw new Error(
		`pruning ${TARGETS} left ${introduced.length} required dependenc${introduced.length === 1 ? 'y' : 'ies'} ` +
			`unresolved, refusing to write ${file}:\n  ${introduced.join('\n  ')}\n` +
			`(if this is a full shrinkwrap, run prune-shrinkwrap-dev.mjs first — this expects a production-only tree)`
	);
}

if (removed > 0) {
	writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
}
for (const [target, before, after] of [
	[SEVER, withEdge, withoutReactNative],
	[`optional ${OPTIONAL_PEER} peers`, withoutReactNative, withoutEdge],
]) {
	const count = [...before].filter((key) => !after.has(key)).length;
	if (count === 0) {
		console.log(`No unused ${target} tree found in ${file} — nothing to prune (has it been fixed upstream?)`);
	} else {
		console.log(`Pruned ${count} entries reachable only through ${target} from ${file}`);
	}
}
