; Maintenance and first-run startup are separate transactions from file replacement.
!macro NSIS_HOOK_PREINSTALL
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    ; The helper revokes before draining and has a 45s deadline. nsExec also bounds
    ; a loader failure; installer errors cannot silently replace a running host.
    nsExec::ExecToStack /TIMEOUT=50000 '"$INSTDIR\${MAINBINARYNAME}.exe" --maintenance-stop'
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
    Abort "Chord Control is still shutting down. Please retry."
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Repair the malformed command written by 0.3.0, while preserving a disabled entry.
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Chord Control"
  StrCpy $1 $0 2
  ${If} $1 == '$$"'
    ClearErrors
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Chord Control" '"$INSTDIR\${MAINBINARYNAME}.exe" --background'
    ${If} ${Errors}
      SetErrorLevel 1
      Abort "Could not save startup settings. Please retry."
    ${EndIf}
  ${EndIf}
  ; Preserve the user's existing login-start choice across every upgrade.
  ${IfNot} ${FileExists} "$LOCALAPPDATA\ChordControl\first-run-complete"
    ClearErrors
    CreateDirectory "$LOCALAPPDATA\ChordControl"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Chord Control" '"$INSTDIR\${MAINBINARYNAME}.exe" --background'
    ${If} ${Errors}
      SetErrorLevel 1
      Abort "Could not enable automatic startup. Please retry."
    ${EndIf}
    FileOpen $0 "$LOCALAPPDATA\ChordControl\first-run-complete" w
    ${If} ${Errors}
      SetErrorLevel 1
      Abort "Could not save startup settings. Check folder permissions and retry."
    ${EndIf}
    FileWrite $0 "1"
    FileClose $0
    ${If} ${Errors}
      SetErrorLevel 1
      Abort "Could not save startup settings. Check folder permissions and retry."
    ${EndIf}
  ${EndIf}
!macroend
