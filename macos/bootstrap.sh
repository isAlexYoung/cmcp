#!/bin/bash
# macOS /bin/bash 3.2 compatible. Source only from launcher.sh.
set -euo pipefail
umask 077
export PATH='/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin'
unset NODE_OPTIONS NODE_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH LD_PRELOAD
if [ "$(/usr/bin/uname -s)" != Darwin ]; then
  echo '此程序只能在 macOS 上运行。' >&2; exit 1
fi
if [ "$(/usr/bin/id -u)" = 0 ]; then
  echo '请用普通用户运行，不要使用 sudo。' >&2; exit 1
fi
MCP_STATE="$HOME/Library/Application Support/ClaudeMcpMac"
for mcp_dir in "$HOME" "$HOME/Library" "$HOME/Library/Application Support" "$MCP_STATE" "$MCP_STATE/runtime"; do
  if [ -L "$mcp_dir" ]; then echo "拒绝符号链接目录：$mcp_dir" >&2; exit 1; fi
done
/bin/mkdir -p "$MCP_STATE/runtime"
if [ "$(/usr/bin/stat -f '%u' "$MCP_STATE")" != "$(/usr/bin/id -u)" ] || [ "$(/usr/bin/stat -f '%u' "$MCP_STATE/runtime")" != "$(/usr/bin/id -u)" ]; then
  echo '程序数据目录的所有者不正确。' >&2; exit 1
fi
/bin/chmod 700 "$MCP_STATE" "$MCP_STATE/runtime"
MCP_ARCH="$(/usr/bin/uname -m)"
case "$MCP_ARCH" in
  arm64) MCP_ARCHIVE='node-v22.23.3-darwin-arm64.tar.gz'; MCP_HASH='23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53' ;;
  x86_64) MCP_ARCHIVE='node-v22.23.3-darwin-x64.tar.gz'; MCP_HASH='8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8' ;;
  *) echo '仅支持 Intel x64 和 Apple Silicon Mac。' >&2; exit 1 ;;
esac
MCP_SOURCE="$MCP_KIT/runtime/$MCP_ARCHIVE"
MCP_ACTUAL="$(/usr/bin/shasum -a 256 "$MCP_SOURCE")"; MCP_ACTUAL="${MCP_ACTUAL%% *}"
if [ "$MCP_ACTUAL" != "$MCP_HASH" ]; then echo 'Node 运行环境校验失败，请重新解压完整压缩包。' >&2; exit 1; fi
MCP_NODE="$MCP_STATE/runtime/node-v22.23.3-$MCP_ARCH"
if [ -L "$MCP_NODE" ] || { [ -e "$MCP_NODE" ] && [ ! -f "$MCP_NODE" ]; }; then echo '不安全的运行环境路径。' >&2; exit 1; fi
mcp_prepare_node() (
  MCP_TEMP="$(/usr/bin/mktemp -d "$MCP_STATE/runtime/.extract.XXXXXXXX")"
  trap '/bin/rm -rf -- "$MCP_TEMP"' EXIT
  # Only extract the exact verified Node executable. No npm or external installer.
  /usr/bin/tar -xzf "$MCP_SOURCE" -C "$MCP_TEMP" --strip-components 2 "${MCP_ARCHIVE%.tar.gz}/bin/node"
  /bin/chmod 700 "$MCP_TEMP/node"
  # Do not replace the inode of a Node executable used by the running service.
  if [ -f "$MCP_NODE" ] && /usr/bin/cmp -s "$MCP_NODE" "$MCP_TEMP/node"; then :; else /bin/mv -f "$MCP_TEMP/node" "$MCP_NODE"; fi
)
mcp_prepare_node
