#!/bin/bash
set -euo pipefail

echo "=== Setting up cloud server environment for doubao-asr-cloud ==="

NODE_VERSION="v20.18.0"
NODE_DISTRO="linux-x64"
NODE_TARBALL="node-${NODE_VERSION}-${NODE_DISTRO}.tar.xz"
NODE_MIRROR="https://registry.npmmirror.com/-/binary/node/${NODE_VERSION}/${NODE_TARBALL}"

if command -v node &>/dev/null && node --version | grep -q "v2"; then
  echo "Node.js already installed: $(node --version)"
else
  echo "Installing Node.js ${NODE_VERSION} from npmmirror..."
  cd /tmp
  curl -fsSL -o "${NODE_TARBALL}" "${NODE_MIRROR}"
  tar -xJf "${NODE_TARBALL}" -C /usr/local --strip-components=1
  rm -f "${NODE_TARBALL}"
  echo "Node.js installed: $(node --version)"
fi

echo "npm version: $(npm --version)"

echo "Configuring npm mirror (npmmirror.com)..."
npm config set registry https://registry.npmmirror.com

if command -v pm2 &>/dev/null; then
  echo "PM2 already installed: $(pm2 --version)"
else
  echo "Installing PM2 globally..."
  npm install -g pm2 --loglevel=error
  echo "PM2 installed: $(pm2 --version)"
fi

mkdir -p /root/doubao-asr-cloud/logs
mkdir -p /root/doubao-asr-cloud/recordings

echo "=== Environment setup complete ==="
echo "Node.js: $(node --version)"
echo "npm: $(npm --version)"
echo "PM2: $(pm2 --version)"
