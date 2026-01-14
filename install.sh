#!/bin/bash

# Vexira VPN Agent Installation Script

set -e

echo "🚀 Vexira VPN Agent Installation Script"
echo "========================================"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed"
    echo "Please install Node.js 14+ first:"
    echo "  Ubuntu/Debian: sudo apt install nodejs npm"
    echo "  CentOS/RHEL: sudo yum install nodejs npm"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 14 ]; then
    echo "❌ Error: Node.js version 14+ is required (current: $(node -v))"
    exit 1
fi

echo "✅ Node.js version: $(node -v)"
echo ""

# Check if WireGuard is installed
if ! command -v wg &> /dev/null; then
    echo "⚠️  Warning: WireGuard (wg) command not found"
    echo "Please install WireGuard:"
    echo "  Ubuntu/Debian: sudo apt install wireguard"
    echo "  CentOS/RHEL: sudo yum install wireguard-tools"
    echo ""
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

echo ""
echo "✅ Installation complete!"
echo ""
echo "Next steps:"
echo "1. Configure environment variables:"
echo "   export BACKEND_URL=\"http://your-backend:5000\""
echo "   export SERVER_ID=\"your-server-id-from-mongodb\""
echo ""
echo "2. Test the agent:"
echo "   npm start"
echo ""
echo "3. Install as systemd service (optional):"
echo "   See README.md for systemd service configuration"
echo ""

