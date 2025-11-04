import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';

// Configuration constants
const HARPER_LOOPBACK_POOL_COUNT = parseInt(process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT, 10) || 32;
if (HARPER_LOOPBACK_POOL_COUNT < 1 || HARPER_LOOPBACK_POOL_COUNT > 255) {
	throw new Error('HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT must be between 1 and 255');
}
const HARPER_LOOPBACK_POOL_PATH = join(tmpdir(), 'harper-integration-test-loopback-pool.json');
const HARPER_LOOPBACK_POOL_LOCK_PATH = join(tmpdir(), 'harper-integration-test-loopback-pool.lock');

// Constants for timeouts and retries
const LOCK_STALE_TIMEOUT_MS = 10000;
const RETRY_DELAY_MS = 1000;

// Type definitions
type LoopbackPool = (number | null)[];

interface LoopbackAddressError extends Error {
	loopbackAddress: string;
}

// Custom error classes
class LoopbackAddressValidationError extends Error {
	constructor(address: string, cause?: Error) {
		super(
			`Failed to validate loopback address ${address}. This likely means your system does not have the required loopback addresses configured/enabled. Refer to the Harper Integration Test documentation (integrationTests/README.md) for more information.`
		);
		this.name = 'LoopbackAddressValidationError';
		if (cause) {
			this.cause = cause;
		}
	}
}

class InvalidLoopbackAddressError extends Error {
	constructor(address: string) {
		super(
			`Invalid loopback address format: ${address}. Expected format: 127.0.0.X where X is between 1 and ${HARPER_LOOPBACK_POOL_COUNT}`
		);
		this.name = 'InvalidLoopbackAddressError';
	}
}

/**
 * Acquires a file-based lock by creating the lock file. This enables safe concurrent
 * access to the loopback pool across multiple test processes.
 *
 * Uses the 'wx' file flag which atomically fails if the file already exists, providing
 * a simple but effective cross-process mutex. Handles stale locks by removing lock files
 * older than LOCK_STALE_TIMEOUT_MS (10 seconds).
 *
 * @returns A promise that resolves when the lock is acquired
 */
async function acquireLock(): Promise<void> {
	while (true) {
		try {
			// The 'wx' flag causes the open to fail if the file already exists
			const lockFileHandle = await open(HARPER_LOOPBACK_POOL_LOCK_PATH, 'wx');
			// We have the lock - close the handle as we don't intend to write to it
			await lockFileHandle.close();
			return;
		} catch (error) {
			// If the lock file already exists, it's either stale or we wait for it to be released
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
				try {
					const lockFileStat = await stat(HARPER_LOOPBACK_POOL_LOCK_PATH);
					// If the lock file is older than the timeout, consider it stale and remove it
					if (Date.now() - lockFileStat.mtimeMs > LOCK_STALE_TIMEOUT_MS) {
						await unlink(HARPER_LOOPBACK_POOL_LOCK_PATH);
					}
				} catch {
					// Lock file may have been removed by another process, continue
				}

				await sleep(RETRY_DELAY_MS);
				continue;
			}

			// Rethrow other errors
			throw error;
		}
	}
}

/**
 * Releases the file-based lock by deleting the lock file.
 */
async function releaseLock(): Promise<void> {
	try {
		await unlink(HARPER_LOOPBACK_POOL_LOCK_PATH);
	} catch {
		// Ignore errors if lock file is already gone
	}
}

/**
 * Executes a callback function while holding the lock. Automatically acquires
 * and releases the lock, ensuring the lock is always released even if the callback
 * throws an error.
 *
 * @param callback The async function to execute while holding the lock
 * @returns The result of the callback function
 */
async function withLock<T>(callback: () => Promise<T>): Promise<T> {
	await acquireLock();
	try {
		return await callback();
	} finally {
		await releaseLock();
	}
}

/**
 * Reads the loopback pool from the pool file. The pool is a JSON array where each
 * index represents a loopback address (127.0.0.1, 127.0.0.2, etc.) and the value
 * is either null (available) or a process PID (in use).
 *
 * If the file doesn't exist, creates and returns a new empty pool with all addresses
 * marked as available (null).
 *
 * @returns The loopback pool array
 */
async function readPoolFile(): Promise<LoopbackPool> {
	try {
		const content = await readFile(HARPER_LOOPBACK_POOL_PATH, 'utf-8');
		return JSON.parse(content) as LoopbackPool;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			// If the pool file doesn't exist yet, create it with null entries
			return Array<number | null>(HARPER_LOOPBACK_POOL_COUNT).fill(null);
		}
		throw error;
	}
}

/**
 * Writes the loopback pool to the pool file as JSON.
 *
 * @param pool The loopback pool array to persist
 */
async function writePoolFile(pool: LoopbackPool): Promise<void> {
	await writeFile(HARPER_LOOPBACK_POOL_PATH, JSON.stringify(pool));
}

/**
 * Finds the first available (null) index in the pool. This implements a simple
 * first-available allocation strategy.
 *
 * @param pool The loopback pool array
 * @returns The first available index, or null if the pool is full
 */
function findAvailableIndex(pool: LoopbackPool): number | null {
	for (let i = 0; i < pool.length; i++) {
		if (pool[i] === null) {
			return i;
		}
	}
	return null;
}

/**
 * Validates the format of a loopback address and extracts the pool index.
 *
 * Expects addresses in the format "127.0.0.X" where X is between 1 and the pool count.
 * The returned index is 0-based (e.g., "127.0.0.1" returns index 0).
 *
 * @param address The loopback address to parse (e.g., "127.0.0.2")
 * @returns The 0-based pool index for this address
 * @throws {InvalidLoopbackAddressError} If the address format is invalid or out of range
 */
function parseLoopbackAddress(address: string): number {
	const parts = address.split('.');
	if (parts.length !== 4 || parts[0] !== '127' || parts[1] !== '0' || parts[2] !== '0') {
		throw new InvalidLoopbackAddressError(address);
	}

	const index = parseInt(parts[3], 10) - 1;
	if (isNaN(index) || index < 0 || index >= HARPER_LOOPBACK_POOL_COUNT) {
		throw new InvalidLoopbackAddressError(address);
	}

	return index;
}

/**
 * Validates that a given loopback address can be bound to by creating a temporary
 * TCP server on that address. This ensures the loopback address is actually configured
 * and available on the system before allocating it to a test process.
 *
 * The server is bound to port 0 (random port) just to verify the address exists,
 * then immediately closed.
 *
 * @param loopbackAddress The loopback IP address to validate (e.g., "127.0.0.2")
 * @returns A promise that resolves with the address if valid
 * @throws An error with the loopbackAddress property if binding fails
 */
function validateLoopbackAddress(loopbackAddress: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', (error) => {
			const enhancedError = error as LoopbackAddressError;
			enhancedError.loopbackAddress = loopbackAddress;
			reject(enhancedError);
		});
		server.listen(0, loopbackAddress, () => {
			server.close(() => {
				resolve(loopbackAddress);
			});
		});
	});
}

/**
 * This method attempts to validate all loopback addresses in the pool by trying to
 * bind to each one. It returns an object containing arrays of successfully bound
 * loopback addresses and those that failed along with their errors.
 *
 * It will check all loopback addresses from 127.0.0.1 to 127.0.0.32 (by default).
 *
 * Use the HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT environment variable to
 * adjust the number of loopback addresses to validate (up to 255).
 */
export async function validateLoopbackAddressPool(): Promise<{
	successful: string[];
	failed: { loopbackAddress: string; error: Error }[];
}> {
	return Promise.allSettled(
		Array.from({ length: HARPER_LOOPBACK_POOL_COUNT }, (_, i) => validateLoopbackAddress(`127.0.0.${i + 1}`))
	).then((results) =>
		results.reduce<{ successful: string[]; failed: { loopbackAddress: string; error: Error }[] }>(
			(acc, result) => {
				if (result.status === 'fulfilled') {
					acc.successful.push(result.value);
				} else {
					const error = result.reason as LoopbackAddressError;
					acc.failed.push({ loopbackAddress: error.loopbackAddress, error });
				}

				return acc;
			},
			{ successful: [], failed: [] }
		)
	);
}

/**
 * Retrieves the next available loopback address from the pool using a file-based
 * locking mechanism to safely allocate addresses across concurrent test processes.
 *
 * **How it works:**
 * 1. Acquires a file-based lock to prevent race conditions with other processes
 * 2. Reads the pool state (a JSON array of process IDs, with null for available slots)
 * 3. Finds the first available (null) slot and assigns the current process PID to it
 * 4. Writes the updated pool back to disk and releases the lock
 * 5. Validates that the allocated address can actually be bound to
 * 6. Returns the loopback address (e.g., "127.0.0.2")
 *
 * If no addresses are available, waits and retries until one becomes available.
 *
 * **Pool file location:** `${tmpdir()}/harper-integration-test-loopback-pool.json`
 * **Lock file location:** `${tmpdir()}/harper-integration-test-loopback-pool.lock`
 *
 * @returns A promise that resolves with an allocated loopback address
 * @throws {LoopbackAddressValidationError} If the allocated address cannot be bound to
 */
export async function getNextAvailableLoopbackAddress(): Promise<string> {
	// Each index+1 is a different loopback address that a test process will be assigned to
	// So if the first test process number is 42, it would be assigned to index 0 associated with address 127.0.0.1
	// [42, null, null, ...];
	// Then the next process (call is 43) gets the next available, so index 1 -> 127.0.0.2
	// [42, 43, null, ...];
	// And so on...
	// As processes exit and release their loopback addresses, those addresses become available for new processes to use
	// [42, null, 44, ...];
	// Next process (45) gets index 1 again ->
	// [42, 45, 44, ...];
	// This continues until all loopback addresses are used, at which point new processes will wait until an address becomes available

	// Since multiple processes may be trying to get a loopback address at the same time, we need to implement a simple file-based locking mechanism to prevent race conditions
	while (true) {
		const assignedIndex = await withLock(async () => {
			// Read the pool file
			const loopbackPool = await readPoolFile();

			// Find the first available index
			const index = findAvailableIndex(loopbackPool);

			if (index !== null) {
				// Assign the process PID to that index to mark it as used
				loopbackPool[index] = process.pid;
				// Write the updated pool back to the file
				await writePoolFile(loopbackPool);
			}

			return index;
		});

		// If we got an index, validate and return the address
		if (assignedIndex !== null) {
			const loopbackAddress = `127.0.0.${assignedIndex + 1}`;
			try {
				await validateLoopbackAddress(loopbackAddress);
				return loopbackAddress;
			} catch (error) {
				// Validation failed - throw a proper error instead of breaking
				throw new LoopbackAddressValidationError(loopbackAddress, error as Error);
			}
		}

		// No available addresses; wait and retry
		await sleep(RETRY_DELAY_MS);
	}
}

/**
 * Releases a loopback address back to the pool, making it available for other processes.
 *
 * @param address The loopback address to release (e.g., "127.0.0.1")
 * @throws InvalidLoopbackAddressError if the address format is invalid
 */
export async function releaseLoopbackAddress(address: string): Promise<void> {
	// Validate and parse the address
	const index = parseLoopbackAddress(address);

	await withLock(async () => {
		// Read the pool file
		const loopbackPool = await readPoolFile();

		// Release the address by setting it to null
		loopbackPool[index] = null;

		// Write the updated pool back to the file
		await writePoolFile(loopbackPool);
	});
}

/**
 * Releases all loopback addresses assigned to the current process.
 * Useful for cleanup during graceful shutdown.
 */
export async function releaseAllLoopbackAddressesForCurrentProcess(): Promise<void> {
	await withLock(async () => {
		// Read the pool file
		const loopbackPool = await readPoolFile();

		// Find and release all addresses assigned to this process
		for (let i = 0; i < loopbackPool.length; i++) {
			if (loopbackPool[i] === process.pid) {
				loopbackPool[i] = null;
			}
		}

		// Write the updated pool back to the file
		await writePoolFile(loopbackPool);
	});
}
