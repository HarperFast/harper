/**
 * This module provides a Blob class that can be used to store binary data in the database, and can be used to store large binary data in a file
 * on the server. The Blob class is a subclass of the global Blob class, and can be used in the same way.
 * The Blob-backed files begin with an 8-byte header:
 * - The first 2 bytes indicate the type of storage:
 * 		- 0: Uncompressed
 * 		- 1: Compressed with deflate
 * - The next 6 bytes are the size of the content
 *   - While the file is being written, 0xffffffffffff is used as a placeholder to indicate that the file is not finished being written (this nicely matches the logic that if the written content size is less than the indicated content size, it is not finished)
 *   - Note that for compressed data, the size is the uncompressed size, and the compressed size in the file
 */

import { addExtension, pack, unpack } from 'msgpackr';
import { stat, readFile, writeFile } from 'node:fs/promises';
import {
	close,
	createWriteStream,
	fdatasync,
	open,
	openSync,
	readFileSync,
	read,
	unlink,
	readdirSync,
	existsSync,
	readSync,
	watch,
	write,
} from 'node:fs';
import { createDeflate, deflate, createInflate } from 'node:zlib';
import { Readable } from 'node:stream';
import { ensureDir } from 'fs-extra';
import { get as envGet, getHdbBasePath } from '../utility/environment/environmentManager';
import { CONFIG_PARAMS } from '../utility/hdbTerms';
import { join, dirname } from 'path';

const FILE_STORAGE_THRESHOLD = 8192; // if the file is below this size, we will store it in memory, or within the record itself, otherwise we will store it in a file
// We want to keep the file path private (but accessible to the extension)
const HEADER_SIZE = 8;
const UNCOMPRESSED_TYPE = 0;
const DEFLATE_TYPE = 1;
const DEFAULT_HEADER = new Uint8Array([0, UNCOMPRESSED_TYPE, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const COMPRESS_HEADER = new Uint8Array([0, DEFLATE_TYPE, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const storageInfoForBlob = new WeakMap();
export const Blob = global.Blob || polyfillBlob(); // use the global Blob class if it exists (it doesn't on Node v16)
let encodeForStorageForRecordId: number = undefined; // only enable encoding of the file path if we are saving to the DB, not for serialization to external clients, and only for one record
let promisedWrites: Array<Promise<void>>;
export let blobsWereEncoded = false; // keep track of whether blobs were encoded with file paths
addExtension({
	Class: Blob,
	type: 11,
	unpack: function (buffer) {
		if (buffer[0] > 1) {
			// this was encoded as reference to a file path, so we can decode it as msgpack and create the referencing blob
			const data = unpack(buffer);
			// this is a file backed blob, so we need to create a new blob object with the storage info
			return new FileBackedBlob({
				storageIndex: data[0],
				fileId: data[1],
			});
		} else {
			// this directly encoded as a buffer, so we need to create a new blob object backed by a file, with the buffer
			const blob = createBlobFromDirectBuffer(buffer);
			if (blob.finished) promisedWrites.push(blob.finished);
			return blob;
		}
	},
	pack: function (blob) {
		const storageInfo = storageInfoForBlob.get(blob);
		if (storageInfo) {
			if (encodeForStorageForRecordId !== undefined) {
				// this is used when we are encoding the data for storage in the database, referencing the (local) file storage
				blobsWereEncoded = true;
				if (storageInfo.recordId && storageInfo.recordId !== encodeForStorageForRecordId) {
					throw new Error('Cannot use the same blob in two different records');
				}
				storageInfo.recordId = encodeForStorageForRecordId;
				return pack([storageInfo.storageIndex, storageInfo.fileId, {}]);
			} else {
				// if we want to encode as binary (necessary for replication), we need to encode as a buffer, not sure if we should always do that
				// also, for replication, we would presume that this is most likely in OS cache, and sync will be fast. For other situations, a large sync call could be
				// unpleasant
				// we include the headers, as the receiving end will need them, and this differentiates from a reference
				return readFileSync(getFilePath(storageInfo));
			}
		} else if (blob.buffer) {
			return blob.buffer;
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
// the header is 8 bytes
// this is a reusable buffer for reading and writing to the header (without having to create new allocations)
const HEADER = new Uint8Array(8);
const headerView = new DataView(HEADER.buffer);
const FILE_READ_TIMEOUT = 30000;
const CHUNK_SIZE = 16 * 1024;
/**
 * A blob that is backed by a file, and can be saved to the database as a reference
 */
class FileBackedBlob extends Blob {
	finished: Promise<void>;
	constructor(options?: FilePropertyBag) {
		super([], options);
		storageInfoForBlob.set(this, {
			storageIndex: options?.storageIndex,
			fileId: options?.fileId,
		});
	}

	async text(): Promise<string> {
		return (await this.bytes()).toString();
	}

	bytes(): Promise<Buffer> {
		const filePath = getFilePathForBlob(this);
		let watcher: any;
		let timer: NodeJS.Timeout;
		let lastRead = 0;
		async function readContents(): Promise<Buffer> {
			const rawBytes = await readFile(filePath);
			rawBytes.copy(HEADER, 0, 0, HEADER_SIZE);
			const size = Number(headerView.getBigUint64(0) & 0xffffffffffffn);
			if (lastRead) lastRead = Date.now();
			function checkCompletion(rawBytes: Buffer): Buffer | Promise<Buffer> {
				if (size > rawBytes.length) {
					// the file is not finished being written, watch the file for changes to resume reading
					if (!watcher)
						return new Promise((resolve, reject) => {
							lastRead = Date.now();
							const tryAgain = () => {
								clearTimeout(timer);
								readContents().then((result) => {
									if (result) {
										resolve(result);
										clearInterval(timer);
										watcher.close();
									}
									if (Date.now() - lastRead > FILE_READ_TIMEOUT) {
										reject(new Error('File read timed out'));
									}
								});
							};
							watcher = watch(filePath, { persistent: false }, tryAgain);
							// we also just repeatedly check the file, watch isn't necessarily reliable; there could be a race condition with getting the watch in place in time with other threads
							timer = setInterval(tryAgain, 100).unref();
						});
					return;
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
		}
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
		const filePath = getFilePathForBlob(this);
		let fd: number;
		let position = 0;
		let totalContentRead = 0;

		return new ReadableStream({
			start() {
				return new Promise((resolve, reject) => {
					open(filePath, 'r', (error, openedFd) => {
						if (error) reject(error);
						fd = openedFd;
						resolve(openedFd);
					});
				});
			},
			pull: (controller) => {
				let size = 0;
				return new Promise(function readMore(resolve, reject) {
					read(fd, { position, length: CHUNK_SIZE }, (error, bytesRead, buffer) => {
						// TODO: Implement support for decompression
						totalContentRead += bytesRead;
						if (error) return reject(error);
						if (position === 0) {
							// for the first read, we need to read the header and skip it for the data
							buffer.copy(HEADER, 0, 0, HEADER_SIZE);
							const headerValue = headerView.getBigUint64(0);
							size = Number(headerValue & 0xffffffffffffn);
							buffer = buffer.subarray(HEADER_SIZE, bytesRead);
							totalContentRead -= HEADER_SIZE;
						} else if (bytesRead === 0) {
							const buffer = new Uint8Array(8);
							return read(fd, buffer, 0, HEADER_SIZE, 0, (error) => {
								if (error) reject(error);
								HEADER.set(buffer);
								size = Number(headerView.getBigUint64(0) & 0xffffffffffffn);
								if (size > totalContentRead) {
									// the file is not finished being written, watch the file for changes to resume reading
									let watcher: any;
									const timer = setTimeout(() => {
										reject(new Error('File read timed out'));
										watcher.close();
									}, FILE_READ_TIMEOUT).unref();
									watcher = watch(filePath, { persistent: false }, () => {
										clearTimeout(timer);
										watcher.close();
										readMore(resolve, reject);
									});
									return;
								}
								close(fd);
								controller.close();
								resolve();
							});
						} else {
							buffer = buffer.subarray(0, bytesRead);
						}
						position += bytesRead;
						controller.enqueue(buffer);
						if (totalContentRead === size) {
							close(fd);
							controller.close();
						}
						resolve();
					});
				});
			},
			cancel: () => {},
		});
	}
	get size(): number {
		const filePath = getFilePathForBlob(this);
		const fd = openSync(filePath, 'r');
		readSync(fd, HEADER, 0, HEADER_SIZE, 0);
		close(fd);
		const headerValue = headerView.getBigUint64(0);
		const size = Number(headerValue & 0xffffffffffffn);
		if (size < 0xffffffffffff) return size;
		// else return undefined to indicate that the file is not finished being written, so we don't know the size yet
	}
	slice() {
		throw new Error('Not implemented');
	}
}
let deletion_delay = 500;
/**
 * Delete the file for the blob
 * @param blob
 */
export function deleteBlob(blob: Blob): Promise<void> {
	// do we even need to check for completion here?
	return new Promise((resolve, reject) => {
		const filePath = getFilePathForBlob(blob);
		setTimeout(() => {
			// TODO: we need to determine when any read transaction are done with the file, and then delete it, this is a hack to just give it some time for that
			unlink(filePath, (error) => {
				if (error) reject(error);
				else resolve();
			});
		}, deletion_delay);
	});
}
export function setDeletionDelay(delay: number) {
	deletion_delay = delay;
}
let blobStoragePaths: Array<string>;
export type BlobCreationOptions = {
	compress?: boolean; // compress the data with deflate
	flush?: boolean; // flush to disk after writing and before resolving the finished promise
	size?: number; // the size of the data, if known ahead of time
};
/**
 * Create a blob from a readable stream or a buffer by creating a file in the blob storage path with a new unique internal id, that
 * can be saved/stored.
 * @param source
 */
global.createBlob = function (
	source: NodeJS.ReadableStream | NodeJS.Buffer,
	options?: BlobCreationOptions
): Promise<Blob> {
	if (source instanceof Uint8Array) return createBlobFromBuffer(source, options);
	else if (source instanceof Readable) return createBlobFromStream(source, options);
	else if (typeof source === 'string') return createBlobFromBuffer(Buffer.from(source), options);
	else if (source?.[Symbol.asyncIterator] || source?.[Symbol.iterator])
		return createBlobFromStream(Readable.from(source), options);
	else throw new Error('Invalid source type');
};
/**
 * Create a blob from a readable stream
 */
function createBlobFromStream(stream: NodeJS.ReadableStream, options: any): Promise<Blob> {
	if (options?.size < FILE_STORAGE_THRESHOLD) {
		// if the data is small enough, we can just store it in memory
		return streamToBuffer(stream).then((buffer) => {
			return createBlobFromBuffer(buffer, options);
		});
	}
	const results = createBlobWithFile();
	const { filePath, blob, ready } = results;
	let finishedResolve: () => void;
	let finishedReject: (error: Error) => void;
	blob.finished = new Promise((resolve, reject) => {
		finishedResolve = resolve;
		finishedReject = reject;
	});
	return ready.then(
		() =>
			new Promise((resolve, reject) => {
				// TODO: If the data is below the threshold, we should just store it in memory
				// pipe the stream to the file
				const writeStream = createWriteStream(filePath, { autoClose: false, flags: 'w' });
				const writeCallback = (error) => {
					if (error) reject(error);
					else resolve(blob);
				};
				let wroteSize = false;
				if (options?.size !== undefined) {
					// if we know the size, we can write the header immediately
					writeStream.write(createHeader(options.size), writeCallback); // write the default header
					wroteSize = true;
				}
				let compressedStream: NodeJS.Stream;
				if (options?.compress) {
					if (!wroteSize) writeStream.write(COMPRESS_HEADER, writeCallback); // write the default header to the file
					compressedStream = createDeflate();
					stream.pipe(compressedStream).pipe(writeStream);
				} else {
					if (!wroteSize) writeStream.write(DEFAULT_HEADER, writeCallback); // write the default header to the file
					stream.pipe(writeStream);
				}
				function createHeader(size: number): Uint8Array {
					let headerValue = BigInt(size);
					const header = new Uint8Array(HEADER_SIZE);
					const headerView = new DataView(header.buffer);
					headerValue |= BigInt(options?.compress ? DEFLATE_TYPE : UNCOMPRESSED_TYPE) << 48n;
					headerView.setBigInt64(0, headerValue);
					return header;
				}
				// when the stream is finished, we may need to flush, and then close the handle and resolve the promise
				function finished(error?: Error) {
					const fd = writeStream.fd;
					if (error) {
						close(fd);
						const storageInfo = storageInfoForBlob.get(blob);
						unlink(storageInfo.path, () => {}); // if there's an error, delete the file
						finishedReject(error);
					}
					if (options?.flush) {
						// we just use fdatasync because we really aren't that concerned with flushing file metadata
						fdatasync(fd, (error) => {
							if (error) finishedReject(error);
							finishedResolve();
							close(fd);
						});
					} else {
						finishedResolve();
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
			})
	);
}
export function getFilePathForBlob(blob: FileBackedBlob): string {
	return getFilePath(storageInfoForBlob.get(blob));
}
function getFilePath(storageInfo: any): string {
	if (!blobStoragePaths) {
		// initialize paths if not already done
		blobStoragePaths = envGet(CONFIG_PARAMS.STORAGE_BLOBPATHS) || [join(getHdbBasePath(), 'blobs')];
	}
	return join(
		blobStoragePaths[storageInfo.storageIndex],
		storageInfo.fileId.slice(0, -6) || '0',
		storageInfo.fileId.slice(-6, -3) || '0',
		storageInfo.fileId.slice(-3)
	);
}

/**
 * Create a blob from a buffer that already has a header
 * @param buffer
 */
function createBlobFromDirectBuffer(buffer: NodeJS.Buffer): Blob {
	if (buffer.length < FILE_STORAGE_THRESHOLD) {
		// if the buffer is small enough, just store it in memory
		const blob: Blob = new Blob([buffer.subarray(HEADER_SIZE)]);
		blob.buffer = buffer;
		return blob;
	}
	const results = createBlobWithFile();
	const { blob, filePath, ready } = results;
	blob.finished = ready.then(() => {
		return writeFile(filePath, buffer);
	});
	return blob;
}

/**
 * Create a blob from a buffer
 * @param buffer
 */
function createBlobFromBuffer(buffer: NodeJS.Buffer, options?: BlobCreationOptions): Promise<Blob> {
	// we know the size, so we can create the header immediately
	const size = buffer.length;
	if (size < FILE_STORAGE_THRESHOLD) {
		// if the buffer is small enough, just store it in memory
		const blob = new Blob([buffer]);
		headerView.setBigInt64(0, BigInt(size));
		blob.buffer = Buffer.concat([HEADER, buffer]);
		return Promise.resolve(blob);
	}
	if (options) options.size = size;
	else options = { size };
	return createBlobFromStream(Readable.from([buffer]), options);
}

/**
 * Create a blob that is backed by a *new* file with a new unique internal id, so it can be filled with data and saved to the database
 */
function createBlobWithFile(): { filePath: string; blob: FileBackedBlob; ready: Promise<void> } {
	if (!blobStoragePaths) {
		// initialize paths if not already done
		getFilePath({ storageIndex: 0, fileId: '0' }); // just to initialize the paths
	}
	const id = getNextFileId();
	// get the storage index, which is the index of the blob storage path to use, distributed round-robin based on the id
	const storageIndex = blobStoragePaths?.length > 1 ? id % blobStoragePaths.length : 0;
	const fileId = getNextFileId().toString(16); // get the next file id
	const storageInfo = { storageIndex, fileId };
	const filePath = getFilePath(storageInfo);
	const fileDir = dirname(filePath);
	const blob = new FileBackedBlob({ storageIndex, fileId });
	// ensure the directory structure exists

	return { filePath, blob, ready: stat(fileDir).catch(() => ensureDir(fileDir)) };
}
let idIncrementer: BigInt64Array;
function getNextFileId(): number {
	// all threads will use a shared buffer to atomically increment the id
	// first, we create our proposed incrementer buffer that will be used if we are the first thread to get here
	// and initialize it with the starting id
	if (!idIncrementer) {
		// get the last id by checking the highest id in all the blob storage paths
		let lastId = 0;
		for (let path of blobStoragePaths) {
			// we need to get the highest id in the directory structure, so we need to iterate through all the directories to find the highest byte sequence
			for (let i = 0; i < 3; i++) {
				lastId = lastId * 0x1000;
				let highest = 0;
				if (existsSync(path)) {
					for (const entry of readdirSync(path)) {
						const n = parseInt(entry, 16);
						if (n > highest) {
							highest = n;
						}
					}
				}
				lastId += highest;
				path = join(path, highest.toString(16));
			}
		}
		idIncrementer = new BigInt64Array([BigInt(lastId) + 1n]);
		// now get the selected incrementer buffer, this is the shared buffer was first registered and that all threads will use
		idIncrementer = new BigInt64Array(
			databases.system.hdb_info.primaryStore.getUserSharedBuffer('blob-file-id', idIncrementer.buffer)
		);
	}
	return Number(Atomics.add(idIncrementer, 0, 1n));
}

/**
 * Encode blobs with file paths, so that they can be saved to the database
 * @param callback
 * @param encodingId
 * @param objectToClear
 */
export function encodeBlobsWithFilePath<T>(callback: () => T, encodingId: number) {
	encodeForStorageForRecordId = encodingId;
	blobsWereEncoded = false;
	try {
		return callback();
	} finally {
		encodeForStorageForRecordId = 0;
	}
}

/**
 * Decode blobs, creating local storage to holde the blogs and returning a promise that resolves when all the blobs are written to disk
 * @param callback
 */
export function decodeBlobsWithWrites(callback: () => void) {
	try {
		promisedWrites = [];
		return callback();
	} finally {
		const finished = promisedWrites.length < 2 ? promisedWrites[0] : Promise.all(promisedWrites);
		promisedWrites = undefined;
		// eslint-disable-next-line no-unsafe-finally
		return finished;
	}
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
		slice() {
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
function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const buffers = [];
		stream.on('data', (data) => buffers.push(data));
		stream.on('end', () => resolve(Buffer.concat(buffers)));
		stream.on('error', reject);
	});
}
