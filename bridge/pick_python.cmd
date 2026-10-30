@echo off
rem Pick a Python interpreter that can import wxauto4 (WeChat channel needs it).
rem Output form: "py -3.13" / "python". ASCII only on purpose:
rem non-ASCII bytes can break cmd parsing when the code page is not UTF-8 yet.
setlocal enabledelayedexpansion
set "FOUND="
for %%V in (3.13 3.12 3.11 3.10) do (
  if not defined FOUND (
    py -%%V -c "import wxauto4" >nul 2>nul
    if not errorlevel 1 set "FOUND=py -%%V"
  )
)
if not defined FOUND (
  python -c "import wxauto4" >nul 2>nul
  if not errorlevel 1 set "FOUND=python"
)
if not defined FOUND (
  for %%V in (3.13 3.12 3.11 3.10) do (
    if not defined FOUND (
      py -%%V -c "import sys" >nul 2>nul
      if not errorlevel 1 set "FOUND=py -%%V"
    )
  )
)
if not defined FOUND (
  python -c "import sys" >nul 2>nul
  if not errorlevel 1 set "FOUND=python"
)
if not defined FOUND set "FOUND=python"
echo %FOUND%
