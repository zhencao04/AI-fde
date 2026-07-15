@echo off
cd /d C:\wwwroot\ai-fde-observer
C:\nodejs\node.exe --max-old-space-size=2048 dist\server\index.js
