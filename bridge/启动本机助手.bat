@echo off
rem 这个文件存的是 GBK（ANSI）编码，别用 UTF-8 编辑器另存。
cd /d "%~dp0"
rem 前台入口，主要用来看日志、排查问题。日常用上一层的「启动信息管家.bat」。
for /f "delims=" %%P in ('call "%~dp0pick_python.cmd"') do set "PY=%%P"
echo 用 %PY% 启动本机助手（关掉这个窗口即停止，或双击上一层的「停止本机助手.bat」）。
echo.
%PY% notice_bridge.py %*
echo.
echo 已退出。按任意键关闭窗口。
pause >nul
