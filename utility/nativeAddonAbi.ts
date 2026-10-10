/**
 * Whether a native addon (`.node`) may load on a V8 pointer-compression Node.js runtime. The rules
 * and why they hold: server/DESIGN.md, "On a pointer-compression Node, no standard-V8-ABI addon is
 * dlopen'ed". Imports only Node builtins: it runs inside process.dlopen before Harper's logger loads,
 * and the logger itself loads a V8 C++ API addon.
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { debuglog } from 'node:util';

export const POINTER_COMPRESSION_MARKER = '.pointer-compression-build';

const ELF_MAGIC = 0x7f454c46;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const ELFDATA2MSB = 2;
const ELF64_HEADER_SIZE = 64;
const ELF64_SECTION_HEADER_SIZE = 64;
const ELF64_SYMBOL_SIZE = 24;
const SHT_STRTAB = 3;
const SHT_DYNSYM = 11;
const SHN_UNDEF = 0;
// Real addons' dynamic tables are kilobytes to a few megabytes; a corrupt size must not allocate gigabytes.
const MAX_TABLE_BYTES = 64 * 1024 * 1024;
const V8_CXX_SYMBOL_PREFIXES = [Buffer.from('_ZN2v8'), Buffer.from('_ZNK2v8')];
const POINTER_COMPRESSION_CONFIG = /"v8_enable_pointer_compression":\s*1\b/;

const debug = debuglog('harper_native_addon');

export function isPointerCompressionRuntime(): boolean {
	return (process.config?.variables as Record<string, unknown>)?.v8_enable_pointer_compression === 1;
}

export type AddonSymbolScan =
	{ kind: 'not-elf64' } | { kind: 'uninspectable'; detail: string } | { kind: 'scanned'; v8SymbolCount: number };

const NOT_ELF64: AddonSymbolScan = { kind: 'not-elf64' };
const uninspectable = (detail: string): AddonSymbolScan => ({ kind: 'uninspectable', detail });

/**
 * Counts the undefined V8 C++ symbols (mangled `_ZN2v8…` / `_ZNK2v8…`) in a 64-bit ELF file's
 * dynamic symbol table, reading only the ELF header, section headers, `.dynsym` and its string table.
 */
export function scanUndefinedV8Symbols(file: string): AddonSymbolScan {
	const fd = openSync(file, 'r');
	try {
		return scanDescriptor(fd, fstatSync(fd).size);
	} finally {
		closeSync(fd);
	}
}

function scanDescriptor(fd: number, fileSize: number): AddonSymbolScan {
	const header = readExactly(fd, 0, ELF64_HEADER_SIZE, fileSize);
	if (
		!header ||
		header.readUInt32BE(0) !== ELF_MAGIC ||
		header[4] !== ELFCLASS64 ||
		(header[5] !== ELFDATA2LSB && header[5] !== ELFDATA2MSB)
	)
		return NOT_ELF64;
	const littleEndian = header[5] === ELFDATA2LSB;
	const u16 = (buffer: Buffer, at: number) => (littleEndian ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at));
	const u32 = (buffer: Buffer, at: number) => (littleEndian ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
	const u64 = (buffer: Buffer, at: number) =>
		Number(littleEndian ? buffer.readBigUInt64LE(at) : buffer.readBigUInt64BE(at));

	const sectionTableOffset = u64(header, 0x28);
	const sectionEntrySize = u16(header, 0x3a);
	const sectionCount = u16(header, 0x3c);
	if (sectionTableOffset === 0 || sectionCount === 0) return uninspectable('no section headers');
	if (sectionEntrySize < ELF64_SECTION_HEADER_SIZE) return uninspectable(`section header size ${sectionEntrySize}`);
	const sections = readExactly(fd, sectionTableOffset, sectionCount * sectionEntrySize, fileSize);
	if (!sections) return uninspectable('section headers out of bounds');

	let dynsymAt = -1;
	for (let index = 0; index < sectionCount; index++) {
		if (u32(sections, index * sectionEntrySize + 4) === SHT_DYNSYM) {
			dynsymAt = index * sectionEntrySize;
			break;
		}
	}
	if (dynsymAt < 0) return uninspectable('no .dynsym section');
	const stringSectionIndex = u32(sections, dynsymAt + 0x28);
	if (stringSectionIndex >= sectionCount) return uninspectable('.dynsym string table index out of range');
	const stringsAt = stringSectionIndex * sectionEntrySize;
	if (u32(sections, stringsAt + 4) !== SHT_STRTAB) return uninspectable('.dynsym string table is not SHT_STRTAB');
	const symbolEntrySize = u64(sections, dynsymAt + 0x38);
	const symbolTableSize = u64(sections, dynsymAt + 0x20);
	if (symbolEntrySize !== ELF64_SYMBOL_SIZE || symbolTableSize === 0 || symbolTableSize % ELF64_SYMBOL_SIZE !== 0)
		return uninspectable(`.dynsym of ${symbolTableSize} bytes in ${symbolEntrySize}-byte entries`);
	const symbols = readExactly(fd, u64(sections, dynsymAt + 0x18), symbolTableSize, fileSize);
	const strings = readExactly(fd, u64(sections, stringsAt + 0x18), u64(sections, stringsAt + 0x20), fileSize);
	if (!symbols || !strings) return uninspectable('.dynsym or its string table out of bounds');

	let v8SymbolCount = 0;
	// entry 0 is the reserved null symbol
	for (let at = ELF64_SYMBOL_SIZE; at < symbols.length; at += ELF64_SYMBOL_SIZE) {
		if (u16(symbols, at + 6) !== SHN_UNDEF) continue;
		const nameAt = u32(symbols, at);
		if (nameAt >= strings.length) return uninspectable('symbol name out of bounds');
		if (V8_CXX_SYMBOL_PREFIXES.some((prefix) => startsWithAt(strings, nameAt, prefix))) v8SymbolCount++;
	}
	return { kind: 'scanned', v8SymbolCount };
}

function readExactly(fd: number, position: number, length: number, fileSize: number): Buffer | undefined {
	if (length > MAX_TABLE_BYTES || position + length > fileSize) return undefined;
	const buffer = Buffer.allocUnsafe(length);
	return readSync(fd, buffer, 0, length, position) === length ? buffer : undefined;
}

function startsWithAt(buffer: Buffer, at: number, prefix: Buffer): boolean {
	return at + prefix.length <= buffer.length && buffer.compare(prefix, 0, prefix.length, at, at + prefix.length) === 0;
}

export type NativeAddonVerdictReason =
	| 'node-api'
	| 'not-elf64'
	| 'pointer-compression-marker'
	| 'pointer-compression-build'
	| 'v8-cxx-abi'
	| 'uninspectable';

export interface NativeAddonVerdict {
	loadable: boolean;
	reason: NativeAddonVerdictReason;
	scan: AddonSymbolScan;
	/** Nearest ancestor directory with a package.json, if any. */
	packageDirectory?: string;
}

/** Applies the pointer-compression load rules to `file` (expected to be a real path). Uncached. */
export function checkNativeAddon(file: string): NativeAddonVerdict {
	const fd = openSync(file, 'r');
	try {
		return checkDescriptor(file, fd, fstatSync(fd));
	} finally {
		closeSync(fd);
	}
}

function checkDescriptor(file: string, fd: number, fileStats: Stats): NativeAddonVerdict {
	const scan = scanDescriptor(fd, fileStats.size);
	if (scan.kind === 'scanned' && scan.v8SymbolCount === 0) return { loadable: true, reason: 'node-api', scan };
	const packageDirectory = findPackageDirectory(file);
	if (existsSync(join(packageDirectory ?? dirname(file), POINTER_COMPRESSION_MARKER)))
		return { loadable: true, reason: 'pointer-compression-marker', scan, packageDirectory };
	if (isPointerCompressionBuild(file, fileStats, packageDirectory))
		return { loadable: true, reason: 'pointer-compression-build', scan, packageDirectory };
	if (scan.kind === 'not-elf64') return { loadable: true, reason: 'not-elf64', scan, packageDirectory };
	return { loadable: false, reason: scan.kind === 'scanned' ? 'v8-cxx-abi' : 'uninspectable', scan, packageDirectory };
}

function findPackageDirectory(file: string): string | undefined {
	for (let directory = dirname(file); basename(directory) !== 'node_modules';) {
		if (existsSync(join(directory, 'package.json'))) return directory;
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

function isPointerCompressionBuild(file: string, fileStats: Stats, packageDirectory: string | undefined): boolean {
	for (let directory = dirname(file); directory !== packageDirectory;) {
		if (basename(directory) === 'build') {
			const configPath = join(directory, 'config.gypi');
			const configStats = statSync(configPath, { throwIfNoEntry: false });
			// strictly newer: configure writes config.gypi before compiling, so a failed compile leaves an older binary
			if (!configStats || configStats.mtimeMs >= fileStats.mtimeMs) return false;
			try {
				return POINTER_COMPRESSION_CONFIG.test(readFileSync(configPath, 'utf8'));
			} catch {
				return false; // an unreadable config.gypi (or a directory by that name) is not evidence
			}
		}
		const parent = dirname(directory);
		if (parent === directory) return false;
		directory = parent;
	}
	return false;
}

/** Thrown in place of loading a native addon that would crash a pointer-compression runtime. */
export class IncompatibleNativeAddonError extends Error {
	statusCode: number;
	code: string;
	constructor(file: string, verdict: NativeAddonVerdict) {
		const packageName = readPackageName(verdict.packageDirectory);
		const subject = `Native addon ${file}${packageName ? ` (package ${packageName})` : ''}`;
		const problem =
			verdict.scan.kind === 'uninspectable'
				? `could not be checked for V8 C++ API use (${verdict.scan.detail}), and on this pointer-compression Node.js runtime an unchecked addon could crash the process on first use`
				: `links V8's C++ API built for the standard Node.js ABI, which this pointer-compression Node.js runtime does not share; loading it would crash the process on first use`;
		super(
			`${subject} ${problem}. Install a Node-API version of ${packageName ?? 'the package'} or a build compiled ` +
				`for pointer compression, rebuild it from source under this Node.js ` +
				`(npm rebuild ${packageName ?? '<package>'} --build-from-source), or run on a standard Node.js build.`
		);
		this.name = 'IncompatibleNativeAddonError';
		this.statusCode = 500;
		// Node's code for an addon it could not load, so existing fallbacks treat a refusal the same way
		this.code = 'ERR_DLOPEN_FAILED';
	}
}

function readPackageName(packageDirectory: string | undefined): string | undefined {
	if (!packageDirectory) return undefined;
	try {
		return JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')).name;
	} catch {
		return undefined; // only names the package in the message
	}
}

// realpath → dev:ino:size:mtime of the binary that was admitted; refusals are re-checked on every attempt
const admittedAddons = new Map<string, string>();

/** Throws IncompatibleNativeAddonError unless `file` may load on a pointer-compression runtime. */
export function assertNativeAddonLoadable(file: string): void {
	let realFile: string;
	let fd: number;
	try {
		realFile = realpathSync(file);
		fd = openSync(realFile, 'r');
	} catch {
		return; // a missing or unreadable file is reported by dlopen itself
	}
	try {
		// identity of the descriptor that is scanned, so a path swapped mid-check cannot be cached as admitted
		const fileStats = fstatSync(fd);
		if (!fileStats.isFile()) return; // dlopen reports a directory or device itself
		const identity = `${fileStats.dev}:${fileStats.ino}:${fileStats.size}:${fileStats.mtimeMs}`;
		if (admittedAddons.get(realFile) === identity) return;
		const verdict = checkDescriptor(realFile, fd, fileStats);
		if (!verdict.loadable) throw new IncompatibleNativeAddonError(realFile, verdict);
		if (verdict.reason === 'not-elf64') debug('admitting %s: not a 64-bit ELF file', realFile);
		admittedAddons.set(realFile, identity);
	} finally {
		closeSync(fd);
	}
}
