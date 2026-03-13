import { Resource as ResourceImport } from './resources/Resource.ts';
import { server as serverImport } from './server/Server.ts';
import { tables as dbTables, databases as dbDatabases } from './resources/databases.ts';
import { BlobCreationOptions } from './resources/blob.ts';
import { Logger } from './utility/logging/logger.ts';

export { Resource } from './resources/Resource.ts';
export type {
	Query,
	Context,
	Session,
	SourceContext,
	SubscriptionRequest,
	RequestTargetOrId,
} from './resources/ResourceInterface.ts';
export { ResourceInterface } from './resources/ResourceInterface.ts';
export type { User } from './security/user.ts';
export type { RecordObject } from './resources/RecordEncoder.ts';
export type { IterableEventQueue } from './resources/IterableEventQueue.ts';
export { RequestTarget } from './resources/RequestTarget.ts';
export { server } from './server/Server';
export { tables, databases, type Table } from './resources/databases.ts';
export type { Attribute } from './resources/Table.ts';

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

declare const logger: Logger;
export { type Logger, logger };

declare global {
	const tables: typeof dbTables;
	const logger: Logger;
	const databases: typeof dbDatabases;
	const server: typeof serverImport;
	const Resource: typeof ResourceImport;
	const createBlob: (
		source: Uint8Array | NodeJS.ReadableStream | string | Iterable<Uint8Array> | AsyncIterator<Uint8Array>,
		options?: BlobCreationOptions
	) => Blob;
}
