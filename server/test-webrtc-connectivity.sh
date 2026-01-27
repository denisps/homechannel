#!/bin/bash

# Run WebRTC connectivity tests
# Installs all optional WebRTC libraries before testing

echo "WebRTC Connectivity and Performance Tests"
echo "=========================================="
echo ""
echo "Installing optional WebRTC libraries..."
echo "(Some may fail to install - this is normal)"
npm install --no-save 2>&1 | grep -E "(added|removed|up to date|werift|wrtc|node-datachannel)" || true
echo ""

# Run the connectivity tests
node --test test/webrtc-connectivity.test.js

exit_code=$?

if [ $exit_code -eq 0 ]; then
    echo ""
    echo "✅ All connectivity tests passed!"
else
    echo ""
    echo "❌ Some tests failed (exit code: $exit_code)"
fi

exit $exit_code
