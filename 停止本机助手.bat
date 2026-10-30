@echo off
rem 这个文件存的是 GBK（ANSI）编码，别用 UTF-8 编辑器另存。
rem 通知本机助手自己退出：走 /quit，不用 taskkill，端口能干净释放。
curl -s -f -X POST -m 3 http://127.0.0.1:8787/quit >nul 2>nul
if errorlevel 1 (
  echo 本机助手没在运行。
) else (
  echo 已停止本机助手。
)
ping -n 3 127.0.0.1 >nul
