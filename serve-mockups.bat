@echo off
REM Start the mockup preview server and open it in the default browser.
REM Double-click this file. Close the window to stop the server.

set "ROOT=%~dp0docs\design\mockups\v1"
set "PORT=8765"

echo.
echo ============================================================
echo  MediSlot mockup preview server
echo  Serving: %ROOT%
echo  URL:     http://localhost:%PORT%/imports/app/index.html
echo  Close this window to stop the server.
echo ============================================================
echo.

cd /d "%ROOT%" || (
  echo [ERROR] Could not enter %ROOT%
  pause
  exit /b 1
)

REM Try npx (Node). If Node isn't available, fall back to Python launcher.
where npx >nul 2>&1 && (
  start "" "http://localhost:%PORT%/imports/app/index.html"
  npx --yes serve -p %PORT% -L .
  goto :eof
)

where py >nul 2>&1 && (
  start "" "http://localhost:%PORT%/imports/app/index.html"
  py -3 -m http.server %PORT%
  goto :eof
)

where python >nul 2>&1 && (
  start "" "http://localhost:%PORT%/imports/app/index.html"
  python -m http.server %PORT%
  goto :eof
)

echo [ERROR] Neither npx (Node) nor Python was found on PATH.
echo Install Node.js from https://nodejs.org/ or Python from https://www.python.org/
pause
