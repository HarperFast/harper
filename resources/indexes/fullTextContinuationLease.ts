import { fullTextContinuationNow } from './fullTextContinuationClock.ts';
import { ClientError, ServerError } from '../../utility/errors/hdbError.ts';
import type { FullTextCursorClaim } from './fullTextContinuation.ts';
import { FullTextContinuationToken, type FullTextContinuationPosition } from './fullTextContinuationToken.ts';
import type {
	NativeFullTextReader,
	NativeFullTextSearchExpression,
	NativeFullTextSearchPageResult,
} from './fullTextNativeBinding.ts';
import { loggerWithTag } from '../../utility/logging/logger.ts';

const logger = loggerWithTag('fulltext-continuation');

type Lease = {
	claim: FullTextCursorClaim;
	queryHash: string;
	query: NativeFullTextSearchExpression;
	reader: NativeFullTextReader;
	release(): void | Promise<void>;
	active: number;
	revoked: boolean;
	releaseStarted: boolean;
	timer: NodeJS.Timeout;
	drained: Promise<void>;
	resolveDrained(): void;
	rejectDrained(error: unknown): void;
};

export class FullTextContinuationLeases {
	readonly #tokens: FullTextContinuationToken;
	readonly #maxNativePageSize: number;
	readonly #maxNativeBudgetMilliseconds: number;
	readonly #leases = new Map<string, Lease>();

	constructor(tokens: FullTextContinuationToken, maxNativePageSize: number, maxNativeBudgetMilliseconds: number) {
		this.#tokens = tokens;
		this.#maxNativePageSize = maxNativePageSize;
		this.#maxNativeBudgetMilliseconds = maxNativeBudgetMilliseconds;
	}

	register(
		claim: FullTextCursorClaim,
		queryHash: string,
		query: NativeFullTextSearchExpression,
		reader: NativeFullTextReader,
		release: () => void | Promise<void>
	): void {
		const duration = Number((claim.expires - fullTextContinuationNow()) / 1_000_000n);
		if (
			this.#leases.has(claim.id) ||
			duration < 1 ||
			duration > 0x7fffffff ||
			!/^[a-f0-9]{32}$/.test(claim.id) ||
			!/^[a-f0-9]{64}$/.test(queryHash)
		)
			throw expired();
		const { promise: drained, resolve: resolveDrained, reject: rejectDrained } = Promise.withResolvers<void>();
		const timer = setTimeout(
			() => {
				this.#expire(claim.id);
			},
			Math.max(1, Number((claim.expires - fullTextContinuationNow()) / 1_000_000n))
		);
		timer.unref();
		this.#leases.set(claim.id, {
			claim: { ...claim },
			queryHash,
			query: structuredClone(query),
			reader,
			release,
			active: 0,
			revoked: false,
			releaseStarted: false,
			timer,
			drained,
			resolveDrained,
			rejectDrained,
		});
	}

	resume(token: string, queryHash: string): { claim: FullTextCursorClaim; position: FullTextContinuationPosition } {
		const { lease: id, position } = this.#tokens.open(token, queryHash);
		const lease = this.#get(id, queryHash);
		return { claim: { ...lease.claim }, position };
	}

	seal(id: string, queryHash: string, position: FullTextContinuationPosition): string {
		this.#get(id, queryHash);
		return this.#tokens.seal(id, queryHash, position);
	}

	async read(
		id: string,
		queryHash: string,
		position: FullTextContinuationPosition,
		deadline: bigint
	): Promise<NativeFullTextSearchPageResult> {
		const lease = this.#get(id, queryHash);
		if (
			!Number.isSafeInteger(position.batchSize) ||
			position.batchSize < 1 ||
			position.batchSize > this.#maxNativePageSize ||
			!Number.isSafeInteger(position.consumed) ||
			position.consumed < 0 ||
			position.consumed > position.batchSize
		)
			throw new ClientError('Invalid full-text continuation page', 400);
		const remaining = Number((deadline - fullTextContinuationNow()) / 1_000_000n);
		if (!Number.isSafeInteger(remaining) || remaining < 1)
			throw new ServerError('Full-text continuation exceeded its request budget', 503);
		return this.#use(lease, async () => {
			const page = await lease.reader.searchPage(
				{ query: lease.query, limit: position.batchSize, continuation: position.boundary },
				{ remainingBudgetMilliseconds: Math.min(remaining, this.#maxNativeBudgetMilliseconds) }
			);
			this.#get(id, queryHash);
			if (
				position.consumed > page.hits.length ||
				(page.hits.length === 0 && page.continuation !== undefined) ||
				(position.boundary !== undefined && page.continuation === position.boundary)
			)
				throw new ServerError('Full-text continuation returned an invalid replay boundary', 500);
			if (fullTextContinuationNow() >= deadline)
				throw new ServerError('Full-text continuation exceeded its request budget', 503);
			return page;
		});
	}

	withReader<T>(id: string, queryHash: string, operation: (reader: NativeFullTextReader) => Promise<T>): Promise<T> {
		const lease = this.#get(id, queryHash);
		return this.#use(lease, async () => {
			const result = await operation(lease.reader);
			this.#get(id, queryHash);
			return result;
		});
	}

	async #use<T>(lease: Lease, operation: () => Promise<T>): Promise<T> {
		lease.active++;
		try {
			return await operation();
		} finally {
			lease.active--;
			this.#releaseIfDrained(lease);
		}
	}

	close(token: string, queryHash: string): Promise<void> {
		const { lease } = this.#tokens.open(token, queryHash);
		this.#get(lease, queryHash);
		return this.revoke(lease);
	}

	revoke(id: string): Promise<void> {
		const lease = this.#leases.get(id);
		if (!lease) return Promise.resolve();
		lease.revoked = true;
		clearTimeout(lease.timer);
		this.#releaseIfDrained(lease);
		return lease.drained;
	}

	async revokeReader(reader: NativeFullTextReader): Promise<void> {
		const draining: Promise<void>[] = [];
		for (const [id, lease] of this.#leases) if (lease.reader === reader) draining.push(this.revoke(id));
		const outcomes = await Promise.allSettled(draining);
		for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
	}

	#get(id: string, queryHash: string): Lease {
		const lease = this.#leases.get(id);
		if (!lease || lease.revoked || lease.queryHash !== queryHash) throw expired();
		if (lease.claim.expires <= fullTextContinuationNow()) {
			this.#expire(id);
			throw expired();
		}
		return lease;
	}

	#releaseIfDrained(lease: Lease): void {
		if (!lease.revoked || lease.releaseStarted || lease.active !== 0) return;
		lease.releaseStarted = true;
		void Promise.resolve()
			.then(() => lease.release())
			.then(
				() => {
					this.#leases.delete(lease.claim.id);
					lease.resolveDrained();
				},
				(error) => {
					this.#leases.delete(lease.claim.id);
					lease.rejectDrained(error);
				}
			);
	}

	#expire(id: string): void {
		void this.revoke(id).catch((error) => logger.warn?.('Could not release an expired full-text continuation', error));
	}
}

function expired(): ClientError {
	return new ClientError('Full-text continuation expired; start a new search', 410);
}
