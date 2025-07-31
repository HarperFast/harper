#!/usr/bin/env node

const crypto = require('crypto');

// Check if stdin is a terminal (no input piped)
if (process.stdin.isTTY) {
	console.log(`This utility converts OpenSSH format Ed25519 keys (public and private) into PEM format keys that node:crypto can use (specifically as args to createPublicKey and createPrivateKey).

Usage:

./keyConverter.js < public-or-private.key

It will output the converted key to stdout.`);
	process.exit(0);
}

// Read SSH Ed25519 key from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
	const trimmedInput = input.trim();

	if (trimmedInput.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')) {
		// Handle OpenSSH private key format
		try {
			// Parse OpenSSH format manually to extract Ed25519 private key
			const lines = trimmedInput.split('\n');
			const base64Content = lines.slice(1, -2).join('');
			const keyBuffer = Buffer.from(base64Content, 'base64');

			let offset = 0;

			// Skip AUTH_MAGIC (15 bytes)
			offset += 15;

			// Skip ciphername
			const cipherLen = keyBuffer.readUInt32BE(offset);
			offset += 4 + cipherLen;

			// Skip kdfname
			const kdfLen = keyBuffer.readUInt32BE(offset);
			offset += 4 + kdfLen;

			// Skip kdf options
			const kdfOptsLen = keyBuffer.readUInt32BE(offset);
			offset += 4 + kdfOptsLen;

			// Skip number of keys
			offset += 4;

			// Skip public key
			const pubKeyLen = keyBuffer.readUInt32BE(offset);
			offset += 4 + pubKeyLen;

			// Read private key section
			const privSectionLen = keyBuffer.readUInt32BE(offset);
			offset += 4;
			const privSection = keyBuffer.slice(offset, offset + privSectionLen);

			// Parse private section
			let privOffset = 8; // Skip check values

			// Skip private key type
			const privKeyTypeLen = privSection.readUInt32BE(privOffset);
			privOffset += 4;
			const privKeyType = privSection.slice(privOffset, privOffset + privKeyTypeLen).toString();
			privOffset += privKeyTypeLen;

			if (privKeyType !== 'ssh-ed25519') {
				throw new Error('Only Ed25519 keys are supported');
			}

			// Skip public key in private section
			const privPubKeyLen = privSection.readUInt32BE(privOffset);
			privOffset += 4 + privPubKeyLen;

			// Read private key data
			const privKeyDataLen = privSection.readUInt32BE(privOffset);
			privOffset += 4;
			const privKeyData = privSection.slice(privOffset, privOffset + privKeyDataLen);

			// Extract the 32-byte private key
			const privateKeyBytes = privKeyData.slice(0, 32);

			// Create PKCS8 DER structure for Ed25519
			const oid = Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]); // OID for Ed25519
			const innerOctetString = Buffer.concat([Buffer.from([0x04, 0x20]), privateKeyBytes]);
			const outerOctetString = Buffer.concat([Buffer.from([0x04, 0x22]), innerOctetString]);
			const algorithmSeq = Buffer.concat([Buffer.from([0x30, 0x05]), oid]);
			const version = Buffer.from([0x02, 0x01, 0x00]); // INTEGER 0

			const totalLen = version.length + algorithmSeq.length + outerOctetString.length;
			const pkcs8Der = Buffer.concat([
				Buffer.from([0x30, totalLen]), // SEQUENCE
				version,
				algorithmSeq,
				outerOctetString,
			]);

			// Create key object from DER
			const keyObject = crypto.createPrivateKey({
				key: pkcs8Der,
				format: 'der',
				type: 'pkcs8',
			});

			// Export as PEM
			const pkcs8Key = keyObject.export({
				format: 'pem',
				type: 'pkcs8',
			});

			console.log(pkcs8Key);
		} catch (error) {
			console.error('Error converting OpenSSH private key:', error.message);
		}
	} else if (trimmedInput.startsWith('ssh-ed25519')) {
		// Handle SSH public key format
		const sshKey = trimmedInput.split(' ')[1];

		// Decode base64
		const keyBuffer = Buffer.from(sshKey, 'base64');

		// Extract the 32-byte Ed25519 public key (skip SSH format header)
		const publicKeyBytes = keyBuffer.slice(19, 51);

		// Create the DER format for Ed25519 public key
		// OID for Ed25519: 1.3.101.112
		const oid = Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
		const derKey = Buffer.concat([oid, publicKeyBytes]);

		// Create KeyObject from DER
		const keyObject = crypto.createPublicKey({
			key: derKey,
			format: 'der',
			type: 'spki',
		});

		// Export as PEM
		const pem = keyObject.export({
			format: 'pem',
			type: 'spki',
		});

		console.log(pem);
	} else {
		console.error('Unsupported key format. Expected OpenSSH private key or ssh-ed25519 public key.');
	}
});
