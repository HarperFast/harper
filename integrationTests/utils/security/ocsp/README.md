# OCSP Certificate Testing

This directory contains utilities for testing OCSP (Online Certificate Status Protocol) certificate verification in Harper.

## Quick Start for Integration Tests

The integration tests handle all setup automatically! Simply ensure Harper is configured for mTLS and run:

```bash
# Set required environment variables
export HDB_ADMIN_USERNAME=admin
export HDB_ADMIN_PASSWORD=password

# Run the OCSP tests
npm run test:integration -- --grep "OCSP"
```

Or in one line:

```bash
HDB_ADMIN_USERNAME=admin HDB_ADMIN_PASSWORD=password npm run test:integration -- --grep "OCSP"
```

The tests will:

- Generate test certificates if needed
- Start/stop the OCSP responder automatically
- Clean up when done (if CLEANUP_TEST_CERTS=true)

### Required Harper Configuration

Harper must be configured with mTLS enabled. Example configuration:

```yaml
  # Simple configuration with defaults
  http:
    securePort: 9926
    mtls: true  # Uses default certificate verification settings

  # Or with custom certificate verification settings
  http:
    securePort: 9926
    mtls:
      certificateVerification:
        timeout: 5000        # OCSP timeout in milliseconds (default: 5000)
        cacheTtl: 3600000    # Cache TTL for success in milliseconds (default: 1 hour)
        errorCacheTtl: 300000 # Cache TTL for errors in milliseconds (default: 5 minutes)
        failureMode: fail-open  # or fail-closed (default: fail-open)
```

## Manual Testing

### Prerequisites

**Harper must be running** before running the manual setup script. The setup script needs to update Harper's configuration file, so Harper needs to already be installed and running.

### Manual Setup Steps

1. **Setup test environment:**

   ```bash
   HDB_ADMIN_USERNAME=admin HDB_ADMIN_PASSWORD=password bash setup-ocsp-test.sh
   ```

   This generates test certificates and configures Harper for mTLS with OCSP verification. Harper will need to be restarted to pick up the new configuration.

2. **Start OCSP responder (separate terminal):**

   ```bash
   bash start-ocsp.sh
   ```

3. **Test OCSP verification:**

   ```bash
   node test-ocsp-manual.js
   ```

   Note: Use `test-ocsp-manual.js` for Ed25519 certificates. The `test-ocsp.sh` script may not work properly with Ed25519 keys depending on your curl/OpenSSL version.

## Expected Results

- **Valid certificate**: HTTP 200/404 (connection succeeds)
- **Revoked certificate**: Connection refused/reset (certificate rejected)

## Manual Testing with curl

```bash
# Test with valid certificate
curl --cert generated/client-valid-chain.crt \
     --key generated/client-valid.key \
     --cacert generated/harper-ca.crt \
     https://localhost:9926/

# Test with revoked certificate
curl --cert generated/client-revoked-chain.crt \
     --key generated/client-revoked.key \
     --cacert generated/harper-ca.crt \
     https://localhost:9926/
```

## Configuration

OCSP verification settings in `harperdb-config.yaml`:

```yaml
http:
  port: 9925
  securePort: 9926
  mtls:
    certificateVerification:
      timeout: 5000 # OCSP timeout (ms)
      cacheTtl: 3600000 # Cache TTL for success (ms) - 1 hour
      errorCacheTtl: 300000 # Cache TTL for errors (ms) - 5 minutes
      failureMode: fail-open # Allow on OCSP failure
```

## Generated Files

All certificates are generated using Ed25519 keys for improved security and performance.

- `harper-ca.crt` - Certificate Authority
- `server.crt/key` - Harper server certificate (Ed25519)
- `client-valid.crt` - Valid client certificate (Ed25519)
- `client-revoked.crt` - Revoked client certificate (Ed25519)
- `ocsp.crt` - OCSP responder certificate (Ed25519)
- `index.txt` - Certificate database for OCSP responder

## Troubleshooting

- If Harper isn't configured for mTLS, the test will fail with "connection refused"
- Check logs: `tail -f ~/hdb/log/hdb.log | grep cert-verification`
- The OCSP responder must be running for verification to work
- Ensure OpenSSL is installed and available in PATH
