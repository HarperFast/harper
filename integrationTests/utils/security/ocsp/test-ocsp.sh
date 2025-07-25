#!/bin/bash

cd "$(dirname "$0")"

echo "=== OCSP Certificate Verification Test ==="
echo

# Test with valid certificate
echo "Testing VALID certificate:"
VALID_STATUS=$(curl --cert generated/client-valid-chain.crt \
                   --key generated/client-valid.key \
                   --cacert generated/harper-ca.crt \
                   https://localhost:9943/ -s -o /dev/null -w "%{http_code}")

if [ "$VALID_STATUS" = "404" ]; then
    echo "✓ Valid certificate accepted (HTTP $VALID_STATUS)"
else
    echo "✗ Valid certificate failed (HTTP $VALID_STATUS)"
fi

# Test with revoked certificate  
echo "Testing REVOKED certificate:"
REVOKED_STATUS=$(curl --cert generated/client-revoked-chain.crt \
                     --key generated/client-revoked.key \
                     --cacert generated/harper-ca.crt \
                     https://localhost:9943/ -s -o /dev/null -w "%{http_code}")

if [ "$REVOKED_STATUS" = "401" ]; then
    echo "✓ Revoked certificate rejected (HTTP $REVOKED_STATUS)"
else
    echo "✗ Revoked certificate not properly rejected (HTTP $REVOKED_STATUS)"
fi

echo
echo "Check logs: tail -f ~/hdb/log/hdb.log | grep cert-verification"