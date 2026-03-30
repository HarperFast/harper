---
id: certificate-verification
title: Certificate Verification
---

<!-- Source: versioned_docs/version-4.7/developers/security/certificate-verification.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (certificate revocation added) -->
<!-- Source: release-notes/v4-tucker/4.7.0.md (confirmed OCSP support added) -->

Added in: v4.5.0

Changed in: v4.7.0 (OCSP support added)

Certificate verification (also called certificate revocation checking) ensures that revoked certificates cannot be used for mTLS authentication, even if they are otherwise valid and trusted. This is a critical security control for environments where certificates may need to be revoked before their expiration date — due to compromise, employee departure, or other security concerns.

## Overview

When a client presents a certificate for mTLS authentication, Harper performs two levels of checks:

1. **Certificate Validation** (always performed by Node.js TLS):
   - Certificate signature is valid
   - Certificate is issued by a trusted CA
   - Certificate is within its validity period
   - Certificate chain is properly formed

2. **Certificate Revocation Checking** (optional, must be explicitly enabled):
   - Certificate has not been revoked by the issuing CA
   - Uses CRL and/or OCSP

Revocation checking is **disabled by default**.

## Revocation Checking Methods

### CRL (Certificate Revocation List)

A CRL is a digitally signed list of revoked certificates published by a Certificate Authority.

**Advantages:**

- Fast verification (cached locally)
- Works offline once downloaded
- Predictable bandwidth usage
- Good for high-volume verification
- No privacy concerns (no per-certificate queries)

**How it works:**

1. Harper downloads the CRL from the distribution point specified in the certificate.
2. The CRL is cached locally (24 hours by default).
3. Subsequent verifications check the cached CRL — very fast, no network requests.
4. The CRL is refreshed in the background before expiration.

**Configuration:**

```yaml
http:
  mtls:
    certificateVerification:
      crl:
        timeout: 10000 # 10 seconds to download CRL
        cacheTtl: 86400000 # Cache for 24 hours
        gracePeriod: 86400000 # 24 hour grace period after nextUpdate
        failureMode: fail-closed # Reject on CRL check failure
```

### OCSP (Online Certificate Status Protocol)

OCSP provides real-time certificate status checking by querying the CA's OCSP responder.

**Advantages:**

- Real-time revocation status
- Smaller response size than CRL
- Good for certificates without CRL distribution points
- Works when CRL is unavailable

**How it works:**

1. Harper sends a request to the OCSP responder specified in the certificate.
2. The responder returns the current status: good, revoked, or unknown.
3. The response is cached (1 hour by default for success, 5 minutes for errors).

**Configuration:**

```yaml
http:
  mtls:
    certificateVerification:
      ocsp:
        timeout: 5000 # 5 seconds for OCSP response
        cacheTtl: 3600000 # Cache successful responses for 1 hour
        errorCacheTtl: 300000 # Cache errors for 5 minutes
        failureMode: fail-closed # Reject on OCSP check failure
```

## Verification Strategy

Harper uses a **CRL-first strategy with OCSP fallback**:

1. **Check CRL** if available (fast; uses cached CRL; no network request if cached).
2. **Fall back to OCSP** if the certificate has no CRL distribution point, the CRL download fails, or the CRL is expired and cannot be refreshed.
3. **Apply failure mode** if both methods fail.

This provides the best balance of performance, reliability, and security.

## Configuration

### Enable with Defaults

```yaml
http:
  mtls:
    required: true
    certificateVerification: true
```

This enables CRL checking (10s timeout, 24h cache), OCSP checking (5s timeout, 1h cache), and fail-closed mode.

### Custom Configuration

```yaml
http:
  mtls:
    required: true
    certificateVerification:
      failureMode: fail-closed # Global setting
      crl:
        timeout: 15000 # 15 seconds for CRL download
        cacheTtl: 43200000 # Cache CRLs for 12 hours
        gracePeriod: 86400000 # 24 hour grace period
        failureMode: fail-closed # CRL-specific setting
      ocsp:
        timeout: 8000 # 8 seconds for OCSP response
        cacheTtl: 7200000 # Cache results for 2 hours
        errorCacheTtl: 600000 # Cache errors for 10 minutes
        failureMode: fail-closed # OCSP-specific setting
```

### CRL Only (No OCSP)

```yaml
http:
  mtls:
    certificateVerification:
      ocsp: false # Disable OCSP; CRL remains enabled
```

Only disable OCSP if all client certificates have CRL distribution points. Otherwise, certificates without CRL URLs won't be checked for revocation.

### OCSP Only (No CRL)

```yaml
http:
  mtls:
    certificateVerification:
      crl: false # Disable CRL; OCSP remains enabled
```

### Environment Variables

All settings can be configured via environment variables:

```bash
# Enable certificate verification
HTTP_MTLS_CERTIFICATEVERIFICATION=true

# Global failure mode
HTTP_MTLS_CERTIFICATEVERIFICATION_FAILUREMODE=fail-closed

# CRL settings
HTTP_MTLS_CERTIFICATEVERIFICATION_CRL=true
HTTP_MTLS_CERTIFICATEVERIFICATION_CRL_TIMEOUT=15000
HTTP_MTLS_CERTIFICATEVERIFICATION_CRL_CACHETTL=43200000
HTTP_MTLS_CERTIFICATEVERIFICATION_CRL_GRACEPERIOD=86400000
HTTP_MTLS_CERTIFICATEVERIFICATION_CRL_FAILUREMODE=fail-closed

# OCSP settings
HTTP_MTLS_CERTIFICATEVERIFICATION_OCSP=true
HTTP_MTLS_CERTIFICATEVERIFICATION_OCSP_TIMEOUT=8000
HTTP_MTLS_CERTIFICATEVERIFICATION_OCSP_CACHETTL=7200000
HTTP_MTLS_CERTIFICATEVERIFICATION_OCSP_ERRORCACHETTL=600000
HTTP_MTLS_CERTIFICATEVERIFICATION_OCSP_FAILUREMODE=fail-closed
```

For replication servers, use the `REPLICATION_` prefix instead of `HTTP_`.

## Failure Modes

### fail-closed (Recommended)

**Default behavior.** Rejects connections when verification fails due to network errors, timeouts, or other operational issues.

Use when:

- Security is paramount
- You can tolerate false positives (rejecting valid certificates due to CA unavailability)
- Your CA infrastructure is highly available
- You're in a zero-trust environment

```yaml
certificateVerification:
  failureMode: fail-closed
```

### fail-open

Allows connections when verification fails, but logs a warning. The connection is still rejected if the certificate is explicitly found to be revoked.

Use when:

- Availability is more important than perfect security
- Your CA infrastructure may be intermittently unavailable
- You have other compensating controls
- You're gradually rolling out certificate verification

```yaml
certificateVerification:
  failureMode: fail-open
```

**Important:** Invalid signatures on CRLs always result in rejection regardless of failure mode, as this indicates potential tampering.

## Performance Considerations

### CRL Performance

- **First verification**: Downloads CRL (10s timeout by default)
- **Subsequent verifications**: Instant (reads from cache)
- **Background refresh**: CRL is refreshed before expiration without blocking requests
- **Memory usage**: ~10–100KB per CRL depending on size
- **Network usage**: One download per CRL per `cacheTtl` period

### OCSP Performance

- **First verification**: OCSP query (5s timeout by default)
- **Subsequent verifications**: Reads from cache (1 hour default)
- **Memory usage**: Minimal (~1KB per cached response)
- **Network usage**: One query per unique certificate per `cacheTtl` period

### Optimization Tips

Increase CRL cache TTL for stable environments:

```yaml

...
crl:
  cacheTtl: 172800000 # 48 hours
```

Increase OCSP cache TTL for long-lived connections:

```yaml

...
ocsp:
  cacheTtl: 7200000 # 2 hours
```

Reduce grace period for tighter revocation enforcement:

```yaml

...
crl:
  gracePeriod: 0 # No grace period
```

## Production Best Practices

### High-Security Environments

```yaml
http:
  mtls:
    required: true
    certificateVerification:
      failureMode: fail-closed
      crl:
        timeout: 15000
        cacheTtl: 43200000 # 12 hours
        gracePeriod: 0 # No grace period for strict enforcement
      ocsp:
        timeout: 8000
        cacheTtl: 3600000 # 1 hour
```

### High-Availability Environments

```yaml
http:
  mtls:
    required: true
    certificateVerification:
      failureMode: fail-open # Prioritize availability
      crl:
        timeout: 5000
        cacheTtl: 86400000 # 24 hours
        gracePeriod: 86400000 # 24 hour grace period
      ocsp:
        timeout: 3000
        cacheTtl: 7200000 # 2 hours
```

### Performance-Critical Environments

```yaml
http:
  mtls:
    required: true
    certificateVerification:
      crl:
        cacheTtl: 172800000 # 48 hours
        gracePeriod: 86400000
      ocsp:
        cacheTtl: 7200000 # 2 hours
        errorCacheTtl: 600000
```

## Troubleshooting

### Connection Rejected: Certificate Verification Failed

**Cause:** Certificate was found to be revoked, or verification failed in fail-closed mode.

**Solutions:**

1. Check if the certificate is actually revoked in the CRL or OCSP responder.
2. Verify CA infrastructure is accessible.
3. Check timeout settings — increase if needed.
4. Temporarily switch to fail-open mode while investigating.

### High Latency on First Connection

**Cause:** CRL is being downloaded for the first time.

**Solutions:**

1. This is normal; only happens once per CRL per `cacheTtl` period.
2. Subsequent connections will be fast (cached CRL).
3. Increase CRL timeout if downloads are slow:
   ```yaml
   crl:
     timeout: 20000 # 20 seconds
   ```

### Frequent CRL Downloads

**Cause:** `cacheTtl` is too short, or the CRL's `nextUpdate` period is very short.

**Solutions:**

1. Increase `cacheTtl`:
   ```yaml
   crl:
     cacheTtl: 172800000 # 48 hours
   ```
2. Increase `gracePeriod` to allow using slightly expired CRLs.

### OCSP Responder Unavailable

**Cause:** OCSP responder is down or unreachable.

**Solutions:**

1. CRL will be used as fallback automatically.
2. Use fail-open mode to allow connections:
   ```yaml
   ocsp:
     failureMode: fail-open
   ```
3. Disable OCSP and rely on CRL only (ensure all certs have CRL URLs):
   ```yaml
   ocsp: false
   ```

### Network or Firewall Blocking Outbound Requests

**Cause:** Secure hosting environments often restrict outbound HTTP/HTTPS traffic. This prevents Harper from reaching CRL distribution points and OCSP responders.

**Symptoms:**

- Certificate verification timeouts in fail-closed mode
- Logs show connection failures to CRL/OCSP URLs
- First connection may succeed (no cached data), but subsequent connections fail after cache expires

**Solutions:**

1. **Allow outbound traffic to CA infrastructure** (recommended):
   - Whitelist CRL distribution point URLs from your certificates
   - Whitelist OCSP responder URLs from your certificates
   - Example for Let's Encrypt: allow `http://x1.c.lencr.org/` and `http://ocsp.int-x3.letsencrypt.org/`

2. **Use fail-open mode:**

   ```yaml
   certificateVerification:
     failureMode: fail-open
   ```

3. **Set up an internal CRL mirror/proxy:**

   ```yaml
   certificateVerification:
     crl:
       cacheTtl: 172800000 # 48 hours
     ocsp: false
   ```

4. **Disable verification** (if you have alternative security controls):
   ```yaml
   certificateVerification: false
   ```

## Security Considerations

Enable certificate verification when:

- Certificates have long validity periods (> 1 day)
- You need immediate revocation capability
- Compliance requires revocation checking (PCI DSS, HIPAA, etc.)
- You're in a zero-trust security model
- Client certificates are used for API authentication

Consider skipping it when:

- Certificates have very short validity periods (< 24 hours)
- You rotate certificates automatically (e.g., with cert-manager)
- You have alternative revocation mechanisms
- Your CA doesn't publish CRLs or support OCSP

Certificate verification is one layer of security. Also consider: short certificate validity periods, certificate pinning, network segmentation, access logging, and regular certificate rotation.

## Replication

Certificate verification works identically for replication servers. Use the `replication.mtls` configuration:

```yaml
replication:
  hostname: server-one
  routes:
    - server-two
  mtls:
    certificateVerification: true
```

mTLS is always required for replication and cannot be disabled. This configuration only controls whether certificate revocation checking is performed.

For complete replication configuration, see [Replication Configuration](../replication/clustering.md).
