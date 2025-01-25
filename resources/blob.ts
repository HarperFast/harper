import { Encoder, addExtension, pack, unpack } from 'msgpackr';
import { readFile } from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { server } from '../server/Server';
// We want to keep the file path private (but accessible to the extension)
const filePaths = new WeakMap();
addExtension({
	Class: Blob,
	type: 11,
	unpack: function (buffer) {
		const data = unpack(buffer);
		return new FileFromPath(data[0], data[1]);
	},
	pack: function (instance) {
		return pack([filePaths.get(instance), {}]);
	},
});

class FileFromPath extends Blob {
	constructor(filePath: string, options?: FilePropertyBag) {
		super();
		filePaths.set(this, filePath);
	}

	async text(): Promise<string> {
		return readFile(filePaths.get(instance), 'utf-8');
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		const fileContent = await readFile(filePaths.get(instance));
		return fileContent.buffer;
	}

	stream(): NodeJS.ReadableStream {
		return createReadStream(filePaths.get(instance));
	}
}
server.getBlobFromStream = function (stream: NodeJS.ReadableStream): Promise<Blob> {
	const filePath = `/tmp/${Math.random().toString(32).slice(2)}`;
	createWriteStream(filePath).pipe(stream);
};
