#!/usr/bin/env node
// Enforces the design-doc layout described in the root DESIGN.md: the root is an index only, every
// per-directory DESIGN.md section is indexed there and every index link resolves; each DESIGN.md and
// MAP.md stays within its byte budget, or its ceiling in CEILINGS_FILE; and each MAP.md has a
// `@MAP.md` CLAUDE.md, is listed in AGENTS.md and names only symbols and files that exist.
//   --base <ref>       also reject a raised or new ceiling, and hold only files changed since <ref> to their budget
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
export const CEILING_SLACK = KIB;
export const CEILINGS_FILE = 'build-tools/design-docs-ceilings.json';
const SKIP = new Set(['node_modules', 'dist', '.git', '.claude', 'unitTests', 'integrationTests']);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'this', 'super', 'NaN', 'Infinity']);
const PATH = /(?:^|\/)[^/.][^/]*\.(?:[cm]?[jt]s|[jt]sx|json|md|ya?ml|sh)$/;
const SOURCE_PATHSPECS = ['*.ts', '*.mts', '*.cts', '*.tsx', '*.js', '*.mjs', '*.cjs', '*.jsx'];
const WORD = /#?[A-Za-z_$][\w$]*/g;
const IDENTIFIER_PATH = /^#?[A-Za-z_$][\w$]*(?:\.#?[A-Za-z_$][\w$]*)*$/;

const readText = (root, file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const byteSize = (text) => Buffer.byteLength(text);
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
const headings = (root, file) =>
	readText(root, file)
		.split('\n')
		.filter((l) => l.startsWith('## '))
		.map((l) => l.slice(3).trim());

export function codeSpans(text) {
	const spans = [];
	let fence;
	text.split('\n').forEach((line, i) => {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim())
				fence = undefined;
			return;
		}
		if (marker) {
			fence = marker[1];
			return;
		}
		for (const match of line.matchAll(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/g))
			spans.push({ text: match[2].trim(), line: i + 1 });
	});
	return spans;
}

// What a backticked span names: a `#section:` marker, a file path (optionally `:line` or `:symbol`), or an
// identifier path such as `TableResource._writeUpdate` (a trailing call `(...)` is ignored).
export function classifySpan(span) {
	const section = /^(?:\/\/\s*)?#section:\s*([\w-]+)$/.exec(span);
	if (section) return { type: 'section', name: section[1] };
	const located = /^(.+?)(?::(\d+(?:-\d+)?)|#L\d+(?:-L?\d+)?|:[A-Za-z_$][\w$.]*)$/.exec(span);
	const file = located ? located[1] : span;
	if (PATH.test(file) && !/[\s*?{}<>[\]`'"]|^[a-z]+:/.test(file))
		return { type: 'path', path: file.replace(/^\.\//, ''), line: Boolean(located?.[2]) || /#L\d/.test(span) };
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
const relativeTo = (root, docDir, target) =>
	exists(root, path.posix.join(docDir, target)) || (!/^\.\.?\//.test(target) && exists(root, target));

function git(root, ...args) {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

function baseState(root, base) {
	try {
		git(root, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`);
	} catch {
		throw new Error(`--base ${base} does not resolve to a commit in this checkout`);
	}
	const changed = new Set(
		[
			...git(root, 'diff', '--name-only', '--no-renames', base, '--').split('\n'),
			...git(root, 'ls-files', '--others', '--exclude-standard').split('\n'),
		].filter(Boolean)
	);
	let atBase = true;
	try {
		git(root, 'cat-file', '-e', `${base}:${CEILINGS_FILE}`);
	} catch {
		atBase = false;
	}
	const ceilings = atBase
		? parseCeilings(git(root, 'show', `${base}:${CEILINGS_FILE}`), `${base}:${CEILINGS_FILE}`)
		: undefined;
	return { changed, ceilings };
}

let outlineModule;
const loadOutline = async () => (outlineModule ??= await import('./outline.mjs'));

// Declared names under `dir`, each with the names of the declarations enclosing it, and its section markers.
async function symbolIndex(root, dir, cache) {
	if (cache.has(dir)) return cache.get(dir);
	const { outlineSource, sourceFiles } = await loadOutline();
	const names = new Map();
	const sections = new Set();
	for (const file of sourceFiles(path.join(root, dir))) {
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
	cache.set(dir, index);
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
			else if (!relativeTo(root, dir, reference.path))
				problems.push({
					line: span.line,
					text: span.text,
					kind: 'path',
					why: `no such file in ${dir}/ or the repository root`,
				});
		} else if (
			!(reference.parts.length === 1 && ts.stringToToken(reference.parts[0]) !== undefined) &&
			!declares(index, reference.parts) &&
			!relativeTo(root, dir, span.text)
		) {
			problems.push({ line: span.line, text: span.text, kind: 'symbol', why: `not declared in ${dir}/ source` });
		}
	}
	return problems;
}

function budgetFor(file) {
	return path.posix.basename(file) === 'MAP.md' ? MAP_BUDGET : DESIGN_BUDGET;
}

export async function checkDesignDocs({ root, base } = {}) {
	const errors = [];
	const warnings = [];
	const { design, maps } = docFiles(root);
	const rootLines = readText(root, 'DESIGN.md').split('\n');

	const linked = new Map();
	for (const line of rootLines) {
		for (const m of line.matchAll(/\]\(([^)#\s]+)(?:#([^)\s]+))?\)/g)) {
			const [, file, anchor] = m;
			if (/^https?:/.test(file)) continue;
			if (!fs.existsSync(path.join(root, file))) {
				errors.push(`DESIGN.md links to missing file ${file}`);
				continue;
			}
			if (!anchor) continue;
			const anchors = headings(root, file).map(slug);
			if (!anchors.includes(anchor))
				errors.push(`DESIGN.md links to ${file}#${anchor}, which no ## heading there produces`);
			(linked.get(file) ?? linked.set(file, new Set()).get(file)).add(anchor);
		}
	}
	for (const file of design) {
		if (file === 'DESIGN.md') continue;
		const seen = linked.get(file) ?? new Set();
		for (const h of headings(root, file))
			if (!seen.has(slug(h))) errors.push(`${file} section "${h}" is not indexed in DESIGN.md`);
	}

	const ceilings = readCeilings(root);
	const baseline = base ? baseState(root, base) : undefined;
	const ceilingsChanged = baseline?.changed.has(CEILINGS_FILE);
	const inScope = (file) =>
		!baseline ||
		baseline.changed.has(file) ||
		(ceilingsChanged && (file in ceilings || file in (baseline.ceilings ?? {})));
	const report = (file, message) => {
		if (inScope(file)) errors.push(message);
		else warnings.push(`${message} (unchanged since ${base}, so not failing this change)`);
	};
	for (const file of [...design, ...maps]) {
		const text = readText(root, file);
		const size = byteSize(text);
		const limit = ceilings[file] ?? budgetFor(file);
		if (size > limit)
			report(
				file,
				`${file} is ${formatBytes(size)} bytes, over its ${file in ceilings ? 'ceiling' : 'budget'} of ${formatBytes(limit)} — prune it before adding`
			);
		if (file.endsWith('MAP.md') && lineCount(text) > MAP_LINES)
			report(file, `${file} is ${lineCount(text)} lines; a MAP.md stays within ${MAP_LINES}`);
	}
	const update = 'run `npm run check:design-docs -- --update-ceilings`';
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
		else if (ceiling - size > CEILING_SLACK)
			report(
				file,
				`${file} is ${formatBytes(size)} bytes, ${formatBytes(ceiling - size)} under its ceiling of ${formatBytes(ceiling)}; a trim lowers the ceiling — ${update}`
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

// What this repository once had: deleted paths, the words of removed source lines (comments stripped) and
// removed section markers. A reference that resolves nowhere now is dead only if it is here; otherwise it
// names something outside this repository (another repo's symbol, a native API, a runtime file).
async function pastNames(root) {
	if (git(root, 'rev-parse', '--is-shallow-repository').trim() === 'true')
		console.error(
			'warning: shallow history; a name removed before its oldest commit is not reported (fetch with --unshallow)'
		);
	const deleted = git(root, 'log', '--no-renames', '--diff-filter=D', '--name-only', '--format=', 'HEAD')
		.split('\n')
		.filter(Boolean);
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
		const code = line.slice(1);
		if (/^\s*(?:\/\*|\*)/.test(code)) continue;
		for (const word of code.replace(/(^|\s)\/\/.*$/, '').matchAll(WORD)) words.add(word[0]);
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
	const pathIsDead = (docDir, target) => {
		if (relativeTo(root, docDir, target)) return false;
		if (target.includes('/') ? files.some((file) => file.endsWith(`/${target}`)) : basenames.has(target)) return false;
		const full = path.posix.join(docDir, target);
		return past.deleted.some(
			(file) =>
				file === full ||
				file === target ||
				file.endsWith(`/${target}`) ||
				(!target.includes('/') && path.posix.basename(file) === target)
		);
	};
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
			} else if (
				isCodeShaped(reference) &&
				!(reference.parts.length === 1 && ts.stringToToken(reference.parts[0]) !== undefined) &&
				reference.parts.some((part) => !live.names.has(part) && past.words.has(part))
			) {
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

// Never raises an existing entry: a file past its ceiling has to be pruned, not re-recorded.
export function updateCeilings({ root } = {}) {
	const { design } = docFiles(root);
	const current = readCeilings(root);
	const ceilings = {};
	for (const file of design) {
		const size = byteSize(readText(root, file));
		if (size > DESIGN_BUDGET) ceilings[file] = Math.min(size, current[file] ?? size);
	}
	fs.writeFileSync(path.join(root, CEILINGS_FILE), `${JSON.stringify(ceilings, null, '\t')}\n`);
	return ceilings;
}

async function main(args) {
	let root = path.resolve(import.meta.dirname, '..');
	let base;
	let mode = 'check';
	let limit;
	const value = (i) => {
		if (args[i + 1] === undefined) throw new Error(`${args[i]} needs a value`);
		return args[i + 1];
	};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--base') base = value(i++);
		else if (args[i] === '--root') root = path.resolve(value(i++));
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
	const { errors, warnings } = await checkDesignDocs({ root, base });
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
