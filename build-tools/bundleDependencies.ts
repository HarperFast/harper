import { execFileSync } from 'node:child_process';
import {
	closeSync,
	cpSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

type Package = {
	name?: string;
	version?: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
	bundleDependencies?: string[];
	devDependencies?: Record<string, string>;
	files?: string[];
	scripts?: Record<string, string>;
	os?: string[];
	cpu?: string[];
	libc?: string[];
	engines?: Record<string, string>;
	gypfile?: boolean;
	addon?: boolean;
	hasInstallScript?: boolean;
};
type Lock = { lockfileVersion: number; packages: Record<string, Package> };

const unbundled = new Set([
	'@datadog/pprof',
	'@harperfast/rocksdb-js',
	'@harperfast/extended-iterable',
	'argon2',
	'cbor-x',
	'lmdb',
	'msgpackr',
	'ordered-binary',
	're2',
	'structon',
	'systeminformation',
	'tar-fs',
	'tar-stream',
	'weak-lru-cache',
	'ws',
]);
const engineModules = {
	'@harperfast/rocksdb-js': ['@harperfast/extended-iterable', 'ordered-binary', 'msgpackr'],
	'lmdb': ['@harperfast/extended-iterable', 'ordered-binary'],
};

function readJson(file: string) {
	return JSON.parse(readFileSync(file, 'utf8'));
}

function readLock(file: string): Lock {
	const lock = readJson(file);
	if (lock.lockfileVersion !== 3 || !lock.packages?.['']) {
		throw new Error('Expected lockfileVersion 3 with a root packages entry');
	}
	return lock;
}

function severed(entry: Package, name: string) {
	if (entry.dependencies?.[name] !== undefined) return false;
	if (name === 'react-native-fs') {
		return (
			entry.optionalDependencies?.[name] !== undefined &&
			(entry.peerDependencies?.[name] === undefined || entry.peerDependenciesMeta?.[name]?.optional === true)
		);
	}
	return (
		name === 'utf-8-validate' &&
		entry.optionalDependencies?.[name] === undefined &&
		entry.peerDependenciesMeta?.[name]?.optional === true
	);
}

function optionalPeerOnly(entry: Package, name: string) {
	return (
		entry.dependencies?.[name] === undefined &&
		entry.optionalDependencies?.[name] === undefined &&
		entry.peerDependenciesMeta?.[name]?.optional === true
	);
}

function resolvePackage(packages: Record<string, Package>, from: string, name: string) {
	const segments = from ? from.split('/node_modules/') : [];
	for (let depth = segments.length; depth >= 0; depth--) {
		const prefix = segments.slice(0, depth).join('/node_modules/');
		const candidate = `${prefix ? `${prefix}/` : ''}node_modules/${name}`;
		if (packages[candidate]) return candidate;
	}
}

function nativeManifest(entry: Package) {
	return (
		entry.os ||
		entry.cpu ||
		entry.libc ||
		entry.gypfile ||
		entry.addon ||
		entry.hasInstallScript ||
		entry.engines?.bare ||
		['preinstall', 'install', 'postinstall'].some((hook) => entry.scripts?.[hook])
	);
}

export function bundlePlan(lock: Lock) {
	const root = lock.packages[''];
	for (const [engine, names] of Object.entries(engineModules)) {
		if (!root.dependencies?.[engine] && !root.optionalDependencies?.[engine]) continue;
		const key = resolvePackage(lock.packages, '', engine);
		for (const name of names) {
			if (!key || !lock.packages[key].dependencies?.[name]) {
				throw new Error(`${engine} no longer declares ${name} — update the shared-module contract`);
			}
		}
	}
	const roots = Object.keys(root.dependencies ?? {}).filter((name) => !unbundled.has(name));
	if (!roots.length) throw new Error('Expected at least one bundled dependency');
	const packages = new Set<string>();
	const pending = roots.map((name) => {
		const key = resolvePackage(lock.packages, '', name);
		if (!key) throw new Error(`Missing locked dependency ${name}`);
		return key;
	});
	while (pending.length) {
		const key = pending.pop()!;
		if (packages.has(key)) continue;
		packages.add(key);
		const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
		if (unbundled.has(name)) throw new Error(`Bundle reaches intentionally unbundled dependency ${key}`);
		const entry = lock.packages[key];
		if (nativeManifest(entry)) throw new Error(`Cannot bundle native or platform dependency ${key}`);
		for (const name of Object.keys({
			...entry.dependencies,
			...entry.optionalDependencies,
			...entry.peerDependencies,
		})) {
			if (severed(entry, name) || optionalPeerOnly(entry, name)) continue;
			const target = resolvePackage(lock.packages, key, name);
			if (target) pending.push(target);
			else if (
				entry.dependencies?.[name] !== undefined ||
				entry.optionalDependencies?.[name] !== undefined ||
				!entry.peerDependenciesMeta?.[name]?.optional
			) {
				throw new Error(`Missing locked dependency ${key} -> ${name}`);
			}
		}
	}
	const external = Object.fromEntries(
		Object.keys({ ...root.dependencies, ...root.optionalDependencies })
			.filter((name) => !roots.includes(name))
			.map((name) => {
				const spec = root.optionalDependencies?.[name] ?? root.dependencies?.[name];
				if (!spec || /[:/@]/.test(spec) || /\.(?:tgz|tar(?:\.gz)?)$/.test(spec)) {
					throw new Error(`Cannot replace non-registry dependency ${name} with an exact registry version`);
				}
				const key = resolvePackage(lock.packages, '', name);
				const version = key && lock.packages[key].version;
				if (!version) throw new Error(`Missing locked version for ${name}`);
				return [name, version];
			})
	);
	return { roots, packages, external };
}

function checkNativeFiles(directory: string) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === 'node_modules') continue;
		const file = join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Cannot bundle symbolic link ${file}`);
		if (entry.isDirectory()) {
			checkNativeFiles(file);
			continue;
		}
		if (/\.(?:node|bare|dll|dylib|exe|so(?:\.\d+)*)$/.test(entry.name) || entry.name === 'binding.gyp') {
			throw new Error(`Cannot bundle native file ${file}`);
		}
		const signature = Buffer.alloc(4);
		const descriptor = openSync(file, 'r');
		let portableExecutable = false;
		try {
			readSync(descriptor, signature, 0, 4, 0);
			if (signature.subarray(0, 2).toString() === 'MZ') {
				const header = Buffer.alloc(64);
				if (readSync(descriptor, header, 0, header.length, 0) === header.length) {
					const offset = header.readUInt32LE(60);
					const peSignature = Buffer.alloc(4);
					portableExecutable =
						offset >= header.length &&
						readSync(descriptor, peSignature, 0, 4, offset) === 4 &&
						peSignature.equals(Buffer.from([0x50, 0x45, 0, 0]));
				}
			}
		} finally {
			closeSync(descriptor);
		}
		if (
			[
				'7f454c46',
				'feedface',
				'feedfacf',
				'cefaedfe',
				'cffaedfe',
				'cafebabe',
				'bebafeca',
				'cafebabf',
				'bfbafeca',
			].includes(signature.toString('hex')) ||
			portableExecutable
		) {
			throw new Error(`Cannot bundle native executable ${file}`);
		}
	}
}

export function prepareBundle(source: string, destination: string) {
	source = resolve(source);
	destination = resolve(destination);
	if (dirname(destination) === destination || source === destination || source.startsWith(destination + sep)) {
		throw new Error('Bundle destination must not contain the source');
	}
	const lock = readLock(join(source, 'package-lock.json'));
	const plan = bundlePlan(lock);
	const marker = join(destination, '.harper-bundle-stage.json');
	if (existsSync(destination) && (!existsSync(marker) || readJson(marker).source !== source)) {
		throw new Error(`Destination is not an owned bundle stage: ${destination}`);
	}
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(destination, { recursive: true });
	writeFileSync(marker, JSON.stringify({ source }) + '\n');
	const packed = JSON.parse(
		execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
			cwd: source,
			encoding: 'utf8',
			timeout: 120_000,
		})
	);
	const stage = join(destination, 'package');
	mkdirSync(stage);
	const artifact = Array.isArray(packed) ? packed[0] : packed[lock.packages[''].name!];
	if (!artifact?.filename) throw new Error('npm pack did not report a package filename');
	execFileSync('tar', ['-xzf', join(destination, artifact.filename), '--strip-components=1', '-C', stage]);
	rmSync(join(stage, 'node_modules'), { recursive: true, force: true });
	rmSync(join(stage, 'npm-shrinkwrap.json'), { force: true });
	const manifest: Package = readJson(join(stage, 'package.json'));
	delete manifest.devDependencies;
	manifest.bundleDependencies = plan.roots;
	manifest.files = manifest.files?.filter((file) => file !== 'npm-shrinkwrap.json');
	for (const [name, version] of Object.entries(plan.external)) {
		const group = manifest.optionalDependencies?.[name] ? 'optionalDependencies' : 'dependencies';
		manifest[group][name] = version;
	}
	writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
	for (const key of plan.packages) {
		const original = join(source, key);
		const entry: Package = readJson(join(original, 'package.json'));
		if (entry.version !== lock.packages[key].version)
			throw new Error(`Installed ${key} differs from package-lock.json`);
		if (nativeManifest(entry)) throw new Error(`Cannot bundle native or platform dependency ${key}`);
		checkNativeFiles(original);
		const target = join(stage, key);
		cpSync(original, target, {
			recursive: true,
			filter: (file) => file === original || basename(file) !== 'node_modules',
		});
		for (const name of Object.keys({ ...entry.optionalDependencies, ...entry.peerDependencies })) {
			if (!severed(entry, name)) continue;
			delete entry.optionalDependencies?.[name];
			delete entry.peerDependencies?.[name];
			delete entry.peerDependenciesMeta?.[name];
		}
		writeFileSync(join(target, 'package.json'), JSON.stringify(entry, null, 2) + '\n');
	}
	checkBundle(stage, join(source, 'package-lock.json'));
	return stage;
}

function installedPackage(from: string, name: string) {
	for (let directory = resolve(from); ; directory = dirname(directory)) {
		const file = join(directory, 'node_modules', name, 'package.json');
		if (existsSync(file)) return file;
		if (dirname(directory) === directory) return;
	}
}

function packagePaths(root: string, prefix = 'node_modules'): string[] {
	if (!existsSync(join(root, prefix))) return [];
	const paths: string[] = [];
	for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
		if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
		const key = `${prefix}/${entry.name}`;
		if (entry.name.startsWith('@')) paths.push(...packagePaths(root, key));
		else {
			paths.push(key);
			paths.push(...packagePaths(root, `${key}/node_modules`));
		}
	}
	return paths;
}

export function checkBundle(root: string, lockFile: string, installed = false) {
	root = resolve(root);
	const lock = readLock(lockFile);
	const plan = bundlePlan(lock);
	const manifest: Package = readJson(join(root, 'package.json'));
	if (manifest.name !== lock.packages[''].name || manifest.version !== lock.packages[''].version) {
		throw new Error('Release identity differs from package-lock.json');
	}
	if (existsSync(join(root, 'npm-shrinkwrap.json'))) throw new Error('Release must not contain npm-shrinkwrap.json');
	if (JSON.stringify(manifest.bundleDependencies?.toSorted()) !== JSON.stringify(plan.roots.toSorted())) {
		throw new Error('Release bundleDependencies differ from the production bundle plan');
	}
	if (!installed) {
		for (const key of packagePaths(root)) {
			if (!plan.packages.has(key)) throw new Error(`Unexpected bundled package ${key}`);
		}
	}
	for (const key of plan.packages) {
		const directory = join(root, key);
		const entry: Package = readJson(join(directory, 'package.json'));
		if (entry.version !== lock.packages[key].version) throw new Error(`Bundled ${key} differs from package-lock.json`);
		if (nativeManifest(entry)) throw new Error(`Cannot bundle native or platform dependency ${key}`);
		checkNativeFiles(directory);
		const locked = lock.packages[key];
		for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
			for (const name of new Set([...Object.keys(entry[group] ?? {}), ...Object.keys(locked[group] ?? {})])) {
				const expected = severed(locked, name) ? undefined : locked[group]?.[name];
				if (entry[group]?.[name] !== expected) {
					throw new Error(`Bundled ${key} ${group} declaration for ${name} differs from package-lock.json`);
				}
			}
		}
		for (const name of Object.keys(locked.peerDependencies ?? {})) {
			if (
				!severed(locked, name) &&
				Boolean(entry.peerDependenciesMeta?.[name]?.optional) !== Boolean(locked.peerDependenciesMeta?.[name]?.optional)
			) {
				throw new Error(`Bundled ${key} peer optionality for ${name} differs from package-lock.json`);
			}
		}
		for (const name of Object.keys({
			...entry.dependencies,
			...entry.optionalDependencies,
			...entry.peerDependencies,
		})) {
			if (severed(entry, name)) throw new Error(`Unused optional dependency ${key} -> ${name} remains declared`);
			if (optionalPeerOnly(entry, name)) continue;
			const target = resolvePackage(lock.packages, key, name);
			if (target && !plan.packages.has(target)) throw new Error(`Bundle is not closed: ${key} -> ${name}`);
		}
	}
	for (const name of plan.roots) {
		if (manifest.dependencies?.[name] !== lock.packages[''].dependencies?.[name]) {
			throw new Error(`Bundled ${name} declaration differs from package-lock.json`);
		}
		const location = realpathSync(installedPackage(root, name)!);
		if (!location.startsWith(realpathSync(join(root, 'node_modules')) + sep)) {
			throw new Error(`${name} resolves outside the dependency bundle`);
		}
	}
	for (const [name, version] of Object.entries(plan.external)) {
		if ((manifest.optionalDependencies?.[name] ?? manifest.dependencies?.[name]) !== version) {
			throw new Error(`Unbundled ${name} must be exact-pinned to ${version}`);
		}
		if (!installed) continue;
		const file = installedPackage(root, name);
		if (!file && manifest.optionalDependencies?.[name]) continue;
		if (!file || readJson(file).version !== version)
			throw new Error(`Installed ${name} differs from its exact pin ${version}`);
	}
	if (installed) {
		const requireFromRoot = createRequire(join(root, 'package.json'));
		for (const [engine, names] of Object.entries(engineModules)) {
			const file = installedPackage(root, engine);
			if (!file) continue;
			const requireFromEngine = createRequire(realpathSync(file));
			for (const name of names) {
				if (realpathSync(requireFromEngine.resolve(name)) !== realpathSync(requireFromRoot.resolve(name))) {
					throw new Error(`${engine} and Harper resolve separate ${name} instances`);
				}
			}
		}
	}
	return { roots: plan.roots.length, packages: plan.packages.size };
}

if (
	process.argv[1] &&
	existsSync(process.argv[1]) &&
	realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
	const [command, root, target] = process.argv.slice(2);
	if (!root || !target || !['prepare', 'check', 'installed'].includes(command)) {
		throw new Error(
			'Usage: bundleDependencies.ts prepare <source> <destination> | check|installed <package-root> <lockfile>'
		);
	}
	console.log(command === 'prepare' ? prepareBundle(root, target) : checkBundle(root, target, command === 'installed'));
}
