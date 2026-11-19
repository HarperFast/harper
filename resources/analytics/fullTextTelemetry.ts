import { createHash, randomUUID } from 'node:crypto';
import { METRIC } from './metadata.ts';
import type { NativeFullTextTelemetryHandle } from '../indexes/fullTextNativeBinding.ts';

type ConfigureTelemetryOptions = Parameters<NativeFullTextTelemetryHandle['configureTelemetry']>[0];
type FullTextTelemetrySnapshot = ReturnType<NativeFullTextTelemetryHandle['telemetry']>;

export type FullTextTelemetryPolicy = Required<ConfigureTelemetryOptions> & {
	enabled: boolean;
	intervalMilliseconds: number;
};

const DEFAULT_FULL_TEXT_TELEMETRY_POLICY: Readonly<FullTextTelemetryPolicy> = Object.freeze({
	enabled: false,
	intervalMilliseconds: 60_000,
	histograms: false,
	snapshotBytes: false,
});

export function resolveFullTextTelemetryPolicy(value: unknown): FullTextTelemetryPolicy {
	if (value === undefined) return { ...DEFAULT_FULL_TEXT_TELEMETRY_POLICY };
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError('analytics.fullText must be an object');
	const options = value as Record<string, unknown>;
	for (const key of Object.keys(options))
		if (!Object.hasOwn(DEFAULT_FULL_TEXT_TELEMETRY_POLICY, key))
			throw new TypeError(`Unknown analytics.fullText option '${key}'`);
	const result = { ...DEFAULT_FULL_TEXT_TELEMETRY_POLICY, ...options } as FullTextTelemetryPolicy;
	for (const key of ['enabled', 'histograms', 'snapshotBytes'] as const)
		if (typeof result[key] !== 'boolean') throw new TypeError(`analytics.fullText.${key} must be boolean`);
	if (
		!Number.isSafeInteger(result.intervalMilliseconds) ||
		result.intervalMilliseconds < 1_000 ||
		result.intervalMilliseconds > 2_147_483_647
	)
		throw new TypeError('analytics.fullText.intervalMilliseconds must be an integer between 1000 and 2147483647');
	return result;
}

export type FullTextTelemetryHandle = NativeFullTextTelemetryHandle;

export type FullTextTelemetrySample = {
	index: string;
	role: 'writer' | 'reader';
	series: string;
	sampledAt: number;
	snapshot?: FullTextTelemetrySnapshot;
	error?: 'configuration-error' | 'collection-error';
	stage?: 'closing';
};

type Scalar = string | number | boolean | null;
type FullTextTelemetryRow = Record<string, Scalar>;
type FlatSnapshot = {
	counters: Map<string, bigint>;
	gauges: FullTextTelemetryRow;
	aggregateGauges: Map<string, bigint | null>;
};
type Group = {
	index: string;
	role: 'writer' | 'reader';
	series: string;
	entries: Set<Entry>;
	totals: Map<string, bigint>;
	complete: boolean;
};
type Entry = {
	handle: FullTextTelemetryHandle;
	group: Group;
	previous: Map<string, bigint>;
	flat?: FlatSnapshot;
	observedAt: number;
	nextAt: number;
	closing: boolean;
	configured: boolean;
	warned: boolean;
};
type Consumer = {
	callback: (sample: FullTextTelemetrySample) => void | PromiseLike<void>;
	policy: FullTextTelemetryPolicy;
	busy: boolean;
};

const UINT64_MODULUS = 1n << 64n;
function fullTextNativeCounterDelta(current: bigint, previous: bigint): bigint {
	return current >= previous ? current - previous : UINT64_MODULUS - previous + current;
}

function isCounter(path: string[]): boolean {
	if (path.some((part) => part.startsWith('upperBounds'))) return false;
	if (path[0] === 'logicalBatches' || path[0] === 'preparationRejections') return true;
	return path[0] === 'native' && (path[1] === 'phases' || (path[1] === 'operations' && path[3] !== 'dispatched'));
}

function flattenFullTextTelemetry(snapshot: FullTextTelemetrySnapshot): FlatSnapshot {
	const counters = new Map<string, bigint>();
	const gauges: FullTextTelemetryRow = {};
	const aggregateGauges = new Map<string, bigint | null>();
	function visit(value: unknown, path: string[]) {
		const name = path.join('_');
		if (typeof value === 'bigint') {
			if (isCounter(path)) {
				counters.set(name, (counters.get(name) ?? 0n) + value);
				return;
			}
			gauges[name] = value.toString();
		} else if (value === null || typeof value === 'boolean' || typeof value === 'number') {
			gauges[name] = value as Scalar;
		} else if (typeof value === 'string') {
			if (path.at(-1) === 'state') gauges[name] = value;
			else if (path.at(-1)?.endsWith('Error') || path.at(-1) === 'error')
				gauges[name] = /^E_[A-Z_]{1,60}$/.test(value) ? value : 'other';
			else gauges[name] = path.includes('unsupported') ? 'unsupported' : 'unavailable';
		} else if (Array.isArray(value)) {
			for (let i = 0; i < value.length; i++) visit(value[i], [...path, String(i)]);
			return;
		} else if (value && typeof value === 'object') {
			for (const [key, child] of Object.entries(value)) {
				const boundedKey = path.at(-1) === 'errors' && !/^E_[A-Z_]{1,60}$/.test(key) ? 'other' : key;
				visit(child, [...path, boundedKey]);
			}
			return;
		} else return;
		if (
			path.length === 4 &&
			path[0] === 'native' &&
			(path[1] === 'operations' || path[1] === 'queues') &&
			(/^native_operations_[A-Za-z]+_dispatched$/.test(name) ||
				/^native_queues_[A-Za-z]+_(commands|bytes|maxCommands|maxBytes|oldestAgeNanoseconds)$/.test(name))
		)
			aggregateGauges.set(name, typeof value === 'bigint' && value >= 0n ? value : null);
	}
	visit(snapshot, []);
	return { counters, gauges, aggregateGauges };
}

export function fullTextTelemetryIndexLabel(database: string, table: string, index: string): string {
	const components = [database, table, index];
	const encode = (value: string) => encodeURIComponent(value).replaceAll('.', '%2E');
	try {
		return `${encode(database)}.${encode(table)}/${encode(index)}`;
	} catch (error) {
		if (!(error instanceof URIError)) throw error;
		return `index:${createHash('sha256').update(JSON.stringify(components)).digest('hex')}`;
	}
}

export class FullTextTelemetryCollector {
	#groups = new Map<string, Group>();
	#entries = new Set<Entry>();
	#registered = new WeakMap<object, Entry>();
	#finished = new WeakSet<object>();
	#consumers = new Set<Consumer>();
	#pending = new Map<Group, FullTextTelemetryRow>();
	#operator = { ...DEFAULT_FULL_TEXT_TELEMETRY_POLICY };
	#policy = { ...DEFAULT_FULL_TEXT_TELEMETRY_POLICY };
	#timer?: NodeJS.Timeout;
	#revision = 0;
	#stopped = false;
	#maxPendingRows: number;
	#droppedRows = 0n;
	#onPending: () => void;
	#onError: () => void;

	constructor(options: { onPending?: () => void; onError?: () => void; maxPendingRows?: number } = {}) {
		this.#maxPendingRows = options.maxPendingRows ?? 128;
		if (!Number.isSafeInteger(this.#maxPendingRows) || this.#maxPendingRows < 1)
			throw new TypeError('The full-text telemetry pending-row budget must be a positive safe integer');
		this.#onPending = options.onPending ?? (() => {});
		this.#onError = options.onError ?? (() => {});
	}

	get collecting(): boolean {
		return this.#policy.enabled && !this.#stopped;
	}

	get scheduled(): boolean {
		return this.#timer !== undefined;
	}

	setOperatorPolicy(value: unknown): void {
		this.#operator = resolveFullTextTelemetryPolicy(value);
		if (!this.#operator.enabled) this.#pending.clear();
		this.#updatePolicy();
	}

	subscribe(
		callback: (sample: FullTextTelemetrySample) => void | PromiseLike<void>,
		options: Omit<Partial<FullTextTelemetryPolicy>, 'enabled'> = {}
	): () => void {
		if (typeof callback !== 'function') throw new TypeError('A full-text telemetry consumer must be a function');
		if (this.#stopped) throw new Error('Full-text telemetry collection has stopped');
		const consumer = { callback, policy: resolveFullTextTelemetryPolicy({ ...options, enabled: true }), busy: false };
		this.#consumers.add(consumer);
		this.#updatePolicy();
		return () => {
			if (this.#consumers.delete(consumer)) this.#updatePolicy();
		};
	}

	register(handle: FullTextTelemetryHandle, index: string, role: 'writer' | 'reader') {
		if (!index || Buffer.byteLength(index) > 256 || (role !== 'writer' && role !== 'reader'))
			throw new TypeError('Full-text telemetry requires a bounded index label and writer/reader role');
		const previous = this.#registered.get(handle);
		if (previous) return this.#registration(previous);
		if (this.#finished.has(handle) || this.#stopped) return { beforeClose() {}, afterClose() {} };
		const key = JSON.stringify([index, role]);
		let group = this.#groups.get(key);
		if (!group) {
			group = { index, role, series: randomUUID(), entries: new Set(), totals: new Map(), complete: true };
			this.#groups.set(key, group);
		}
		const entry: Entry = {
			handle,
			group,
			previous: new Map(),
			observedAt: 0,
			nextAt: performance.now() + this.#policy.intervalMilliseconds / (this.#entries.size + 1),
			closing: false,
			configured: false,
			warned: false,
		};
		group.entries.add(entry);
		this.#entries.add(entry);
		this.#registered.set(handle, entry);
		if (this.collecting) this.#configure(entry);
		this.#schedule();
		return this.#registration(entry);
	}

	#registration(entry: Entry) {
		return {
			beforeClose: () => {
				entry.closing = true;
				if (this.collecting) this.#publish(entry, undefined, undefined, 'closing');
				this.#schedule();
			},
			afterClose: () => {
				if (!this.#entries.has(entry)) return;
				if (this.collecting) this.#observe(entry);
				else entry.group.complete = false;
				this.#entries.delete(entry);
				this.#registered.delete(entry.handle);
				this.#finished.add(entry.handle);
				entry.group.entries.delete(entry);
				this.#prune();
				this.#schedule();
			},
		};
	}

	collect(handle: object): void {
		if (!this.collecting) return;
		const entry = this.#registered.get(handle);
		if (entry && !entry.closing) this.#observe(entry);
	}

	beforeClose(handle: object): void {
		const entry = this.#registered.get(handle);
		if (entry) this.#closeHook(() => this.#registration(entry).beforeClose());
	}

	afterClose(handle: object): void {
		const entry = this.#registered.get(handle);
		if (entry) this.#closeHook(() => this.#registration(entry).afterClose());
	}

	closeFailed(handle: object): void {
		const entry = this.#registered.get(handle);
		if (!entry) return;
		entry.closing = false;
		this.#closeHook(() => {
			if (this.collecting) this.#observe(entry);
			else if (!entry.configured) this.#configure(entry);
			this.#schedule();
		});
	}

	#closeHook(action: () => void) {
		try {
			action();
		} catch {
			try {
				this.#onError();
			} catch {}
		}
	}

	get hasPendingRows(): boolean {
		return this.#pending.size !== 0;
	}

	takeRows(): FullTextTelemetryRow[] {
		const rows = [...this.#pending.values()];
		this.#pending.clear();
		this.#prune();
		return rows;
	}

	collectFinalRows(): FullTextTelemetryRow[] {
		const rows = this.takeRows();
		if (this.collecting)
			for (const entry of [...this.#entries]) {
				if (entry.closing) continue;
				this.#observe(entry);
				rows.push(...this.takeRows());
			}
		return rows;
	}

	stop(): void {
		if (this.#stopped) return;
		this.#operator = { ...DEFAULT_FULL_TEXT_TELEMETRY_POLICY };
		this.#consumers.clear();
		this.#updatePolicy();
		this.#stopped = true;
		this.#pending.clear();
		this.#entries.clear();
		this.#registered = new WeakMap();
		for (const group of this.#groups.values()) group.entries.clear();
		this.#groups.clear();
	}

	#updatePolicy() {
		this.#revision++;
		const demands = [...this.#consumers].map((consumer) => consumer.policy);
		if (this.#operator.enabled) demands.push(this.#operator);
		const previous = this.#policy;
		const next = {
			enabled: demands.length > 0,
			intervalMilliseconds: demands.length
				? Math.min(...demands.map((policy) => policy.intervalMilliseconds))
				: DEFAULT_FULL_TEXT_TELEMETRY_POLICY.intervalMilliseconds,
			histograms: demands.some((policy) => policy.histograms),
			snapshotBytes: demands.some((policy) => policy.snapshotBytes),
		};
		if (
			previous.enabled === next.enabled &&
			previous.intervalMilliseconds === next.intervalMilliseconds &&
			previous.histograms === next.histograms &&
			previous.snapshotBytes === next.snapshotBytes
		) {
			this.#prune();
			return;
		}
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#policy = next;
		const recordingChanged = previous.histograms !== next.histograms || previous.snapshotBytes !== next.snapshotBytes;
		let offset = 0;
		const step = this.#policy.intervalMilliseconds / Math.max(1, this.#entries.size);
		for (const entry of this.#entries) {
			if (recordingChanged) entry.configured = false;
			if (!entry.closing && !entry.configured) this.#configure(entry);
			entry.nextAt = performance.now() + step * ++offset;
		}
		this.#prune();
		this.#schedule();
	}

	#configure(entry: Entry): boolean {
		try {
			entry.handle.configureTelemetry({
				histograms: this.#policy.histograms,
				snapshotBytes: this.#policy.snapshotBytes,
			});
			entry.configured = true;
			return true;
		} catch {
			this.#failed(entry, 'configuration-error');
			return false;
		}
	}

	#failed(entry: Entry, error: FullTextTelemetrySample['error']) {
		if (entry.closing) entry.group.complete = false;
		if (!entry.warned) {
			entry.warned = true;
			try {
				this.#onError();
			} catch {}
		}
		this.#publish(entry, undefined, error);
	}

	#observe(entry: Entry) {
		if (!this.collecting || !this.#entries.has(entry)) return;
		if (!entry.closing && !entry.configured && !this.#configure(entry)) return;
		try {
			const snapshot = entry.handle.telemetry();
			const flat = flattenFullTextTelemetry(snapshot);
			for (const [name, value] of flat.counters) {
				const previous = entry.previous.get(name) ?? 0n;
				const delta = name.startsWith('native_') ? fullTextNativeCounterDelta(value, previous) : value - previous;
				if (delta < 0n) entry.group.complete = false;
				else entry.group.totals.set(name, (entry.group.totals.get(name) ?? 0n) + delta);
				entry.previous.set(name, value);
			}
			entry.flat = flat;
			entry.observedAt = performance.now();
			entry.warned = false;
			if (!snapshot.available && entry.closing) entry.group.complete = false;
			if (snapshot.available && !entry.closing && !entry.group.complete) {
				entry.group.series = randomUUID();
				entry.group.complete = true;
			}
			this.#publish(entry, snapshot);
		} catch {
			this.#failed(entry, 'collection-error');
		}
	}

	#publish(
		entry: Entry,
		snapshot?: FullTextTelemetrySnapshot,
		error?: FullTextTelemetrySample['error'],
		stage?: 'closing'
	) {
		const sampledAt = Date.now();
		const revision = this.#revision;
		if (this.#operator.enabled && stage !== 'closing') {
			let newest = entry;
			let activeHandles = 0;
			let closingHandles = 0;
			for (const candidate of entry.group.entries) {
				if (candidate.closing) closingHandles++;
				else activeHandles++;
				if (!candidate.closing && candidate.flat && (newest.closing || candidate.observedAt > newest.observedAt))
					newest = candidate;
			}
			const row: FullTextTelemetryRow = {
				...newest.flat?.gauges,
				metric: METRIC.FULL_TEXT,
				path: entry.group.index,
				method: entry.group.role,
				perThread: true,
				cumulative: true,
				series: entry.group.series,
				sampledAt,
				complete: entry.group.complete,
				collectionError: error ?? null,
				droppedRows: this.#droppedRows.toString(),
				observationAgeMilliseconds: newest.observedAt ? performance.now() - newest.observedAt : null,
				activeHandles,
				closingHandles,
				available: !error && snapshot?.available === true,
			};
			for (const [name, value] of entry.group.totals) row[name] = value.toString();
			for (const name of newest.flat?.aggregateGauges.keys() ?? []) {
				let total = 0n;
				let observed = false;
				for (const candidate of entry.group.entries) {
					const value = candidate.flat?.aggregateGauges.get(name);
					if (!candidate.closing && typeof value === 'bigint') {
						total = name.endsWith('oldestAgeNanoseconds') ? (value > total ? value : total) : total + value;
						observed = true;
					}
				}
				row[name] = observed ? total.toString() : null;
			}
			if (this.#pending.has(entry.group)) this.#pending.delete(entry.group);
			else if (this.#pending.size >= this.#maxPendingRows) {
				let oldest = this.#pending.keys().next().value!;
				for (const candidate of this.#pending.keys())
					if (candidate.entries.size) {
						oldest = candidate;
						break;
					}
				this.#pending.delete(oldest);
				this.#droppedRows++;
				row.droppedRows = this.#droppedRows.toString();
				this.#prune();
			}
			this.#pending.set(entry.group, row);
			try {
				this.#onPending();
			} catch {}
		}
		for (const consumer of [...this.#consumers]) {
			if (revision !== this.#revision) break;
			if (!this.#consumers.has(consumer) || consumer.busy) continue;
			try {
				const result = consumer.callback({
					index: entry.group.index,
					role: entry.group.role,
					series: entry.group.series,
					sampledAt,
					snapshot,
					error,
					stage,
				});
				if (result && typeof result.then === 'function') {
					consumer.busy = true;
					void Promise.resolve(result)
						.catch(() => {
							try {
								this.#onError();
							} catch {}
						})
						.finally(() => {
							consumer.busy = false;
						});
				}
			} catch {
				try {
					this.#onError();
				} catch {}
			}
		}
	}

	#schedule() {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (!this.collecting) return;
		let next: Entry | undefined;
		for (const entry of this.#entries) if (!entry.closing && (!next || entry.nextAt < next.nextAt)) next = entry;
		if (!next) return;
		const entry = next;
		this.#timer = setTimeout(
			() => {
				this.#timer = undefined;
				entry.nextAt = performance.now() + this.#policy.intervalMilliseconds;
				this.#observe(entry);
				this.#schedule();
			},
			Math.max(0, next.nextAt - performance.now())
		).unref();
	}

	#prune() {
		for (const [key, group] of this.#groups)
			if (!group.entries.size && !this.#pending.has(group)) this.#groups.delete(key);
	}
}
