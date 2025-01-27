import { addExtension, pack, unpack } from 'msgpackr';
import { stat, readFile, writeFile } from 'fs/promises';
import {
	createReadStream,
	createWriteStream,
	open,
	close,
	readFileSync,
	unlink,
	writeSync,
	read,
	readdirSync,
	existsSync,
} from 'fs';
import { ensureDir } from 'fs-extra';
import { server } from '../server/Server';
import { get as envGet } from '../utility/environment/environmentManager';
import { CONFIG_PARAMS, getHdbBasePath, DATABASES_DIR_NAME } from '../utility/hdbTerms';
import { join, dirname } from 'path';

const FILE_STORAGE_THRESHOLD = 8192; // if the file is below this size, we will store it in memory, or within the record itself, otherwise we will store it in a file
// We want to keep the file path private (but accessible to the extension)
const storageInfoForBlob = new WeakMap();
let filePathEncodingId: number = 0; // only enable encoding of the file path if we are saving to the DB, not for serialization to external clients
export let blobsWereEncoded = false; // keep track of whether blobs were encoded with file paths
addExtension({
	Class: Blob,
	type: 11,
	unpack: function (buffer) {
		const data = unpack(buffer);
		if (data instanceof Array) {
			return new FileBackedBlob({
				storageIndex: data[0],
				fileId: data[1],
			});
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
			if (filePathEncodingId) {
				blobsWereEncoded = true;
				if (storageInfo.filePathEncodingId && storageInfo.filePathEncodingId !== filePathEncodingId) {
					//throw new Error('Cannot use the same blob in two different records');
				}
				storageInfo.filePathEncodingId = filePathEncodingId;
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
		});
	}

	async text(): Promise<string> {
		return readFile(getFilePath(storageInfoForBlob.get(this)), 'utf-8');
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		const fileContent = await readFile(getFilePath(storageInfoForBlob.get(this)));
		return fileContent.buffer;
	}

	stream(): NodeJS.ReadableStream {
		return createReadStream(getFilePath(storageInfoForBlob.get(this)));
	}
}

/**
 * Delete the file for the blob
 * @param blob
 */
export function deleteBlob(blob: Blob): Promise<void> {
	// do we even need to check for completion here?
	return new Promise((resolve, reject) => {
		const storageInfo = storageInfoForBlob.get(blob);
		setTimeout(() => {
			// TODO: we need to determine when any read transaction are done with the file, and then delete it, this is a hack to just give it some time for that
			unlink(storageInfo.filePath, (error) => {
				if (error) reject(error);
				else resolve();
			});
		}, 500);
	});
}
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
	const [filePath, blob] = await createBlobWithFile();
	return new Promise((resolve, reject) => {
		// TODO: If the data is below the threshold, we should just store it in memory
		// TODO: Implement compression
		// pipe the stream to the file
		const writeStream = createWriteStream(filePath);
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
function getFilePath(storageInfo: any): string {
	return join(
		blobStoragePaths[storageInfo.storageIndex],
		storageInfo.fileId.slice(0, -6) || '0',
		storageInfo.fileId.slice(-6, -4) || '0',
		storageInfo.fileId.slice(-4, -2) || '0',
		storageInfo.fileId.slice(-2)
	);
}
async function createBlobFromBuffer(buffer: NodeJS.Buffer): Promise<Blob> {
	const [filePath, blob] = await createBlobWithFile();
	await writeFile(filePath, buffer);
	return blob;
}
async function createBlobWithFile(): Promise<[string, Blob]> {
	if (!blobStoragePaths) {
		// initialize paths if not already done
		blobStoragePaths = envGet(CONFIG_PARAMS.STORAGE_BLOBPATHS) || [
			join(
				process.env.STORAGE_PATH || envGet(CONFIG_PARAMS.STORAGE_PATH) || join(getHdbBasePath(), DATABASES_DIR_NAME),
				'blobs'
			),
		];
	}
	const storageIndex = blobStoragePaths?.length > 1 ? Math.floor(blobStoragePaths.length * Math.random()) : 0;
	const fileId = getNextFileId().toString(16); // get the next file id
	const storageInfo = { storageIndex, fileId };
	const filePath = getFilePath(storageInfo);
	const fileDir = dirname(filePath);
	// ensure the directory structure exists
	await stat(fileDir).catch(() => ensureDir(fileDir));

	const blob = new FileBackedBlob({ storageIndex, fileId });
	return [filePath, blob];
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
			for (let i = 0; i < 4; i++) {
				lastId = lastId * 256;
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
export function encodeBlobsWithFilePath<T>(callback: () => T, encodingId: number, objectToClear?: any) {
	filePathEncodingId = encodingId;
	blobsWereEncoded = false;
	if (objectToClear) {
		deleteBlobsInObject(objectToClear);
	}
	try {
		return callback();
	} finally {
		filePathEncodingId = 0;
	}
}
export function deleteBlobsInObject(obj) {
	if (obj instanceof Blob) {
		deleteBlob(obj);
	} else if (obj.constructor === Object) {
		for (const key in obj) {
			deleteBlobsInObject(obj[key]);
		}
	}
}
