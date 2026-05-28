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

import { readFile, writeFile, readdir, stat, mkdir, realpath, open } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import type { AgentTool, AgentToolContext, AgentScopes } from '../types.ts';

const MAX_READ_BYTES = 5 * 1024 * 1024; // 5 MiB
const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_GREP_RESULTS = 500;
const DEFAULT_TAIL_LINES = 200;
const TAIL_READ_BYTES = 1 * 1024 * 1024; // 1 MiB — enough for thousands of normal log lines

type Access = 'read' | 'write';

async function resolveScoped(scopes: AgentScopes, path: string, access: Access): Promise<string> {
	const absolute = resolve(path);
	const candidates = [scopes.componentsRoot];
	if (access === 'read') {
		candidates.push(scopes.logDir, scopes.configDir);
	}
	const realAbsolute = await safeRealPath(absolute);
	for (const root of candidates) {
		const realRoot = await safeRealPath(root);
		if (isInside(realAbsolute, realRoot)) return realAbsolute;
	}
	throw new Error(`Path is outside the agent's ${access} scope: ${path}`);
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
	return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`));
}

export const readFileTool: AgentTool = {
	def: {
		name: 'read_file',
		description: 'Read a UTF-8 text file within componentsRoot, logDir, or configDir.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Absolute filesystem path.' },
			},
			required: ['path'],
		},
	},
	handler: async (args: any, ctx: AgentToolContext) => {
		const path = await resolveScoped(ctx.scopes, args.path, 'read');
		const st = await stat(path);
		if (st.size > MAX_READ_BYTES) {
			throw new Error(`File ${path} exceeds ${MAX_READ_BYTES}-byte read cap (size ${st.size})`);
		}
		const content = await readFile(path, 'utf8');
		return { path, size: st.size, content };
	},
};

export const writeFileTool: AgentTool = {
	def: {
		name: 'write_file',
		description: 'Write a UTF-8 text file within componentsRoot. Creates parent directories as needed.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Absolute filesystem path under componentsRoot.' },
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
		const path = await resolveScoped(ctx.scopes, args.path, 'write');
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, 'utf8');
		return { path, bytesWritten: Buffer.byteLength(content, 'utf8') };
	},
	destructive: true,
};

export const listDirTool: AgentTool = {
	def: {
		name: 'list_dir',
		description: 'List the immediate entries in a directory within an allowed scope.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Absolute filesystem path.' },
			},
			required: ['path'],
		},
	},
	handler: async (args: any, ctx: AgentToolContext) => {
		const path = await resolveScoped(ctx.scopes, args.path, 'read');
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
		description: 'Search recursively under a scoped directory for a regex pattern. Returns matched lines.',
		parameters: {
			type: 'object',
			properties: {
				root: { type: 'string', description: 'Directory to search under.' },
				pattern: { type: 'string', description: 'JavaScript-compatible regular expression source.' },
				flags: { type: 'string', description: 'Regex flags (default: "i").' },
				maxResults: { type: 'integer', minimum: 1, maximum: MAX_GREP_RESULTS },
			},
			required: ['root', 'pattern'],
		},
	},
	handler: async (args: any, ctx: AgentToolContext) => {
		const root = await resolveScoped(ctx.scopes, args.root, 'read');
		const pattern = new RegExp(args.pattern, args.flags ?? 'i');
		const cap = Math.min(args.maxResults ?? MAX_GREP_RESULTS, MAX_GREP_RESULTS);
		const results: Array<{ path: string; line: number; text: string }> = [];
		await walk(root, async (file) => {
			if (results.length >= cap) return false;
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
				if (pattern.test(lines[i])) results.push({ path: file, line: i + 1, text: lines[i] });
			}
			return true;
		});
		return { root, count: results.length, results };
	},
};

export const tailFileTool: AgentTool = {
	def: {
		name: 'tail_file',
		description: 'Return the last N lines of a UTF-8 file. Useful for log tails.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Absolute filesystem path.' },
				lines: { type: 'integer', minimum: 1, maximum: 5000 },
			},
			required: ['path'],
		},
	},
	handler: async (args: any, ctx: AgentToolContext) => {
		const path = await resolveScoped(ctx.scopes, args.path, 'read');
		const wanted = Math.min(args.lines ?? DEFAULT_TAIL_LINES, 5000);
		// Read only the trailing TAIL_READ_BYTES — a multi-GB log file otherwise OOMs the process.
		const st = await stat(path);
		const start = Math.max(0, st.size - TAIL_READ_BYTES);
		const truncated = start > 0;
		const fh = await open(path, 'r');
		try {
			const buf = Buffer.alloc(st.size - start);
			await fh.read(buf, 0, buf.length, start);
			const text = buf.toString('utf8');
			const all = text.split('\n');
			// `split('\n')` on a file ending with `\n` leaves a trailing empty entry — drop it so the
			// "last N lines" the agent sees matches what a human reading the file would see.
			if (all.length > 0 && all[all.length - 1] === '') all.pop();
			// When we read from a mid-file offset the first "line" is almost certainly a partial
			// fragment of a real line. Drop it so we don't hand the agent a misleading prefix.
			if (truncated && all.length > 0) all.shift();
			const sliceStart = Math.max(0, all.length - wanted);
			return { path, lines: all.slice(sliceStart), truncated };
		} finally {
			await fh.close();
		}
	},
};

export const fsTools: AgentTool[] = [readFileTool, writeFileTool, listDirTool, grepFilesTool, tailFileTool];

async function walk(root: string, visit: (file: string) => Promise<boolean>): Promise<void> {
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
				stack.push(full);
			} else if (entry.isFile()) {
				const proceed = await visit(full);
				if (proceed === false) return;
			}
		}
	}
}
