#!/data/data/com.termux/files/usr/bin/bash
# POSIX assistant launcher: run from a real terminal (Termux, Linux, macOS).
set -u
dir=$(cd "$(dirname "$0")" && pwd)
nodebin="${DSH_NODE_EXECUTABLE:-}"
if [ -z "$nodebin" ] || [ ! -x "$nodebin" ]; then
  nodebin=$(command -v node || true)
fi
if [ -z "$nodebin" ] || [ ! -x "$nodebin" ]; then
  echo "找不到 Node.js：请设置 DSH_NODE_EXECUTABLE，或把 node 放进 PATH。" >&2
  exit 1
fi
exec "$nodebin" "$dir/assistant.cjs"