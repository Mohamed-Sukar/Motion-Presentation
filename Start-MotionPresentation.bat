@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================================
echo   Motion Presentation Studio - PC Desktop Application
echo ========================================================
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)
echo Building production bundle...
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed! Please review compilation errors above.
    pause
    exit /b 1
)
echo Starting Desktop Window...
call npx electron .

