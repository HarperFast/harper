#!/usr/bin/env node
// Remove the react-native tree from the shrinkwrap that ships in the published package.
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
// Deliberately surgical: it computes the set of packages reachable *with* the
// react-native-fs edge and the set reachable *without* it, and deletes only the
// difference, so the removed set is derived rather than a hardcoded list of directory
// names that would silently rot as alasql's tree shifts.
//
// Only edges the dependent declared as an `optionalDependency` are severed. A package
// that hard-depends on react-native-fs keeps it alive for the whole tree — otherwise
// severing every edge by name would delete a package another dependent still requires and
// leave that requirement dangling. Belt and braces, the result is checked for unresolved
// *required* edges before it is written, so a bad prune fails the build instead of
// shipping a broken shrinkwrap to every consumer.
//
// Delete this script once react-native-fs marks its react-native peer optional, or once
// alasql stops declaring the optional dependency.
//
// Usage: node build-tools/prune-shrinkwrap-react-native.mjs [npm-shrinkwrap.json]
import { readFileSync, writeFileSync } from 'node:fs';

const SEVER = 'react-native-fs';

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

// Severable only if the dependent declared it optional and does not also hard-depend on
// it. A plain `dependencies` (or non-optional peer) entry is a real requirement, so that
// edge is traversed normally and keeps the package alive for everyone.
function isSeverableEdge(key, name) {
	if (name !== SEVER) return false;
	const entry = lock.packages[key] ?? {};
	return entry.optionalDependencies?.[name] !== undefined && entry.dependencies?.[name] === undefined;
}

// Walk the tree from the root manifest. When `sever` is true, refuse to traverse the
// optional react-native-fs edges, so anything only reachable through them never gets marked.
function reachableFromRoot({ sever }) {
	const seen = new Set();
	const queue = [''];
	while (queue.length > 0) {
		const key = queue.pop();
		for (const name of requiredBy(key)) {
			if (sever && isSeverableEdge(key, name)) continue;
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

const withEdge = reachableFromRoot({ sever: false });
const withoutEdge = reachableFromRoot({ sever: true });
const danglingBefore = danglingRequiredEdges();

let removed = 0;
for (const key of withEdge) {
	if (withoutEdge.has(key)) continue; // reachable another way — leave it alone
	delete lock.packages[key];
	removed++;
}

// With the sever restricted to optional edges this should be unreachable: anything a
// surviving package requires is reachable without the severed edge, so it is never
// removed. It stays as a backstop because the cost of being wrong is a broken install for
// every consumer — fail the build rather than write the file.
const introduced = [...danglingRequiredEdges()].filter((edge) => !danglingBefore.has(edge));
if (introduced.length > 0) {
	throw new Error(
		`pruning ${SEVER} left ${introduced.length} required dependenc${introduced.length === 1 ? 'y' : 'ies'} ` +
			`unresolved, refusing to write ${file}:\n  ${introduced.join('\n  ')}`
	);
}

if (removed === 0) {
	console.log(`No ${SEVER} tree found in ${file} — nothing to prune (has it been fixed upstream?)`);
} else {
	writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
	console.log(`Pruned ${removed} entries reachable only through ${SEVER} from ${file}`);
}
