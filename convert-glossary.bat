@echo off
chcp 65001 >nul
rem 术语表 JSON 格式转换：把 JSON 文件拖到本 bat 图标上即可自动转换
if "%~1"=="" (
    echo.
    echo Usage: drag a glossary JSON file onto this .bat file to convert it.
    echo.
    pause
    exit /b 0
)
node "%~dp0convert-glossary.cjs" "%~1"
echo.
pause
