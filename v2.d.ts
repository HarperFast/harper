export { ResourceV2 as Resource } from './resources/ResourceV2.ts';
import { ResourceV2 as ResourceImport } from './resources/ResourceV2.ts';
export type {
	Context,
	Query,
	RequestTargetOrId,
	Session,
	SourceContext,
	SubscriptionRequest,
} from './resources/ResourceInterface.ts';
export { ResourceInterfaceV2 as ResourceInterface } from './resources/ResourceInterfaceV2.ts';
export type { User } from './security/user.ts';
export type { RecordObject } from './resources/RecordEncoder.ts';
export type { IterableEventQueue } from './resources/IterableEventQueue.ts';
export { RequestTarget } from './resources/RequestTarget.ts';
export { server } from './server/Server';
import { server as serverImport } from './server/Server.ts';
export { tables, databases } from './resources/databases.ts';
import { tables as dbTables, databases as dbDatabases } from './resources/databases.ts';
import { BlobCreationOptions } from './resources/blob.ts';
export type { Logger } from './components/Logger.ts';
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
