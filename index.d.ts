export { Resource } from './resources/Resource';
import { Resource as ResourceImport } from './resources/Resource.ts';
export { Query, Context, SubscriptionRequest } from './resources/ResourceInterface';
export { server } from './server/Server';
import { server as serverImport } from './server/Server.ts';
export { tables, databases } from './resources/databases';
import { tables as dbTables, databases as dbDatabases } from './resources/databases.ts';
import { BlobCreationOptions } from './resources/blob.ts';
export { Scope } from './components/Scope.ts';
export { FilesOption, FilesOptionObject } from './components/deriveGlobOptions.ts';
export { FileAndURLPathConfig } from './components/Component.ts';
export { OptionsWatcher, Config, ConfigValue } from './components/OptionsWatcher.ts';
export {
	EntryHandler,
	BaseEntry,
	FileEntry,
	EntryEvent,
	AddFileEvent,
	ChangeFileEvent,
	UnlinkFileEvent,
	FileEntryEvent,
	AddDirectoryEvent,
	UnlinkDirectoryEvent,
	DirectoryEntryEvent } from './components/EntryHandler.ts';
declare global {
	const tables: typeof dbTables;
	const databases: typeof dbDatabases;
	const server: typeof serverImport;
	const Resource: typeof ResourceImport;
	const createBlob: (
		source: Uint8Array | NodeJS.ReadableStream | string | Iterable<Uint8Array> | AsyncIterator<Uint8Array>,
		options?: BlobCreationOptions
	) => Blob;
}
