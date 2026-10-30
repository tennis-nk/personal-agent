@echo off
rem 这个文件存的是 GBK（ANSI）编码，别用 UTF-8 编辑器另存，否则中文会变乱码、cmd 解析也会崩。
setlocal
cd /d "%~dp0"

if not exist "信息管家.html" (
  echo 找不到 信息管家.html，请先 npm run build 再把它复制到这一层。
  pause
  exit /b 1
)

rem 1) 本机助手已经在跑，就只管把应用打开，不用再起一个（会撞端口）。
curl -s -f -m 2 http://127.0.0.1:8787/health >nul 2>nul
if not errorlevel 1 goto open
rem 1.5) 端口被别的程序占着（或者上次的进程没退干净），别硬起第二个。
netstat -ano | findstr ":8787" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo 8787 端口已被占用，可能上次的本机助手没退干净。先双击「停止本机助手.bat」，或改 bridge\config.json 里的 port。
  pause
  exit /b 1
)


rem 2) 起助手。自动挑一个装了 wxauto4 的解释器；窗口最小化，日志在 bridge\bridge.log。
for /f "delims=" %%P in ('call "bridge\pick_python.cmd"') do set "PY=%%P"
echo 正在启动本机助手（%PY%）……
start "本机助手" /min %PY% "bridge\notice_bridge.py"

rem 3) 等它就绪，最多 20 秒。ping 当 sleep 用，timeout 在这个窗口里会漏键。
for /l %%I in (1,1,20) do (
  curl -s -f -m 1 http://127.0.0.1:8787/health >nul 2>nul && goto open
  ping -n 2 127.0.0.1 >nul
)

echo.
echo 本机助手没起来。常见原因：Python 没装，或依赖缺（pip install wxauto4 pywin32 lark-oapi）。
echo 想看具体报错，双击 bridge\启动本机助手.bat，日志直接打在窗口里。
echo.
pause
exit /b 1

:open
start "" "信息管家.html"
exit /b 0
