#!/usr/bin/env node

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Parse command line arguments
let PORT = 8889;
let CERTS_PATH = path.join(__dirname, 'generated');

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--port' && i + 1 < args.length) {
		PORT = parseInt(args[i + 1], 10);
	} else if (args[i] === '--certs-path' && i + 1 < args.length) {
		CERTS_PATH = args[i + 1];
	}
}

const CRL_FILE = path.join(CERTS_PATH, 'test.crl');

const server = http.createServer((req, res) => {
	console.log(`CRL Server: ${req.method} ${req.url}`);

	if (req.url === '/test.crl') {
		try {
			const crlData = fs.readFileSync(CRL_FILE);
			res.writeHead(200, {
				'Content-Type': 'application/pkix-crl',
				'Content-Length': crlData.length,
			});
			res.end(crlData);
		} catch (error) {
			console.error('Error serving CRL:', error);
			res.writeHead(404);
			res.end('CRL not found');
		}
	} else if (req.url === '/health') {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end('CRL Server OK');
	} else {
		res.writeHead(404);
		res.end('Not found');
	}
});

// Check if CRL file exists
if (!fs.existsSync(CRL_FILE)) {
	console.error(`Error: CRL file not found at ${CRL_FILE}`);
	console.error('Please ensure test certificates have been generated.');
	process.exit(1);
}

server.listen(PORT, () => {
	console.log(`CRL server listening on port ${PORT}`);
	console.log(`Serving CRL from: ${CRL_FILE}`);
	console.log(`CRL URL: http://localhost:${PORT}/test.crl`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
	console.log('Shutting down CRL server...');
	server.close(() => {
		process.exit(0);
	});
});

process.on('SIGINT', () => {
	console.log('Shutting down CRL server...');
	server.close(() => {
		process.exit(0);
	});
});
