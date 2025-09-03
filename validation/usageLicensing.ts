import { createPublicKey, verify } from 'node:crypto';
import * as env from '../utility/environment/environmentManager.js';
import * as terms from '../utility/hdbTerms.ts';

export class PublicKey {
	pem: string;

	constructor(mode?: string) {
		if (mode && (mode === 'test' || mode === 'development')) {
			this.pem = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAO301jvpO12znGdK/Izrre518pgmQNk9hSMXf4wDMucM=
-----END PUBLIC KEY-----
`;
		} else {
			this.pem = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAMtpzMn9YfS0fGaDLcAmYQx2OH8kVevwbNyQ1RIj5cvw=
-----END PUBLIC KEY-----
`;
		}
	}

	getKey() {
		return createPublicKey(this.pem);
	}

	toString() {
		return this.pem;
	}
}

interface DecodedLicense {
	header: string;
	payload: string;
	signature: string;
}

type HarperLicenseTyp = 'Harper-License';
type HarperLicenseAlg = 'EdDSA';

export interface LicenseHeader {
	typ: HarperLicenseTyp;
	alg: HarperLicenseAlg;
}

export interface LicensePayload {
	id: string;
	level: number;
	region?: string;
	reads: number;
	writes: number;
	readBytes: number;
	writeBytes: number;
	realTimeMessages: number;
	realTimeBytes: number;
	cpuTime: number;
	storage: number;
	expiration: string;
	autoRenew?: boolean;
}

export type ValidatedLicense = LicensePayload;

export class LicenseEncodingError extends TypeError {}

export class InvalidLicenseError extends TypeError {}

export class InvalidLicenseSignatureError extends InvalidLicenseError {}

export class InvalidHeaderError extends InvalidLicenseError {}

export class InvalidPayloadError extends InvalidLicenseError {}

export const publicKey = new PublicKey(env.get(terms.CONFIG_PARAMS.LICENSE_MODE));

function validateLicenseSignature(encodedLicense: string): DecodedLicense {
	if (typeof encodedLicense !== 'string') {
		throw new LicenseEncodingError(`License must be a string; received ${typeof encodedLicense}: ${encodedLicense}`);
	}
	let licenseComponents: string[];
	try {
		licenseComponents = encodedLicense.split('.');
	} catch (cause) {
		const error = new LicenseEncodingError(
			`Unable to split license into components; license must be a string with three dot-separated parts; got: ${encodedLicense}`
		);
		error.cause = cause;
		throw error;
	}

	if (licenseComponents.length !== 3) {
		throw new InvalidLicenseError(`License must have three dot-separated parts; got ${licenseComponents.length}`);
	}

	const [header, payload, signature] = licenseComponents;

	const pubKey = publicKey.getKey();
	const valid = verify(null, Buffer.from(header + '.' + payload, 'utf8'), pubKey, Buffer.from(signature, 'base64url'));
	if (!valid) {
		throw new InvalidLicenseSignatureError('License signature is invalid');
	}
	return {
		header: toJSON(header),
		payload: toJSON(payload),
		signature: toJSON(signature),
	};
	function toJSON(str: string): string {
		return Buffer.from(str, 'base64url').toString('utf8');
	}
}

function validateLicenseHeader(header: LicenseHeader): void {
	if (header?.typ !== 'Harper-License') {
		throw new InvalidHeaderError(`Invalid license header; typ must be 'Harper-License'; got: ${header?.typ}`);
	}
	if (header?.alg !== 'EdDSA') {
		throw new InvalidHeaderError(`Invalid license header; alg must be 'EdDSA'; got: ${header?.alg}`);
	}
}

type AttrSchema = { required: boolean; type: string };

function valid(schema: AttrSchema, value: any) {
	if (schema.required) {
		return typeof value === schema.type;
	}
	return typeof value === 'undefined' || typeof value === schema.type;
}

function validateLicensePayload(payload: LicensePayload): void {
	const attrs = {
		id: { required: true, type: 'string' },
		region: { required: false, type: 'string' },
		expiration: { required: true, type: 'string' },
		level: { required: true, type: 'number' },
		reads: { required: true, type: 'number' },
		writes: { required: true, type: 'number' },
		readBytes: { required: true, type: 'number' },
		writeBytes: { required: true, type: 'number' },
		realTimeMessages: { required: true, type: 'number' },
		realTimeBytes: { required: true, type: 'number' },
		cpuTime: { required: true, type: 'number' },
		storage: { required: true, type: 'number' },
		autoRenew: { required: false, type: 'boolean' },
	};
	for (const attr in attrs) {
		const { required, type } = attrs[attr];
		const attrDesc = required ? `required attribute '${attr}'` : `optional attribute '${attr}', when present,`;
		if (!valid(attrs[attr], payload[attr])) {
			throw new InvalidPayloadError(
				`Invalid license payload; ${attrDesc} must be a ${type}; got: ${typeof payload[attr]}`
			);
		}
	}
}

export function validateLicense(encodedLicense: string): ValidatedLicense {
	const { header: headerJSON, payload: payloadJSON } = validateLicenseSignature(encodedLicense);

	let header: LicenseHeader;
	try {
		header = JSON.parse(headerJSON);
	} catch (cause) {
		const error = new InvalidHeaderError();
		error.cause = cause;
		throw error;
	}

	validateLicenseHeader(header);

	let payload: LicensePayload;
	try {
		payload = JSON.parse(payloadJSON);
	} catch (cause) {
		const error = new InvalidPayloadError();
		error.cause = cause;
		throw error;
	}

	validateLicensePayload(payload);

	return payload;
}
