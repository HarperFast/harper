/**
 * Reads a `get_backup` archive from a stream and writes each entry once, to the place a router names.
 * The entry checks are the hardened walker the archive restore depends on (dataLayer/DESIGN.md): only
 * regular files and directories, no name that escapes its root or that a case- or
 * normalization-insensitive filesystem would merge with another, every file created exclusively.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { Transform, type Readable, type Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import gunzip from 'gunzip-maybe';
import { extract as tarExtract, type Headers } from 'tar-stream';
import { ClientError } from '../utility/errors/hdbError.ts';
import { HTTP_STATUS_CODES } from '../utility/errors/commonErrors.ts';
import { ARCHIVE_MANIFEST_ENTRY, parseArchiveManifest, type BackupArchiveManifest } from './backupArchiveManifest.ts';

export interface ArchiveLimits {
	maxEntries: number;
	maxPathBytes: number;
	maxEntryBytes: number;
	maxTotalBytes: number;
	maxManifestBytes: number;
}

const DEFAULT_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
	maxEntries: 1_000_000,
	maxPathBytes: 1024,
	maxEntryBytes: 256 * 1024 ** 3,
	maxTotalBytes: 4 * 1024 ** 4,
	maxManifestBytes: 1024 * 1024,
});

// Inflated bytes that are not written payload: headers, padding, pax records, a blocking-factor tail,
// dropped entries, and what is buffered between the meter and the entry loop (up to two chunks). Past
// this allowance a stream inflates without producing entries — zero blocks, which tar-stream skips, or
// oversized long headers.
const OVERHEAD_PER_ENTRY = 8 * 1024;
const OVERHEAD_FIXED = 1024 * 1024;
const TAR_BLOCK = 512;
const TAR_TRAILER_BYTES = 2 * TAR_BLOCK;

/** Where an entry is written: a directory that exists, the path below it, and the budget it is charged to. */
export interface EntryDestination {
	root: string;
	segments: string[];
	budget: string;
}

export interface ArchiveRouter {
	/** Runs once, before any entry is written: the parsed first-entry manifest, or null when there is none. */
	admitManifest(manifest: BackupArchiveManifest | null): void;
	/** null drops the entry; throwing refuses the archive. */
	route(segments: string[], kind: 'file' | 'directory'): EntryDestination | null;
}

export interface ExtractStreamOptions {
	router: ArchiveRouter;
	/** Bytes each budget may still take; exceeding one refuses the archive with 507. */
	budgets: Map<string, number>;
	limits?: Partial<ArchiveLimits>;
	/** Accept an archive whose first entry is not the manifest (one produced before manifests). */
	allowMissingManifest?: boolean;
	/** Writer for a file already created exclusively; replaceable to simulate a failing device. */
	createWriteStream?: (handle: FileHandle) => Writable;
}

export interface ExtractStreamResult {
	/** sha256 of the bytes as received, before any inflation. */
	sha256: string;
	archiveBytes: number;
	inflatedBytes: number;
	entries: number;
	files: number;
	bytes: number;
	manifest: BackupArchiveManifest | null;
}

type EntryKind = 'file' | 'directory' | 'implied';

/**
 * Inflates `input` and writes its entries where `options.router` sends them. Rejects on the first
 * refusal or failure with every stream it touched — `input` included — destroyed and settled, so no
 * stream is left to error later outside the caller's handler. What it wrote is the caller's to remove.
 */
export async function extractArchiveStream(
	input: Readable,
	options: ExtractStreamOptions
): Promise<ExtractStreamResult> {
	const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
	const openWriter = options.createWriteStream ?? ((handle: FileHandle) => handle.createWriteStream());
	const result: ExtractStreamResult = {
		sha256: '',
		archiveBytes: 0,
		inflatedBytes: 0,
		entries: 0,
		files: 0,
		bytes: 0,
		manifest: null,
	};
	const realRoots = new Map<string, string>();
	const rootOf = async (root: string) => {
		let real = realRoots.get(root);
		if (!real) realRoots.set(root, (real = await realpath(root)));
		return real;
	};
	const budgets = options.budgets;
	const charge = (budget: string, bytes: number) => {
		const remaining = (budgets.get(budget) ?? 0) - bytes;
		if (remaining < 0) {
			throw new ClientError(
				'The archive does not fit in the space this restore may use beside its destination',
				HTTP_STATUS_CODES.INSUFFICIENT_STORAGE
			);
		}
		budgets.set(budget, remaining);
	};

	const hash = createHash('sha256');
	const tap = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			result.archiveBytes += chunk.length;
			callback(null, chunk);
		},
	});
	let admittedPayload = 0;
	let largestChunk = 0;
	const tail = Buffer.alloc(TAR_TRAILER_BYTES);
	let tailFilled = 0;
	const meter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			result.inflatedBytes += chunk.length;
			largestChunk = Math.max(largestChunk, chunk.length);
			const allowance =
				admittedPayload + (result.entries + 1) * (OVERHEAD_PER_ENTRY + TAR_BLOCK) + OVERHEAD_FIXED + 2 * largestChunk;
			if (result.inflatedBytes > allowance) {
				callback(
					new ClientError(
						`The archive inflates to more data than its entries account for (over ${allowance} bytes); refusing it as a decompression bomb`
					)
				);
				return;
			}
			if (chunk.length >= TAR_TRAILER_BYTES) {
				chunk.copy(tail, 0, chunk.length - TAR_TRAILER_BYTES);
				tailFilled = TAR_TRAILER_BYTES;
			} else {
				const kept = Math.min(tailFilled, TAR_TRAILER_BYTES - chunk.length);
				tail.copyWithin(0, tailFilled - kept, tailFilled);
				chunk.copy(tail, kept);
				tailFilled = kept + chunk.length;
			}
			callback(null, chunk);
		},
	});
	const extract = tarExtract();
	const feed = pipeline(input, tap, gunzip(), meter, extract);
	// Rejects when the pipeline fails and never resolves otherwise: tar-stream destroys the entry it is
	// reading without ending it, so anything still draining that entry waits on this as well.
	const failed = feed.then(
		() => new Promise<never>(() => {}),
		(error) => {
			throw error;
		}
	);
	failed.catch(() => {});

	const seen = new Map<string, { kind: EntryKind; name: string }>();
	const claimParents = (segments: string[]) => {
		for (let depth = 1; depth < segments.length; depth++) {
			const parent = segments.slice(0, depth).join('/');
			const existing = seen.get(canonical(parent));
			if (existing) {
				if (existing.kind === 'file')
					throw invalidEntry(segments.join('/'), `is inside ${quote(existing.name)}, a file`);
				if (existing.name !== parent) throw collision(parent, existing.name);
				continue;
			}
			seen.set(canonical(parent), { kind: 'implied', name: parent });
		}
	};
	const created = new Set<string>();
	const ensureDirectory = async (path: string) => {
		if (created.has(path)) return;
		await mkdir(path, { recursive: true, mode: 0o700 });
		created.add(path);
	};
	const admit = (bytes: number) => {
		if (admittedPayload + bytes > limits.maxTotalBytes) {
			throw new ClientError(`The archive's entries exceed ${limits.maxTotalBytes} bytes in total`);
		}
		admittedPayload += bytes;
	};
	const targetFor = async (destination: EntryDestination, name: string) => {
		const root = await rootOf(destination.root);
		const target = join(root, ...destination.segments);
		const fromRoot = relative(root, target);
		if (isAbsolute(fromRoot) || fromRoot.split(/[\\/]/)[0] === '..') {
			throw invalidEntry(name, 'resolves outside its destination');
		}
		return target;
	};

	let manifestDecided = false;
	// a lower bound: pax and long-name records are consumed by tar-stream, not surfaced as entries
	let entryBlockBytes = 0;
	try {
		for await (const entry of extract) {
			const stream = entry as Readable;
			// a dropped entry has no consumer to hear it fail, and a failed archive is reported once, below
			stream.on('error', () => {});
			const header: Headers = (entry as any).header;
			entryBlockBytes += TAR_BLOCK + Math.ceil(Math.max(0, header.size || 0) / TAR_BLOCK) * TAR_BLOCK;
			const index = result.entries++;
			if (result.entries > limits.maxEntries) {
				throw new ClientError(`The archive has more than ${limits.maxEntries} entries`);
			}
			const segments = entrySegments(header.name, limits);
			const name = segments.join('/');
			if (header.type !== 'file' && header.type !== 'directory') {
				throw invalidEntry(
					header.name,
					`is a ${header.type ?? 'unknown-type'} entry; only files and directories are allowed`
				);
			}
			if (header.type === 'file') {
				if (segments.length === 0) throw invalidEntry(header.name, 'has no file name');
				if (!(header.size >= 0) || header.size > limits.maxEntryBytes) {
					throw invalidEntry(name, `is ${header.size} bytes; the limit is ${limits.maxEntryBytes}`);
				}
			}
			if (!manifestDecided) {
				manifestDecided = true;
				if (index === 0 && header.type === 'file' && name === ARCHIVE_MANIFEST_ENTRY) {
					seen.set(canonical(name), { kind: 'file', name });
					if (header.size <= limits.maxManifestBytes) admit(header.size);
					const text = (await Promise.race([readManifest(stream, header, limits), failed])).toString('utf8');
					result.manifest = parseArchiveManifest(text);
					options.router.admitManifest(result.manifest);
					continue;
				}
				if (!options.allowMissingManifest) {
					throw new ClientError(
						`The archive's first entry must be ${ARCHIVE_MANIFEST_ENTRY}, but it is ${quote(name || header.name)}; ` +
							`it was not produced by a get_backup that records one. Set accept_incompatible_backup to restore it anyway.`
					);
				}
				options.router.admitManifest(null);
			}
			if (header.type === 'directory') {
				stream.resume();
				if (segments.length === 0) continue;
				claimParents(segments);
				const key = canonical(name);
				const existing = seen.get(key);
				if (existing) {
					if (existing.kind !== 'implied' || existing.name !== name) throw collision(name, existing.name);
					existing.kind = 'directory';
				} else seen.set(key, { kind: 'directory', name });
				const destination = options.router.route(segments, 'directory');
				if (destination && destination.segments.length > 0) await ensureDirectory(await targetFor(destination, name));
				continue;
			}
			if (name === ARCHIVE_MANIFEST_ENTRY) throw invalidEntry(name, 'may only be the first entry');
			claimParents(segments);
			const key = canonical(name);
			const existing = seen.get(key);
			if (existing) throw collision(name, existing.name);
			seen.set(key, { kind: 'file', name });
			const destination = options.router.route(segments, 'file');
			if (!destination) {
				stream.resume();
				continue;
			}
			admit(header.size);
			const target = await targetFor(destination, name);
			if (destination.segments.length > 1) await ensureDirectory(join(target, '..'));
			result.bytes += await writeEntry(stream, target, header, name, destination.budget, charge, openWriter, failed);
			result.files++;
		}
		await feed;
	} catch (error) {
		extract.destroy();
		await feed.catch(() => {});
		throw classify(error);
	}
	if (result.entries === 0) throw new ClientError('The archive contains no entries');
	if (
		tailFilled !== TAR_TRAILER_BYTES ||
		tail.some((byte) => byte !== 0) ||
		result.inflatedBytes < entryBlockBytes + TAR_TRAILER_BYTES
	) {
		throw new ClientError(
			'The archive ends without the tar end-of-archive marker, so it was cut short; download it again'
		);
	}
	result.sha256 = hash.digest('hex');
	return result;
}

async function writeEntry(
	stream: Readable,
	target: string,
	header: Headers,
	name: string,
	budget: string,
	charge: (budget: string, bytes: number) => void,
	openWriter: (handle: FileHandle) => Writable,
	failed: Promise<never>
): Promise<number> {
	let handle: FileHandle;
	try {
		handle = await open(target, 'wx', 0o600);
	} catch (error) {
		stream.resume();
		throw writeFailure(error, name);
	}
	let written = 0;
	const counter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			written += chunk.length;
			try {
				charge(budget, chunk.length);
			} catch (error) {
				callback(error);
				return;
			}
			callback(null, chunk);
		},
	});
	const writer = openWriter(handle);
	const writing = pipeline(stream, counter, writer);
	writing.catch(() => {});
	try {
		await Promise.race([writing, failed]);
	} catch (error) {
		// settled before the caller cleans up: nothing may still write into what it removes
		counter.destroy();
		writer.destroy();
		await finished(writer).catch(() => {});
		throw writeFailure(error, name);
	} finally {
		// the default writer owns and has closed the handle; a substituted one may not
		await handle.close().catch(() => {});
	}
	if (written !== header.size) {
		throw invalidEntry(name, `declared ${header.size} bytes but carried ${written}`);
	}
	return written;
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

function writeFailure(error: any, name: string): Error {
	if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') {
		return Object.assign(
			new ClientError(
				`Ran out of space (${error.code}) extracting ${quote(name)}`,
				HTTP_STATUS_CODES.INSUFFICIENT_STORAGE
			),
			{ cause: error }
		);
	}
	if (error?.code === 'EEXIST')
		return Object.assign(invalidEntry(name, 'collides with a file already written'), { cause: error });
	return error;
}

// tar-stream's decoding failures, which carry no code
const TAR_DECODE_ERROR = /^(Invalid tar header|Invalid header$|Header exceeds max size$|Unexpected end of data$)/;

/** A gzip or tar decoding failure means the bytes are not a whole archive; anything else is not the client's. */
function classify(error: any): unknown {
	if (error instanceof ClientError) return error;
	const code = typeof error?.code === 'string' ? error.code : '';
	const decoding = code ? code.startsWith('Z_') : TAR_DECODE_ERROR.test(String(error?.message ?? ''));
	if (!decoding) return error;
	return Object.assign(
		new ClientError(`The upload is not a whole get_backup archive (a .tar or .tar.gz): ${error?.message ?? error}`),
		{ cause: error }
	);
}
