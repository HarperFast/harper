// Builds the optional hnsw-plane NAPI module in place (`npm run build:hnsw-plane`); harper
// installs never require a cargo toolchain — without the artifact, nativePlane falls back to
// the JS path.
import { execSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const crateRoot = dirname(fileURLToPath(import.meta.url));
// build the lib alone: the bench bin cannot link against unresolved node-api symbols
execSync('cargo build --release --features napi --lib', { cwd: crateRoot, stdio: 'inherit' });
const cdylib =
	process.platform === 'win32'
		? 'hnsw_plane.dll'
		: process.platform === 'darwin'
			? 'libhnsw_plane.dylib'
			: 'libhnsw_plane.so';
copyFileSync(join(crateRoot, 'target', 'release', cdylib), join(crateRoot, 'hnsw-plane.node'));
console.log('built native/hnsw-plane/hnsw-plane.node');
