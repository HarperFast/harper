import { RocksDatabase, type Transaction } from '@harperfast/rocksdb-js';
import {
	closeDerivedIndexStore,
	dropDerivedIndexStore,
	openDerivedIndexStore,
	type RootDatabaseKind,
} from './databases.ts';

export type DerivedIndexWritePolicy = 'wal' | 'no-wal';

export type DerivedIndexStorageMutation = { type: 'put'; key: Buffer; value: Buffer } | { type: 'delete'; key: Buffer };

/**
 * Synchronous host-storage surface used by native derived indexes. It deliberately exposes only
 * operations Harper can satisfy with its existing RocksDB ownership and durability primitives.
 */
export class RocksDerivedIndexStorage {
	#closed = false;
	#rootStore: RootDatabaseKind & RocksDatabase;
	#store: RocksDatabase;

	constructor(rootStore: RootDatabaseKind, storeName: string) {
		if (!(rootStore instanceof RocksDatabase)) throw new Error('Derived indexes require RocksDB storage');
		this.#rootStore = rootStore;
		this.#store = openDerivedIndexStore(rootStore, storeName);
	}

	read(key: Buffer): Buffer | undefined {
		this.#assertOpen();
		if (!Buffer.isBuffer(key)) throw new TypeError('Derived index storage keys must be Buffers');
		const value = this.#store.getSync(key);
		if (value === undefined) return undefined;
		if (!Buffer.isBuffer(value)) throw new Error('Derived index storage contains a non-binary value');
		return value;
	}

	write(mutations: Array<DerivedIndexStorageMutation>, policy: DerivedIndexWritePolicy): void {
		this.#assertOpen();
		if (policy !== 'wal') throw new Error('Harper derived index writes require the RocksDB WAL');
		validateMutations(mutations);
		if (mutations.length === 0) return;

		const committed = this.#rootStore.transactionSync(
			(transaction: Transaction) => {
				for (const mutation of mutations) {
					if (mutation.type === 'put') {
						this.#store.putSync(mutation.key, mutation.value, { transaction });
					} else {
						this.#store.removeSync(mutation.key, { transaction });
					}
				}
				return true;
			},
			{ retryOnBusy: true }
		);
		if (committed !== true) throw new Error('Derived index storage transaction did not commit');
	}

	/**
	 * Establish durability for preceding WAL writes. rocksdb-js DBDescriptor::flush flushes every
	 * registered column family regardless of the calling handle. This can stall unrelated writes,
	 * so the fulltext publication scheduler must coalesce and rate-limit calls.
	 */
	sync(): void {
		this.#assertOpen();
		this.#rootStore.flushSync({ allowWriteStall: true });
	}

	/** Close only this derived column-family handle; the caller retains ownership of the root store. */
	close(): void {
		if (this.#closed) return;
		closeDerivedIndexStore(this.#rootStore, this.#store);
		this.#closed = true;
	}

	/** Drop this derived column family after its native readers and writer have drained. */
	drop(): void {
		this.#assertOpen();
		dropDerivedIndexStore(this.#rootStore, this.#store);
		this.#closed = true;
	}

	#assertOpen(): void {
		if (this.#closed || !this.#rootStore.isOpen() || !this.#store.isOpen()) {
			throw new Error('Derived index storage is closed');
		}
	}
}

function validateMutations(mutations: Array<DerivedIndexStorageMutation>): void {
	if (!Array.isArray(mutations)) throw new TypeError('Derived index mutations must be an array');
	for (const mutation of mutations) {
		if (!mutation || !Buffer.isBuffer(mutation.key)) {
			throw new TypeError('Derived index storage keys must be Buffers');
		}
		if (mutation.type === 'put') {
			if (!Buffer.isBuffer(mutation.value)) {
				throw new TypeError('Derived index storage values must be Buffers');
			}
		} else if (mutation.type !== 'delete') {
			throw new TypeError('Unknown derived index storage mutation');
		}
	}
}
