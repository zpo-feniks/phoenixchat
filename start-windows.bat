@echo off
rem PhoenixChat launcher for Windows: starts local server and opens the app
cd /d "%~dp0"
start "" "http://localhost:8000"
powershell -NoProfile -ExecutionPolicy Bypass -File "serve.ps1" -Port 8000
