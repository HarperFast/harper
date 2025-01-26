import { addExtension, pack, unpack } from 'msgpackr';
import { stat, readFile, writeFile } from 'fs/promises';
import { createReadStream, createWriteStream, open, close, readFileSync, unlink, writeSync, read } from 'fs';
import { ensureDir } from 'fs-extra';
import { server } from '../server/Server';
import { get as envGet } from '../utility/environment/environmentManager';
import { CONFIG_PARAMS, getHdbBasePath, DATABASES_DIR_NAME } from '../utility/hdbTerms';
import { join } from 'path';

const FILE_STORAGE_THRESHOLD = 8192; // if the file is below this size, we will store it in memory, or within the record itself, otherwise we will store it in a file
// We want to keep the file path private (but accessible to the extension)
const storageInfoForBlob = new WeakMap();
let filePathEncodingEnabled = false; // only enable encoding of the file path if we are saving to the DB, not for serialization to external clients
export let blobsWereEncoded = false; // keep track of whether blobs were encoded with file paths
addExtension({
	Class: Blob,
	type: 11,
	unpack: function (buffer) {
		const data = unpack(buffer);
		if (data instanceof Array) {
			if (filePathEncodingEnabled) {
				const data = unpack(buffer);
				return new FileBackedBlob(data[0], data[1]);
			} else {
				server.getBlobFromStream;
			}
		} else {
			// this directly encoded as a buffer, so we can just return the buffer in a blob object
			buffer = new Uint8Array(buffer.buffer, 8);
			const blob = new Blob([buffer]);
			blob.buffer = buffer;
			return buffer;
		}
	},
	pack: function (blob) {
		const storageInfo = storageInfoForBlob.get(blob);
		if (storageInfo) {
			if (filePathEncodingEnabled) {
				blobsWereEncoded = true;
				REFERENCE_COUNT_VIEW.setUint32(4, ++storageInfo.referenceCount);
				writeSync(storageInfo.fd, REFERENCE_COUNT_BUFFER, 0);
				return pack([storageInfo.storageIndex, storageInfo.fileId, {}]);
			} else {
				// if we want to encode as binary (necessary for replication), we need to encode as a buffer, not sure if we should always do that
				// also, for replication, we would presume that this is most likely in OS cache, and sync will be fast. For other situations, a large sync call could be
				// unpleasant
				return readFileSync(filePath);
			}
		} else {
			return blob.buffer;
		}
	},
});

const fdRegistry = new FinalizationRegistry((fd: number) => {
	// cleanup the file descriptor when the blob is garbage collected
	close(fd);
});
// we can delete the file.
class FileBackedBlob extends Blob {
	constructor(options?: FilePropertyBag) {
		super([], options);
		storageInfoForBlob.set(this, {
			storageIndex: options?.storageIndex,
			fileId: options?.fileId,
			referenceCount: 1,
		});
	}
	async open(flags) {
		if (!blobStoragePaths) {
			// initialize paths if not already done
			blobStoragePaths = envGet(CONFIG_PARAMS.STORAGE_BLOBPATHS) || [
				join(
					process.env.STORAGE_PATH || envGet(CONFIG_PARAMS.STORAGE_PATH) || join(getHdbBasePath(), DATABASES_DIR_NAME),
					'blobs'
				),
			];
		}
		const storageInfo = storageInfoForBlob.get(this);
		const { storageIndex, fileId, fd } = storageInfo;
		if (fd) return fd;
		const blobStoragePath = blobStoragePaths[storageIndex];
		const fileDir = join(
			// create the file path, using the file id to create a directory structure in a 3-level deep format that won't create too many entries per directory
			blobStoragePath,
			fileId.slice(0, -6) || '0',
			fileId.slice(-6, -4) || '0',
			fileId.slice(-4, -2) || '0'
		);
		const filePath = join(fileDir, fileId.slice(-2));
		storageInfo.path = filePath;
		// ensure the directory structure exists
		await stat(fileDir).catch(() => ensureDir(fileDir));

		return new Promise((resolve, reject) => {
			open(filePath, flags, (error, fd) => {
				if (error) reject(error);
				else {
					storageInfo.fd = fd;
					fdRegistry.register(this, fd);
					resolve(fd);
				}
			});
		});
	}

	async text(): Promise<string> {
		return readFile(storageInfoForBlob.get(this), 'utf-8');
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		const fileContent = await readFile(storageInfoForBlob.get(this));
		return fileContent.buffer;
	}

	stream(): NodeJS.ReadableStream {
		return createReadStream(storageInfoForBlob.get(this));
	}
}

/**
 * Decrement the reference count for a blob and delete the file if the reference count reaches 0.
 * @param blob
 */
export function removeReferenceToBlob(blob: Blob): Promise<void> {
	return new Promise((resolve, reject) => {
		const storageInfo = storageInfoForBlob.get(blob);
		blob.open('rw').then((fd) => {
			if (error) reject(error);
			read(fd, { length: 8 }, (error, buffer) => {
				if (error) reject(error);
				storageInfo.referenceCount = new DataView(buffer).getUint32(4) - 1;
				if (storageInfo.referenceCount <= 0) {
					close(fd);
					unlink(storageInfo.filePath, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} else {
					REFERENCE_COUNT_VIEW.setUint32(4, storageInfo.referenceCount);
					writeSync(fd, REFERENCE_COUNT_BUFFER, 0);
					close(fd);
				}
			});
		});
	});
}
const STARTING_OFFSET = 8; // reserve 8 bytes for reference counting
const REFERENCE_COUNT_BUFFER = new Uint8Array(STARTING_OFFSET);
const REFERENCE_COUNT_VIEW = new DataView(REFERENCE_COUNT_BUFFER.buffer);
let blobStoragePaths: [];
/**
 * Create a blob from a readable stream or a buffer by creating a file in the blob storage path with a new unique internal id, that
 * can be saved/stored.
 * @param stream
 */
server.createBlob = function (source: NodeJS.ReadableStream | NodeJS.Buffer): Promise<Blob> {
	if (source instanceof Uint8Array) {
		return createBlobFromBuffer(source);
	} else {
		return createBlobFromStream(source);
	}
};
async function createBlobFromStream(stream: NodeJS.ReadableStream): Promise<Blob> {
	const [fd, blob] = await createBlobWithFile();
	return new Promise((resolve, reject) => {
		// TODO: If the data is below the threshold, we should just store it in memory
		// pipe the stream to the file
		const writeStream = createWriteStream(null, { fd, autoClose: false });
		REFERENCE_COUNT_VIEW.setUint32(4, 1); // set the reference count to 1
		writeStream.write(REFERENCE_COUNT_BUFFER); // write the starting buffer to the file to reserve room for reference counting
		stream
			.pipe(writeStream)
			.on('error', (error) => {
				const storageInfo = storageInfoForBlob.get(blob);
				unlink(storageInfo.path, () => {}); // if there's an error, delete the file
				reject(error); // if there's an error, reject the promise
			})
			.on('finish', () => {
				resolve(blob);
			});
	});
}
async function createBlobFromBuffer(buffer: NodeJS.Buffer): Promise<Blob> {
	const [fd, blob] = await createBlobWithFile();
	await writeFile(fd, buffer);
	return blob;
}
async function createBlobWithFile(): Promise<[number, Blob]> {
	const storageIndex = blobStoragePaths?.length > 1 ? Math.floor(blobStoragePaths.length * Math.random()) : 0;
	const fileId = getNextFileId().toString(16); // get the next file id

	const blob = new FileBackedBlob({ storageIndex, fileId });
	const fd = await blob.open('w');
	return [fd, blob];
}
let idIncrementer: BigInt64Array;
function getNextFileId(): number {
	// all threads will use a shared buffer to atomically increment the id
	// first, we create our proposed incrementer buffer that will be used if we are the first thread to get here
	// and initialize it with the starting id
	if (!idIncrementer) {
		const lastId = 1; // find the last file id
		idIncrementer = new BigInt64Array([BigInt(lastId) + 1n]);
		// now get the selected incrementer buffer, this is the shared buffer was first registered and that all threads will use
		idIncrementer = new BigInt64Array(
			databases.system.hdb_info.primaryStore.getUserSharedBuffer('blob-file-id', idIncrementer.buffer)
		);
	}
	return Number(Atomics.add(idIncrementer, 0, 1n));
}

export function encodeBlobsWithFilePath(callback, existingEntry) {
	filePathEncodingEnabled = true;
	blobsWereEncoded = false;
	if (existingEntry?.value) {
		removeBlobsInObject(existingEntry.value);
	}
	try {
		return callback();
	} finally {
		filePathEncodingEnabled = false;
	}
}
function removeBlobsInObject(obj) {
	if (obj instanceof Blob) {
		removeReferenceToBlob(obj);
	} else if (obj instanceof Object) {
		for (const key in obj) {
			removeBlobsInObject(obj[key]);
		}
	}
}
