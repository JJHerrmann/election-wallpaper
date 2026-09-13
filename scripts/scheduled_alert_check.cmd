@echo off
setlocal
set LOGFILE=%~dp0..\logs\alert_check_runs.log
echo [%date% %time%] Running news alert check >> "%LOGFILE%"
"C:\Program Files\nodejs\node.exe" "%~dp0check_news_alerts.js" >> "%LOGFILE%" 2>&1
echo [%date% %time%] Finished with exit code %ERRORLEVEL% >> "%LOGFILE%"
endlocal
