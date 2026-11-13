/**
 * The full matrix's tables, from the run directories run-matrix.sh leaves (gcp/runs/<base>-<set>): the conditions
 * each set ran under; per point, every (workload, target) cell's median rep by throughput, with the reps' spread,
 * the primary operation's latency, CPU and instructions per op; harper-uws's throughput ratios to pg-redis and to
 * harper; and each target's cost per additional dependent read: (chain-4 - C) / 4, and (chain-4 - chain-1) / 3, which
 * compares requests of one shape (the stack's C returns Redis's bytes unparsed, its chains parse every record).
 *
 *   node benchmarks/ycsb-vs-pg/gcp/matrix-report.mts --base=<base> [--runs-dir=<dir>]
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { primaryLatency } from '../run-compare.mts';

const SETS = ['warm', '2x', '8x-cb', '8x-fi', '8x-chain12', '8x-chain4'];
const WORKLOADS = ['C', 'B', 'inspect', 'chain-1', 'chain-2', 'chain-4', 'F'];
const TARGETS = ['harper-uws', 'harper', 'pg-redis'];
const POINTS = ['warm', '2x', '8x'];

interface Sample {
	target: string;
	workload: string;
	rep: number;
	ratio?: number;
	status?: string;
	settled?: boolean;
	failure?: { phase?: string };
	measured?: {
		cpuMicrosPerOp: number;
		perf?: {
			total: { instructionsUser: number; instructionsKernel: number; cyclesUser: number; cyclesKernel: number };
		};
		result: { throughput: number; ops: number; errors: number; latency: Record<string, any> };
		window?: { startMs: number; endMs: number };
		/** Remote mode: the target host's busy cores over the window, by whose work they were. */
		hosts?: { target?: { ownCores: number; agentCores: number; otherCores: number } };
	};
}

export interface Cell {
	point: string;
	workload: string;
	target: string;
	reps: number;
	throughputs: number[];
	opsPerSec: number;
	spread: number;
	p50: number;
	p99: number;
	cpuMicrosPerOp: number;
	instructionsPerOp: number;
	/** Reps not settled (memory-sweep: warmup without a plateau, quiesce timeout), or with request errors. */
	notes: string[];
}

const measuredPhase = (set: string) => (set === 'warm' ? 'warm' : `sweep-${set.split('-')[0]}`);

/** The results file a phase wrote, by the generator path its log names, under the copied results/. */
export function phaseResults(setDir: string, phase: string): string | undefined {
	const log = join(setDir, 'logs', `${phase}.log`);
	if (!existsSync(log)) return undefined;
	const written = [...readFileSync(log, 'utf8').matchAll(/Results written to (\S+\.json)/g)].pop();
	if (!written) return undefined;
	const file = join(setDir, 'results', basename(written[1]));
	return existsSync(file) ? file : undefined;
}

/** The median rep by throughput, as run-compare's table picks it. */
export function cells(samples: Sample[], point: string): Cell[] {
	const groups = new Map<string, Sample[]>();
	for (const s of samples) {
		if (!s.measured?.result) continue;
		const key = `${s.workload}\0${s.target}`;
		groups.set(key, [...(groups.get(key) ?? []), s]);
	}
	const failed = samples.filter((s) => !s.measured?.result && s.status === 'failed');
	return [...groups.values()].map((reps) => {
		const sorted = [...reps].sort((a, b) => a.measured!.result.throughput - b.measured!.result.throughput);
		const median = sorted[Math.floor((sorted.length - 1) / 2)];
		const m = median.measured!;
		const throughputs = sorted.map((s) => s.measured!.result.throughput);
		const latency = primaryLatency(m.result as any);
		const perf = m.perf?.total;
		const notes: string[] = [];
		const unsettled = reps.filter((s) => s.settled === false || (s.status && s.status !== 'ok'));
		if (unsettled.length)
			notes.push(`${unsettled.length}/${reps.length} ${[...new Set(unsettled.map((s) => s.status))].join(',')}`);
		const errors = reps.reduce((sum, s) => sum + s.measured!.result.errors, 0);
		if (errors) notes.push(`${errors} errors`);
		const lost = failed.filter((s) => s.workload === median.workload && s.target === median.target);
		if (lost.length) notes.push(`${lost.length} failed at ${lost.map((s) => s.failure?.phase ?? '?').join(', ')}`);
		return {
			point,
			workload: median.workload,
			target: median.target,
			reps: reps.length,
			throughputs,
			opsPerSec: m.result.throughput,
			spread: (throughputs.at(-1)! - throughputs[0]) / m.result.throughput,
			p50: latency?.p50 ?? NaN,
			p99: latency?.p99 ?? NaN,
			cpuMicrosPerOp: m.cpuMicrosPerOp,
			instructionsPerOp: perf ? (perf.instructionsUser + perf.instructionsKernel) / m.result.ops : NaN,
			notes,
		};
	});
}

interface SetReport {
	set: string;
	cells: Cell[];
	conditions?: string[];
	missing?: string;
}

function readSet(runsDir: string, base: string, set: string): SetReport {
	const dir = join(runsDir, `${base}-${set}`);
	const file = phaseResults(dir, measuredPhase(set));
	if (!file) return { set, cells: [], missing: `no results from phase ${measuredPhase(set)}` };
	const results = JSON.parse(readFileSync(file, 'utf8'));
	const point = set === 'warm' ? 'warm' : set.split('-')[0];
	const hosts = results.meta.remote?.hosts ?? {};
	const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
	const vm = (role: string) => `${manifest.vms[role].machineType} (${manifest.vms[role].cpuPlatform})`;
	const shards = existsSync(join(dir, 'shards')) ? readFileSync(join(dir, 'shards'), 'utf8').trim() : '?';
	const ceilingLog = join(dir, 'logs', `ceiling-${shards}.log`);
	const ceiling = existsSync(ceilingLog)
		? readFileSync(ceilingLog, 'utf8').match(/CLIENT_CEILING workload=C .*ops_per_sec=(\d+)/)?.[1]
		: undefined;
	const conditions = [
		set,
		manifest.zone,
		`harper ${vm('harper')}, stack ${vm('stack')}`,
		`${vm('generator')}, ${shards} shards, ceiling ${ceiling ? Number(ceiling).toLocaleString('en-US') : '?'} ops/s`,
		hosts.harper?.cpuModel ?? '?',
		hosts.harper?.kernel ?? '?',
		hosts.harper?.node ?? '?',
	];
	conditions.push(
		`harper ${vmClock(results.samples, ['harper-uws', 'harper'])}, stack ${vmClock(results.samples, ['pg-redis'])}`
	);
	const setCells = cells(results.samples, point);
	for (const c of setCells)
		if (ceiling && c.opsPerSec > Number(ceiling) / 2) c.notes.push('over half the generator ceiling');
	return { set, cells: setCells, conditions };
}

/**
 * A target VM's speed over the set: the median, across its measured samples, of cycles per busy CPU-second on the VM
 * (GHz) and of instructions per cycle. Host-scope counts cover every cpu of the VM, so the busy time is the whole VM's:
 * the target's, its agent's and the rest (kernel threads included). Turbo is on and VMs share hosts, so both differ
 * between VMs and over time.
 */
function vmClock(samples: Sample[], targets: string[]): string {
	const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
	const rows = samples.filter((s) => targets.includes(s.target) && s.measured?.perf && s.measured.hosts?.target);
	if (rows.length === 0) return '?';
	const cycles = (s: Sample) => s.measured!.perf!.total.cyclesUser + s.measured!.perf!.total.cyclesKernel;
	const busySeconds = (s: Sample) => {
		const { ownCores, agentCores, otherCores } = s.measured!.hosts!.target!;
		return ((ownCores + agentCores + otherCores) * (s.measured!.window!.endMs - s.measured!.window!.startMs)) / 1000;
	};
	const ghz = median(rows.map((s) => cycles(s) / (busySeconds(s) * 1e9)));
	const ipc = median(
		rows.map((s) => (s.measured!.perf!.total.instructionsUser + s.measured!.perf!.total.instructionsKernel) / cycles(s))
	);
	return `${ghz.toFixed(2)} GHz, IPC ${ipc.toFixed(2)}`;
}

const fmt = (n: number, digits = 0) =>
	Number.isFinite(n)
		? n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
		: '–';

function report(sets: SetReport[]): string {
	const out: string[] = [];
	out.push(
		'| set | zone | target VMs | generator | target CPU | kernel | Node | target VM clock and IPC (medians) |',
		'|---|---|---|---|---|---|---|---|'
	);
	for (const s of sets)
		out.push(s.conditions ? `| ${s.conditions.join(' | ')} |` : `| ${s.set} | ${s.missing} | | | | | | |`);
	const all = sets.flatMap((s) => s.cells);
	const find = (point: string, workload: string, target: string) =>
		all.find((c) => c.point === point && c.workload === workload && c.target === target);
	for (const point of POINTS) {
		if (!all.some((c) => c.point === point)) continue;
		out.push(
			'',
			`#### ${point}`,
			'',
			'| workload | target | ops/s | spread | p50 ms | p99 ms | CPU µs/op | instructions/op | notes |',
			'|---|---|--:|--:|--:|--:|--:|--:|---|'
		);
		for (const workload of WORKLOADS)
			for (const target of TARGETS) {
				const c = find(point, workload, target);
				out.push(
					c
						? `| ${workload} | ${target} | ${fmt(c.opsPerSec)} | ${fmt(c.spread * 100, 1)}% | ${fmt(c.p50, 2)} | ${fmt(c.p99, 2)} | ${fmt(c.cpuMicrosPerOp, 1)} | ${fmt(c.instructionsPerOp / 1000, 1)}k | ${[...(c.reps < 3 ? [`${c.reps} reps`] : []), ...c.notes].join('; ')} |`
						: `| ${workload} | ${target} | not run | | | | | | |`
				);
			}
	}
	out.push(
		'',
		'Throughput ratios (median reps): harper-uws / pg-redis and harper-uws / harper.',
		'',
		`| workload | ${POINTS.flatMap((p) => [`${p} uws/pg-redis`, `${p} uws/harper`]).join(' | ')} |`,
		`|---|${POINTS.flatMap(() => ['--:', '--:']).join('|')}|`
	);
	for (const workload of WORKLOADS) {
		const ratio = (point: string, other: string) => {
			const a = find(point, workload, 'harper-uws');
			const b = find(point, workload, other);
			return a && b ? (a.opsPerSec / b.opsPerSec).toFixed(2) : '–';
		};
		out.push(`| ${workload} | ${POINTS.flatMap((p) => [ratio(p, 'pg-redis'), ratio(p, 'harper')]).join(' | ')} |`);
	}
	out.push(
		'',
		'Cost of each additional dependent read, from the median reps: (chain-4 − C) / 4, and (chain-4 − chain-1) / 3.',
		'',
		'| point | target | instructions/op C, chain-1, chain-4 | per extra read | same, from chain-1 | CPU µs/op C, chain-1, chain-4 | per extra read | same, from chain-1 |',
		'|---|---|--:|--:|--:|--:|--:|--:|'
	);
	for (const point of POINTS)
		for (const target of TARGETS) {
			const [c, chain1, chain4] = ['C', 'chain-1', 'chain-4'].map((w) => find(point, w, target));
			if (!c || !chain1 || !chain4) continue;
			const k = (cell: Cell) => cell.instructionsPerOp / 1000;
			out.push(
				`| ${point} | ${target} | ${[c, chain1, chain4].map((x) => `${fmt(k(x), 1)}k`).join(', ')} | ${fmt((k(chain4) - k(c)) / 4, 1)}k | ${fmt((k(chain4) - k(chain1)) / 3, 1)}k | ${[c, chain1, chain4].map((x) => fmt(x.cpuMicrosPerOp, 1)).join(', ')} | ${fmt((chain4.cpuMicrosPerOp - c.cpuMicrosPerOp) / 4, 1)} | ${fmt((chain4.cpuMicrosPerOp - chain1.cpuMicrosPerOp) / 3, 1)} |`
			);
		}
	return out.join('\n') + '\n';
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
	const base = arg('base');
	if (!base) throw new Error('usage: matrix-report.mts --base=<base> [--runs-dir=<dir>]');
	const runsDir = arg('runs-dir') ?? join(import.meta.dirname, 'runs');
	process.stdout.write(report(SETS.map((set) => readSet(runsDir, base, set))));
}
