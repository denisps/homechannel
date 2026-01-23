#!/bin/bash

# Run WebRTC connectivity tests
# This script only runs if at least one WebRTC library is installed

echo "WebRTC Connectivity and Performance Tests"
echo "=========================================="
echo ""
echo "This test suite requires at least one WebRTC library to be installed:"
echo "  - werift (recommended): npm install werift"
echo "  - wrtc: npm install wrtc"
echo "  - node-datachannel: npm install node-datachannel"
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
