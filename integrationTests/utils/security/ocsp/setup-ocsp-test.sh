#!/bin/bash

# OCSP Test Setup Script
# This script sets up everything needed to test OCSP certificate verification

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
CONFIG_FILE="/Users/nathan/hdb/harperdb-config.yaml"

echo "=== OCSP Test Setup ==="

# Clean up any existing generated files to ensure fresh certificates
echo "Cleaning up existing certificates..."
rm -rf "$SCRIPT_DIR/generated"/*

# Generate new certificates
echo "Generating fresh certificates..."
cd "$SCRIPT_DIR"
node generate-ocsp-certs.js

# 2. Update Harper config for mTLS and certificate verification
echo ""
echo "Checking Harper configuration..."

# Check if mTLS is configured
MTLS_CONFIGURED=false
CERT_VERIFICATION_CONFIGURED=false

if grep -q "mtls: true" "$CONFIG_FILE" && grep -q "securePort: 9943" "$CONFIG_FILE"; then
    MTLS_CONFIGURED=true
fi

if grep -q "certificateVerification:" "$CONFIG_FILE"; then
    CERT_VERIFICATION_CONFIGURED=true
fi

if [ "$MTLS_CONFIGURED" = false ] || [ "$CERT_VERIFICATION_CONFIGURED" = false ]; then
    echo "Updating Harper config..."
    # Backup config
    cp "$CONFIG_FILE" "$CONFIG_FILE.backup"
    
    if [ "$MTLS_CONFIGURED" = false ]; then
        echo "Configuring mTLS..."
        # Update HTTP section for mTLS
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            sed -i '' 's/securePort: null/securePort: 9943/' "$CONFIG_FILE"
            sed -i '' 's/mtls: false/mtls: true/' "$CONFIG_FILE"
        else
            # Linux
            sed -i 's/securePort: null/securePort: 9943/' "$CONFIG_FILE"
            sed -i 's/mtls: false/mtls: true/' "$CONFIG_FILE"
        fi
    fi
    
    if [ "$CERT_VERIFICATION_CONFIGURED" = false ]; then
        echo "Adding certificate verification config..."
        # Add certificate verification to http section
        # Find the line number of "http:" and the next section
        HTTP_LINE=$(grep -n "^http:" "$CONFIG_FILE" | cut -d: -f1)
        NEXT_SECTION_LINE=$(tail -n +$((HTTP_LINE + 1)) "$CONFIG_FILE" | grep -n "^[a-zA-Z]" | head -1 | cut -d: -f1)
        
        if [ -n "$NEXT_SECTION_LINE" ]; then
            INSERT_LINE=$((HTTP_LINE + NEXT_SECTION_LINE - 1))
        else
            INSERT_LINE=$(wc -l < "$CONFIG_FILE")
        fi
        
        # Create temporary file with certificate verification config
        cat > /tmp/cert_verify_config.txt << 'EOF'
  certificateVerification:
    timeout: 5000
    cacheTtl: 3600000
    failureMode: fail-open
EOF
        
        # Insert the config
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            sed -i '' "${INSERT_LINE}r /tmp/cert_verify_config.txt" "$CONFIG_FILE"
        else
            # Linux
            sed -i "${INSERT_LINE}r /tmp/cert_verify_config.txt" "$CONFIG_FILE"
        fi
        
        rm /tmp/cert_verify_config.txt
    fi
    
    echo "Config updated with mTLS and certificate verification. Harper restart required."
else
    echo "Harper already configured with mTLS and certificate verification."
fi

# 3. Show completion message
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "1. Restart Harper if config was changed"
echo "2. Start OCSP responder: bash start-ocsp.sh"
echo "3. Test with: bash test-ocsp.sh"