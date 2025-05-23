import { Socket } from 'net';
import { _assignPackageExport } from '../globals.js';
import type { Value } from '../resources/analytics/write.ts';
import type { Resources } from '../resources/Resources.ts';

/**
 * This is the central interface by which we define entry points for different server protocol plugins to listen for
 * incoming connections and requests.
 */
export interface Server {
	socket?(listener: (socket: Socket) => void, options: ServerOptions): void;
	http?(listener: (request: Request, nextLayer: (request: Request) => Response) => void, options?: ServerOptions): void;
	request?(
		listener: (request: Request, nextLayer: (request: Request) => Response) => void,
		options?: ServerOptions
	): void;
	ws?(
		listener: (ws: WebSocket, request: Request, requestCompletion: Promise<any>) => any,
		options?: WebSocketOptions
	): void;
	contentTypes: Map<string, ContentTypeHandler>;
	getUser(username: string, password: string | null, request: Request): any;
	authenticateUser(username: string, password: string, request: Request): any;
	operation(operation: any, context: any, authorize?: boolean): Promise<any>;
	recordAnalytics(value: Value, metric: string, path?: string, method?: string, type?: string): void;
	nodes: string[];
	shards: Map<number, string[]>;
	hostname: string;
	resources: Resources;
}
export interface ServerOptions {
	port?: number;
	securePort?: number;
	isOperationsServer?: boolean;
}
interface WebSocketOptions extends ServerOptions {
	subProtocol: string;
}
export interface ContentTypeHandler {
	serialize(data: any): Buffer | string;
	serializeStream(data: any): Buffer | string;
	deserialize(data: any): Buffer | string;
	q: number;
}

export const server: Server = {};
_assignPackageExport('server', server);
