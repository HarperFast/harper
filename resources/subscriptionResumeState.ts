import { createHash } from 'node:crypto';

export type SubscriptionResumeOptions = {
	historyId: string;
	window: number;
	origins: Iterable<string>;
};

export type SubscriptionResumeCheckpoint = {
	startTime: number;
	resumeState?: string;
};

export class SubscriptionResumeError extends Error {
	readonly resyncRequired = true;
	readonly reason: string;
	constructor(reason: string) {
		super(`Subscription resume requires a new snapshot: ${reason}`);
		this.name = 'SubscriptionResumeError';
		this.reason = reason;
	}
}

export class SubscriptionResumeBusyError extends Error {
	readonly retryable = true;
	readonly resyncRequired = false;
	constructor() {
		super('Subscription resume validation is already running; retry later');
		this.name = 'SubscriptionResumeBusyError';
	}
}

export function validateResumeTimestamp(timestamp: number): void {
	if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 8.64e15)
		throw new TypeError('A resume transaction timestamp must be finite, positive, and within the date range');
}

export function subscriptionResumeFingerprint(
	historyId: string,
	window: number,
	states: Iterable<[string, 'active' | number | null]>
): string {
	const ordered = Array.from(states).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `1.${createHash('sha256')
		.update(JSON.stringify(['subscription-resume-v1', historyId, window, ordered]))
		.digest()
		.subarray(0, 16)
		.toString('base64url')}`;
}

/** Tracks completed physical prefixes; historyId must identify their incarnation and subscription scope. */
export class SubscriptionResumeState {
	readonly #historyId: string;
	readonly #window: number;
	readonly #positions = new Map<string, { last: number | null; maximum: number }>();
	#maximum = 0;
	#previousShape?: string;

	constructor({ historyId, window, origins }: SubscriptionResumeOptions) {
		if (typeof historyId !== 'string' || !historyId.length)
			throw new TypeError('A subscription resume history identity is required');
		validateResumeTimestamp(window);
		if (!Number.isSafeInteger(window)) throw new TypeError('The resume window must be whole milliseconds');
		this.#historyId = historyId;
		this.#window = window;
		for (const origin of Array.from(origins).sort()) {
			if (typeof origin !== 'string' || !origin.length || this.#positions.has(origin))
				throw new TypeError('Resume origins must be distinct, nonempty names');
			this.#positions.set(origin, { last: null, maximum: 0 });
		}
		if (!this.#positions.size) throw new TypeError('At least one resume origin is required');
	}

	recordTransaction(origin: string, timestamp: number): void {
		validateResumeTimestamp(timestamp);
		const position = this.#positions.get(origin);
		if (!position) throw new SubscriptionResumeError('origin membership changed');
		position.last = timestamp;
		position.maximum = Math.max(position.maximum, timestamp);
		this.#maximum = Math.max(this.#maximum, timestamp);
	}

	/** Persist each startTime with the most recently offered resumeState, after processing its complete prefix. */
	checkpoint(): SubscriptionResumeCheckpoint {
		const startTime = Math.max(0, this.#maximum - this.#window);
		const states: [string, 'active' | number | null][] = [];
		for (const [origin, position] of this.#positions) {
			states.push([origin, position.last !== null && position.maximum >= startTime ? 'active' : position.last]);
		}
		const shape = JSON.stringify(states);
		if (shape === this.#previousShape) return { startTime };
		this.#previousShape = shape;
		return { startTime, resumeState: subscriptionResumeFingerprint(this.#historyId, this.#window, states) };
	}
}
