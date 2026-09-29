/**
 * Type-contract test for the plugin-parity exports (#2715): a package-installed protocol plugin reaches
 * `registerShutdownDrain`, `verifyCertificate` and the deferred-authentication helpers through the
 * shipped `harper` declarations, typed, with the companion types importable by name.
 *
 * Run (after `npm run build`):  npm run test:types
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import {
	registerShutdownDrain,
	verifyCertificate,
	isCredentialRejection,
	assertNoDeferredCredentialRejection,
	getAuthenticationRejectedInPlace,
	getDeferredCredentialRejection,
	settleDeferredCredentialRejection,
	type ShutdownDrain,
	type PeerCertificate,
	type CertificateVerificationResult,
	type DeferredCredentialRejection,
} from '../../dist/index.js';

const drain: ShutdownDrain = {
	hasWork: () => false,
	drain: async (deadlineMs: number) => {},
};
const unregister: () => void = registerShutdownDrain(drain);
unregister();
// @ts-expect-error a drain implements both hooks
registerShutdownDrain({ hasWork: () => false });

declare const peerCertificate: PeerCertificate;
const verification: Promise<CertificateVerificationResult> = verifyCertificate(peerCertificate, {
	certificateVerification: { crl: { enabled: true } },
});
verifyCertificate(peerCertificate, true);
verifyCertificate(peerCertificate);
// @ts-expect-error the peer certificate is the TLS socket's object, not PEM text
verifyCertificate('-----BEGIN CERTIFICATE-----');

declare const request: unknown;
const rejected: boolean = isCredentialRejection(new Error('Login failed'));
const deferred: DeferredCredentialRejection | undefined = getDeferredCredentialRejection(request);
const inPlace: { status: number; message: string } | undefined = getAuthenticationRejectedInPlace(request);
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
