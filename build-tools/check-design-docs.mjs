#!/usr/bin/env node
// Enforces the DESIGN.md layout described in the root DESIGN.md: the root is an index only, every
// per-directory DESIGN.md section is indexed there, every index link resolves, and each file stays
// under its line budget so notes are pruned as they are added.
import fs from 'node:fs';
import path from 'node:path';

const ROOT_BUDGET = 250;
const FILE_BUDGET = 1000;
const repo = path.resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'dist', '.git', '.claude', 'unitTests', 'integrationTests']);

function* designFiles(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIP.has(entry.name)) yield* designFiles(path.join(dir, entry.name));
		} else if (entry.name === 'DESIGN.md') yield path.relative(repo, path.join(dir, entry.name));
	}
}
// GitHub's heading-anchor algorithm.
const slug = (s) =>
	s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\p{M} \-_]/gu, '')
		.replace(/ /g, '-');
const lines = (file) => fs.readFileSync(path.join(repo, file), 'utf8').split('\n');
const headings = (file) =>
	lines(file)
		.filter((l) => l.startsWith('## '))
		.map((l) => l.slice(3).trim());

const errors = [];
const root = lines('DESIGN.md');
if (root.length > ROOT_BUDGET) errors.push(`DESIGN.md is ${root.length} lines; the index budget is ${ROOT_BUDGET}`);

// Every link in the index resolves to a file and, when it has one, to a heading in that file.
const linked = new Map();
for (const line of root) {
	for (const m of line.matchAll(/\]\(([^)#\s]+)(?:#([^)\s]+))?\)/g)) {
		const [, file, anchor] = m;
		if (/^https?:/.test(file)) continue;
		if (!fs.existsSync(path.join(repo, file))) {
			errors.push(`DESIGN.md links to missing file ${file}`);
			continue;
		}
		if (!anchor) continue;
		const anchors = headings(file).map(slug);
		if (!anchors.includes(anchor))
			errors.push(`DESIGN.md links to ${file}#${anchor}, which no ## heading there produces`);
		(linked.get(file) ?? linked.set(file, new Set()).get(file)).add(anchor);
	}
}

for (const file of designFiles(repo)) {
	if (file === 'DESIGN.md') continue;
	const n = lines(file).length;
	if (n > FILE_BUDGET) errors.push(`${file} is ${n} lines; the budget is ${FILE_BUDGET} — prune before adding`);
	const seen = linked.get(file) ?? new Set();
	for (const h of headings(file))
		if (!seen.has(slug(h))) errors.push(`${file} section "${h}" is not indexed in DESIGN.md`);
}

if (errors.length) {
	console.error(errors.map((e) => `error: ${e}`).join('\n'));
	process.exit(1);
}
console.log('design docs: index complete, links resolve, budgets met');
