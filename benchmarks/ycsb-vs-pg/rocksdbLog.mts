/**
 * RocksDB's flush and compaction events, read from the info LOG files under a Harper install.
 *
 * Background flushes and compactions run on Harper's own (capped, pinned) threads, so one landing in
 * a measured window shows up as lower throughput and higher CPU per op. The structured EVENT_LOG_v1
 * lines carry epoch timestamps, which places each event against the sample's phases.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface RocksdbEvent {
	/** Database directory, relative to the install root. */
	db: string;
	timeMs: number;
	event: string;
	/** Selected numeric fields: sizes, entries, and compaction time and CPU. */
	fields: Record<string, number>;
	reason?: string;
}

const KEPT_FIELDS = [
	'total_num_input_entries',
	'total_data_size',
	'memory_usage',
	'num_input_records',
	'num_output_records',
	'total_output_size',
	'compaction_time_micros',
	'compaction_time_cpu_micros',
	'output_level',
	'file_size',
];

/** The EVENT_LOG_v1 lines of one LOG file. */
export function parseEventLog(text: string, db: string): RocksdbEvent[] {
	const events: RocksdbEvent[] = [];
	for (const line of text.split('\n')) {
		const at = line.indexOf('EVENT_LOG_v1 ');
		if (at < 0) continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(line.slice(at + 'EVENT_LOG_v1 '.length));
		} catch {
			continue; // a line cut off by a crash or a rotation
		}
		const fields: Record<string, number> = {};
		for (const key of KEPT_FIELDS) if (typeof parsed[key] === 'number') fields[key] = parsed[key] as number;
		const reason = parsed.flush_reason ?? parsed.compaction_reason;
		events.push({
			db,
			timeMs: Number(parsed.time_micros) / 1000,
			event: String(parsed.event),
			fields,
			...(typeof reason === 'string' ? { reason } : {}),
		});
	}
	return events;
}

async function logFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await logFiles(path)));
		else if (entry.name === 'LOG' || entry.name.startsWith('LOG.old.')) out.push(path);
	}
	return out;
}

/** Flush and compaction events under `root` between `fromMs` and `toMs`, oldest first. */
export async function readRocksdbEvents(root: string, fromMs: number, toMs: number): Promise<RocksdbEvent[]> {
	const events: RocksdbEvent[] = [];
	for (const file of await logFiles(root)) {
		const db = relative(root, join(file, '..'));
		for (const event of parseEventLog(await readFile(file, 'utf8'), db)) {
			if (event.timeMs >= fromMs && event.timeMs <= toMs && event.event !== 'table_file_deletion') events.push(event);
		}
	}
	return events.sort((a, b) => a.timeMs - b.timeMs);
}

export interface RocksdbActivity {
	flushes: number;
	compactions: number;
	/** Sum of compaction_time_cpu_micros over compactions that finished in the window, in ms. */
	compactionCpuMs: number;
	compactionOutputBytes: number;
}

export function summarizeEvents(events: RocksdbEvent[], fromMs: number, toMs: number): RocksdbActivity {
	const inWindow = events.filter((e) => e.timeMs >= fromMs && e.timeMs <= toMs);
	const finished = inWindow.filter((e) => e.event === 'compaction_finished');
	return {
		flushes: inWindow.filter((e) => e.event === 'flush_finished').length,
		compactions: finished.length,
		compactionCpuMs: finished.reduce((sum, e) => sum + (e.fields.compaction_time_cpu_micros ?? 0), 0) / 1000,
		compactionOutputBytes: finished.reduce((sum, e) => sum + (e.fields.total_output_size ?? 0), 0),
	};
}
