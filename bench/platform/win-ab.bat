@echo off
setlocal enabledelayedexpansion
rem ===========================================================================
rem  A/B benchmark wrapper: baseline side, candidate side, then the comparison.
rem
rem     node bench/run.mjs     --label bench-base --profile bench-base ...
rem     node bench/run.mjs     --label bench-ops  --profile bench-ops  ...
rem     node bench/compare.mjs  bench-base bench-ops --folder ...
rem
rem  This is the Windows entry point behind `npm run bench:baseline`; it chdirs to
rem  the repository root first, because both node commands resolve `bench/`
rem  relatively, wherever the script was launched from.
rem
rem  Usage:
rem     npm run bench:baseline -- [flags]
rem     bench\platform\win-ab.bat [--task ^<id^>]... [--repeat ^<N^>] [--folder ^<name^>]
rem                               [--base ^<label^>] [--cand ^<label^>]
rem                               [extra run.mjs flags...] [--show] [--help]
rem
rem  --task    optional, repeatable. default: the whole bench/tasks corpus.
rem  --repeat  optional. default: each task's own budget (see bench/README.md).
rem  --folder  optional. default: the first free bench\runs\benchmark-test-NN
rem            (01, 02, ...), allocated once here so both runs AND the compare
rem            resolve their labels inside the SAME new group.
rem  --base    optional baseline label AND profile (default: bench-base).
rem  --cand    optional candidate label AND profile  (default: bench-ops).
rem  --show    print the resolved root and the three commands, run nothing.
rem
rem  Examples:
rem     npm run bench:baseline
rem     npm run bench:baseline -- --task csv-sum --repeat 1
rem     npm run bench:baseline -- --folder ops-0.3.1
rem     npm run bench:baseline -- --verbose --probe-endpoint
rem
rem  Exit code: the compare gate result (0 = passed), 1 when a run failed.
rem ===========================================================================

rem %~dp0 already ends with a separator: ..\.. is the repository root.
pushd "%~dp0..\.." || exit /b 1
if not exist "bench\run.mjs" (
  echo [ab] error: bench\run.mjs not found under "%CD%" 1>&2
  echo [ab] this wrapper belongs to a dsh-ops checkout; run it from that tree 1>&2
  popd
  exit /b 2
)

set "BASE=bench-base"
set "CAND=bench-ops"
set "TASKS="
set "REPEAT="
set "FOLDER="
set "EXTRA="
set "SHOW="

:parse
if "%~1"=="" goto parsed

if /i "%~1"=="--task" (
  if "%~2"=="" goto missing_value
  set "TASKS=!TASKS! --task %~2"
  shift & shift & goto parse
)
if /i "%~1"=="--repeat" (
  if "%~2"=="" goto missing_value
  set "REPEAT=%~2"
  shift & shift & goto parse
)
if /i "%~1"=="--folder" (
  if "%~2"=="" goto missing_value
  set "FOLDER=%~2"
  shift & shift & goto parse
)
if /i "%~1"=="--base" (
  if "%~2"=="" goto missing_value
  set "BASE=%~2"
  shift & shift & goto parse
)
if /i "%~1"=="--cand" (
  if "%~2"=="" goto missing_value
  set "CAND=%~2"
  shift & shift & goto parse
)

if /i "%~1"=="--show" ( set "SHOW=1" & shift & goto parse )
if /i "%~1"=="-h" goto usage
if /i "%~1"=="--help" goto usage

rem anything else goes straight to bench/run.mjs (--verbose, --timeout MS, ...)
set "EXTRA=!EXTRA! %~1"
shift
goto parse

:parsed

rem Default group: the first free bench\runs\benchmark-test-NN. Allocated ONCE, here, and
rem handed to both runs and the compare — a per-process default would put the baseline in
rem one group and the candidate in the next one.
set "AUTO="
if not defined FOLDER (
  for /f "usebackq delims=" %%i in (`node "bench\lib\next-folder.mjs"`) do set "FOLDER=%%i"
  if defined FOLDER set "AUTO=1"
)
if not defined FOLDER (
  echo [ab] error: cannot allocate a folder under bench\runs - see bench\lib\next-folder.mjs 1>&2
  popd
  exit /b 2
)

set "RUN=!TASKS!"
if defined REPEAT set "RUN=!RUN! --repeat !REPEAT!"
set "RUN=!RUN! --folder !FOLDER!"
if defined EXTRA set "RUN=!RUN! !EXTRA:~1!"
if defined RUN set "RUN=!RUN:~1!"

echo [ab] base   : !BASE!
echo [ab] cand   : !CAND!
if defined AUTO (echo [ab] folder : bench\runs\!FOLDER! [auto]) else (echo [ab] folder : bench\runs\!FOLDER!)
if defined TASKS (echo [ab] tasks  : !TASKS:~1!) else (echo [ab] tasks  : full corpus)
if defined REPEAT (echo [ab] repeat : !REPEAT! per task) else (echo [ab] repeat : per-task budget)

if defined SHOW (
  echo.
  echo [ab] root   : %CD%
  echo node bench/run.mjs --label !BASE! --profile !BASE! !RUN!
  echo node bench/run.mjs --label !CAND! --profile !CAND! !RUN!
  echo node bench/compare.mjs !BASE! !CAND! --folder !FOLDER!
  popd
  exit /b 0
)

echo.
echo [ab] 1/3 baseline: node bench/run.mjs --label !BASE! --profile !BASE! !RUN!
rem `call` matters: it returns control to this script even when `node` resolves to a
rem .cmd/.bat shim on PATH (a batch file invoked without `call` would replace this one).
call node bench/run.mjs --label %BASE% --profile %BASE% !RUN!
if errorlevel 1 ( echo [ab] baseline run failed 1>&2 & popd & exit /b 1 )

echo.
echo [ab] 2/3 candidate: node bench/run.mjs --label !CAND! --profile !CAND! !RUN!
call node bench/run.mjs --label %CAND% --profile %CAND% !RUN!
if errorlevel 1 ( echo [ab] candidate run failed 1>&2 & popd & exit /b 1 )

echo.
echo [ab] 3/3 compare: node bench/compare.mjs !BASE! !CAND! --folder !FOLDER!
call node bench/compare.mjs %BASE% %CAND% --folder %FOLDER%
set "RC=!ERRORLEVEL!"
popd
echo.
echo [ab] compare exit code !RC!  (0 = gates passed, non-zero = regression or pass-drop)
exit /b !RC!

:missing_value
echo [ab] error: this flag needs a value: %~1
echo [ab] run "bench\platform\win-ab.bat --help" for usage
popd
exit /b 2

:usage
echo usage: bench\platform\win-ab.bat [--task ^<id^>]... [--repeat ^<N^>] [--folder ^<name^>] [--base ^<label^>] [--cand ^<label^>] [extra run.mjs flags...] [--show]
echo.
echo   --task    optional, repeatable; default: every bench/tasks/*.task.json
echo   --repeat  optional; default: each task's own budget
echo   --folder  optional; default: first free bench\runs\benchmark-test-NN (01, 02, ...), used by both runs and the compare
echo   --base    optional baseline label and profile, default bench-base
echo   --cand    optional candidate label and profile, default bench-ops
echo   --show    print the three commands, run nothing
echo.
echo   other flags are forwarded to bench/run.mjs, e.g. --verbose --timeout 120000
echo   see bench\README.md for the runner options
popd
exit /b 0
