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

import { readFile, writeFile, readdir, stat, mkdir, realpath, lstat, open, type FileHandle } from 'node:fs/promises';
import { resolve, dirname, relative, sep, isAbsolute } from 'node:path';
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
const NEWLINE = 0x0a;

/** Most file text one read returns: half the loop's per-result cap, which leaves room for JSON escaping. */
function pageBytes(ctx: AgentToolContext): number {
	return ctx.maxResultBytes ? Math.floor(ctx.maxResultBytes / 2) : DEFAULT_PAGE_BYTES;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
	if (value == null) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new Error(`${name} must be a positive integer; got ${JSON.stringify(value)}`);
	}
	return value as number;
}

type Access = 'read' | 'write';
type Scope = 'components' | 'logs' | 'config';

// The three filesystem scopes the agent can address. Exposed to the model as a `root` enum on the
// fs tools so it names the scope explicitly instead of guessing an absolute path — which is what led
// the model to invent literal `componentsRoot/…` prefixes. `components` is the only writable scope.
const SCOPES: Scope[] = ['components', 'logs', 'config'];
const SCOPE_DESCRIPTION =
	"Which scope the `path` is relative to: 'components' (app source directory, the only writable scope), " +
	"'logs' (read-only), or 'config' (read-only). Defaults to 'components'.";

function scopeRoot(scopes: AgentScopes, scope: Scope): string {
	switch (scope) {
		case 'components':
			return scopes.componentsRoot;
		case 'logs':
			return scopes.logDir;
		case 'config':
			return scopes.configDir;
		default:
			throw new Error(`Unknown fs root '${scope}'. Use one of: ${SCOPES.join(', ')}.`);
	}
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
	if (isInside(realAbsolute, realRoot)) return realAbsolute;
	throw new Error(`Path is outside the agent's '${scope}' scope: ${path}`);
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
			'Read a UTF-8 text file from the components, logs, or config scope, one page of whole lines at a time. ' +
			'A file that fits in one page comes back whole. When the file continues, `nextLine` is the startLine of ' +
			'the next page; `totalLines` is present once a page reaches the end of the file. A line longer than a ' +
			'page comes back cut, with `lineTruncated: true`; use grep_files to search inside it. write_file replaces ' +
			'the whole file, so read every page before rewriting one.',
		parameters: {
			type: 'object',
			properties: {
				root: { type: 'string', enum: SCOPES, description: SCOPE_DESCRIPTION },
				path: { type: 'string', description: 'Path relative to the chosen root, e.g. "my_app/schema.graphql".' },
				startLine: { type: 'integer', minimum: 1, description: 'First line to return, 1-based. Default 1.' },
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
		const path = await resolveScoped(ctx.scopes, normalizeScope(args.root), args.path, 'read');
		const startLine = optionalPositiveInteger(args.startLine, 'startLine') ?? 1;
		const lineCount = optionalPositiveInteger(args.lineCount, 'lineCount') ?? Infinity;
		const fh = await open(path, 'r');
		try {
			const { size } = await fh.stat();
			const page = await readLinePage(fh, size, startLine, lineCount, pageBytes(ctx), ctx.signal);
			return { path, size, startLine, ...page };
		} finally {
			await fh.close();
		}
	},
};

interface LinePage {
	content: string;
	/** Last line in `content`; absent when the page holds no line. */
	endLine?: number;
	nextLine?: number;
	totalLines?: number;
	lineTruncated?: true;
}

/**
 * Whole lines from `startLine` on, up to `lineCount` lines and `budget` bytes, as the file's exact
 * bytes. Memory stays bounded by `budget` and one scan chunk however large the file or its lines.
 */
async function readLinePage(
	fh: FileHandle,
	size: number,
	startLine: number,
	lineCount: number,
	budget: number,
	signal?: AbortSignal
): Promise<LinePage> {
	const located = await findLineStart(fh, size, startLine, signal);
	if ('totalLines' in located) return { content: '', totalLines: located.totalLines };
	const offset = located.offset;
	const window = Buffer.alloc(Math.min(budget, size - offset));
	const { bytesRead } = await fh.read(window, 0, window.length, offset);
	const page = window.subarray(0, bytesRead);
	const reachesEnd = offset + bytesRead >= size;
	if (page.length === 0) return { content: '', totalLines: startLine - 1 };

	let end = 0;
	let lines = 0;
	for (let index = page.indexOf(NEWLINE); lines < lineCount && index !== -1; index = page.indexOf(NEWLINE, end)) {
		end = index + 1;
		lines++;
	}
	if (lines < lineCount && reachesEnd && end < page.length) {
		end = page.length;
		lines++;
	}
	if (lines === 0) {
		// One line longer than the page: return its head, cut on a character boundary.
		return {
			content: page.subarray(0, completeUtf8Length(page)).toString('utf8'),
			endLine: startLine,
			nextLine: startLine + 1,
			lineTruncated: true,
		};
	}
	const endLine = startLine + lines - 1;
	const content = page.subarray(0, end).toString('utf8');
	return offset + end < size ? { content, endLine, nextLine: endLine + 1 } : { content, endLine, totalLines: endLine };
}

/** The byte offset where `line` starts, or the file's line count when it has fewer lines than that. */
async function findLineStart(
	fh: FileHandle,
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
		const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, size - position), position);
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
		description: 'List the immediate entries in a directory within the components, logs, or config scope.',
		parameters: {
			type: 'object',
			properties: {
				root: { type: 'string', enum: SCOPES, description: SCOPE_DESCRIPTION },
				path: {
					type: 'string',
					description: 'Directory relative to the chosen root. Omit or "" for the root itself.',
				},
			},
		},
	},
	handler: async (args: any, ctx: AgentToolContext) => {
		const path = await resolveScoped(ctx.scopes, normalizeScope(args.root), args.path ?? '', 'read');
		const entries = await readdir(path, { withFileTypes: true });
		return {
			path,
			entries: entries.map((e) => ({
				name: e.name,
				kind: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other',
			})),
		};
	},
};

export const grepFilesTool: AgentTool = {
	def: {
		name: 'grep_files',
		description:
			'Search recursively within a scope for a regex pattern. Returns matched lines with line numbers ' +
			`(each cut to ${MAX_GREP_LINE_CHARS} characters), up to one page of results; \`truncated: true\` ` +
			'means the search stopped early, so narrow the pattern or path.',
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
		const root = await resolveScoped(ctx.scopes, normalizeScope(args.root), args.path ?? '', 'read');
		// Cap pattern length. A maliciously crafted regex (e.g. nested quantifiers) can backtrack
		// catastrophically and block the main thread; JS has no native per-match timeout. The agent
		// is super_user-gated so this is self-inflicted DoS rather than a privilege boundary, but a
		// length cap removes the easiest footgun without a worker-thread regex sandbox.
		const patternSource = String(args.pattern ?? '');
		if (patternSource.length > MAX_PATTERN_LENGTH) {
			throw new Error(`grep pattern exceeds ${MAX_PATTERN_LENGTH}-char cap`);
		}
		const pattern = new RegExp(patternSource, args.flags ?? 'i');
		const cap = Math.min(args.maxResults ?? MAX_GREP_RESULTS, MAX_GREP_RESULTS);
		const budget = pageBytes(ctx);
		let resultBytes = 0;
		let truncated = false;
		const results: Array<{ path: string; line: number; text: string }> = [];
		await walk(root, async (file) => {
			if (results.length >= cap || truncated) return false;
			// `stat` first so a multi-GB log or database file can't be slurped into memory by a
			// well-formed grep request. Anything over the read cap is silently skipped.
			let size = 0;
			try {
				const st = await stat(file);
				size = st.size;
			} catch {
				return true;
			}
			if (size > MAX_READ_BYTES) return true;
			const text = await readFile(file, 'utf8').catch(() => '');
			if (!text) return true;
			const lines = text.split('\n');
			for (let i = 0; i < lines.length; i++) {
				if (results.length >= cap) return false;
				if (!pattern.test(lines[i])) continue;
				const text = lines[i].length > MAX_GREP_LINE_CHARS ? `${lines[i].slice(0, MAX_GREP_LINE_CHARS)}…` : lines[i];
				const match = { path: file, line: i + 1, text };
				resultBytes += Buffer.byteLength(JSON.stringify(match), 'utf8');
				if (resultBytes > budget) {
					truncated = true;
					return false;
				}
				results.push(match);
			}
			return true;
		});
		return { root, count: results.length, results, truncated };
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
		const path = await resolveScoped(ctx.scopes, normalizeScope(args.root), args.path, 'read');
		const wanted = Math.min(optionalPositiveInteger(args.lines, 'lines') ?? DEFAULT_TAIL_LINES, MAX_TAIL_LINES);
		const fh = await open(path, 'r');
		try {
			// Read only the trailing page — a multi-GB log file otherwise OOMs the process.
			const { size } = await fh.stat();
			const start = Math.max(0, size - pageBytes(ctx));
			const buf = Buffer.alloc(size - start);
			await fh.read(buf, 0, buf.length, start);
			// Starting mid-file can land inside a character; skip to the next character boundary.
			let firstChar = 0;
			while (start > 0 && firstChar < buf.length && (buf[firstChar] & 0xc0) === 0x80) firstChar++;
			const all = buf.subarray(firstChar).toString('utf8').split('\n');
			// `split('\n')` on a file ending with `\n` leaves a trailing empty entry — drop it so the
			// "last N lines" the agent sees matches what a human reading the file would see.
			if (all.length > 0 && all[all.length - 1] === '') all.pop();
			// From a mid-file offset the first "line" is almost certainly a fragment; drop it, unless it
			// is the only line, which is then the cut end of a line longer than the page.
			const lastLineCut = start > 0 && all.length === 1;
			if (start > 0 && all.length > 1) all.shift();
			const lines = all.slice(Math.max(0, all.length - wanted));
			return { path, lines, truncated: start > 0 && (lines.length < wanted || lastLineCut) };
		} finally {
			await fh.close();
		}
	},
};

export const fsTools: AgentTool[] = [readFileTool, writeFileTool, listDirTool, grepFilesTool, tailFileTool];

async function walk(root: string, visit: (file: string) => Promise<boolean>): Promise<void> {
	// Resolve the scope root once via realpath so the per-entry symlink check below has a
	// stable comparison anchor; otherwise a symlink in the root itself could shift the anchor.
	const realRoot = await safeRealPath(root);
	const stack: string[] = [root];
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
				if (!isInside(realFull, realRoot)) continue;
				stack.push(full);
			} else if (entry.isFile()) {
				const realFull = await safeRealPath(full);
				if (!isInside(realFull, realRoot)) continue;
				const proceed = await visit(full);
				if (proceed === false) return;
			}
		}
	}
}
