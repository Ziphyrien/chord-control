; Maintenance and first-run startup are separate transactions from file replacement.
!macro NSIS_HOOK_PREINSTALL
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    ; The helper revokes before draining and has a 45s deadline. nsExec also bounds
    ; a loader failure; installer errors cannot silently replace a running host.
    nsExec::ExecToStack /TIMEOUT=50000 '$"$INSTDIR\${MAINBINARYNAME}.exe$" --maintenance-stop'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      SetErrorLevel 1
      Abort "Chord Control could not stop for maintenance. Close it and retry."
    ${EndIf}
  ${EndIf}
  ; Legacy hosts may not understand maintenance-stop. Do not kill processes by name:
  ; that can interrupt another installation and bypass plugin restoration.
  nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 0
    SetErrorLevel 1
    Abort "Close Chord Control before installing this update."
  ${EndIf}
  nsis_tauri_utils::FindProcessCurrentUser "plugin-controller.exe"
  Pop $0
  ${If} $0 = 0
    SetErrorLevel 1
    Abort "The plugin controller is still running. Close Chord Control and retry."
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Preserve the user's existing login-start choice across every upgrade.
  ${IfNot} ${FileExists} "$LOCALAPPDATA\ChordControl\first-run-complete"
    ClearErrors
    CreateDirectory "$LOCALAPPDATA\ChordControl"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Chord Control" '$"$INSTDIR\${MAINBINARYNAME}.exe$" --background'
    ${If} ${Errors}
      SetErrorLevel 1
      Abort "Could not register current-user startup."
    ${EndIf}
    FileOpen $0 "$LOCALAPPDATA\ChordControl\first-run-complete" w
    ${If} ${Errors}
      SetErrorLevel 1
      Abort "Could not save the first-run marker."
    ${EndIf}
    FileWrite $0 "1"
    FileClose $0
    ${If} ${Errors}
      SetErrorLevel 1
      Abort "Could not save the first-run marker."
    ${EndIf}
  ${EndIf}
!macroend
