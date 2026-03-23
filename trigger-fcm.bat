@echo off
setlocal

:: Edit these variables with your actual server URL and API key
set "SERVER_URL=http://localhost:3000"
set "API_KEY=change-this-key"

echo Triggering FCM wake-up manually...
curl -X POST "%SERVER_URL%/api/fcm-wake" -H "X-API-Key: %API_KEY%" -H "Content-Type: application/json"
echo.
echo.
pause
