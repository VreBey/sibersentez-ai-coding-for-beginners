@echo off
rem SiberSentez developer launcher: runs the panel server in this console window and opens it in the browser.
rem End users run the installed SiberSentez program (SiberSentez-Setup.exe); in development "npm start" opens the Electron window.
rem Port and hub folder: SIBERSENTEZ_PORT / SIBERSENTEZ_HUB environment variables, else sibersentez.json, else defaults (port 4545).
rem If the panel is already running this only opens the browser. Closing this window stops the server.
rem NOTE: this file is deliberately ASCII only; cmd misreads UTF-8 characters and breaks lines.
title SiberSentez (developer)
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js not found: https://nodejs.org & pause & exit /b 1)
node "%~dp0server\index.mjs" --open
if errorlevel 1 pause
