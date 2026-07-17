/**
 * Security Services Utilities for Integration Tests
 *
 * This module provides utilities for managing OCSP responders, CRL servers,
 * and certificate generation for security-related integration tests.
 *
 * All certificate generation and OCSP responding is done in pure Node.js
 * using webcrypto + pkijs — no openssl CLI dependency.
 */

import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { OcspCertificates } from './security/ocsp/generate-test-certs.ts';
import type { CrlCertificates } from './security/crl/generate-test-certs.ts';
import { startOcspServer, stopOcspServer } from './security/ocspServer.ts';

export interface OcspResponderContext {
	server: Server;
	port: number;
	certsPath: string;
	certs: OcspCertificates;
}

export interface CrlServerContext {
	server: Server;
	port: number;
	certsPath: string;
	certs: CrlCertificates;
}

/**
 * Stop an OCSP responder server
 */
export async function stopOcspResponder(ctx: OcspResponderContext): Promise<void> {
	return stopOcspServer(ctx.server);
}

/**
 * Start a Node.js HTTP server to serve CRL files
 */
export async function startCrlServer(
	certsPath: string,
	port: number,
	certs: CrlCertificates
): Promise<CrlServerContext> {
	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			if (req.url === '/test.crl') {
				try {
					const crl = readFileSync(join(certsPath, 'test.crl'));
					res.writeHead(200, {
						'Content-Type': 'application/pkix-crl',
						'Cache-Control': 'no-cache',
					});
					res.end(crl);
				} catch {
					res.writeHead(500);
					res.end('Internal Server Error');
				}
			} else if (req.url === '/health') {
				res.writeHead(200, { 'Content-Type': 'text/plain' });
				res.end('OK');
			} else {
				res.writeHead(404);
				res.end('Not Found');
			}
		});

		server.on('error', reject);

		server.listen(port, () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				reject(new Error('Server did not bind to a network port'));
				return;
			}
			resolve({
				server,
				port: address.port,
				certsPath,
				certs,
			});
		});
	});
}

/**
 * Stop a CRL server
 */
export async function stopCrlServer(ctx: CrlServerContext): Promise<void> {
	return new Promise((resolve) => {
		ctx.server.close(() => resolve());
	});
}

// Re-export certificate generation functions and types
export { generateOcspCertificates, type OcspCertificates } from './security/ocsp/generate-test-certs.ts';
export { generateCrlCertificates, type CrlCertificates } from './security/crl/generate-test-certs.ts';

/**
 * Setup CRL server with automatic port allocation and retry on conflict
 */
export async function setupCrlServerWithCerts(
	certsPath: string,
	hostname: string = '127.0.0.1',
	maxRetries: number = 5
): Promise<CrlServerContext> {
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const port = 50000 + Math.floor(Math.random() * 10000);

		try {
			const { generateCrlCertificates } = await import('./security/crl/generate-test-certs.ts');
			const certs = await generateCrlCertificates(certsPath, hostname, port);
			// await so EADDRINUSE from server.listen() lands in the catch and triggers retry
			// (matches setupOcspResponderWithCerts pattern)
			return await startCrlServer(certsPath, port, certs);
		} catch (error: any) {
			if (error.code === 'EADDRINUSE' && attempt < maxRetries - 1) {
				continue;
			}
			throw new Error(`Failed to setup CRL server after ${attempt + 1} attempts: ${error.message}`);
		}
	}
	throw new Error(`Failed to setup CRL server after ${maxRetries} attempts`);
}

/**
 * Setup OCSP responder with automatic port allocation and retry on conflict
 *
 * Generates certificates with OCSP URL embedded, then starts the Node.js
 * OCSP responder on the same port.
 */
export async function setupOcspResponderWithCerts(
	certsPath: string,
	hostname: string = '127.0.0.1',
	maxRetries: number = 5
): Promise<OcspResponderContext> {
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const port = 50000 + Math.floor(Math.random() * 10000);

		try {
			const { generateOcspCertificates } = await import('./security/ocsp/generate-test-certs.ts');
			const { files, serverCerts } = await generateOcspCertificates(certsPath, hostname, port);

			const server = await startOcspServer(port, serverCerts);

			return { server, port, certsPath, certs: files };
		} catch (error: any) {
			if (error.code === 'EADDRINUSE' && attempt < maxRetries - 1) {
				continue;
			}
			throw new Error(`Failed to setup OCSP responder after ${attempt + 1} attempts: ${error.message}`);
		}
	}
	throw new Error(`Failed to setup OCSP responder after ${maxRetries} attempts`);
}
