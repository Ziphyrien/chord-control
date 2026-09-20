; Best-effort, current-user installer diagnostics. No command lines or child output.
; UTF-16LE with BOM; two files of at most 512 KiB each (1 MiB total).
!ifndef CHORD_INSTALLER_DIAGNOSTICS_INCLUDED
!define CHORD_INSTALLER_DIAGNOSTICS_INCLUDED
!include FileFunc.nsh
!include LogicLib.nsh
!ifndef INSTALLER_DIAGNOSTIC_ROOT
  !define INSTALLER_DIAGNOSTIC_ROOT "$LOCALAPPDATA\ChordControl\updates"
!endif

; Push arguments before touching registers: callers may pass any $0-$9/$R0-$R9.
!macro InstallerLog EVENT STATUS PATH
  Push "${EVENT}"
  Push "${STATUS}"
  Push "${PATH}"
  Call InstallerDiagnosticLog
!macroend

!macro InstallerLogResult EVENT PATH
  ${If} ${Errors}
    ; IfErrors (including LogicLib ${Errors}) consumes the flag. Restore it first.
    SetErrors
    !insertmacro InstallerLog "${EVENT}" "error" "${PATH}"
  ${Else}
    !insertmacro InstallerLog "${EVENT}" "ok" "${PATH}"
  ${EndIf}
!macroend

; The error flag, registers, stack and process exit code belong to the caller.
; Each write closes its handle so an abruptly terminated installer leaves evidence.
Function InstallerDiagnosticLog
  Exch $2
  Exch 1
  Exch $1
  Exch 2
  Exch $0
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  IfErrors diag_had_error diag_no_error
  diag_had_error:
    StrCpy $R0 1
    Goto diag_begin
  diag_no_error:
    StrCpy $R0 0
  diag_begin:
  ; Never wait for another installer. Serialize rotation as well as append.
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\ChordControlInstallerDiagnostics") p.r9'
  StrCmp $9 0 diag_restore
  System::Call 'kernel32::WaitForSingleObject(p r9, i 0) i.r8'
  StrCmp $8 0 diag_locked
  StrCmp $8 128 diag_locked diag_close_mutex
  diag_locked:
  ClearErrors
  CreateDirectory "${INSTALLER_DIAGNOSTIC_ROOT}"
  IfErrors diag_unlock
  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $R1
  StrCpy $R1 "$5-$4-$3T$7:$8:$R1"
  System::Call 'kernel32::GetCurrentProcessId() i.r6'
  ; Bound fields so every record retains its status and newline even for long paths.
  StrCpy $0 $0 64
  StrCpy $1 $1 64
  StrCpy $2 $2 512
  ; Only controlled event/status tokens and the relevant installation path enter here.
  StrCpy $R1 "$R1 pid=$6 event=$0 version=${INSTALLER_DIAGNOSTIC_VERSION} path=$2 status=$1$\r$\n"
  ; Reserve 8 KiB for one UTF-16 record (NSIS strings here are at most 1024 chars).
  ClearErrors
  FileOpen $R2 "${INSTALLER_DIAGNOSTIC_ROOT}\installer.log" a
  IfErrors diag_unlock
  FileSeek $R2 0 END $R3
  IfErrors diag_close_file
  IntCmp $R3 516096 diag_append diag_append diag_rotate
  diag_rotate:
    FileClose $R2
    ClearErrors
    Delete "${INSTALLER_DIAGNOSTIC_ROOT}\installer.previous.log"
    IfErrors diag_unlock
    Rename "${INSTALLER_DIAGNOSTIC_ROOT}\installer.log" "${INSTALLER_DIAGNOSTIC_ROOT}\installer.previous.log"
    IfErrors diag_unlock
    FileOpen $R2 "${INSTALLER_DIAGNOSTIC_ROOT}\installer.log" w
    IfErrors diag_unlock
    StrCpy $R3 0
  diag_append:
    StrCmp $R3 0 0 diag_write
    FileWriteUTF16LE /BOM $R2 ""
  diag_write:
    FileWriteUTF16LE $R2 "$R1"
  diag_close_file:
    FileClose $R2
  diag_unlock:
    System::Call 'kernel32::ReleaseMutex(p r9)'
  diag_close_mutex:
    System::Call 'kernel32::CloseHandle(p r9)'
  diag_restore:
  StrCmp $R0 1 diag_restore_error
    ClearErrors
    Goto diag_restore_registers
  diag_restore_error:
    SetErrors
  diag_restore_registers:
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $0
  Pop $2
  Pop $1
FunctionEnd
!endif
