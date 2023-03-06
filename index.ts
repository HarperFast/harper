import { Resource } from './resources/Resource';
import { tables, databases } from './resources/database';
import { Socket } from 'net';
interface Server {
	socket?(listener: (socket: Socket) => void): void;
	http?(listener: (request: Request, nextLayer: (request: Request) => Response) => void): void
	request?(listener: (request: Request, nextLayer: (request: Request) => Response) => void): void
	ws?(listener: (ws: WebSocket, request: Request, requestCompletion: Promise<any>) => any): void
}
const server: Server = {};
export { Resource, tables, databases, server };
