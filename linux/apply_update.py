#!/usr/bin/python3
"""Detached same-user installer; it never uses sudo or changes /opt/cmcp."""
import os
import sys
sys.dont_write_bytecode = True
from update_runtime import apply

if __name__ == '__main__':
    if os.getuid() == 0 or len(sys.argv) != 2:
        raise SystemExit('A normal-user update request is required')
    try:
        apply(sys.argv[1])
    except Exception:
        raise SystemExit('更新失败，原版本已保留或恢复。')
