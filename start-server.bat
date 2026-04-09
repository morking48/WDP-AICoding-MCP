@echo off
chcp 65001 >nul
echo 🚀 启动 WDP MCP 服务器（局域网模式）...
echo.

set KNOWLEDGE_BASE_PATH=D:/WorkFiles_Codex/WDP_AIcoding/skills
set PORT=3000
set HOST=0.0.0.0
set VALID_TOKENS=local-token:本地测试
set ADMIN_TOKEN=admin-local

echo 📚 知识库路径: %KNOWLEDGE_BASE_PATH%
echo 📡 服务端口: %PORT%
echo 🌐 监听地址: %HOST%
echo.

echo 🔨 检查并编译 TypeScript...
call npm run build
if %errorlevel% neq 0 (
    echo ❌ 编译失败，请检查错误信息
    pause
    exit /b 1
)
echo ✅ 编译完成
echo.

echo 🚀 启动服务器...
node dist/server.js

pause
