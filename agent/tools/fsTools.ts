/**
 * Operator-only filesystem tools for the built-in agent (#626).
 *
 * Every path is resolved against the configured scopes (componentsRoot,
 * logDir, configDir) and rejected if it escapes them. Writes are restricted
 * to `componentsRoot` — `logDir` and `configDir` are observation-only so
 * the agent can read logs and inspect config without rewriting either.
 *
 * Lifted in spirit from the external `harper-agent` CLI's file tools; the
 * sandboxing rules are tightened here because the in-process agent can
 * reach more of the filesystem than a remote CLI.
 */

import { writeFile, readdir, stat, mkdir, realpath, lstat, open, type FileHandle } from 'node:fs/promises';
import { resolve, dirname, relative, sep, isAbsolute, basename } from 'node:path';
import { MAX_CREDENTIAL_FILE_BYTES, maskCredentialFile, maskCredentialValues } from '../../utility/credentials.ts';
import type { AgentTool, AgentToolContext, AgentScopes } from '../types.ts';

const MAX_READ_BYTES = 5 * 1024 * 1024; // 5 MiB — grep skips larger files
const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_GREP_RESULTS = 500;
const MAX_GREP_LINE_CHARS = 500;
const MAX_PATTERN_LENGTH = 1000;
const DEFAULT_TAIL_LINES = 200;
const MAX_TAIL_LINES = 5000;
const DEFAULT_PAGE_BYTES = 32 * 1024;
const SCAN_CHUNK_BYTES = 64 * 1024;
// The observation envelope and a result's fields other than its text and `path`, numbers included.
const RESULT_FIELD_BYTES = 256;
// Room for one `list_dir` entry with a 255-byte name; `list_dir` cuts a longer name to fit.
const MIN_PAGE_BYTES = 320;
const NEWLINE = 0x0a;

/**
 * Most file text, measured JSON-escaped, one read returns: half the loop's per-result cap, and
 * never more than what the result's other fields (`path` among them) leave of it, so the loop
 * never cuts a page.
 */
function pageBytes(ctx: AgentToolContext, path: string): number {
	const cap = ctx.maxResultBytes ?? 2 * DEFAULT_PAGE_BYTES;
	const besidePage = cap - escapedBytes(path) - RESULT_FIELD_BYTES;
	if (besidePage < MIN_PAGE_BYTES) {
		throw new Error(
			`agent.maxToolResultBytes (${cap}) leaves no room for a page beside this path and the result's fields; raise it`
		);
	}
	return Math.min(Math.floor(cap / 2), besidePage);
}

/** Bytes `text` takes inside a JSON string: control characters escape to six bytes, quotes to two. */
function escapedBytes(text: string): number {
	return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

function optionalInteger(value: unknown, name: string, minimum: number): number | undefined {
	if (value == null) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < minimum) {
		throw new Error(`${name} must be an integer of at least ${minimum}; got ${JSON.stringify(value)}`);
	}
	return value as number;
}

const KEY_FILE_NAME = /\.(?:pem|key)$|^\.jwtPass$/i;
// Checked against the text a tool returns, so a key without armor passes; the name and key-directory
// rules are the guarantee.
export const PRIVATE_KEY_ARMOR = /-----(BEGIN|END) [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const ARMOR_LINE_OVERLAP_BYTES = 64;
// Longer than any PEM private-key block, post-quantum ones included (FrodoKEM-1344 is ~57 KB), so a window
// whose start lies inside a key normally sees its BEGIN line.
const KEY_LOOKBACK_BYTES = 128 * 1024;
// A key block's body line: base64, indented when the key is embedded in YAML. Inside a block whose BEGIN
// lies beyond the look-back, the look-back holds nothing else, so that is the one case the armor lines
// cannot settle.
const KEY_BODY_LINE = /^[ \t]*[A-Za-z0-9+/=]*[ \t]*\r?$/;

type Access = 'read' | 'write';
type Scope = 'components' | 'logs' | 'config';

// The three filesystem scopes the agent can address. Exposed to the model as a `root` enum on the
// fs tools so it names the scope explicitly instead of guessing an absolute path — which is what led
// the model to invent literal `componentsRoot/…` prefixes. `components` is the only writable scope.
const SCOPES: Scope[] = ['components', 'logs', 'config'];
const SCOPE_DESCRIPTION =
	"Which scope the `path` is relative to: 'components' (app source directory, the only writable scope), " +
	"'logs' (read-only), or 'config' (read-only). Defaults to 'components'. In the read-only scopes, credential " +
	'values (apiKey, password, token, secret and the like) come back as `*`s.';

function masksCredentials(scope: Scope): boolean {
	return scope !== 'components';
}

function scopeRoot(scopes: AgentScopes, scope: Scope): string {
	switch (scope) {
		case 'components':
			return scopes.componentsRoot;
		case 'logs':
			return scopes.logDir;
		case 'config':
			if (!scopes.configDir) {
				throw new Error(
					"The 'config' scope is unavailable: agent.configScope named no readable file or directory at startup."
				);
			}
			return scopes.configDir;
		default:
			throw new Error(`Unknown fs root '${scope}'. Use one of: ${SCOPES.join(', ')}.`);
	}
}

function scopeFile(scopes: AgentScopes, scope: Scope): string | undefined {
	return scope === 'config' ? scopes.configFile : undefined;
}

function scopedPath(scopes: AgentScopes, scope: Scope, path: unknown): string {
	const file = scopeFile(scopes, scope);
	if (file && (path == null || path === '' || path === '.')) return file;
	return (path as string) ?? '';
}

// Resolved on every call, like scope roots, so a key directory that becomes a link after boot is followed.
function realKeyDirs(scopes: AgentScopes): Promise<string[]> {
	return Promise.all(scopes.keyDirs.map(safeRealPath));
}

function inKeyDir(realKeyDirs: string[], realPath: string): boolean {
	return realKeyDirs.some((keyDir) => isInside(realPath, keyDir));
}

function assertNoPrivateKey(text: string, path: string): void {
	if (PRIVATE_KEY_ARMOR.test(text)) throw new Error(`Refusing to read key material: ${path} holds a PEM private key`);
}

type KeyState = 'outside' | 'inside' | 'unknown';

/**
 * Where the first `limit` characters of `text` leave whatever follows them: after the last armor line
 * that begins there, or, with none, `unknown` when they are all key-body characters and do not reach
 * back to the start of the file.
 */
function keyStateAfter(text: string, limit: number, reachesFileStart: boolean): KeyState {
	let last: string | undefined;
	for (const match of text.matchAll(new RegExp(PRIVATE_KEY_ARMOR.source, 'g'))) {
		if (match.index >= limit) break;
		last = match[1];
	}
	if (last) return last === 'BEGIN' ? 'inside' : 'outside';
	// The first line is cut by the look-back's start, so it may be the tail of a BEGIN line: skip it.
	const bodyOnly = text
		.slice(0, limit)
		.split('\n')
		.slice(1)
		.every((line) => KEY_BODY_LINE.test(line));
	return !reachesFileStart && bodyOnly ? 'unknown' : 'outside';
}

function assertOutsidePrivateKey(state: KeyState, path: string, insideMessage: string): void {
	if (state === 'inside') throw new Error(insideMessage);
	if (state === 'unknown') {
		throw new Error(
			`Refusing to read ${path} there: only key-body characters for ${KEY_LOOKBACK_BYTES / 1024} KiB before it, so it may be inside a PEM private key`
		);
	}
}

interface Reader {
	read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
}

interface Source {
	reader: Reader;
	size: number;
	masked?: Buffer;
}

/**
 * A config-scope file is read and masked whole, so the YAML parse sees every key. One too large to parse
 * on this thread, or not UTF-8, is refused: the per-page text scan cannot resolve a key YAML reads
 * differently from how it is written.
 */
async function openSource(fh: FileHandle, scope: Scope, requested: string): Promise<Source> {
	const { size } = await fh.stat();
	if (scope !== 'config') return { reader: fh, size };
	if (size > MAX_CREDENTIAL_FILE_BYTES) {
		throw new Error(
			`Refusing to read ${requested}: a config-scope file over ${MAX_CREDENTIAL_FILE_BYTES / 1024} KiB cannot be checked for credentials`
		);
	}
	const file = await readWhole(fh, size);
	const masked = maskCredentialFile(file);
	if (!masked)
		throw new Error(`Refusing to read ${requested}: it is not UTF-8 text, so it cannot be checked for credentials`);
	const reader: Reader = {
		read: async (buffer, offset, length, position) => ({
			bytesRead: position >= file.length ? 0 : file.copy(buffer, offset, position, position + length),
		}),
	};
	return { reader, size: file.length, masked };
}

async function readWhole(fh: FileHandle, size: number): Promise<Buffer> {
	const whole = Buffer.alloc(size);
	let filled = 0;
	while (filled < size) {
		const { bytesRead } = await fh.read(whole, filled, size - filled, filled);
		if (bytesRead === 0) break;
		filled += bytesRead;
	}
	return whole.subarray(0, filled);
}

interface Window {
	page: Buffer;
	reachesEnd: boolean;
	before: string;
	/** `before`, read on into the page far enough to hold an armor line that the page start cuts. */
	beforeWithOverlap: string;
	beforeAtFileStart: boolean;
}

/**
 * Up to `budget` bytes from `start`, and the look-back the key-material and credential checks judge them by,
 * in one read so a file changed in place cannot give the two different contents.
 */
async function readWindow(reader: Reader, size: number, start: number, budget: number): Promise<Window> {
	const from = Math.max(0, start - KEY_LOOKBACK_BYTES);
	const pageLength = Math.min(budget, size - start);
	const buffer = Buffer.alloc(start - from + Math.max(pageLength, ARMOR_LINE_OVERLAP_BYTES));
	const { bytesRead } = await reader.read(buffer, 0, buffer.length, from);
	const pageStart = Math.min(start - from, bytesRead);
	const page = buffer.subarray(pageStart, Math.min(bytesRead, start - from + pageLength));
	return {
		page,
		reachesEnd: start + page.length >= size,
		before: buffer.toString('utf8', 0, pageStart),
		beforeWithOverlap: buffer.toString('utf8', 0, Math.min(bytesRead, start - from + ARMOR_LINE_OVERLAP_BYTES)),
		beforeAtFileStart: from === 0,
	};
}

/**
 * Where the page lies relative to a PEM private-key block. Only armor lines that begin before it count: an
 * END line just after its start must not clear a page that starts on the key's last body line.
 */
function keyStateAt(window: Window): KeyState {
	return keyStateAfter(window.beforeWithOverlap, window.before.length, window.beforeAtFileStart);
}

/** Coerce/validate a tool's `root` argument, defaulting to the writable components scope. */
function normalizeScope(root: unknown): Scope {
	if (root == null) return 'components';
	if (typeof root !== 'string' || !SCOPES.includes(root as Scope))
		throw new Error(`Invalid fs root '${String(root)}'. Use one of: ${SCOPES.join(', ')}.`);
	return root as Scope;
}

async function resolveScoped(scopes: AgentScopes, scope: Scope, path: string, access: Access): Promise<string> {
	// Writes are confined to the components (app) scope; logs and config are observation-only.
	if (access === 'write' && scope !== 'components') {
		throw new Error(`Cannot write to the '${scope}' scope; writes are limited to 'components'.`);
	}
	const root = scopeRoot(scopes, scope);
	// Paths are relative to the chosen scope root. Rejecting absolute paths removes the ambiguity that
	// led the model to guess literal prefixes, and keeps resolution a single unambiguous join.
	if (isAbsolute(path)) {
		throw new Error(`Path must be relative to the '${scope}' root, not absolute: ${path}`);
	}
	const absolute = resolve(root, path);
	// Reject a symlink leaf. `safeRealPath` resolves existing symlinks via `realpath` (so a link to
	// an out-of-scope *existing* file is caught by the isInside check below) — but a link whose
	// target does NOT exist makes `realpath` throw, and the fallback returns the link's own in-scope
	// path. `writeFile`/`readFile` then follow the link out of scope. An explicit lstat closes that
	// gap: a legitimate component/log/config file is never a symlink.
	try {
		const linkStat = await lstat(absolute);
		if (linkStat.isSymbolicLink()) {
			throw new Error(`Refusing to ${access} through a symlink: ${path}`);
		}
	} catch (err) {
		// ENOENT (path doesn't exist yet — normal for a new-file write) is fine; rethrow anything else
		// (including our own symlink rejection).
		if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
	}
	const realAbsolute = await safeRealPath(absolute);
	const realRoot = await safeRealPath(root);
	const file = scopeFile(scopes, scope);
	const admitted = file ? realAbsolute === resolve(realRoot, file) : isInside(realAbsolute, realRoot);
	if (!admitted) throw new Error(`Path is outside the agent's '${scope}' scope: ${path}`);
	if (
		inKeyDir(await realKeyDirs(scopes), realAbsolute) ||
		(access === 'read' && KEY_FILE_NAME.test(basename(realAbsolute)))
	) {
		throw new Error(`Refusing to ${access} key material: ${path}`);
	}
	return realAbsolute;
}

async function safeRealPath(p: string): Promise<string> {
	try {
		return await realpath(p);
	} catch {
		// Missing leaf is fine — resolve the deepest existing ancestor and join.
		const parent = dirname(p);
		if (parent === p) return p;
		const parentReal = await safeRealPath(parent);
		return resolve(parentReal, p.slice(parent.length + 1));
	}
}

function isInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	// On Windows, `path.relative` returns an absolute path when the two arguments are on
	// different drive letters (e.g. C:\components vs D:\etc). Without this check the agent
	// could escape its scope by naming a path on another drive.
	if (isAbsolute(rel)) return false;
	return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`));
}

export const readFileTool: AgentTool = {
	def: {
		name: 'read_file',
		description:
			'Read a UTF-8 text file from the components, logs, or config scope, one page at a time. A page holds as ' +
			'many whole lines as fit; a file that fits in one page comes back whole. While the file continues, the ' +
			'result has `nextLine` and `nextOffset`: pass both back as `startLine` and `offset` to read the next page ' +
			'without rescanning the file. A line longer than a page comes back in parts, continued the same way; every ' +
			'part but the last is flagged `lineTruncated: true`. `totalLines` is present once a page reaches the end of the ' +
			'file. write_file replaces the whole file, so read every page before rewriting one.',
		parameters: {
			type: 'object',
			properties: {
				root: { type: 'string', enum: SCOPES, description: SCOPE_DESCRIPTION },
				path: { type: 'string', description: 'Path relative to the chosen root, e.g. "my_app/schema.graphql".' },
				startLine: {
					type: 'integer',
					minimum: 1,
					description: 'Line to start at, 1-based. Default 1. With `offset`, the line number of that byte.',
				},
				offset: {
					type: 'integer',
					minimum: 0,
					description: 'Byte offset to start at, as returned in `nextOffset`. Skips scanning for `startLine`.',
				},
				lineCount: {
					type: 'integer',
					minimum: 1,
					description: 'Most lines to return. Default: as many as fit in one page.',
				},
			},
			required: ['path'],
		},
	},
	handler: async (args: any, ctx: AgentToolContext) => {
		const scope = normalizeScope(args.root);
		const requested = scopedPath(ctx.scopes, scope, args.path);
		const path = await resolveScoped(ctx.scopes, scope, requested, 'read');
		const requestedLine = optionalInteger(args.startLine, 'startLine', 1);
		const offset = optionalInteger(args.offset, 'offset', 0);
		const lineCount = optionalInteger(args.lineCount, 'lineCount', 1) ?? Infinity;
		const startLine = offset === undefined ? (requestedLine ?? 1) : requestedLine;
		const fh = await open(path, 'r');
		try {
			const source = await openSource(fh, scope, requested);
			const { size } = source;
			if (offset !== undefined && offset > size) {
				throw new Error(`offset ${offset} is past the end of the file (${size} bytes)`);
			}
			let start = offset;
			if (start === undefined) {
				const located = await findLineStart(source.reader, size, startLine, ctx.signal);
				if ('totalLines' in located) return { path, size, startLine, content: '', totalLines: located.totalLines };
				start = located.offset;
			}
			const budget = pageBytes(ctx, path);
			const window = await readWindow(source.reader, size, start, budget);
			const page = readPage(window.page, window.reachesEnd, start, lineCount, budget);
			if (page.endOffset === start && start < size) {
				throw new Error(`${requested} changed while it was read; read it again`);
			}
			assertNoPrivateKey(page.content, requested);
			assertOutsidePrivateKey(
				keyStateAt(window),
				requested,
				`Refusing to read key material: ${requested} holds a PEM private key at that position`
			);
			// Masking never lengthens text, so the page still fits the budget it was cut to.
			const content = source.masked
				? source.masked.toString('utf8', start, page.endOffset)
				: masksCredentials(scope)
					? maskCredentialValues(page.content, { before: window.before, beforeAtSourceStart: window.beforeAtFileStart })
					: page.content;
			const result: Record<string, unknown> = { path, size, offset: start, content };
			const endLine = startLine === undefined || page.lines === 0 ? undefined : startLine + page.lines - 1;
			if (startLine !== undefined) Object.assign(result, { startLine, endLine });
			if (page.lineTruncated) result.lineTruncated = true;
			if (page.endOffset < size) {
				result.nextOffset = page.endOffset;
				if (startLine !== undefined) result.nextLine = page.lineTruncated ? endLine : (endLine ?? startLine - 1) + 1;
			} else if (startLine !== undefined) {
				result.totalLines = endLine ?? startLine - 1;
			}
			return result;
		} finally {
			await fh.close();
		}
	},
};

interface Page {
	content: string;
	/** Lines in `content`, counting a partial line. */
	lines: number;
	endOffset: number;
	lineTruncated: boolean;
}

/**
 * Whole lines from byte `start`, up to `lineCount` lines whose JSON-escaped text fits in `budget`
 * bytes; when not even one line fits, the part of it that does. `content` is the file's exact bytes
 * and `endOffset` always lands on a character boundary.
 */
function readPage(bytes: Buffer, reachesEnd: boolean, start: number, lineCount: number, budget: number): Page {
	let end = 0;
	let lines = 0;
	let used = 0;
	while (lines < lineCount && end < bytes.length) {
		const newline = bytes.indexOf(NEWLINE, end);
		if (newline === -1 && !reachesEnd) break;
		const lineEnd = newline === -1 ? bytes.length : newline + 1;
		const cost = escapedBytes(bytes.toString('utf8', end, lineEnd));
		if (used + cost > budget) break;
		used += cost;
		end = lineEnd;
		lines++;
	}
	if (lines > 0 || bytes.length === 0) {
		return { content: bytes.toString('utf8', 0, end), lines, endOffset: start + end, lineTruncated: false };
	}
	let cut = completeUtf8Length(bytes);
	for (let cost = escapedBytes(bytes.toString('utf8', 0, cut)); cost > budget;) {
		cut = Math.max(1, completeUtf8Length(bytes.subarray(0, Math.floor((cut * budget) / cost))));
		cost = escapedBytes(bytes.toString('utf8', 0, cut));
		if (cut === 1) break;
	}
	return { content: bytes.toString('utf8', 0, cut), lines: 1, endOffset: start + cut, lineTruncated: true };
}

/** The byte offset where `line` starts, or the file's line count when it has fewer lines than that. */
async function findLineStart(
	reader: Reader,
	size: number,
	line: number,
	signal?: AbortSignal
): Promise<{ offset: number } | { totalLines: number }> {
	if (line === 1) return { offset: 0 };
	const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
	let newlines = 0;
	let lastByte = NEWLINE;
	for (let position = 0; position < size;) {
		signal?.throwIfAborted();
		const { bytesRead } = await reader.read(chunk, 0, Math.min(chunk.length, size - position), position);
		if (bytesRead === 0) break;
		const read = chunk.subarray(0, bytesRead);
		for (let index = read.indexOf(NEWLINE); index !== -1; index = read.indexOf(NEWLINE, index + 1)) {
			if (++newlines === line - 1) {
				const offset = position + index + 1;
				return offset < size ? { offset } : { totalLines: newlines };
			}
		}
		lastByte = read[bytesRead - 1];
		position += bytesRead;
	}
	return { totalLines: newlines + (lastByte === NEWLINE ? 0 : 1) };
}

/** The longest start of `text` whose JSON-escaped form fits in `budget` bytes. */
function escapedHead(text: string, budget: number): string {
	let head = text;
	for (let cost = escapedBytes(head); cost > budget && head.length > 1; cost = escapedBytes(head)) {
		head = head.slice(0, Math.max(1, Math.floor((head.length * budget) / cost)));
		const last = head.charCodeAt(head.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
	}
	return head;
}

/** The longest end of `text` whose JSON-escaped form fits in `budget` bytes. */
function escapedTail(text: string, budget: number): string {
	let tail = text;
	for (let cost = escapedBytes(tail); cost > budget && tail.length > 1; cost = escapedBytes(tail)) {
		tail = tail.slice(tail.length - Math.max(1, Math.floor((tail.length * budget) / cost)));
		const first = tail.charCodeAt(0);
		if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
	}
	return tail;
}

function clipLine(line: string): string {
	if (line.length <= MAX_GREP_LINE_CHARS) return line;
	const last = line.charCodeAt(MAX_GREP_LINE_CHARS - 1);
	const end = last >= 0xd800 && last <= 0xdbff ? MAX_GREP_LINE_CHARS - 1 : MAX_GREP_LINE_CHARS;
	return `${line.slice(0, end)}…`;
}

/** Length of the longest prefix of `bytes` that does not end inside a UTF-8 character. */
function completeUtf8Length(bytes: Buffer): number {
	if (bytes.length === 0) return 0;
	let lead = bytes.length - 1;
	while (lead > 0 && bytes.length - lead < 4 && (bytes[lead] & 0xc0) === 0x80) lead--;
	const first = bytes[lead];
	const width = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
	return lead + width <= bytes.length ? bytes.length : lead;
}

export const writeFileTool: AgentTool = {
	def: {
		name: 'write_file',
		description:
			'Write a UTF-8 text file into the components (app source) scope — the only writable scope. Creates parent directories as needed.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Path relative to the components directory, e.g. "my_app/schema.graphql".',
				},
				content: { type: 'string', description: 'UTF-8 file contents.' },
			},
			required: ['path', 'content'],
		},
	},
	handler: async (args: any, ctx: AgentToolContext) => {
		const content = String(args.content ?? '');
		if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
			throw new Error(`Write exceeds ${MAX_WRITE_BYTES}-byte cap`);
		}
		const path = await resolveScoped(ctx.scopes, 'components', args.path, 'write');
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, 'utf8');
		return { path, bytesWritten: Buffer.byteLength(content, 'utf8') };
	},
	destructive: true,
};

export const listDirTool: AgentTool = {
	def: {
		name: 'list_dir',
		description:
			'List the immediate entries in a directory within the components, logs, or config scope, sorted by name, ' +
			'one page at a time. While entries remain, the result has `nextOffset`: pass it back as `offset` for the next page.',
		parameters: {
			type: 'object',
			properties: {
				root: { type: 'string', enum: SCOPES, description: SCOPE_DESCRIPTION },
				path: {
					type: 'string',
					description: 'Directory relative to the chosen root. Omit or "" for the root itself.',
				},
				offset: { type: 'integer', minimum: 0, description: 'Entry to start at, as returned in `nextOffset`.' },
			},
		},
	},
	handler: async (args: any, ctx: AgentToolContext) => {
		const scope = normalizeScope(args.root);
		const path = await resolveScoped(ctx.scopes, scope, scopedPath(ctx.scopes, scope, args.path), 'read');
		const file = scopeFile(ctx.scopes, scope);
		// Never enumerated, even if the file was swapped for a directory after boot.
		if (file) return { path, entries: (await lstat(path)).isFile() ? [{ name: file, kind: 'file' }] : [] };
		const offset = optionalInteger(args.offset, 'offset', 0) ?? 0;
		const budget = pageBytes(ctx, path);
		const all = (await readdir(path, { withFileTypes: true })).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0
		);
		const entries: Array<{ name: string; kind: string; nameTruncated?: true }> = [];
		let used = 0;
		let next = offset;
		for (; next < all.length; next++) {
			const e = all[next];
			const entry: { name: string; kind: string; nameTruncated?: true } = {
				name: e.name,
				kind: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other',
			};
			const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
			if (used + entryBytes > budget) {
				if (entries.length > 0) break;
				// A name too long for a page on its own: cut it to fit.
				const nameRoom = budget - (entryBytes - escapedBytes(e.name)) - 22;
				entry.name = escapedHead(e.name, nameRoom);
				entry.nameTruncated = true;
			}
			used += entryBytes;
			entries.push(entry);
		}
		return next < all.length
			? { path, total: all.length, entries, nextOffset: next }
			: { path, total: all.length, entries };
	},
};

export const grepFilesTool: AgentTool = {
	def: {
		name: 'grep_files',
		description:
			'Search recursively within a scope for a regex pattern. Returns matched lines with line numbers ' +
			`(each cut to ${MAX_GREP_LINE_CHARS} characters), up to one page of results; \`truncated: true\` ` +
			'means the search stopped early, so narrow the pattern or path. Files over 5 MiB, and config-scope files over ' +
			'256 KiB or not UTF-8, are not searched; `skippedFiles` counts them, and read_file pages through larger logs.',
		parameters: {
			type: 'object',
			properties: {
				root: { type: 'string', enum: SCOPES, description: SCOPE_DESCRIPTION },
				path: {
					type: 'string',
					description: 'Subdirectory relative to the chosen root to search under. Omit or "" for the whole scope.',
				},
				pattern: { type: 'string', description: 'JavaScript-compatible regular expression source.' },
				flags: { type: 'string', description: 'Regex flags (default: "i").' },
				maxResults: { type: 'integer', minimum: 1, maximum: MAX_GREP_RESULTS },
			},
			required: ['pattern'],
		},
	},
	handler: async (args: any, ctx: AgentToolContext) => {
		const scope = normalizeScope(args.root);
		const root = await resolveScoped(ctx.scopes, scope, scopedPath(ctx.scopes, scope, args.path), 'read');
		// Cap pattern length. A maliciously crafted regex (e.g. nested quantifiers) can backtrack
		// catastrophically and block the main thread; JS has no native per-match timeout. The agent
		// is super_user-gated so this is self-inflicted DoS rather than a privilege boundary, but a
		// length cap removes the easiest footgun without a worker-thread regex sandbox.
		const patternSource = String(args.pattern ?? '');
		if (patternSource.length > MAX_PATTERN_LENGTH) {
			throw new Error(`grep pattern exceeds ${MAX_PATTERN_LENGTH}-char cap`);
		}
		const pattern = new RegExp(patternSource, args.flags ?? 'i');
		const masks = masksCredentials(scope);
		const cap = Math.min(args.maxResults ?? MAX_GREP_RESULTS, MAX_GREP_RESULTS);
		const budget = pageBytes(ctx, root);
		let resultBytes = 0;
		let truncated = false;
		let skippedFiles = 0;
		const results: Array<{ path: string; line: number; text: string }> = [];
		const grepFile = async (file: string): Promise<boolean> => {
			if (truncated) return false;
			// Sized on the open handle and read no further than that size, so a multi-GB log, or a file that
			// grows after the check, is never slurped into memory or handed to the YAML parse.
			let bytes: Buffer;
			try {
				const handle = await open(file, 'r');
				try {
					const { size } = await handle.stat();
					if (size > (scope === 'config' ? MAX_CREDENTIAL_FILE_BYTES : MAX_READ_BYTES)) {
						skippedFiles++;
						return true;
					}
					bytes = await readWhole(handle, size);
				} finally {
					await handle.close();
				}
			} catch {
				return true;
			}
			const text = bytes.toString('utf8');
			// Skipped whole, like an oversize file: a matched line could be one line of a key.
			if (!text || PRIVATE_KEY_ARMOR.test(text)) return true;
			// Matched after masking, or whether a guessed value matches would tell the model what was masked.
			const searched =
				scope === 'config' ? maskCredentialFile(bytes)?.toString('utf8') : masks ? maskCredentialValues(text) : text;
			if (searched === undefined) {
				skippedFiles++;
				return true;
			}
			const lines = searched.split('\n');
			for (let i = 0; i < lines.length; i++) {
				if (!pattern.test(lines[i])) continue;
				const match = { path: file, line: i + 1, text: clipLine(lines[i]) };
				const matchBytes = Buffer.byteLength(JSON.stringify(match), 'utf8') + 1; // with its comma
				if (results.length >= cap || resultBytes + matchBytes > budget) {
					truncated = true;
					// A first match too long for the page still comes back, cut to fit, rather than none.
					const room = budget - (matchBytes - escapedBytes(match.text));
					if (results.length === 0 && cap > 0) {
						if (room <= 0) {
							throw new Error(
								`agent.maxToolResultBytes (${ctx.maxResultBytes}) leaves no room for a match in ${file}; raise it`
							);
						}
						match.text = escapedHead(match.text, room);
						results.push(match);
					}
					return false;
				}
				resultBytes += matchBytes;
				results.push(match);
			}
			return true;
		};
		const target = await stat(root).catch(() => undefined);
		if (target?.isFile()) {
			await grepFile(root);
		} else if (target?.isDirectory() && !scopeFile(ctx.scopes, scope)) {
			await walk(root, await realKeyDirs(ctx.scopes), grepFile);
		}
		return { root, count: results.length, results, truncated, skippedFiles };
	},
};

export const tailFileTool: AgentTool = {
	def: {
		name: 'tail_file',
		description:
			`Return the last N lines of a UTF-8 file (default ${DEFAULT_TAIL_LINES}, at most ${MAX_TAIL_LINES}) that fit in ` +
			'one page. Useful for log tails (root: "logs"). `truncated: true` means fewer lines than asked fit, or the ' +
			'last line was longer than a page and comes back cut; read earlier content with grep_files or read_file.',
		parameters: {
			type: 'object',
			properties: {
				root: { type: 'string', enum: SCOPES, description: SCOPE_DESCRIPTION },
				path: { type: 'string', description: 'Path relative to the chosen root, e.g. "hdb.log".' },
				lines: { type: 'integer', minimum: 1, maximum: MAX_TAIL_LINES },
			},
			required: ['path'],
		},
	},
	handler: async (args: any, ctx: AgentToolContext) => {
		const scope = normalizeScope(args.root);
		const requested = scopedPath(ctx.scopes, scope, args.path);
		const path = await resolveScoped(ctx.scopes, scope, requested, 'read');
		const wanted = Math.min(optionalInteger(args.lines, 'lines', 1) ?? DEFAULT_TAIL_LINES, MAX_TAIL_LINES);
		const budget = pageBytes(ctx, path);
		const fh = await open(path, 'r');
		try {
			// Read only the trailing page — a multi-GB log file otherwise OOMs the process — and the bytes
			// before it that can hold the BEGIN line of a key the page ends inside.
			const source = await openSource(fh, scope, requested);
			const { size } = source;
			const start = Math.max(0, size - budget);
			const scanStart = Math.max(0, start - KEY_LOOKBACK_BYTES);
			const scanned = Buffer.alloc(size - scanStart);
			const { bytesRead } = await source.reader.read(scanned, 0, scanned.length, scanStart);
			const bytes = scanned.subarray(start - scanStart, bytesRead);
			let firstChar = 0;
			while (start > 0 && firstChar < bytes.length && (bytes[firstChar] & 0xc0) === 0x80) firstChar++;
			const rawText = bytes.toString('utf8', firstChar);
			const pageAt = Math.min(start - scanStart + firstChar, bytesRead);
			const text = source.masked
				? source.masked.toString('utf8', start + firstChar, scanStart + bytesRead)
				: masksCredentials(scope)
					? maskCredentialValues(rawText, {
							before: scanned.toString('utf8', 0, pageAt),
							beforeAtSourceStart: scanStart === 0,
						})
					: rawText;
			// Masking keeps every line break, so the raw and masked lines pair up by index.
			const all = text.split('\n');
			const rawAll = text === rawText ? all : rawText.split('\n');
			// `split('\n')` on a file ending with `\n` leaves a trailing empty entry — drop it so the
			// "last N lines" the agent sees matches what a human reading the file would see.
			const end = all.length > 0 && all[all.length - 1] === '' ? all.length - 1 : all.length;
			// From a mid-file offset the first "line" is almost certainly a fragment; drop it, unless it
			// is the only line, which is then the cut end of a line longer than the page.
			let lastLineCut = start > 0 && end === 1;
			let begin = Math.max(start > 0 && end > 1 ? 1 : 0, end - wanted);
			let used = 0;
			for (let index = begin; index < end; index++) used += escapedBytes(all[index]) + 3;
			while (end - begin > 1 && used > budget) used -= escapedBytes(all[begin++]) + 3;
			const lines = all.slice(begin, end);
			const rawLines = rawAll.slice(begin, end);
			if (lines.length === 1 && used > budget) {
				lines[0] = escapedTail(lines[0], budget);
				lastLineCut = true;
			}
			assertNoPrivateKey(rawLines.join('\n'), requested);
			const scannedText = scanned.toString('utf8', 0, bytesRead);
			assertOutsidePrivateKey(
				keyStateAfter(scannedText, scannedText.length, scanStart === 0),
				requested,
				`Refusing to read key material: ${requested} ends inside a PEM private key`
			);
			const omitted = lines.length < Math.min(wanted, start > 0 ? Infinity : end);
			return { path, lines, truncated: omitted || lastLineCut };
		} finally {
			await fh.close();
		}
	},
};

export const fsTools: AgentTool[] = [readFileTool, writeFileTool, listDirTool, grepFilesTool, tailFileTool];

async function walk(root: string, realKeyDirs: string[], visit: (file: string) => Promise<boolean>): Promise<void> {
	// Resolve the scope root once via realpath so the per-entry symlink check below has a
	// stable comparison anchor; otherwise a symlink in the root itself could shift the anchor.
	const realRoot = await safeRealPath(root);
	// Only real paths go on the stack, so a regular file's path below is already its real path.
	const stack: string[] = [realRoot];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = resolve(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === '.git') continue;
				// Re-resolve via realpath so a symlinked directory pointing outside the scope is rejected.
				// Without this, `componentsRoot/escape -> /etc` would let grep walk into /etc.
				const realFull = await safeRealPath(full);
				if (!isInside(realFull, realRoot) || inKeyDir(realKeyDirs, realFull)) continue;
				stack.push(realFull);
			} else if (entry.isFile()) {
				// A Dirent is never a followed link, so `isFile()` excludes symlinks and `full` needs no realpath.
				if (KEY_FILE_NAME.test(entry.name) || inKeyDir(realKeyDirs, full)) continue;
				const proceed = await visit(full);
				if (proceed === false) return;
			}
		}
	}
}
