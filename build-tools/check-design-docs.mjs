#!/usr/bin/env node
// Enforces the DESIGN.md layout described in the root DESIGN.md: the root is an index only, every
// note the index registers is a design note whose sections are all indexed, every relative link
// and anchor in the index and the notes resolves, and each file stays under its line budget so
// notes are pruned as they are added.
import fs from 'node:fs';
import path from 'node:path';

const ROOT_BUDGET = 250;
const FILE_BUDGET = 1000;
const repo = path.resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'dist', '.git', '.claude', 'unitTests', 'integrationTests']);
const rel = (absolute) => path.relative(repo, absolute).split(path.sep).join('/');

function* designFiles(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIP.has(entry.name)) yield* designFiles(path.join(dir, entry.name));
		} else if (entry.name === 'DESIGN.md') yield rel(path.join(dir, entry.name));
	}
}
// GitHub's heading-anchor algorithm.
const slug = (s) =>
	s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\p{M} \-_]/gu, '')
		.replace(/ /g, '-');
const errors = [];
const lineCache = new Map();
const lines = (file) =>
	lineCache.get(file) ?? lineCache.set(file, fs.readFileSync(path.join(repo, file), 'utf8').split(/\r?\n/)).get(file);

const proseCache = new Map();
// A fence left open would hide the rest of the file from every check, so it is an error.
function prose(file) {
	if (proseCache.has(file)) return proseCache.get(file);
	const kept = [];
	let fence;
	lines(file).forEach((line, index) => {
		const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			if (marker && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim())
				fence = undefined;
		} else if (marker && !(marker[1][0] === '`' && marker[2].includes('`')))
			fence = { marker: marker[1], line: index + 1 };
		else kept.push([index + 1, line]);
	});
	if (fence) errors.push(`${file}:${fence.line} opens a code fence that is never closed`);
	proseCache.set(file, kept);
	return kept;
}

const anchorCache = new Map();
// Every heading's anchor, de-duplicated as GitHub does (`-1`, `-2`, skipping taken slugs).
function anchors(file) {
	if (anchorCache.has(file)) return anchorCache.get(file);
	const taken = new Map();
	const found = [];
	for (const [, line] of prose(file)) {
		const heading = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
		if (!heading) continue;
		const base = slug(heading[2]);
		let anchor = base;
		while (taken.has(anchor)) {
			taken.set(base, taken.get(base) + 1);
			anchor = `${base}-${taken.get(base)}`;
		}
		taken.set(anchor, 0);
		found.push({ anchor, level: heading[1].length, text: heading[2] });
	}
	anchorCache.set(file, found);
	return found;
}

// A code span opens and closes with backtick runs of the same length (CommonMark).
const CODE_SPAN = /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g;
function* links(file) {
	for (const [number, line] of prose(file)) {
		for (const m of line
			.replace(CODE_SPAN, '')
			.matchAll(/\]\(([^)#\s]*)(?:#([^)\s]*))?(?:\s+(?:"[^"]*"|'[^']*'))?\)/g)) {
			if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue;
			yield { number, target: m[1], anchor: m[2], listItem: /^\s*[-*] /.test(line) };
		}
	}
}

function resolveLink(from, { number, target, anchor }, level) {
	const file = target ? rel(path.join(repo, target.startsWith('/') ? '' : path.dirname(from), target)) : from;
	const at = `${from}:${number}`;
	if (file === '..' || file.startsWith('../')) {
		errors.push(`${at} links outside the repository: ${target}`);
		return;
	}
	if (!fs.existsSync(path.join(repo, file))) {
		errors.push(`${at} links to missing file ${target}`);
		return;
	}
	if (
		anchor &&
		file.endsWith('.md') &&
		!anchors(file).some((h) => h.anchor === anchor && (!level || h.level === level))
	)
		errors.push(
			`${at} links to ${target}#${anchor}, which no ${level ? '#'.repeat(level) + ' ' : ''}heading there produces`
		);
	return file;
}

const rootLines = lines('DESIGN.md');
if (rootLines.length > ROOT_BUDGET)
	errors.push(`DESIGN.md is ${rootLines.length} lines; the index budget is ${ROOT_BUDGET}`);

const registered = new Map();
for (const link of links('DESIGN.md')) {
	const file = resolveLink('DESIGN.md', link, link.listItem ? 2 : undefined);
	if (file && link.listItem) (registered.get(file) ?? registered.set(file, new Set()).get(file)).add(link.anchor);
}

const notes = new Set(designFiles(repo));
for (const file of registered.keys()) if (file.endsWith('.md')) notes.add(file);
notes.delete('DESIGN.md');

for (const file of [...notes].sort()) {
	const n = lines(file).length;
	if (path.basename(file) === 'DESIGN.md' && n > FILE_BUDGET)
		errors.push(`${file} is ${n} lines; the budget is ${FILE_BUDGET} — prune before adding`);
	const seen = registered.get(file) ?? new Set();
	for (const { anchor, level, text } of anchors(file))
		if (level === 2 && !seen.has(anchor)) errors.push(`${file} section "${text}" is not indexed in DESIGN.md`);
	for (const link of links(file)) resolveLink(file, link);
}

if (errors.length) {
	console.error(errors.map((e) => `error: ${e}`).join('\n'));
	process.exit(1);
}
console.log('design docs: index complete, links resolve, budgets met');
