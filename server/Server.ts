import { Socket } from 'net';
import { _assignPackageExport } from '../globals.js';
import type { Value } from '../resources/analytics/write.ts';
import type { Resources } from '../resources/Resources.ts';
import { OperationDefinition } from './serverHelpers/serverUtilities.ts';
import { Duplex } from 'stream';
import { Request } from './serverHelpers/Request.ts';

export type HttpListener = (request: Request, nextLayer: (request: Request) => Response) => void;
// based on `upgrade` event in Node.js http server: https://nodejs.org/docs/latest/api/http.html#event-upgrade-1
export type UpgradeListener = (
	request: Request,
	socket: Duplex,
	head: Buffer,
	nextLayer: (request: Request, socket: Duplex, head: Buffer) => Promise<void>
) => Promise<void>;
/**
 * This is the central interface by which we define entry points for different server protocol plugins to listen for
 * incoming connections and requests.
 */
export interface Server {
	socket?(listener: (socket: Socket) => void, options: ServerOptions): void;
	http?(listener: HttpListener, options?: HttpOptions): void;
	request?(listener: HttpListener, options?: HttpOptions): void;
	ws?(
		listener: (ws: WebSocket, request: Request, requestCompletion: Promise<any>) => any,
		options?: WebSocketOptions
	): void;
	upgrade?(listener: UpgradeListener, options?: UpgradeOptions): void;
	contentTypes: Map<string, ContentTypeHandler>;
	getUser(username: string, password: string | null, request: Request): any;
	authenticateUser(username: string, password: string, request: Request): any;
	operation(operation: any, context: any, authorize?: boolean): Promise<any>;
	registerOperation(operationDefinition: OperationDefinition): void;
	recordAnalytics(value: Value, metric: string, path?: string, method?: string, type?: string): void;
	nodes: Node[];
	shards: Map<number, string[]>;
	hostname: string;
	resources: Resources;
	replication: {
		getThisNodeId(auditStore: any): number;
		exportIdMapping(auditStore: any): any;
		getIdOfRemoteNode(remoteNodeName: string, auditStore: any): number;
		replicateOperation(operation: {
			replicated: boolean;
			[key: string]: any;
		}): Promise<{ message: string; replicated?: unknown[] }>;
		monitorNodeCAs(listener: () => void): void;
		sendOperationToNode(node: string, operation: any, options: any): Promise<any>;
	};
}
interface Node {
	name: string;
	shard: number;
	url: string;
}
export interface ServerOptions {
	port?: number;
	securePort?: number;
	mtls?: boolean;
	usageType?: string;
}
interface WebSocketOptions extends ServerOptions {
	subProtocol: string;
}
export interface UpgradeOptions {
	port?: number;
	securePort?: number;
	runFirst?: boolean;
}

export interface HttpOptions extends ServerOptions {
	runFirst?: boolean;
}
export interface ContentTypeHandler {
	serialize(data: any): Buffer | string;
	serializeStream(data: any): Buffer | string;
	deserialize(data: any): Buffer | string;
	q: number;
}

export const server: Server = {
	replication: {
		getThisNodeId() {
			return 0;
		},
		exportIdMapping() {
			return undefined;
		},
		replicateOperation(operation) {
			return operation.replicated
				? Promise.reject(new Error('Replication not implemented.'))
				: Promise.resolve({ message: '' });
		},
		monitorNodeCAs(_listener: () => void) {
			throw new Error('Replication not implemented.');
		},
		sendOperationToNode() {
			return Promise.reject(new Error('Replication not implemented.'));
		},
	},
};
_assignPackageExport('server', server);
