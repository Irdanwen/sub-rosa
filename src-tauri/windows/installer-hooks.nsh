; Sub Rosa NSIS installer hooks.
;
; Why this file exists:
; Sub Rosa launches the bundled Hermes agent runtime as a child process from
; $INSTDIR\native\hermes\bin\hermes.exe (spawned by hermes_bridge.rs), which in
; turn runs $INSTDIR\native\hermes\python\current\python.exe. Windows locks any
; running executable, so on an upgrade/reinstall NSIS cannot overwrite those
; files and aborts with "Error opening file for writing ... hermes.exe".
;
; Tauri's built-in NSIS template only knows how to close the MAIN app process
; ("Sub Rosa.exe"); it has no idea the app spawned hermes.exe / python.exe, and
; those children can also outlive a crashed or force-quit app. This PREINSTALL
; hook terminates the stragglers before file extraction.
;
; Safety: we ONLY kill hermes/python processes whose executable path is inside
; $INSTDIR. A user's own unrelated python.exe elsewhere on the machine is never
; touched. The uninstall hook does the same so an uninstall over a running app
; doesn't leave orphaned files behind.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing Sub Rosa agent runtime (Hermes)..."
  ; Backticks delimit the NSIS string so " and ' are free for PowerShell.
  ; $$_ emits a literal PowerShell $_; $INSTDIR is expanded by NSIS into the
  ; single-quoted PowerShell path literal used for the path filter.
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name hermes,python -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and $$_.Path.StartsWith('$INSTDIR') } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $0
  ; Give Windows a moment to release the file handles before extraction.
  Sleep 800
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Closing Sub Rosa agent runtime (Hermes)..."
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name hermes,python -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and $$_.Path.StartsWith('$INSTDIR') } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $0
  Sleep 800
!macroend
