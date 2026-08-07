#!/bin/bash
# Start quiklip and print the address to open on your phone.
cd "$(dirname "$0")" || exit 1

command -v ffmpeg  >/dev/null || { echo "ffmpeg not found — brew install ffmpeg"; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe not found — brew install ffmpeg"; exit 1; }

exec node server.js "$@"
