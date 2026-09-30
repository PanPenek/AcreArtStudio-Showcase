#!/usr/bin/env bash
# AiLabor Art Studio installer for macOS / Linux.
# Step 1 installs the app; step 2 (tools/setup.mjs) picks and downloads an AI model for LM Studio.
# ComfyUI is installed automatically on Windows only; setup.mjs prints the manual steps elsewhere.
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js LTS from https://nodejs.org first."; exit 1; }
npm install --no-fund --no-audit
node tools/setup.mjs "$@"
echo "Done. Start the app with: npm start"
