; Sub Rosa NSIS installer hooks (fork addition, 2026-07-10).
;
; Why this exists: the Hermes gateway (the routines daemon) is designed to
; OUTLIVE the app — it is launched from the user's Startup folder and keeps
; running after Sub Rosa quits. Its python.exe (and any children) run FROM
; the install directory, so during an update they hold locks on files the
; installer must replace. Tauri's NSIS template only closes the main
; executable; the gateway survived, and updates then stalled on retry/abort
; dialogs or silently left a half-replaced runtime — users had to kill the
; processes by hand before every update.
;
; Fix: before installing (and before uninstalling), force-stop every process
; whose executable lives under $INSTDIR. Path-scoped on purpose: it kills the
; gateway python, a leftover dashboard python, june-api.exe, hermes.exe, or
; the app itself, but can never touch an unrelated python/app elsewhere on
; the machine. The gateway comes back on its own: the app restarts it at
; launch (start_hermes_gateway_if_needed), and the Startup entry re-arms it
; at next login.

!macro _SUBROSA_KILL_INSTDIR_PROCESSES
  DetailPrint "Closing Sub Rosa background processes..."
  nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -like '$INSTDIR\*' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500"`
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro _SUBROSA_KILL_INSTDIR_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _SUBROSA_KILL_INSTDIR_PROCESSES
!macroend
