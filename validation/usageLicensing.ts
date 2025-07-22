import { createPublicKey, verify } from 'node:crypto';

const LICENSE_PUBLIC_KEYS = {
	production: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAMtpzMn9YfS0fGaDLcAmYQx2OH8kVevwbNyQ1RIj5cvw=
-----END PUBLIC KEY-----
`,
	development: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAO301jvpO12znGdK/Izrre518pgmQNk9hSMXf4wDMucM=
-----END PUBLIC KEY-----
`,
	test: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAO301jvpO12znGdK/Izrre518pgmQNk9hSMXf4wDMucM=
-----END PUBLIC KEY-----
`,
} as const;

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
	level: string;
	region: string;
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

export class InvalidBase64UrlEncodingError extends LicenseEncodingError {}

export class InvalidLicenseError extends TypeError {}

export class InvalidLicenseSignatureError extends InvalidLicenseError {}

export class InvalidHeaderError extends InvalidLicenseError {}

export class InvalidPayloadError extends InvalidLicenseError {}

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

	const pubKey = createPublicKey(LICENSE_PUBLIC_KEYS[process.env.NODE_ENV ?? 'development']);
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

function validateLicensePayload(payload: LicensePayload): void {
	const stringAttrs = ['id', 'level', 'region', 'expiration'];
	const numberAttrs = [
		'reads',
		'writes',
		'readBytes',
		'writeBytes',
		'realTimeMessages',
		'realTimeBytes',
		'cpuTime',
		'storage',
	];
	for (const attr of stringAttrs) {
		if (typeof payload[attr] !== 'string') {
			throw new InvalidPayloadError(`Invalid license payload; ${attr} must be a string; got: ${typeof payload[attr]}`);
		}
	}
	for (const attr of numberAttrs) {
		if (typeof payload[attr] !== 'number') {
			throw new InvalidPayloadError(`Invalid license payload; ${attr} must be a number; got: ${typeof payload[attr]}`);
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
