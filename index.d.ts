export { Resource } from './resources/Resource.ts';
import { Resource as ResourceImport } from './resources/Resource.ts';
export { Query, Context, SubscriptionRequest } from './resources/ResourceInterface.ts';
export { server } from './server/Server.ts';
import { server as serverImport } from './server/Server.ts';
export { tables, databases } from './resources/databases.ts';
import { tables as dbTables, databases as dbDatabases } from './resources/databases.ts';
import { BlobCreationOptions } from './resources/blob.ts';
export { Scope } from './components/Scope.ts';
export type { FilesOption, FilesOptionObject } from './components/deriveGlobOptions.ts';
export type { FileAndURLPathConfig } from './components/Component.ts';
export { OptionsWatcher, type Config, type ConfigValue } from './components/OptionsWatcher.ts';
export {
	EntryHandler,
	type BaseEntry,
	type FileEntry,
	type EntryEvent,
	type AddFileEvent,
	type ChangeFileEvent,
	type UnlinkFileEvent,
	type FileEntryEvent,
	type AddDirectoryEvent,
	type UnlinkDirectoryEvent,
	type DirectoryEntryEvent,
} from './components/EntryHandler.ts';
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
