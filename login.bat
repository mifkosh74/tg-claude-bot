@echo off
cd /d "%~dp0"
title Claude bot - authorization
echo This will open a browser to authorize the bot with your Claude subscription.
echo After approving, copy the code back here, then copy the printed token (sk-ant-oat01-...).
echo.
"node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe" setup-token
echo.
pause
