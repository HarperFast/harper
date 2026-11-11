#!/usr/bin/env node
// Enforces the design-doc layout described in the root DESIGN.md: the root is an index only, every
// section of a note the index registers is indexed there and every inline relative link and anchor in
// the index and the notes resolves; each DESIGN.md and MAP.md stays within its byte budget, or between its
// ceiling in CEILINGS_FILE and that ceiling's floor, CEILING_HEADROOM percent under it; and each MAP.md has a
// `@MAP.md` CLAUDE.md, is listed in AGENTS.md and names only symbols and files that exist.
//   --base <ref>       also reject a raised or new ceiling, hold only files changed since <ref> or whose ceiling
//                      entry changed to their budget, and hold a change whose new text alone would pass a ceiling
//                      to cutting that file to the floor
//   --push             <ref> is the tip a push replaced, so the range can hold changes made against other bases:
//                      skip the floor rule, which judges one change
//   --update-ceilings  rewrite CEILINGS_FILE from current sizes
//   --stale            report-only: dead backticked paths and symbols, and files over ceiling (markdown, exit 0)
//   --limit <chars>    cap the --stale report at about this many characters
//   --root <dir>       check another tree (tests)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const KIB = 1024;
export const DESIGN_BUDGET = 40 * KIB;
export const MAP_BUDGET = 8 * KIB;
export const MAP_LINES = 80;
export const CEILING_HEADROOM = 40;
export const CEILINGS_FILE = 'build-tools/design-docs-ceilings.json';
const SKIP = new Set(['node_modules', 'dist', '.git', '.claude', 'fixtures']);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'this', 'super', 'NaN', 'Infinity']);
const KNOWN_FILE = /(?:^|\/)[^/.][^/]*\.(?:[cm]?[jt]s|[jt]sx|json|md|ya?ml|sh)$/;
const ANY_FILE = /(?:^|\/)[^/.][^/]*\.[A-Za-z][A-Za-z0-9]*$/;
const SOURCE_PATHSPECS = ['*.ts', '*.mts', '*.cts', '*.tsx', '*.js', '*.mjs', '*.cjs', '*.jsx'];
const WORD = /#?[A-Za-z_$][\w$]*/g;
const IDENTIFIER_PATH = /^#?[A-Za-z_$][\w$]*(?:\.#?[A-Za-z_$][\w$]*)*$/;
// `path` then `:12-14`, `#L12-L14`, or `:Symbol.member` with an optional call `(...)`.
const LOCATED =
	/^(.+?)(?::(\d+(?:-\d+)?)|(#L\d+(?:-L?\d+)?)|:(#?[A-Za-z_$][\w$]*(?:\.#?[A-Za-z_$][\w$]*)*)(?:\(.*\))?)$/;

const readText = (root, file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const byteSize = (text) => Buffer.byteLength(text);
// A ceiling's floor: the least a file may weigh before its ceiling must come down to it, and the most a cut
// forced by that ceiling may leave.
const ceilingFloor = (ceiling) => Math.floor((ceiling * (100 - CEILING_HEADROOM)) / 100);
// The highest ceiling whose floor is at most `size`.
const ceilingFor = (size) => Math.ceil(((size + 1) * 100) / (100 - CEILING_HEADROOM)) - 1;
const lineCount = (text) => (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length);
const formatBytes = (n) => n.toLocaleString('en-US');

function docFiles(root) {
	const design = [];
	const maps = [];
	(function walk(dir) {
		for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
			const file = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!SKIP.has(entry.name)) walk(file);
			} else if (entry.name === 'DESIGN.md') design.push(file);
			else if (entry.name === 'MAP.md') maps.push(file);
		}
	})('');
	return { design: design.sort(), maps: maps.sort() };
}

// GitHub's heading-anchor algorithm.
const slug = (s) =>
	s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\p{M} \-_]/gu, '')
		.replace(/ /g, '-');

// A fence left open hides the rest of the text from every check, so its line is returned as `unclosed`.
function proseLines(text) {
	const lines = [];
	let fence;
	text.split('\n').forEach((line, i) => {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			if (marker && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim())
				fence = undefined;
		} else if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) fence = { marker: marker[1], line: i + 1 };
		else lines.push([i + 1, line]);
	});
	return { lines, unclosed: fence?.line };
}

const CODE_SPAN = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;

export function codeSpans(text) {
	const spans = [];
	for (const [line, content] of proseLines(text).lines)
		for (const match of content.matchAll(CODE_SPAN)) spans.push({ text: match[2].trim(), line });
	return spans;
}

// What a backticked span names: a `#section:` marker, a file path (optionally `:line` or `:symbol`), or an
// identifier path such as `TableResource._writeUpdate` (a trailing call `(...)` is ignored).
export function classifySpan(span) {
	const section = /^(?:\/\/\s*)?#section:\s*([\w-]+)$/.exec(span);
	if (section) return { type: 'section', name: section[1] };
	const located = LOCATED.exec(span);
	const file = located ? located[1] : span;
	// A dotted name such as `Table.subscribe` is a symbol unless its extension is a known one; with a
	// directory or a `:` suffix, any extension marks a file.
	const isFile =
		KNOWN_FILE.test(file) || ((file.includes('/') || located || !IDENTIFIER_PATH.test(file)) && ANY_FILE.test(file));
	if (isFile && !/[\s*?{}<>[\]`'"]|^[a-z]+:/.test(file))
		return {
			type: 'path',
			path: file.replace(/^\.\//, ''),
			line: Boolean(located?.[2] || located?.[3]),
			...(located?.[4] && { symbol: located[4].split('.') }),
		};
	const call = /^(.+?)\(.*\)$/.exec(span);
	const name = call ? call[1] : span;
	if (IDENTIFIER_PATH.test(name) && !LITERALS.has(name))
		return { type: 'symbol', parts: name.split('.'), call: Boolean(call) };
	return undefined;
}

function repoFiles(root) {
	const files = [];
	(function walk(dir) {
		for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
			const file = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!['node_modules', 'dist', '.git', '.claude'].includes(entry.name)) walk(file);
			} else files.push(file);
		}
	})('');
	return { files, basenames: new Set(files.map((file) => path.posix.basename(file))) };
}

const exists = (root, file) => fs.existsSync(path.join(root, file));
const resolveFrom = (root, docDir, target) => {
	const fromDoc = path.posix.join(docDir, target);
	if (exists(root, fromDoc)) return fromDoc;
	if (!/^\.\.?\//.test(target) && exists(root, target)) return target;
	return undefined;
};
const relativeTo = (root, docDir, target) => resolveFrom(root, docDir, target) !== undefined;
const isKeyword = (ts, reference) =>
	!reference.call && reference.parts.length === 1 && ts.stringToToken(reference.parts[0]) !== undefined;

function git(root, ...args) {
	return execFileSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 1 << 26,
	});
}

function parseCeilings(text, source) {
	const ceilings = JSON.parse(text);
	if (!ceilings || typeof ceilings !== 'object' || Array.isArray(ceilings))
		throw new Error(`${source} must be an object of path → bytes`);
	for (const [file, value] of Object.entries(ceilings)) {
		if (!Number.isSafeInteger(value) || value <= 0)
			throw new Error(`${source}: ceiling for ${file} must be a positive integer byte count`);
	}
	return ceilings;
}

function readCeilings(root) {
	const file = path.join(root, CEILINGS_FILE);
	return fs.existsSync(file) ? parseCeilings(fs.readFileSync(file, 'utf8'), CEILINGS_FILE) : {};
}

function textAt(root, commit, file) {
	if (!git(root, 'ls-tree', '--name-only', commit, '--', file)) return undefined;
	return git(root, 'cat-file', 'blob', `${commit}:${file}`).replace(/\r\n/g, '\n');
}

function baseState(root, base) {
	let commit;
	try {
		if (base.startsWith('-')) throw new Error('an option, not a ref');
		commit = git(root, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`).trim();
	} catch {
		throw new Error(`--base ${base} does not resolve to a commit in this checkout`);
	}
	const changed = new Set(
		[
			...git(root, 'diff', '--name-only', '-z', '--no-renames', commit, '--').split('\0'),
			...git(root, 'ls-files', '-z', '--others', '--exclude-standard').split('\0'),
		].filter(Boolean)
	);
	const ceilingsText = textAt(root, commit, CEILINGS_FILE);
	const ceilings = ceilingsText === undefined ? undefined : parseCeilings(ceilingsText, `${base}:${CEILINGS_FILE}`);
	return { commit, changed, ceilings };
}

const TOKEN = /[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu;

// The bytes of new text `text` holds over `before`: the tokens (letter and digit runs, single other marks) it has
// more of, plus the whitespace it gained. A token matches itself anywhere in the file, so text the change only moved
// or reordered adds nothing, re-wrapped text adds only whitespace it gained, and an edit adds its changed tokens.
function addedBytes(before, text) {
	const left = new Map();
	let spaceBefore = byteSize(before);
	for (const [token] of before.matchAll(TOKEN)) {
		left.set(token, (left.get(token) ?? 0) + 1);
		spaceBefore -= byteSize(token);
	}
	let added = 0;
	let space = byteSize(text);
	for (const [token] of text.matchAll(TOKEN)) {
		const bytes = byteSize(token);
		space -= bytes;
		const count = left.get(token);
		if (count) left.set(token, count - 1);
		else added += bytes;
	}
	return added + Math.max(0, space - spaceBefore);
}

let outlineModule;
const loadOutline = async () => (outlineModule ??= await import('./outline.mjs'));

async function symbolIndex(root, target, cache) {
	if (cache.has(target)) return cache.get(target);
	const { outlineSource, sourceFiles } = await loadOutline();
	const names = new Map();
	const sections = new Set();
	const full = path.join(root, target);
	for (const file of fs.statSync(full).isDirectory() ? sourceFiles(full) : [full]) {
		const visit = (node, ancestors) => {
			for (const child of node.children) {
				if (child.kind === 'section') sections.add(child.name);
				else (names.get(child.name) ?? names.set(child.name, []).get(child.name)).push(ancestors);
				visit(child, child.kind === 'section' ? ancestors : [...ancestors, child.name]);
			}
		};
		visit(outlineSource(file, fs.readFileSync(file, 'utf8')), []);
	}
	const index = { names, sections };
	cache.set(target, index);
	return index;
}

// `A.b` needs `b` declared directly in `A`; `x.A.b` also needs an `x` enclosing that `A`.
const declares = (index, parts) =>
	(index.names.get(parts.at(-1)) ?? []).some((ancestors) => {
		if (parts.length === 1) return true;
		if (ancestors.at(-1) !== parts.at(-2)) return false;
		let at = 0;
		for (const name of ancestors.slice(0, -1)) if (at < parts.length - 2 && name === parts[at]) at++;
		return at === parts.length - 2;
	});

async function mapReferenceErrors(root, map, state) {
	const dir = path.posix.dirname(map);
	const index = await symbolIndex(root, dir, state.symbols);
	const { default: ts } = await import('typescript');
	const problems = [];
	for (const span of codeSpans(readText(root, map))) {
		const reference = classifySpan(span.text);
		if (!reference) continue;
		if (reference.type === 'section') {
			if (!index.sections.has(reference.name))
				problems.push({
					line: span.line,
					text: span.text,
					kind: 'section',
					why: `no \`// #section: ${reference.name}\` marker under ${dir}/`,
				});
		} else if (reference.type === 'path') {
			if (reference.line)
				problems.push({
					line: span.line,
					text: span.text,
					kind: 'path',
					why: 'MAP.md names symbols, not line numbers',
				});
			else {
				const file = resolveFrom(root, dir, reference.path);
				if (!file)
					problems.push({
						line: span.line,
						text: span.text,
						kind: 'path',
						why: `no such file in ${dir}/ or the repository root`,
					});
				else if (reference.symbol && !declares(await symbolIndex(root, file, state.symbols), reference.symbol))
					problems.push({ line: span.line, text: span.text, kind: 'symbol', why: `not declared in ${file}` });
			}
		} else if (!isKeyword(ts, reference) && !declares(index, reference.parts) && !relativeTo(root, dir, span.text)) {
			problems.push({ line: span.line, text: span.text, kind: 'symbol', why: `not declared in ${dir}/ source` });
		}
	}
	return problems;
}

function budgetFor(file) {
	return path.posix.basename(file) === 'MAP.md' ? MAP_BUDGET : DESIGN_BUDGET;
}

const LINK = /\]\(([^)#\s]*)(?:#([^)\s]*))?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

// A root list entry must link to a `##` heading and registers each markdown file it links to as a note;
// a link in the root's prose may target any heading and registers nothing.
function checkLinks(root, design, errors) {
	const proseCache = new Map();
	const prose = (file) => {
		if (!proseCache.has(file)) {
			const { lines, unclosed } = proseLines(readText(root, file));
			if (unclosed) errors.push(`${file}:${unclosed} opens a code fence that is never closed`);
			proseCache.set(file, lines);
		}
		return proseCache.get(file);
	};
	const anchorCache = new Map();
	// GitHub de-duplicates a repeated slug with `-1`, `-2`, skipping slugs already taken.
	const anchors = (file) => {
		if (anchorCache.has(file)) return anchorCache.get(file);
		const taken = new Map();
		const found = [];
		for (const [, line] of prose(file)) {
			const heading = HEADING.exec(line);
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
	};
	function* links(file) {
		for (const [line, text] of prose(file))
			for (const match of text.replace(CODE_SPAN, '').matchAll(LINK)) {
				if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(match[1])) continue;
				yield { line, target: match[1], anchor: match[2], listItem: /^\s*(?:[-*+]|\d+[.)])[ \t]/.test(text) };
			}
	}
	const resolve = (from, { line, target, anchor }, level) => {
		const file = target
			? path.posix.normalize(
					target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(from), target)
				)
			: from;
		const at = `${from}:${line}`;
		if (file === '..' || file.startsWith('../')) {
			errors.push(`${at} links outside the repository: ${target}`);
			return;
		}
		if (!fs.existsSync(path.join(root, file))) {
			errors.push(`${at} links to missing file ${target}`);
			return;
		}
		if (
			anchor &&
			file.endsWith('.md') &&
			!anchors(file).some((h) => h.anchor === anchor && (!level || h.level === level))
		)
			errors.push(
				`${at} links to ${target}#${anchor}, which no ${level ? `${'#'.repeat(level)} ` : ''}heading there produces`
			);
		return file;
	};

	const indexed = new Map();
	for (const link of links('DESIGN.md')) {
		const file = resolve('DESIGN.md', link, link.listItem ? 2 : undefined);
		if (file && link.listItem) (indexed.get(file) ?? indexed.set(file, new Set()).get(file)).add(link.anchor);
	}
	const notes = new Set(design);
	for (const file of indexed.keys()) if (file.endsWith('.md')) notes.add(file);
	notes.delete('DESIGN.md');
	for (const file of [...notes].sort()) {
		const seen = indexed.get(file) ?? new Set();
		for (const { anchor, level, text } of anchors(file))
			if (level === 2 && !seen.has(anchor)) errors.push(`${file} section "${text}" is not indexed in DESIGN.md`);
		for (const link of links(file)) resolve(file, link);
	}
}

export async function checkDesignDocs({ root, base, push } = {}) {
	const errors = [];
	const warnings = [];
	const { design, maps } = docFiles(root);
	checkLinks(root, design, errors);

	const ceilings = readCeilings(root);
	const baseline = base ? baseState(root, base) : undefined;
	const ceilingsChanged = baseline?.changed.has(CEILINGS_FILE);
	const inScope = (file) =>
		!baseline || baseline.changed.has(file) || (ceilingsChanged && ceilings[file] !== baseline.ceilings?.[file]);
	const report = (file, message) => {
		if (inScope(file)) errors.push(message);
		else warnings.push(`${message} (unchanged since ${base}, so not failing this change)`);
	};
	const update = 'run `npm run check:design-docs -- --update-ceilings`';
	const floorText = (ceiling) => {
		const floor = ceilingFloor(ceiling);
		return `${formatBytes(floor)} bytes (${100 - CEILING_HEADROOM}% of the ceiling${floor <= DESIGN_BUDGET ? ', and within the budget, so the ceiling goes' : ''})`;
	};
	for (const file of [...design, ...maps]) {
		const text = readText(root, file);
		const size = byteSize(text);
		const limit = ceilings[file] ?? budgetFor(file);
		if (size > limit)
			report(
				file,
				file in ceilings
					? `${file} is ${formatBytes(size)} bytes, over its ceiling of ${formatBytes(limit)} — prune it to at most ${floorText(limit)}, then ${update}`
					: `${file} is ${formatBytes(size)} bytes, over its budget of ${formatBytes(limit)} — prune it before adding`
			);
		if (file.endsWith('MAP.md') && lineCount(text) > MAP_LINES)
			report(file, `${file} is ${lineCount(text)} lines; a MAP.md stays within ${MAP_LINES}`);
	}
	for (const [file, ceiling] of Object.entries(ceilings)) {
		if (path.posix.basename(file) !== 'DESIGN.md') {
			errors.push(`${CEILINGS_FILE} lists ${file}; only DESIGN.md files get ceilings`);
			continue;
		}
		if (!fs.existsSync(path.join(root, file))) {
			report(file, `${CEILINGS_FILE} lists ${file}, which does not exist — ${update}`);
			continue;
		}
		const size = byteSize(readText(root, file));
		if (size <= DESIGN_BUDGET)
			report(
				file,
				`${file} is within the ${formatBytes(DESIGN_BUDGET)}-byte budget, so its ceiling is spent — ${update}`
			);
		else if (size < ceilingFloor(ceiling))
			report(
				file,
				`${file} is ${formatBytes(size)} bytes, more than ${CEILING_HEADROOM}% under its ceiling of ${formatBytes(ceiling)}; a trim that deep lowers the ceiling — ${update}`
			);
	}
	if (baseline?.ceilings) {
		if (!fs.existsSync(path.join(root, CEILINGS_FILE)))
			errors.push(`${CEILINGS_FILE} was deleted; keep it (\`{}\` once no file needs a ceiling)`);
		for (const file of Object.keys(baseline.ceilings)) {
			if (!(file in ceilings) && fs.existsSync(path.join(root, file)) && byteSize(readText(root, file)) > DESIGN_BUDGET)
				errors.push(
					`${CEILINGS_FILE} drops the ceiling for ${file}, which is still over the ${formatBytes(DESIGN_BUDGET)}-byte budget`
				);
		}
		for (const [file, ceiling] of Object.entries(ceilings)) {
			const before = baseline.ceilings[file];
			if (before === undefined)
				errors.push(
					`${CEILINGS_FILE} adds a ceiling for ${file}; a ceiling only ever falls — prune ${file} to ${formatBytes(DESIGN_BUDGET)} bytes instead`
				);
			else if (ceiling > before)
				errors.push(
					`${CEILINGS_FILE} raises ${file} from ${formatBytes(before)} to ${formatBytes(ceiling)}; a ceiling only ever falls — prune instead`
				);
		}
		// A cut back to just under the ceiling leaves the next change no room, so a change that needs a cut makes a deep
		// one. Judged against the base ceiling, the one the change's new text had to fit under.
		for (const [file, ceiling] of push ? [] : Object.entries(baseline.ceilings)) {
			if (!baseline.changed.has(file) || !fs.existsSync(path.join(root, file))) continue;
			const before = textAt(root, baseline.commit, file);
			if (before === undefined) continue;
			const text = readText(root, file);
			const size = byteSize(text);
			const room = ceiling - byteSize(before);
			const added = addedBytes(before, text);
			if (size <= ceiling && size > ceilingFloor(ceiling) && added > room)
				errors.push(
					`${file}: this change adds ${formatBytes(added)} bytes of new text to a file ${formatBytes(Math.abs(room))} bytes ${room < 0 ? 'over' : 'under'} its ceiling of ${formatBytes(ceiling)} at ${base}, and cuts it back only to ${formatBytes(size)}; a change that has to cut to fit cuts to at most ${floorText(ceiling)} — prune ${formatBytes(size - ceilingFloor(ceiling))} more, then ${update}`
				);
		}
	}

	const state = { symbols: new Map() };
	const agents = fs.existsSync(path.join(root, 'AGENTS.md')) ? readText(root, 'AGENTS.md') : '';
	for (const map of maps) {
		const dir = path.posix.dirname(map);
		if (dir === '.') {
			errors.push('MAP.md at the repository root: the root map is AGENTS.md; maps live in subdirectories');
			continue;
		}
		const claude = `${dir}/CLAUDE.md`;
		if (!fs.existsSync(path.join(root, claude)))
			errors.push(
				`${map} needs ${claude} containing exactly \`@MAP.md\`, so Claude Code loads the map with the directory`
			);
		else if (readText(root, claude).replace(/\n$/, '') !== '@MAP.md')
			errors.push(`${claude} must be exactly \`@MAP.md\` (one line) because ${map} exists`);
		if (!agents.includes(`](${map})`))
			errors.push(
				`${map} is not linked from AGENTS.md, which lists the directory maps for agents that do not load CLAUDE.md`
			);
		for (const problem of await mapReferenceErrors(root, map, state))
			errors.push(`${map}:${problem.line} \`${problem.text}\`: ${problem.why}`);
	}
	return { errors, warnings };
}

// Names that are live for a DESIGN.md reference: every identifier, private name and word of a string or
// template or regex literal in source (comments do not count), module basenames, and section markers.
async function liveNames(root) {
	const { parse, sourceFiles } = await loadOutline();
	const { default: ts } = await import('typescript');
	const names = new Set();
	const sections = new Set();
	for (const file of sourceFiles(root)) {
		const text = fs.readFileSync(file, 'utf8');
		names.add(path.basename(file).replace(/\..*$/, ''));
		for (const match of text.matchAll(/^\s*\/\/\s*#section:\s*(\S+)/gm)) sections.add(match[1]);
		const visit = (node) => {
			if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) names.add(node.text);
			else if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isRegularExpressionLiteral(node))
				for (const word of node.text.matchAll(WORD)) names.add(word[0]);
			ts.forEachChild(node, visit);
		};
		visit(parse(file, text));
	}
	return { names, sections };
}

// Adds the identifier, keyword, private-name and literal words of one line of source; comments are trivia.
function addCodeWords(ts, scanner, line, words) {
	const { SyntaxKind: Kind } = ts;
	const templates = []; // brace depth at each open `${`, so its `}` resumes the template
	let depth = 0;
	scanner.setText(line);
	for (let token = scanner.scan(); token !== Kind.EndOfFileToken; token = scanner.scan()) {
		if (token === Kind.CloseBraceToken && templates.at(-1) === depth) {
			templates.pop();
			token = scanner.reScanTemplateToken(false);
		} else if (token === Kind.OpenBraceToken) depth++;
		else if (token === Kind.CloseBraceToken) depth--;
		if (token === Kind.TemplateHead || token === Kind.TemplateMiddle) templates.push(depth);
		if (
			token === Kind.Identifier ||
			token === Kind.PrivateIdentifier ||
			(token >= Kind.FirstKeyword && token <= Kind.LastKeyword)
		)
			words.add(scanner.getTokenText());
		else if (token >= Kind.FirstLiteralToken && token <= Kind.LastTemplateToken)
			for (const word of scanner.getTokenValue().matchAll(WORD)) words.add(word[0]);
	}
}

// What this repository once had: deleted paths, the words of removed source lines (comments stripped) and
// removed section markers. A reference that resolves nowhere now is dead only if it is here; otherwise it
// names something outside this repository (another repo's symbol, a native API, a runtime file).
async function pastNames(root) {
	if (git(root, 'rev-parse', '--is-shallow-repository').trim() === 'true')
		console.error(
			'warning: shallow history; a name removed before its oldest commit is not reported (fetch with --unshallow)'
		);
	const deleted = git(root, 'log', '-z', '--no-renames', '--diff-filter=D', '--name-only', '--format=', 'HEAD')
		.split(/[\0\n]/)
		.filter(Boolean);
	const { default: ts } = await import('typescript');
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, true);
	const words = new Set();
	const sections = new Set();
	const log = spawn('git', ['log', '-p', '--no-renames', '--format=', '-U0', 'HEAD', '--', ...SOURCE_PATHSPECS], {
		cwd: root,
		stdio: ['ignore', 'pipe', 'inherit'],
	});
	const exit = new Promise((resolve, reject) => log.on('error', reject).on('close', resolve));
	for await (const line of readline.createInterface({ input: log.stdout, crlfDelay: Infinity })) {
		if (!line.startsWith('-') || line.startsWith('---')) continue;
		const marker = /\/\/\s*#section:\s*(\S+)/.exec(line);
		if (marker) sections.add(marker[1]);
		// A line opening with `*` is inside a block comment.
		if (!/^-\s*\*/.test(line)) addCodeWords(ts, scanner, line.slice(1), words);
	}
	const code = await exit;
	if (code !== 0) throw new Error(`git log -p exited ${code}`);
	return { deleted, words, sections };
}

const isCodeShaped = (reference) =>
	reference.call || reference.parts.length > 1 || /[a-z0-9][A-Z]|_|^#/.test(reference.parts[0]);

export async function staleReport({ root, limit = Infinity } = {}) {
	const { design, maps } = docFiles(root);
	const ceilings = readCeilings(root);
	const over = [];
	for (const file of [...design, ...maps]) {
		const size = byteSize(readText(root, file));
		const limit = ceilings[file] ?? budgetFor(file);
		if (size > limit)
			over.push(
				`- \`${file}\`: ${formatBytes(size)} bytes, ${file in ceilings ? 'ceiling' : 'budget'} ${formatBytes(limit)}`
			);
	}

	const { default: ts } = await import('typescript');
	const live = await liveNames(root);
	const past = await pastNames(root);
	const { files, basenames } = repoFiles(root);
	const state = { symbols: new Map() };
	const dead = new Map();
	const mapErrors = new Map();
	const add = (file, problem, into = dead) => (into.get(file) ?? into.set(file, []).get(file)).push(problem);
	const pathIsLive = (docDir, target) =>
		relativeTo(root, docDir, target) ||
		(target.includes('/') ? files.some((file) => file.endsWith(`/${target}`)) : basenames.has(target));
	const pathIsDead = (docDir, target) => {
		if (pathIsLive(docDir, target)) return false;
		const full = path.posix.join(docDir, target);
		return past.deleted.some(
			(file) =>
				file === full ||
				file === target ||
				file.endsWith(`/${target}`) ||
				(!target.includes('/') && path.posix.basename(file) === target)
		);
	};
	const symbolIsDead = (parts) => parts.some((part) => !live.names.has(part) && past.words.has(part));
	for (const file of design) {
		const dir = path.posix.dirname(file);
		for (const span of codeSpans(readText(root, file))) {
			const reference = classifySpan(span.text);
			if (!reference) continue;
			if (reference.type === 'section') {
				if (!live.sections.has(reference.name) && past.sections.has(reference.name))
					add(file, { ...span, kind: 'section' });
			} else if (reference.type === 'path') {
				if (pathIsDead(dir, reference.path)) add(file, { ...span, kind: 'path' });
				else if (reference.symbol && symbolIsDead(reference.symbol)) add(file, { ...span, kind: 'symbol' });
			} else if (ANY_FILE.test(span.text) && (pathIsLive(dir, span.text) || pathIsDead(dir, span.text))) {
				// `schema.graphql` parses as a dotted name, but it names a file once a file has or had that name.
				if (!pathIsLive(dir, span.text)) add(file, { ...span, kind: 'path' });
			} else if (isCodeShaped(reference) && !isKeyword(ts, reference) && symbolIsDead(reference.parts)) {
				add(file, { ...span, kind: 'symbol' });
			}
		}
	}
	for (const map of maps) {
		if (path.posix.dirname(map) === '.') continue;
		for (const problem of await mapReferenceErrors(root, map, state)) add(map, problem, mapErrors);
	}

	if (over.length === 0 && dead.size === 0 && mapErrors.size === 0) return '';
	const lines = [];
	const section = (heading, intro, byFile) => {
		const count = [...byFile.values()].reduce((sum, list) => sum + list.length, 0);
		lines.push(heading, '', intro(count), '');
		for (const [file, problems] of byFile) {
			lines.push(`### \`${file}\``, '');
			for (const problem of problems)
				lines.push(`- line ${problem.line}: \`${problem.text}\` (${problem.why ?? problem.kind})`);
			lines.push('');
		}
	};
	if (over.length) lines.push('## Over budget or ceiling', '', ...over, '');
	if (mapErrors.size)
		section(
			'## Map references that do not resolve',
			(count) => `${count} backticked names in MAP.md files that their directory does not declare.`,
			mapErrors
		);
	if (dead.size)
		section(
			'## Dead references',
			(count) =>
				`${count} backticked names in design docs that this repository once had and no longer does: a deleted file, a removed \`#section:\` marker, or a symbol that appears nowhere in source now (identifiers, string literals and module names count; comments do not) but did in a removed line. Names this repository never had are not listed.`,
			dead
		);
	let text = '';
	for (const [i, line] of lines.entries()) {
		if (text.length + line.length > limit) {
			const rest = lines.slice(i).filter((l) => l.startsWith('- ')).length;
			text += `\n- … ${rest} more not shown; run \`npm run check:design-docs -- --stale\` for the full list.\n`;
			break;
		}
		text += `${line}\n`;
	}
	return text;
}

// Never raises an entry: a file past its ceiling has to be pruned, not re-recorded. A file new to the list gets no
// headroom, since a ceiling is never added under --base and room is what a trim earns.
export function updateCeilings({ root } = {}) {
	const { design } = docFiles(root);
	const current = readCeilings(root);
	const ceilings = {};
	for (const file of design) {
		const size = byteSize(readText(root, file));
		if (size > DESIGN_BUDGET) ceilings[file] = file in current ? Math.min(current[file], ceilingFor(size)) : size;
	}
	fs.writeFileSync(path.join(root, CEILINGS_FILE), `${JSON.stringify(ceilings, null, '\t')}\n`);
	return ceilings;
}

async function main(args) {
	let root = path.resolve(import.meta.dirname, '..');
	let base;
	let push = false;
	let mode = 'check';
	let limit;
	const value = (i) => {
		if (args[i + 1] === undefined) throw new Error(`${args[i]} needs a value`);
		return args[i + 1];
	};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--base') base = value(i++);
		else if (args[i] === '--root') root = path.resolve(value(i++));
		else if (args[i] === '--push') push = true;
		else if (args[i] === '--stale') mode = 'stale';
		else if (args[i] === '--update-ceilings') mode = 'update';
		else if (args[i] === '--limit') limit = Number(value(i++));
		else {
			console.error(`check-design-docs: unknown argument ${args[i]}`);
			return 2;
		}
	}
	if (mode === 'stale') {
		const text = await staleReport({ root, limit });
		if (text) process.stdout.write(text);
		else console.error('design docs: no stale references, nothing over ceiling');
		return 0;
	}
	if (mode === 'update') {
		const ceilings = updateCeilings({ root });
		console.log(
			`wrote ${CEILINGS_FILE}: ${Object.keys(ceilings).length} files over the ${formatBytes(DESIGN_BUDGET)}-byte budget`
		);
		return 0;
	}
	const { errors, warnings } = await checkDesignDocs({ root, base, push });
	for (const warning of warnings) console.error(`warning: ${warning}`);
	if (errors.length) {
		console.error(errors.map((e) => `error: ${e}`).join('\n'));
		return 1;
	}
	console.log('design docs: index complete, links resolve, budgets and ceilings met, maps resolve');
	return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (error) {
		console.error(`error: ${error.message}`);
		process.exitCode = 2;
	}
}
