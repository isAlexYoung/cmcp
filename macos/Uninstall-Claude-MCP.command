#!/bin/bash
set -euo pipefail
exec /bin/bash "$(cd "$(dirname "$0")" && pwd -P)/launcher.sh" uninstall
