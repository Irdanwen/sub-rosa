; Sub Rosa NSIS installer hooks.
;
; Why this file exists:
; Sub Rosa launches the bundled Hermes agent runtime as a child process from
; $INSTDIR\native\hermes\bin\hermes.exe (spawned by hermes_bridge.rs), which in
; turn runs a Python interpreter under $INSTDIR\native\hermes with its own venv.
; Windows locks any running executable AND any loaded DLL/.pyd, so on an
; upgrade/reinstall NSIS cannot overwrite those files and aborts with e.g.
; "Error opening file for writing ... native\hermes\bin\hermes.exe" or
; "... hermes-agent\venv\Lib\site-packages\aiohttp\_http_parser.cp311-win_amd64.pyd"
; (a native extension the running python.exe has memory-mapped).
;
; Tauri's built-in NSIS template only knows how to close the MAIN app process
; ("Sub Rosa.exe"); it has no idea the app spawned hermes.exe / python.exe, and
; those children can also outlive a crashed or force-quit app. This PREINSTALL
; hook terminates the stragglers before file extraction.
;
; Safety + robustness: we kill EVERY process whose executable path is inside
; $INSTDIR\native\hermes — regardless of image name. This covers hermes.exe,
; python.exe, pythonw.exe, python3.11.exe, and any future helper, while a user's
; own unrelated Python elsewhere on the machine is never touched (its path is
; not under the install dir). The uninstall hook does the same so an uninstall
; over a running app doesn't leave orphaned, locked files behind.

!macro _SR_KILL_RUNTIME
  ; Backticks delimit the NSIS string so " and ' are free for PowerShell.
  ; $$_ emits a literal PowerShell $_; $INSTDIR is expanded by NSIS into the
  ; single-quoted PowerShell path literal used for the path prefix filter.
  ; Enumerating all processes can raise access-denied reading .Path for
  ; protected processes; the "$$_.Path -and" guard + SilentlyContinue swallow it.
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and $$_.Path.StartsWith('$INSTDIR\native\hermes') } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $0
  ; Give Windows a moment to release the file handles before extraction.
  Sleep 800
!macroend

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing Sub Rosa agent runtime (Hermes)..."
  !insertmacro _SR_KILL_RUNTIME
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Closing Sub Rosa agent runtime (Hermes)..."
  !insertmacro _SR_KILL_RUNTIME
!macroend
