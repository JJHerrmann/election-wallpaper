@echo off
setlocal
set LOGFILE=%~dp0..\logs\refresh.log
echo [%date% %time%] Starting scheduled refresh >> "%LOGFILE%"
"C:\Program Files\nodejs\node.exe" "%~dp0fetch_live_data.js" >> "%LOGFILE%" 2>&1
echo [%date% %time%] Finished with exit code %ERRORLEVEL% >> "%LOGFILE%"
endlocal
