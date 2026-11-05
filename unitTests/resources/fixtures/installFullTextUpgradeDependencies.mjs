import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const [root, ...requestedVersions] = process.argv.slice(2);
const supportedVersions = ['0.5.0', '0.7.0', '0.8.0'];
const versions = requestedVersions.length ? requestedVersions : supportedVersions;
assert(
	versions.every((version) => supportedVersions.includes(version)) && new Set(versions).size === versions.length,
	'Unsupported or duplicate historical full-text version'
);
assert(root && isAbsolute(root), 'Pass an absolute scratch root for the historical full-text engines');
const source = join(dirname(fileURLToPath(import.meta.url)), 'fulltext-upgrade');
const destination = relative(resolve(source, '../../../..'), root);
assert(
	destination === '..' || destination.startsWith(`..${sep}`) || isAbsolute(destination),
	'Install historical engines outside the Harper checkout'
);
assert(process.env.npm_execpath, 'Run through npm run test:fulltext:install-previous -- ROOT');

for (const version of versions) {
	const prefix = join(root, version);
	mkdirSync(prefix, { recursive: true });
	for (const file of ['package.json', 'package-lock.json'])
		copyFileSync(join(source, version, file), join(prefix, file));
	execFileSync(
		process.execPath,
		[
			process.env.npm_execpath,
			'ci',
			'--ignore-scripts',
			'--include=optional',
			'--no-audit',
			'--no-fund',
			'--prefix',
			prefix,
		],
		{ stdio: 'inherit', timeout: 120_000 }
	);
}
