@echo off
cd /d "%~dp0"
echo ========================================================
echo   Configuracao M365 Exchange Online (ColdMail Engine)
echo ========================================================
echo.
echo Abrindo conexao com o Exchange Online...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\m365-setup.ps1"
echo.
pause
