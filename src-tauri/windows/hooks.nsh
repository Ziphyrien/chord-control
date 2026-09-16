!macro NSIS_HOOK_PREINSTALL
  ; New versions cooperate through their guard token. Older versions are handled
  ; by the normal Tauri process check after this hook.
  ${If} ${FileExists} "$LOCALAPPDATA\ChordControl\guard\run"
  ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    ExecWait '$"$INSTDIR\${MAINBINARYNAME}.exe$" --maintenance-stop' $0
    ${If} $0 != 0
      SetErrorLevel 1
      Abort "Chord Control could not stop for maintenance. Close it and retry."
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; First installation opts into login startup; upgrades preserve user choice.
  IfFileExists "$LOCALAPPDATA\ChordControl\first-run-complete" chord_autostart_done
  CreateDirectory "$LOCALAPPDATA\ChordControl"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Chord Control" '$"$INSTDIR\${MAINBINARYNAME}.exe$" --background'
  FileOpen $0 "$LOCALAPPDATA\ChordControl\first-run-complete" w
  FileWrite $0 "1"
  FileClose $0
  chord_autostart_done:
!macroend
