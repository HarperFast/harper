import { Socket } from 'net';

/**
 * This is the central interface by which we define entry points for different server protocol plugins to listen for
 * incoming connections and requests.
 * For now this is not exposed through the main 'harperdb' index entry point, as this should only be used through
 * plugins (not resource handlers).
 */
interface Server {
	socket?(listener: (socket: Socket) => void, options: ServerOptions): void;
	http?(listener: (request: Request, nextLayer: (request: Request) => Response) => void, options?: ServerOptions): void
	request?(listener: (request: Request, nextLayer: (request: Request) => Response) => void, options?: ServerOptions): void
	ws?(listener: (ws: WebSocket, request: Request, requestCompletion: Promise<any>) => any, options?: WebSocketOptions): void
}
interface ServerOptions {
	port?: number
	secure?: any
}
interface WebSocketOptions extends ServerOptions {
	subProtocol: string
}
export const server: Server = {};