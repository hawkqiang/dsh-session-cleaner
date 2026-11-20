@echo off
setlocal
set "nodebin=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if exist "%nodebin%" goto run
set "nodebin="
for %%N in (node.exe) do set "nodebin=%%~$PATH:N"
if not defined nodebin (
 echo Install Node.js 22 LTS or newer from https://nodejs.org/ and reopen this assistant.
 pause
 exit /b 1
)
:run
"%nodebin%" "%~dp0assistant.cjs"
set "result=%errorlevel%"
pause
exit /b %result%
