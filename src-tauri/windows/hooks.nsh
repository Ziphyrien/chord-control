!macro NSIS_HOOK_POSTINSTALL
  ; The first installation opts into login startup. Upgrades preserve user choice.
  IfFileExists "$LOCALAPPDATA\ChordControl\first-run-complete" chord_autostart_done
  CreateDirectory "$LOCALAPPDATA\ChordControl"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Chord Control" '$"$INSTDIR\chord-control.exe$" --background'
  FileOpen $0 "$LOCALAPPDATA\ChordControl\first-run-complete" w
  FileWrite $0 "1"
  FileClose $0
  chord_autostart_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Chord Control"
  Delete "$LOCALAPPDATA\ChordControl\first-run-complete"
  ; Plugin data and configuration intentionally survive uninstall.
!macroend
