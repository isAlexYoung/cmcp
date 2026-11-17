#!/usr/bin/python3
"""Stable system entry; select only a verified, newer user installation."""
import os
from pathlib import Path
import sys
sys.dont_write_bytecode = True
from update_runtime import active_root, state_directory

if __name__ == '__main__':
    if os.getuid() == 0:
        raise SystemExit('请以普通用户运行 CMCP，不要使用 sudo。')
    base = Path(__file__).resolve().parents[1]
    root = active_root(base, state_directory())
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    os.execv('/usr/bin/python3', ['/usr/bin/python3', '-B', str(root / 'linux/desktop.py'), *sys.argv[1:]])
