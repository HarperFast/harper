/**
 * Summarizes V8 .cpuprofile files produced by `run-single-node.mts --profile`.
 * Prints the hottest functions by self time and a per-module breakdown, which
 * is the input for performance recommendations.
 *
 *   node benchmarks/ycsb/analyze-profile.mts benchmarks/ycsb/results/profile [topN]
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface CallFrame {
	functionName: string;
	url: string;
	lineNumber: number;
}
interface ProfileNode {
	id: number;
	callFrame: CallFrame;
	hitCount?: number;
	children?: number[];
}
interface CpuProfile {
	nodes: ProfileNode[];
	samples: number[];
	timeDeltas: number[];
}

function moduleOf(url: string): string {
	if (!url) return '(builtin/native)';
	if (url.startsWith('node:')) return url;
	const nm = url.lastIndexOf('node_modules/');
	if (nm >= 0) {
		const rest = url.slice(nm + 'node_modules/'.length).split('/');
		return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
	}
	const dist = url.indexOf('/dist/');
	if (dist >= 0) {
		// dist/<area>/file.js — bucket by the top-level area (resources, server, ...)
		return `harper/${url.slice(dist + '/dist/'.length).split('/')[0]}`;
	}
	return url.split('/').slice(-2).join('/');
}

// V8 synthetic frames — (program), (idle), (garbage collector) — carry their label in
// functionName with an empty url; bucket them on the name so they don't fold into native.
function moduleOfFrame(frame: CallFrame): string {
	return frame.functionName.startsWith('(') ? frame.functionName : moduleOf(frame.url);
}

function fnKey(frame: CallFrame): string {
	const mod = moduleOf(frame.url);
	const name = frame.functionName || '(anonymous)';
	return `${name}  [${mod}]`;
}

async function analyzeFile(
	path: string
): Promise<{ self: Map<string, number>; module: Map<string, number>; total: number }> {
	const profile = JSON.parse(await readFile(path, 'utf8')) as CpuProfile;
	const byId = new Map<number, ProfileNode>();
	for (const node of profile.nodes) byId.set(node.id, node);

	const selfMicros = new Map<number, number>();
	for (let i = 0; i < profile.samples.length; i++) {
		const id = profile.samples[i];
		selfMicros.set(id, (selfMicros.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
	}

	const self = new Map<string, number>();
	const module = new Map<string, number>();
	let total = 0;
	for (const [id, micros] of selfMicros) {
		const node = byId.get(id);
		if (!node) continue;
		const m = Math.max(0, micros);
		total += m;
		const key = fnKey(node.callFrame);
		self.set(key, (self.get(key) ?? 0) + m);
		const mod = moduleOfFrame(node.callFrame);
		module.set(mod, (module.get(mod) ?? 0) + m);
	}
	return { self, module, total };
}

function topEntries(map: Map<string, number>, total: number, n: number): string[] {
	return [...map.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(
			([key, micros]) =>
				`  ${((micros / total) * 100).toFixed(1).padStart(5)}%  ${(micros / 1000).toFixed(0).padStart(7)} ms  ${key}`
		);
}

async function main(): Promise<void> {
	const dir = process.argv[2];
	const topN = Number(process.argv[3] ?? 30);
	if (!dir) throw new Error('usage: analyze-profile.mts <profile-dir> [topN]');
	const files = (await readdir(dir)).filter((f) => f.endsWith('.cpuprofile'));
	if (files.length === 0) throw new Error(`no .cpuprofile files in ${dir}`);

	const self = new Map<string, number>();
	const module = new Map<string, number>();
	let total = 0;
	for (const file of files) {
		const r = await analyzeFile(join(dir, file));
		for (const [k, v] of r.self) self.set(k, (self.get(k) ?? 0) + v);
		for (const [k, v] of r.module) module.set(k, (module.get(k) ?? 0) + v);
		total += r.total;
	}

	process.stdout.write(`\nCPU profile summary — ${files.length} file(s), ${(total / 1000).toFixed(0)} ms of samples\n`);
	process.stdout.write(`\nBy module / category (self time):\n${topEntries(module, total, 20).join('\n')}\n`);
	process.stdout.write(`\nTop ${topN} functions (self time):\n${topEntries(self, total, topN).join('\n')}\n`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
