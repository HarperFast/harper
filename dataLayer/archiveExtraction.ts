import { createReadStream } from 'node:fs';
import { mkdir, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { Transform, type Readable, type Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import gunzip from 'gunzip-maybe';
import { extract as tarExtract, type Headers } from 'tar-stream';
import { ClientError } from '../utility/errors/hdbError.ts';
import { HTTP_STATUS_CODES } from '../utility/errors/commonErrors.ts';
import {
	ARCHIVE_MANIFEST_ENTRY,
	assertArchiveRestorable,
	parseArchiveManifest,
	type BackupArchiveManifest,
} from './backupArchiveManifest.ts';
import type { DiskLedger } from './diskLedger.ts';

export interface ArchiveLimits {
	maxEntries: number;
	/** UTF-8 bytes of an entry name. */
	maxPathBytes: number;
	maxEntryBytes: number;
	/** Payload bytes across all entries, metered as they inflate. */
	maxTotalBytes: number;
	maxManifestBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
	maxEntries: 1_000_000,
	maxPathBytes: 1024,
	maxEntryBytes: 256 * 1024 ** 3,
	maxTotalBytes: 4 * 1024 ** 4,
	maxManifestBytes: 1024 * 1024,
});

// Inflated bytes that are not entry payload: headers, padding, pax records, end markers (the
// get_backup archive carries an intermediate one), a blocking-factor tail, and what is buffered
// between the meter and the entry loop. Anything past this allowance is a stream that inflates
// without producing entries — zero blocks, which tar-stream skips, or oversized long headers.
const OVERHEAD_PER_ENTRY = 8 * 1024;
const OVERHEAD_FIXED = 1024 * 1024;

const TAR_BLOCK = 512;

export interface ArchiveTally {
	/** Block-rounded bytes extraction will charge: every file in whole `bsize` blocks, one block per directory. */
	bytes: number;
	/** Raw payload bytes. */
	payloadBytes: number;
	entries: number;
	files: number;
	/** Distinct directories extraction creates, including those only implied by an entry's path. */
	directories: number;
	inodes: number;
	firstEntryName: string | null;
	/** The parsed manifest when the first entry is `harper-backup.json`. */
	manifest: BackupArchiveManifest | null;
}

export interface ExtractOptions {
	ledger: DiskLedger;
	limits?: Partial<ArchiveLimits>;
	/** Accept an archive whose first entry is not `harper-backup.json` (one produced before manifests). */
	allowMissingManifest?: boolean;
	/** Passed to `assertArchiveRestorable`: waive a newer manifest schema major. */
	acceptIncompatible?: boolean;
	/** Writer for a file already created exclusively; replaceable to simulate a failing device. It may take ownership of the handle. */
	createWriteStream?: (handle: FileHandle) => Writable;
}

export interface ExtractResult {
	manifest: BackupArchiveManifest | null;
	/** What `acceptIncompatible` waived; empty when nothing was. */
	waived: string[];
	entries: number;
	files: number;
	directories: number;
	/** Raw payload bytes written. */
	bytes: number;
	/** Block-rounded bytes charged to the ledger. */
	chargedBytes: number;
}

type EntryKind = 'file' | 'directory' | 'implied';

interface WalkHandlers {
	beforeEntry?(relativePath: string, header: Headers, index: number): void;
	onDirectory(relativePath: string, segments: string[]): Promise<void>;
	onFile(relativePath: string, segments: string[], header: Headers, stream: Readable, index: number): Promise<void>;
}

/**
 * One streaming inflate of the archive, computing exactly what {@link extractArchive} will charge,
 * with the same entry checks. A hostile header can still lie about nothing it is not held to:
 * extraction meters the actual bytes.
 */
export async function tallyArchive(
	archivePath: string,
	{ bsize, limits }: { bsize: number; limits?: Partial<ArchiveLimits> }
): Promise<ArchiveTally> {
	const effective = { ...DEFAULT_ARCHIVE_LIMITS, ...limits };
	const tally: ArchiveTally = {
		bytes: 0,
		payloadBytes: 0,
		entries: 0,
		files: 0,
		directories: 0,
		inodes: 0,
		firstEntryName: null,
		manifest: null,
	};
	const walk = await walkArchive(archivePath, effective, {
		async onDirectory() {
			tally.directories++;
			tally.bytes += bsize;
		},
		async onFile(relativePath, _segments, header, stream, index) {
			if (index === 0 && relativePath === ARCHIVE_MANIFEST_ENTRY) {
				tally.manifest = parseArchiveManifest((await readManifest(stream, header, effective)).toString('utf8'));
			} else {
				await drain(stream);
			}
			tally.files++;
			tally.payloadBytes += header.size;
			tally.bytes += Math.ceil(header.size / bsize) * bsize;
		},
	});
	tally.entries = walk.entries;
	tally.firstEntryName = walk.firstEntryName;
	tally.inodes = tally.files + tally.directories;
	return tally;
}

/**
 * Extract a Harper backup archive under `destDir` (which must exist), entry by entry: only regular
 * files and directories, no absolute or `..` paths, no two names that a case-insensitive or
 * normalization-insensitive filesystem would merge, every entry charged to the ledger before it is
 * written, every file created exclusively. On any failure everything this call created under
 * `destDir` is removed before the error propagates; `destDir` itself and anything already in it are
 * left alone.
 */
export async function extractArchive(
	archivePath: string,
	destDir: string,
	options: ExtractOptions
): Promise<ExtractResult> {
	const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
	const { ledger } = options;
	const openWriter = options.createWriteStream ?? ((handle: FileHandle) => handle.createWriteStream());
	const root = await realpath(destDir);
	const createdTopLevel = new Set<string>();
	const result: ExtractResult = {
		manifest: null,
		waived: [],
		entries: 0,
		files: 0,
		directories: 0,
		bytes: 0,
		chargedBytes: 0,
	};
	const targetFor = (segments: string[]) => {
		const target = join(root, ...segments);
		const fromRoot = relative(root, target);
		if (fromRoot === '' || isAbsolute(fromRoot) || fromRoot.split(/[\\/]/)[0] === '..') {
			throw invalidEntry(segments.join('/'), 'resolves outside the extraction directory');
		}
		return target;
	};
	try {
		const walk = await walkArchive(archivePath, limits, {
			beforeEntry(relativePath, header, index) {
				if (index > 0 || options.allowMissingManifest) return;
				if (header.type === 'file' && relativePath === ARCHIVE_MANIFEST_ENTRY) return;
				throw new ClientError(
					`The archive's first entry must be ${ARCHIVE_MANIFEST_ENTRY}, but it is ${quote(relativePath || header.name)}; ` +
						`it was not produced by a get_backup that records one. Set accept_incompatible_backup to restore it anyway.`
				);
			},
			async onDirectory(relativePath, segments) {
				const target = targetFor(segments);
				result.chargedBytes += await ledger.debitDirectory(root);
				try {
					await mkdir(target);
				} catch (error) {
					throw writeFailure(error, relativePath, destDir);
				}
				createdTopLevel.add(segments[0]);
				result.directories++;
			},
			async onFile(relativePath, segments, header, stream, index) {
				let contents: Buffer | undefined;
				if (index === 0 && relativePath === ARCHIVE_MANIFEST_ENTRY) {
					contents = await readManifest(stream, header, limits);
					result.manifest = parseArchiveManifest(contents.toString('utf8'));
					result.waived = assertArchiveRestorable(result.manifest, {
						acceptIncompatible: options.acceptIncompatible,
					});
				}
				const target = targetFor(segments);
				result.chargedBytes += await ledger.debitEntry(root, header.size);
				let handle: FileHandle;
				try {
					handle = await open(target, 'wx');
				} catch (error) {
					throw writeFailure(error, relativePath, destDir);
				}
				createdTopLevel.add(segments[0]);
				let written = 0;
				const writer = openWriter(handle);
				try {
					if (contents) {
						writer.end(contents);
						await finished(writer);
						written = contents.length;
					} else {
						const meter = new Transform({
							transform(chunk: Buffer, _encoding, callback) {
								written += chunk.length;
								callback(null, chunk);
							},
						});
						await pipeline(stream, meter, writer);
					}
				} catch (error) {
					writer.destroy();
					await finished(writer).catch(() => {});
					throw writeFailure(error, relativePath, destDir);
				} finally {
					// the default writer owns and has closed the handle; a substituted one may not
					await handle.close();
				}
				if (written !== header.size) {
					throw invalidEntry(relativePath, `declared ${header.size} bytes but carried ${written}`);
				}
				result.files++;
				result.bytes += written;
			},
		});
		result.entries = walk.entries;
		if (walk.entries === 0) throw new ClientError('The archive contains no entries');
		return result;
	} catch (error) {
		await Promise.all([...createdTopLevel].map((name) => rm(join(root, name), { recursive: true, force: true })));
		throw error;
	}
}

async function walkArchive(
	archivePath: string,
	limits: ArchiveLimits,
	handlers: WalkHandlers
): Promise<{ entries: number; firstEntryName: string | null }> {
	const seen = new Map<string, { kind: EntryKind; name: string }>();
	let entries = 0;
	let firstEntryName: string | null = null;
	let admittedPayload = 0;
	let inflated = 0;
	const meter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			inflated += chunk.length;
			const allowance = admittedPayload + (entries + 1) * (OVERHEAD_PER_ENTRY + TAR_BLOCK) + OVERHEAD_FIXED;
			if (inflated > allowance) {
				callback(
					new ClientError(
						`The archive inflates to more data than its entries account for (over ${allowance} bytes); refusing it as a decompression bomb`
					)
				);
			} else callback(null, chunk);
		},
	});
	const extract = tarExtract();
	const feed = pipeline(createReadStream(archivePath), gunzip(), meter, extract);
	// surfaced through the iterator or the await below
	feed.catch(() => {});
	try {
		for await (const entry of extract) {
			const header: Headers = (entry as any).header;
			const index = entries++;
			if (entries > limits.maxEntries) {
				throw new ClientError(`The archive has more than ${limits.maxEntries} entries`);
			}
			const segments = entrySegments(header.name, limits);
			const relativePath = segments.join('/');
			if (index === 0) firstEntryName = relativePath;
			handlers.beforeEntry?.(relativePath, header, index);
			if (header.type === 'directory') {
				(entry as Readable).resume();
				if (segments.length === 0) continue;
				await ensureParents(segments, seen, handlers);
				const key = canonical(relativePath);
				const existing = seen.get(key);
				if (existing) {
					if (existing.kind !== 'implied' || existing.name !== relativePath) {
						throw collision(relativePath, existing.name);
					}
					existing.kind = 'directory';
				} else {
					seen.set(key, { kind: 'directory', name: relativePath });
					await handlers.onDirectory(relativePath, segments);
				}
				continue;
			}
			if (header.type !== 'file') {
				throw invalidEntry(
					header.name,
					`is a ${header.type ?? 'unknown-type'} entry; only files and directories are allowed`
				);
			}
			if (segments.length === 0) throw invalidEntry(header.name, 'has no file name');
			if (!(header.size >= 0) || header.size > limits.maxEntryBytes) {
				throw invalidEntry(relativePath, `is ${header.size} bytes; the limit is ${limits.maxEntryBytes}`);
			}
			if (admittedPayload + header.size > limits.maxTotalBytes) {
				throw new ClientError(`The archive's entries exceed ${limits.maxTotalBytes} bytes in total`);
			}
			admittedPayload += header.size;
			await ensureParents(segments, seen, handlers);
			const key = canonical(relativePath);
			const existing = seen.get(key);
			if (existing) throw collision(relativePath, existing.name);
			seen.set(key, { kind: 'file', name: relativePath });
			await handlers.onFile(relativePath, segments, header, entry as Readable, index);
		}
		await feed;
	} catch (error) {
		extract.destroy();
		await feed.catch(() => {});
		throw error;
	}
	return { entries, firstEntryName };
}

async function ensureParents(
	segments: string[],
	seen: Map<string, { kind: EntryKind; name: string }>,
	handlers: WalkHandlers
): Promise<void> {
	for (let depth = 1; depth < segments.length; depth++) {
		const parentSegments = segments.slice(0, depth);
		const parent = parentSegments.join('/');
		const existing = seen.get(canonical(parent));
		if (existing) {
			if (existing.kind === 'file') throw invalidEntry(segments.join('/'), `is inside ${quote(existing.name)}, a file`);
			if (existing.name !== parent) throw collision(parent, existing.name);
			continue;
		}
		seen.set(canonical(parent), { kind: 'implied', name: parent });
		await handlers.onDirectory(parent, parentSegments);
	}
}

function entrySegments(name: string, limits: ArchiveLimits): string[] {
	if (Buffer.byteLength(name, 'utf8') > limits.maxPathBytes) {
		throw invalidEntry(name, `is longer than ${limits.maxPathBytes} bytes`);
	}
	// backslash and colon are separators/stream markers on Windows; NUL truncates on every platform
	if (/[\0\\:]/.test(name)) throw invalidEntry(name, 'contains a NUL, backslash or colon');
	if (name.startsWith('/')) throw invalidEntry(name, 'is an absolute path');
	const segments = name.split('/').filter((segment) => segment !== '' && segment !== '.');
	if (segments.includes('..')) throw invalidEntry(name, "contains a '..' segment");
	return segments;
}

/** Names a case-insensitive, normalization-insensitive filesystem would treat as the same. */
function canonical(path: string): string {
	return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

async function readManifest(stream: Readable, header: Headers, limits: ArchiveLimits): Promise<Buffer> {
	if (header.size > limits.maxManifestBytes) {
		throw invalidEntry(ARCHIVE_MANIFEST_ENTRY, `is ${header.size} bytes; the limit is ${limits.maxManifestBytes}`);
	}
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	return Buffer.concat(chunks);
}

async function drain(stream: Readable): Promise<void> {
	for await (const _chunk of stream);
}

function quote(name: string): string {
	return JSON.stringify(name.length > 200 ? `${name.slice(0, 200)}…` : name);
}

function invalidEntry(name: string, reason: string): ClientError {
	return new ClientError(`Archive entry ${quote(name)} ${reason}`);
}

function collision(name: string, existing: string): ClientError {
	return new ClientError(
		`Archive entry ${quote(name)} collides with ${quote(existing)}: the names differ only by case or Unicode normalization, or repeat`
	);
}

function writeFailure(error: any, name: string, destDir: string): Error {
	if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') {
		const failure = new ClientError(
			`Ran out of space (${error.code}) extracting ${quote(name)} into ${destDir}`,
			HTTP_STATUS_CODES.INSUFFICIENT_STORAGE
		);
		failure.cause = error;
		return failure;
	}
	if (error?.code === 'EEXIST') {
		const failure = invalidEntry(name, `collides with a path already in ${destDir}`);
		failure.cause = error;
		return failure;
	}
	return error;
}
