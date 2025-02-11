/**
 * This module provides a Blob class that can be used to store binary data in the database, and can be used to store large binary data in a file
 * on the server. The Blob class is a subclass of the global Blob class, and can be used in the same way.
 * The Blob-backed files begin with an 8-byte header:
 * - The first 2 bytes indicate the type of storage:
 * 		- 0: Uncompressed
 * 		- 1: Compressed with deflate
 * 	  - 0xff: Error state (followed by error message). A record can be saved prior to an error in saving a blob, so we must be capable of tracking and even replicating that state
 * - The next 6 bytes are the size of the content
 *   - While the file is being written, 0xffffffffffff is used as a placeholder to indicate that the file is not finished being written (this nicely matches the logic that if the written content size is less than the indicated content size, it is not finished)
 *   - Note that for compressed data, the size is the uncompressed size, and the compressed size in the file
 */

import { addExtension, pack, unpack } from 'msgpackr';
import { readFile } from 'node:fs/promises';
import {
	close,
	createWriteStream,
	fdatasync,
	open,
	readFileSync,
	read,
	unlink,
	readdirSync,
	existsSync,
	watch,
	write,
} from 'node:fs';
import { createDeflate, deflate } from 'node:zlib';
import { Readable } from 'node:stream';
import { ensureDirSync, remove } from 'fs-extra';
import { get as envGet, getHdbBasePath } from '../utility/environment/environmentManager';
import { CONFIG_PARAMS } from '../utility/hdbTerms';
import { join, dirname } from 'path';
import logger from '../utility/logging/logger';
import type { LMDBStore } from 'lmdb';

type StorageInfo = {
	storageIndex: number;
	fileId: string;
	store?: any;
	filePath?: string;
	recordId?: number;
	contentBuffer?: Buffer;
	source?: NodeJS.ReadableStream;
	storageBuffer?: Buffer;
	compress?: boolean;
	flush?: boolean;
	start?: number;
	end?: number;
	saving?: Promise<void>;
};
const FILE_STORAGE_THRESHOLD = 8192; // if the file is below this size, we will store it in memory, or within the record itself, otherwise we will store it in a file
// We want to keep the file path private (but accessible to the extension)
const HEADER_SIZE = 8;
const UNCOMPRESSED_TYPE = 0;
const DEFLATE_TYPE = 1;
const ERROR_TYPE = 0xff;
const DEFAULT_HEADER = new Uint8Array([0, UNCOMPRESSED_TYPE, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const COMPRESS_HEADER = new Uint8Array([0, DEFLATE_TYPE, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const UNKNOWN_SIZE = 0xffffffffffff;
const storageInfoForBlob = new WeakMap<Blob, StorageInfo>();
let currentBlobCallback: (blob: Blob) => Blob | void;
export const Blob = global.Blob || polyfillBlob(); // use the global Blob class if it exists (it doesn't on Node v16)
let encodeForStorageForRecordId: number = undefined; // only enable encoding of the file path if we are saving to the DB, not for serialization to external clients, and only for one record
let promisedWrites: Array<Promise<void>>;
let currentStore: any; // the root store of the database we are currently encoding for
export let blobsWereEncoded = false; // keep track of whether blobs were encoded with file paths
// the header is 8 bytes
// this is a reusable buffer for reading and writing to the header (without having to create new allocations)
const HEADER = new Uint8Array(8);
const headerView = new DataView(HEADER.buffer);
const FILE_READ_TIMEOUT = 30000;
// We want FileBackedBlob instances to be an instanceof Blob, but we don't want to actually extend the class and call Blob's constructor, which is quite expensive because it has to set it up as a transferrable.
function InstanceOfBlobWithNoConstructor() {}
InstanceOfBlobWithNoConstructor.prototype = Blob.prototype;

// @ts-ignore
/**
 * A blob that is backed by a file, and can be saved to the database as a reference
 * Note that this is used instead of the native Blob class for a few reasons:
 * 1. This has the built-in functionality for reading from the file-based storage
 * 2. This support for streams and asynchronous access to data that may not have a known size ahead of time
 * 3. This also avoids the Blob constructor which is expensive due to the transferred setup
 * Harper still supports saving native Blobs, but when they blobs are retrieved from storage, they always use this class.
 */
class FileBackedBlob extends InstanceOfBlobWithNoConstructor {
	type = '';
	size: number;
	declare finished: Promise<void>;
	#onError: ((error: Error) => void)[];
	#options?: BlobCreationOptions;
	constructor(options?: BlobCreationOptions) {
		super();
		if (options?.type) this.type = options.type;
		if (options?.size != undefined) this.size = options.size;
	}

	on(type: string, callback: (error: Error) => void) {
		if (type !== 'error') throw new Error('Only error events are supported');
		if (!this.#onError) this.#onError = [];
		this.#onError.push(callback);
	}

	toJSON() {
		return {
			description:
				'Blob can not be directly serialized as JSON, use as the body of a response or convert to another type',
		};
	}

	async text(): Promise<string> {
		return (await this.bytes()).toString();
	}

	bytes(): Promise<Buffer> {
		const storageInfo = storageInfoForBlob.get(this);
		let { start, end, contentBuffer } = storageInfo;
		if (contentBuffer) {
			if (end !== undefined || start !== undefined) {
				contentBuffer = contentBuffer.subarray(start ?? 0, end ?? storageInfo.contentBuffer.length);
			}
			return Promise.resolve(contentBuffer);
		}
		const filePath = getFilePath(storageInfo);
		let writeFinished: boolean;
		const readContents = async () => {
			let rawBytes: Buffer;
			let size = HEADER_SIZE;
			try {
				rawBytes = await readFile(filePath);
				if (rawBytes.length >= HEADER_SIZE) {
					rawBytes.copy(HEADER, 0, 0, HEADER_SIZE);
					const headerValue = headerView.getBigUint64(0);
					if (Number(headerValue >> 48n) === ERROR_TYPE) {
						throw new Error('Error in blob: ' + buffer.subarray(HEADER_SIZE));
					}

					size = Number(headerValue & 0xffffffffffffn);
					if (size < end) size = end;
					if (size < UNKNOWN_SIZE) this.size = size;
				}
			} catch (error) {
				if (error.code !== 'ENOENT') throw error;
				rawBytes = Buffer.alloc(0);
			}
			function checkCompletion(rawBytes: Buffer): Buffer | Promise<Buffer> {
				if (size > rawBytes.length) {
					// the file is not finished being written, wait for the write lock to complete
					const store = storageInfo.store;
					const lockKey = storageInfo.fileId + ':blob';
					if (writeFinished) throw new Error('Incomplete blob');
					return new Promise((resolve, reject) => {
						if (
							store.attemptLock(lockKey, 0, () => {
								writeFinished = true;
								store.unlock(lockKey, 0);
								return resolve(readContents());
							})
						) {
							writeFinished = true;
							store.unlock(lockKey, 0);
							return resolve(readContents());
						}
					});
				}
				if (end != undefined || start != undefined) {
					rawBytes = rawBytes.subarray(start ?? 0, end ?? rawBytes.length);
				}
				return rawBytes;
			}
			if (rawBytes[1] === DEFLATE_TYPE) {
				return new Promise<Buffer>((resolve, reject) => {
					deflate(rawBytes.subarray(HEADER_SIZE), (error, result) => {
						if (error) reject(error);
						else resolve(checkCompletion(result));
					});
				});
			}
			return checkCompletion(rawBytes.subarray(HEADER_SIZE));
		};
		return readContents();
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		const bytes = await this.bytes();
		const arrayBuffer = new ArrayBuffer(bytes.length);
		const bufferUint8 = new Uint8Array(arrayBuffer);
		bufferUint8.set(bytes);
		return arrayBuffer;
	}

	stream(): ReadableStream {
		const storageInfo = storageInfoForBlob.get(this);
		let { contentBuffer, start, end } = storageInfo;
		if (contentBuffer) {
			if (end != undefined || start != undefined) {
				contentBuffer = contentBuffer.subarray(start ?? 0, end ?? storageInfo.contentBuffer.length);
			}
			return new ReadableStream({
				pull(controller) {
					controller.enqueue(contentBuffer);
					controller.close();
				},
			});
		}

		const filePath = getFilePath(storageInfo);
		let fd: number;
		let position = 0;
		let totalContentRead = 0;
		let watcher: any;
		let timer: any;
		let isBeingWritten: boolean;
		const blob = this;

		return new ReadableStream({
			start() {
				let retries = 1000;
				const openFile = (resolve: (value: any) => void, reject: (error: Error) => void) => {
					open(filePath, 'r', (error, openedFd) => {
						if (error) {
							if (error.code === 'ENOENT' && isBeingWritten !== false) {
								logger.debug?.('File does not exist yet, waiting for it to be created', filePath, retries);
								// the file doesn't exist, so we need to wait for it to be created
								if (retries-- > 0)
									return setTimeout(() => {
										checkIfIsBeingWritten();
										openFile(resolve, reject);
									}, 20).unref();
							}
							reject(error);
							blob.#onError?.forEach((callback) => callback(error));
						} else {
							fd = openedFd;
							resolve(openedFd);
						}
					});
				};
				return new Promise(openFile);
			},
			pull: (controller) => {
				let size = 0;
				let retries = 100;
				return new Promise(function readMore(resolve: () => void, reject: (error: Error) => void) {
					function onError(error) {
						close(fd);
						if (watcher) watcher.close();
						reject(error);
						blob.#onError?.forEach((callback) => callback(error));
					}
					// allocate a buffer for reading. Note that we could do a stat to get the size, but that is a little more complicated, and might be a little extra overhead
					const buffer = Buffer.allocUnsafe(0x40000);
					read(fd, buffer, 0, buffer.length, position, (error, bytesRead, buffer) => {
						// TODO: Implement support for decompression
						totalContentRead += bytesRead;
						if (error) return onError(error);
						if (position === 0) {
							// for the first read, we need to read the header and skip it for the data
							// but first check to see if we read anything
							if (bytesRead < HEADER_SIZE) {
								// didn't read any bytes, have to try again
								if (retries-- > 0 && isBeingWritten !== false) {
									checkIfIsBeingWritten();
									logger.debug?.('File was empty, waiting for data to be written', filePath, retries);
									setTimeout(() => readMore(resolve, reject), 20).unref();
								} else {
									logger.debug?.('File was empty, throwing error', filePath, retries);
									reject(new Error(`Blob ${storageInfo.fileId} was empty`));
								}
								// else throw new Error();
								return;
							}
							buffer.copy(HEADER, 0, 0, HEADER_SIZE);
							const headerValue = headerView.getBigUint64(0);
							if (Number(headerValue >> 48n) === ERROR_TYPE) {
								return onError(new Error('Error in blob: ' + buffer.subarray(HEADER_SIZE)));
							}
							size = Number(headerValue & 0xffffffffffffn);
							if (size < UNKNOWN_SIZE) blob.size = size;
							buffer = buffer.subarray(HEADER_SIZE, bytesRead);
							totalContentRead -= HEADER_SIZE;
						} else if (bytesRead === 0) {
							const buffer = Buffer.allocUnsafe(8);
							return read(fd, buffer, 0, HEADER_SIZE, 0, (error) => {
								if (error) return onError(error);
								HEADER.set(buffer);
								size = Number(headerView.getBigUint64(0) & 0xffffffffffffn);
								if (size > totalContentRead) {
									if (isBeingWritten !== false) {
										// the file is not finished being written, watch the file for changes to resume reading
										timer = setTimeout(() => {
											onError(new Error('File read timed out'));
										}, FILE_READ_TIMEOUT).unref();
										watcher = watch(filePath, { persistent: false }, () => {
											clearTimeout(timer);
											watcher.close();
											checkIfIsBeingWritten();
											readMore(resolve, reject);
										});
									} else {
										onError(new Error('Blob is incomplete'));
										// do NOT close the controller, or the error won't propagate to the stream
									}
									return;
								}
								close(fd);
								controller.close();
								resolve();
							});
						} else {
							buffer = buffer.subarray(0, bytesRead);
						}
						if (start !== undefined || end !== undefined) {
							if (start && totalContentRead < start) {
								// we are before the start of the slice, so we need to read more
								position += bytesRead;
								return readMore(resolve, reject);
							}
							if (end && totalContentRead >= end) {
								// we are past or reached the end of the slice, so we have reached the end, indicate
								if (totalContentRead > end) buffer = buffer.subarray(0, end - position);
								totalContentRead = size = end;
							}
							if (start && start > position) {
								// we need to skip ahead to the start of the slice
								buffer = buffer.subarray(start - position);
							}
						}
						position += bytesRead;
						try {
							controller.enqueue(buffer);
						} catch (error) {
							// we need to catch the error here, because if the controller is closed, it will throw an error
							// but we still want to resolve the promise
							logger.debug?.('Error enqueuing chunk', error);
							return resolve();
						}
						if (totalContentRead === size) {
							close(fd);
							controller.close();
						}
						resolve();
					});
				});
			},
			cancel() {
				close(fd);
				clearTimeout(timer);
				if (watcher) watcher.close();
			},
		});
		function checkIfIsBeingWritten() {
			if (isBeingWritten === undefined) {
				const store = storageInfo.store;
				const lockKey = storageInfo.fileId + ':blob';
				isBeingWritten = !store.attemptLock(lockKey, 0, () => {
					isBeingWritten = false;
					store.unlock(lockKey, 0);
				});
				if (!isBeingWritten) store.unlock(lockKey, 0);
			}
			return isBeingWritten;
		}
	}
	slice(start: number, end: number, type?: string): Blob {
		const sourceStorageInfo = storageInfoForBlob.get(this);
		const slicedBlob = new FileBackedBlob(type && { type });
		if (sourceStorageInfo?.fileId) {
			const slicedStorageInfo = {
				...sourceStorageInfo,
				start,
				end,
			};
			storageInfoForBlob.set(slicedBlob, slicedStorageInfo);
			if (this.size != undefined)
				slicedBlob.size = (end == undefined ? this.size : Math.min(end, this.size)) - (start ?? 0);
		} else if (sourceStorageInfo?.contentBuffer && !sourceStorageInfo.storageBuffer) {
			const slicedStorageInfo = {
				...sourceStorageInfo,
				contentBuffer: sourceStorageInfo.contentBuffer.subarray(start, end),
			};
			storageInfoForBlob.set(slicedBlob, slicedStorageInfo);
			slicedBlob.size = (end ?? this.size) - start;
		} else {
			// TODO: Implement this
			throw new Error('Can not slice a streaming blob that is not backed by a file');
		}
		return slicedBlob;
	}
	save(targetTable: any): Promise<void> {
		const store = targetTable?.primaryStore?.rootStore;
		if (!store) throw new Error('No target table specified');
		return saveBlob(this).saving ?? Promise.resolve();
	}
}
let deletion_delay = 500;
/**
 * Delete the file for the blob
 * @param blob
 */
export function deleteBlob(blob: Blob): void {
	// do we even need to check for completion here?
	const filePath = getFilePathForBlob(blob);
	if (!filePath) {
		logger.debug?.('No file path for blob, can not delete');
		return;
	}
	setTimeout(() => {
		// TODO: we need to determine when any read transaction are done with the file, and then delete it, this is a hack to just give it some time for that
		unlink(filePath, (error) => {
			if (error) logger.debug?.('Error trying to remove blob file', error);
		});
	}, deletion_delay);
}
export function setDeletionDelay(delay: number) {
	deletion_delay = delay;
}
export type BlobCreationOptions = {
	type?: string; // the MIME type of the blob
	compress?: boolean; // compress the data with deflate
	flush?: boolean; // flush to disk after writing and before resolving the finished promise
	size?: number; // the size of the data, if known ahead of time
};
/**
 * Create a blob from a readable stream or a buffer by creating a file in the blob storage path with a new unique internal id, that
 * can be saved/stored.
 * @param source
 */
global.createBlob = function (source: NodeJS.ReadableStream | NodeJS.Buffer, options?: BlobCreationOptions): Blob {
	const blob = new FileBackedBlob(options);
	const storageInfo = { storageIndex: 0, fileId: null, flush: options?.flush, compress: options?.compress };
	storageInfoForBlob.set(blob, storageInfo);
	if (source instanceof Uint8Array) {
		storageInfo.contentBuffer = source;
	} else if (source instanceof Readable) {
		storageInfo.source = source;
	} else if (typeof source === 'string') storageInfo.contentBuffer = Buffer.from(source);
	else if (source?.[Symbol.asyncIterator] || source?.[Symbol.iterator]) storageInfo.source = Readable.from(source);
	else throw new Error('Invalid source type');
	return blob;
};

function saveBlob(blob: FileBackedBlob) {
	let storageInfo = storageInfoForBlob.get(blob);
	if (!storageInfo) {
		storageInfo = { storageIndex: 0, fileId: null, store: currentStore };
		storageInfoForBlob.set(blob, storageInfo);
	} else {
		if (storageInfo.saving) return storageInfo;
		storageInfo.store = currentStore;
	}

	generateFilePath(storageInfo);
	if (storageInfo.source) writeBlobWithStream(blob, storageInfo.source, storageInfo);
	else if (storageInfo.contentBuffer) writeBlobWithBuffer(blob, storageInfo);
	else writeBlobWithStream(blob, Readable.from(blob.stream()), storageInfo); // for native blobs, we have to read them from the stream
	return storageInfo;
}

/**
 * Create a blob from a readable stream
 */
function writeBlobWithStream(blob: Blob, stream: NodeJS.ReadableStream, storageInfo: StorageInfo): Blob {
	const { filePath, fileId, store, compress, flush } = storageInfo;
	storageInfo.saving = new Promise((resolve, reject) => {
		// pipe the stream to the file
		const lockKey = fileId + ':blob';
		if (!store.attemptLock(lockKey, 0)) {
			throw new Error(`Unable to get lock for blob file ${fileId}`);
		}
		const writeStream = createWriteStream(filePath, { autoClose: false, flags: 'w' });
		if (stream.errored) {
			// if starts in an error state, record that immediately
			const error = Buffer.from(stream.errored.toString());
			writeStream.end(Buffer.concat([createHeader(BigInt(error.length) + 0xff000000000000n), error]));
			return;
		}
		let wroteSize = false;
		if (blob.size !== undefined) {
			// if we know the size, we can write the header immediately
			writeStream.write(createHeader(blob.size)); // write the default header
			wroteSize = true;
		}
		let compressedStream: NodeJS.Stream;
		if (compress) {
			if (!wroteSize) writeStream.write(COMPRESS_HEADER); // write the default header to the file
			compressedStream = createDeflate();
			stream.pipe(compressedStream).pipe(writeStream);
		} else {
			if (!wroteSize) writeStream.write(DEFAULT_HEADER); // write the default header to the file
			stream.pipe(writeStream);
		}
		stream.on('error', finished);
		function createHeader(size: number | bigint): Uint8Array {
			let headerValue = BigInt(size);
			const header = new Uint8Array(HEADER_SIZE);
			const headerView = new DataView(header.buffer);
			headerValue |= BigInt(compress ? DEFLATE_TYPE : UNCOMPRESSED_TYPE) << 48n;
			headerView.setBigInt64(0, headerValue);
			return header;
		}
		// when the stream is finished, we may need to flush, and then close the handle and resolve the promise
		function finished(error?: Error) {
			store.unlock(lockKey, 0);
			//			logger.info?.('unlocked blob', lockKey);
			const fd = writeStream.fd;
			if (error) {
				if (fd) close(fd);
				reject(error);
			} else if (flush) {
				// we just use fdatasync because we really aren't that concerned with flushing file metadata
				fdatasync(fd, (error) => {
					if (error) reject(error);
					resolve();
					close(fd);
				});
			} else {
				resolve();
				close(fd);
			}
		}
		writeStream.on('error', finished).on('finish', () => {
			if (wroteSize) finished();
			// now that we know the size, we can write it, in case any other threads were waiting for this to complete
			else
				write(
					writeStream.fd,
					createHeader(compressedStream ? compressedStream.bytesWritten : writeStream.bytesWritten - HEADER_SIZE),
					0,
					HEADER_SIZE,
					0,
					finished
				);
		});
	});
	return blob;
}

export function getFileId(blob: Blob): string {
	return storageInfoForBlob.get(blob)?.fileId;
}
export function getFilePathForBlob(blob: FileBackedBlob): string {
	const storageInfo = storageInfoForBlob.get(blob);
	return storageInfo?.fileId && getFilePath(storageInfo);
}
export const databasePaths = new Map<LMDBStore, string[]>();
export function getRootBlobPathsForDB(store: LMDBStore) {
	if (!store) {
		throw new Error('No store specified, can not determine blob storage path');
	}
	let paths: string[] = databasePaths.get(store);
	if (!paths) {
		if (!store.databaseName) throw new Error('No database name specified, can not determine blob storage path');
		const blobPaths: string[] = envGet(CONFIG_PARAMS.STORAGE_BLOBPATHS);
		if (blobPaths) {
			paths = blobPaths.map((path) => join(path, store.databaseName));
		} else {
			paths = [join(getHdbBasePath(), 'blobs', store.databaseName)];
		}
		databasePaths.set(store, paths);
	}
	return paths;
}
export function deleteRootBlobPathsForDB(store: LMDBStore): Promise<any[]> {
	const paths = databasePaths.get(store);
	const deletions = [];
	if (paths) {
		for (const path of paths) {
			deletions.push(remove(path));
		}
		databasePaths.delete(store);
	}
	return Promise.all(deletions);
}
function getFilePath({ storageIndex, fileId, store }: StorageInfo): string {
	const blobStoragePaths = getRootBlobPathsForDB(store);
	return join(
		// Use a hierarchy of directories to store the file by id, to avoid to many entries in a single directory. This uses 4096 files or directories per parent directory
		blobStoragePaths[storageIndex],
		fileId.slice(-9, -6) || '0',
		fileId.slice(-6, -3) || '0',
		fileId.length <= 9 ? fileId.slice(-3) : fileId.slice(0, -9) + fileId.slice(-3) // after 68 billion entries, we effectively wrap around and start reusing directories again, assuming the most the entries have been deleted
	);
}

/**
 * Create a blob from a buffer
 * @param buffer
 */
function writeBlobWithBuffer(blob: Blob, storageInfo: StorageInfo): Blob {
	// we know the size, so we can create the header immediately
	const buffer = storageInfo.contentBuffer;
	const size = buffer.length;
	if (size < FILE_STORAGE_THRESHOLD) {
		// if the buffer is small enough, just store it in memory
		return;
	}
	blob.size = size;
	return writeBlobWithStream(blob, Readable.from([buffer]), storageInfo);
}

/**
 * Create a blob that is backed by a *new* file with a new unique internal id, so it can be filled with data and saved to the database
 */
function generateFilePath(storageInfo: StorageInfo) {
	const blobStoragePaths = getRootBlobPathsForDB(storageInfo.store);
	const id = getNextFileId();
	// get the storage index, which is the index of the blob storage path to use, distributed round-robin based on the id
	const storageIndex = blobStoragePaths?.length > 1 ? id % blobStoragePaths.length : 0;
	const fileId = id.toString(16); // get the next file id
	storageInfo.storageIndex = storageIndex;
	storageInfo.fileId = fileId;
	const filePath = getFilePath(storageInfo);
	const fileDir = dirname(filePath);
	// ensure the directory structure exists
	if (!existsSync(fileDir)) ensureDirSync(fileDir);
	storageInfo.filePath = filePath;
}
const idIncrementers = new Map<LMDBStore, BigInt64Array>();
function getNextFileId(): number {
	// all threads will use a shared buffer to atomically increment the id
	// first, we create our proposed incrementer buffer that will be used if we are the first thread to get here
	// and initialize it with the starting id
	let idIncrementer = idIncrementers.get(currentStore);
	if (!idIncrementer) {
		// get the last id by checking the highest id in all the blob storage paths
		let highestId = 0;
		const blobStoragePaths = getRootBlobPathsForDB(currentStore);
		for (let path of blobStoragePaths) {
			let id = 0;
			// we need to get the highest id in the directory structure, so we need to iterate through all the directories to find the highest byte sequence
			for (let i = 0; i < 3; i++) {
				id = id * 0x1000;
				let highest = 0;
				if (existsSync(path)) {
					for (const entry of readdirSync(path)) {
						let n = parseInt(entry, 16);
						if (i === 2 && entry.length > 3) {
							// the last iteration is filenames, and if they are longer than 3 characters then the last 3 characters of the id, and the preceding characters are the highest value
							n = parseInt(entry.slice(-3), 16);
							n += parseInt(entry.slice(0, -3), 16) * 0x1000000000;
						}
						if (n > highest) {
							highest = n;
						}
					}
				}
				id += highest;
				path = join(path, highest.toString(16));
			}
			highestId = Math.max(highestId, id);
		}
		idIncrementer = new BigInt64Array([BigInt(highestId) + 1n]);
		// now get the selected incrementer buffer, this is the shared buffer was first registered and that all threads will use
		idIncrementer = new BigInt64Array(currentStore.getUserSharedBuffer('blob-file-id', idIncrementer.buffer));
		idIncrementers.set(currentStore, idIncrementer);
	}
	return Number(Atomics.add(idIncrementer, 0, 1n));
}

/**
 * Encode blobs with file paths, so that they can be saved to the database
 * @param callback
 * @param encodingId
 * @param objectToClear
 */
export function encodeBlobsWithFilePath<T>(callback: () => T, encodingId: number, store: LMDBStore): T {
	encodeForStorageForRecordId = encodingId;
	currentStore = store;
	blobsWereEncoded = false;
	try {
		return callback();
	} finally {
		encodeForStorageForRecordId = undefined;
		currentStore = undefined;
	}
}
/**
 * Encode blobs as buffers, so they can be transferred remotely
 * @param callback
 * @param encodingId
 * @param objectToClear
 */
export function encodeBlobsAsBuffers<T>(callback: () => T): Promise<T> {
	promisedWrites = [];
	let result: any;
	try {
		result = callback();
	} finally {
		const finished = promisedWrites.length < 2 ? promisedWrites[0] : Promise.all(promisedWrites);
		promisedWrites = undefined;
		// eslint-disable-next-line no-unsafe-finally
		return finished ? finished.then(() => callback()) : result;
	}
}

/**
 * Decode blobs, creating local storage to hold the blogs and returning a promise that resolves when all the blobs are written to disk
 * @param callback
 */
export function decodeBlobsWithWrites(callback: () => void, blobCallback?: (blob: Blob) => void) {
	try {
		promisedWrites = [];
		currentBlobCallback = blobCallback;
		return callback();
	} finally {
		currentBlobCallback = undefined;
		const finished = promisedWrites.length < 2 ? promisedWrites[0] : Promise.all(promisedWrites);
		promisedWrites = undefined;
		// eslint-disable-next-line no-unsafe-finally
		return finished;
	}
}

/**
 * Decode with a callback for when blobs are encountered, allowing for detecting of blobs
 * @param callback
 */
export function decodeWithBlobCallback(callback: () => void, blobCallback: (blob: Blob) => void) {
	try {
		currentBlobCallback = blobCallback;
		return callback();
	} finally {
		currentBlobCallback = undefined;
	}
}
/**
 * Decode with a callback for when blobs are encountered, allowing for detecting of blobs
 * @param callback
 */
export function decodeFromDatabase(callback: () => void, rootStore: LMDBStore) {
	// note that this is actually called recursively (but always the same root store), so we don't clear afterwards
	currentStore = rootStore;
	return callback();
}

/**
 * Delete blobs in an object, recursively searching for blobs
 * @param object
 */
export function deleteBlobsInObject(object) {
	if (object instanceof Blob) {
		// eslint-disable-next-line
		// @ts-ignore
		deleteBlob(object);
	} else if (object.constructor === Object || Array.isArray(object)) {
		// recursively find and delete blobs in the object
		for (const key in object) {
			const value = object[key];
			if (typeof value === 'object') deleteBlobsInObject(object[key]);
		}
	}
}

addExtension({
	Class: Blob,
	type: 11,
	unpack: function (buffer) {
		const blobInfo = unpack(buffer);
		const blob = new FileBackedBlob();
		Object.assign(blob, blobInfo[0]); // copy any properties
		if (typeof blobInfo[1] !== 'object') {
			// this is a reference, not followed by any buffer
			if (!currentStore) {
				throw new Error('No store specified, can not load blob from storage');
			}
			storageInfoForBlob.set(blob, {
				storageIndex: blobInfo[1],
				fileId: blobInfo[2],
				store: currentStore,
			});
			if (currentBlobCallback) return currentBlobCallback(blob) ?? blob;
		} else {
			storageInfoForBlob.set(blob, {
				storageIndex: 0,
				fileId: null,
				storageBuffer: buffer,
				contentBuffer: blobInfo[1],
			});
		}
		return blob;
	},
	pack: function (blob) {
		let storageInfo = storageInfoForBlob.get(blob);
		if (encodeForStorageForRecordId !== undefined) {
			blobsWereEncoded = true;
			if (storageInfo?.recordId !== undefined && storageInfo.recordId !== encodeForStorageForRecordId) {
				throw new Error('Cannot use the same blob in two different records');
			}
		}
		const options = { ...blob };
		if (blob.type) options.type = blob.type;
		if (blob.size !== undefined) options.size = blob.size;
		if (storageInfo) {
			if (storageInfo.storageBuffer) {
				return storageInfo.storageBuffer;
			}
			if (storageInfo.contentBuffer?.length < FILE_STORAGE_THRESHOLD) {
				options.size = storageInfo.contentBuffer.length;
				return pack([options, storageInfo.contentBuffer]);
			}
		}
		if (encodeForStorageForRecordId !== undefined) {
			storageInfo = saveBlob(blob);
			if (!storageInfo.fileId) {
				throw new Error('Unable to save blob without file id');
			}
			storageInfo.recordId = encodeForStorageForRecordId;
			return pack([options, storageInfo.storageIndex, storageInfo.fileId]);
		}
		if (storageInfo) {
			// if we want to encode as binary (necessary for replication), we need to encode as a buffer, not sure if we should always do that
			// also, for replication, we would presume that this is most likely in OS cache, and sync will be fast. For other situations, a large sync call could be
			// unpleasant
			// we include the headers, as the receiving end will need them, and this differentiates from a reference
			try {
				const buffer = readFileSync(getFilePath(storageInfo));
				if (buffer.length >= HEADER_SIZE) {
					buffer.copy(HEADER, 0, 0, HEADER_SIZE);
					const size = Number(headerView.getBigUint64(0) & 0xffffffffffffn);
					if (size === buffer.length - HEADER_SIZE) {
						// the file is there and complete, we can return the encoding
						return Buffer.concat([pack([options]), buffer]);
					}
				}
				// declare it as being fulfilled
				if (promisedWrites) promisedWrites.push(blob.bytes());
				else {
					throw new Error('Incomplete blob');
				}
				return Buffer.alloc(0);
			} catch (error) {
				if (error.code === 'ENOENT' && promisedWrites) {
					promisedWrites.push(blob.bytes());
					return Buffer.alloc(0);
				} else throw error;
			}
		} else {
			throw new Error('Blob has no storage info or buffer attached to it');
		}
	},
});
// with Blobs, it is easy to forget to await the creation, make sure that the blob is created before continuing
addExtension({
	Class: Promise,
	type: 12, // not actually used, but we need to define a type
	pack() {
		throw new Error('Cannot encode a promise');
	},
});

function polyfillBlob() {
	// polyfill Blob for older Node, it has just enough to handle a single Buffer
	return class Blob {
		content: Buffer;
		constructor(contents: Buffer[]) {
			this.content = contents[0];
		}
		stream() {
			return new ReadableStream({
				start(controller) {
					controller.enqueue(this.content);
					controller.close();
				},
			});
		}
		text() {
			return Promise.resolve(this.content.toString());
		}
		arrayBuffer() {
			return Promise.resolve(this.content.buffer);
		}
		get size() {
			return this.content.length;
		}
		slice(): Blob {
			throw new Error('Not implemented');
		}
		bytes() {
			return Promise.resolve(this.content);
		}
		get type() {
			return '';
		}
	};
}
