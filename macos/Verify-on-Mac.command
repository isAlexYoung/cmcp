#!/bin/bash
set -euo pipefail
MCP_KIT="$(cd "$(dirname "$0")" && pwd -P)"
trap 'mcp_rc=$?; if [ "$mcp_rc" != 0 ]; then echo "检查失败，错误码：$mcp_rc"; fi; if [ -t 0 ]; then read -r -p "按回车关闭此窗口……" mcp_reply; fi' EXIT
source "$MCP_KIT/bootstrap.sh"
"$MCP_NODE" "$MCP_KIT/verify-mac.mjs"
