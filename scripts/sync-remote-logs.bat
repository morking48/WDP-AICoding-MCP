@echo off
chcp 65001 >nul
echo ==========================================
echo WDP 知识引擎 - 远程日志同步工具
echo ==========================================
echo.

REM 配置变量
set REMOTE_HOST=code.51aes.com
set REMOTE_USER=root
set REMOTE_LOGS_PATH=/opt/wdp-mcp-server/mcp-knowledge-server/logs
set REMOTE_DB_PATH=/opt/wdp-mcp-server/mcp-knowledge-server/data/logs.db
set LOCAL_LOGS_DIR=D:\WorkFiles_Codex\mcp-knowledge-server\remote-logs
set LOCAL_DB_DIR=D:\WorkFiles_Codex\mcp-knowledge-server\remote-data

REM 创建本地目录
if not exist "%LOCAL_LOGS_DIR%" mkdir "%LOCAL_LOGS_DIR%"
if not exist "%LOCAL_DB_DIR%" mkdir "%LOCAL_DB_DIR%"

echo [1/3] 正在同步日志文件...
scp -r %REMOTE_USER%@%REMOTE_HOST%:%REMOTE_LOGS_PATH%/* "%LOCAL_LOGS_DIR%/"
if %errorlevel% neq 0 (
    echo [错误] 日志同步失败，请检查SSH连接
    pause
    exit /b 1
)

echo [2/3] 正在同步数据库文件...
scp %REMOTE_USER%@%REMOTE_HOST%:%REMOTE_DB_PATH% "%LOCAL_DB_DIR%/logs.db"
if %errorlevel% neq 0 (
    echo [警告] 数据库同步失败，可能服务器未启用SQLite
) else (
    echo [成功] 数据库同步完成
)

echo [3/3] 同步完成！
echo.
echo 本地日志位置: %LOCAL_LOGS_DIR%
echo 本地数据库位置: %LOCAL_DB_DIR%
echo.
echo 同步时间: %date% %time%
echo ==========================================

pause
