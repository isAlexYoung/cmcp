@echo off
rem Opens a Chinese window; no console output.
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0start.ps1"
