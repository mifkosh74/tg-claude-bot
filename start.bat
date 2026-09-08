@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Claude Telegram Bot
:loop
node bot.js
echo.
echo Bot stopped. Restarting in 5 seconds... (close window to quit)
timeout /t 5 /nobreak >nul
goto loop
