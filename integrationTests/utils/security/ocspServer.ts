/**
 * Node.js OCSP (Online Certificate Status Protocol) responder
 *
 * A pure-Node.js replacement for `openssl ocsp`. Handles OCSP requests using pkijs
 * for ASN.1 encoding and certGenUtils for Ed25519 signatures.
 */

import { createServer, type Server } from 'node:http';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { signBasicOCSPResponse } from './certGenUtils.js';
import type { OcspServerCerts } from './ocsp/generate-test-certs.js';

const OCSP_BASIC_RESPONSE_OID = '1.3.6.1.5.5.7.48.1.1';

/**
 * Build a DER-encoded OCSPResponse for the given DER-encoded OCSPRequest.
 */
async function buildOcspResponse(requestBody: Buffer, certs: OcspServerCerts): Promise<Buffer> {
	// Parse incoming OCSP request
	const asn1 = asn1js.fromBER(requestBody);
	if (asn1.offset === -1) {
		throw new Error('Failed to parse OCSP request');
	}
	const ocspRequest = new pkijs.OCSPRequest({ schema: asn1.result });

	const now = new Date();
	const nextUpdate = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour

	// Build SingleResponse for each requested certificate
	const singleResponses = ocspRequest.tbsRequest.requestList.map((req) => {
		// Extract the decimal serial number to look up status
		const serialDec = req.reqCert.serialNumber.valueBlock.valueDec;
		const status = certs.statusMap.get(String(serialDec));

		// certStatus ASN.1 encoding:
		//   good    [0] IMPLICIT NULL
		//   revoked [1] IMPLICIT RevokedInfo (SEQUENCE with revocation time)
		//   unknown [2] IMPLICIT UnknownInfo
		let certStatus: asn1js.PrimitiveStringValueBlock | asn1js.Constructed;
		if (status === 'good') {
			certStatus = new asn1js.Primitive({
				idBlock: { tagClass: 3, tagNumber: 0 },
				valueHex: new ArrayBuffer(0),
			} as any);
		} else if (status === 'revoked') {
			certStatus = new asn1js.Constructed({
				idBlock: { tagClass: 3, tagNumber: 1 },
				value: [new asn1js.GeneralizedTime({ valueDate: now })],
			} as any);
		} else {
			// unknown
			certStatus = new asn1js.Primitive({
				idBlock: { tagClass: 3, tagNumber: 2 },
				valueHex: new ArrayBuffer(0),
			} as any);
		}

		return new pkijs.SingleResponse({
			certID: req.reqCert, // echo back the same certID
			certStatus,
			thisUpdate: now,
			nextUpdate,
		});
	});

	// Use the OCSP responder cert's subject as the responderID (byName, tagNumber=1)
	const responseData = new pkijs.ResponseData({
		responderID: certs.ocspCert.subject,
		producedAt: now,
		responses: singleResponses,
	});

	// Create BasicOCSPResponse and sign it
	const basicResponse = new pkijs.BasicOCSPResponse({
		tbsResponseData: responseData,
		certs: [certs.ocspCert, certs.caCert],
	});

	await signBasicOCSPResponse(basicResponse, certs.ocspKeyPair.privateKey);

	// Encode BasicOCSPResponse to DER, wrap in OCSPResponse
	const basicDer = basicResponse.toSchema().toBER();

	const ocspResponse = new pkijs.OCSPResponse({
		responseStatus: new asn1js.Enumerated({ value: 0 }), // successful
		responseBytes: new pkijs.ResponseBytes({
			responseType: OCSP_BASIC_RESPONSE_OID,
			response: new asn1js.OctetString({ valueHex: basicDer }),
		}),
	});

	return Buffer.from(ocspResponse.toSchema().toBER());
}

/**
 * Start a Node.js HTTP OCSP responder.
 *
 * @param port - Port to listen on
 * @param certs - In-memory certificate and key data for the responder
 * @returns Promise resolving to the HTTP server (already listening)
 */
export async function startOcspServer(port: number, certs: OcspServerCerts): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			if (req.method !== 'POST' && req.method !== 'GET') {
				res.writeHead(405);
				res.end();
				return;
			}

			const chunks: Buffer[] = [];
			req.on('data', (chunk) => chunks.push(chunk));
			req.on('end', async () => {
				try {
					const body = Buffer.concat(chunks);
					const response = await buildOcspResponse(body, certs);
					res.writeHead(200, { 'Content-Type': 'application/ocsp-response' });
					res.end(response);
				} catch (err) {
					console.error('OCSP server error:', err);
					// Return an "internalError" response
					const errResponse = new pkijs.OCSPResponse({
						responseStatus: new asn1js.Enumerated({ value: 2 }), // internalError
					});
					const errDer = Buffer.from(errResponse.toSchema().toBER());
					res.writeHead(200, { 'Content-Type': 'application/ocsp-response' });
					res.end(errDer);
				}
			});
			req.on('error', (err) => {
				console.error('OCSP request error:', err);
				res.writeHead(500);
				res.end();
			});
		});

		server.on('error', reject);
		server.listen(port, '127.0.0.1', () => resolve(server));
	});
}

/** Stop a running OCSP server */
export async function stopOcspServer(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}
