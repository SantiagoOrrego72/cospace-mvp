@echo off
cd /d "%~dp0"
where python >nul 2>nul && (python servidor.py %*) || (py -3 servidor.py %*)
pause
