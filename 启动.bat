@echo off
setlocal
cd /d "%~dp0"
title ZangHan Translator - Web

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ not found. Install from https://nodejs.org and run again.
  pause
  exit /b 1
)

start "" http://127.0.0.1:5300
node server.js

pause
