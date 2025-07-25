#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
CERT_DIR="$SCRIPT_DIR/generated"

# Check if generated directory exists
if [ ! -d "$CERT_DIR" ]; then
    echo "Error: Generated certificate directory not found."
    echo "Please run 'bash setup-ocsp-test.sh' first to generate certificates."
    exit 1
fi

cd "$CERT_DIR"

# Check if required files exist
if [ ! -f "index.txt" ] || [ ! -f "ocsp.crt" ] || [ ! -f "ocsp.key" ] || [ ! -f "harper-ca.crt" ]; then
    echo "Error: Required certificate files not found in $CERT_DIR"
    echo "Please run 'bash setup-ocsp-test.sh' first to generate certificates."
    exit 1
fi

echo "Starting OCSP responder on port 8888..."
# Create OCSP chain if it doesn't exist
if [ ! -f "ocsp-chain.crt" ]; then
    cat ocsp.crt harper-ca.crt > ocsp-chain.crt
fi
openssl ocsp -index index.txt -port 8888 -rsigner ocsp-chain.crt -rkey ocsp.key -CA harper-ca.crt -text
