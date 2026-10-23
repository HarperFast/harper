/**
 * Asserts the SHIPPED declarations (imported from the build output, so this strict tsconfig checks the
 * declaration surface rather than the repo graph). Run after `npm run build`: npm run test:types
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import {
	verifyCertificate,
	credentialRejectionError,
	assertNoDeferredCredentialRejection,
	settleDeferredCredentialRejection,
	type PeerCertificate,
	type CertificateVerificationResult,
	type CredentialRejection,
	type DeferredCredentialRejection,
	type AuthenticationRejectedInPlace,
} from '../../dist/index.js';

declare const peerCertificate: PeerCertificate;
const verification: Promise<CertificateVerificationResult> = verifyCertificate(peerCertificate, {
	certificateVerification: { crl: { enabled: true } },
});
verifyCertificate(peerCertificate, true);
verifyCertificate(peerCertificate);
// @ts-expect-error the peer certificate is the TLS socket's object, not PEM text
verifyCertificate('-----BEGIN CERTIFICATE-----');

const tagged: CredentialRejection = credentialRejectionError('Login failed', 401);
const rejected: true = tagged.credentialRejection;
// @ts-expect-error the rejection tag is read-only
tagged.credentialRejection = true;

declare const request: {
	deferredCredentialRejection?: DeferredCredentialRejection;
	authenticationRejectedInPlace?: AuthenticationRejectedInPlace;
};
const deferred = request.deferredCredentialRejection;
const inPlace: { status: number; message: string } | undefined = request.authenticationRejectedInPlace;
assertNoDeferredCredentialRejection(request);
const settled = settleDeferredCredentialRejection(request);
if (settled) {
	const status: number = settled.status;
	const body: string | Buffer = settled.body;
}
if (deferred) {
	const strategy: string = deferred.strategy;
	// @ts-expect-error the deferred record is immutable
	deferred.status = 403;
}
