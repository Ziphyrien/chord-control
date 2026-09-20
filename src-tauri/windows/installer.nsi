; Chord Control 0.3 current-user NSIS template (Tauri 2 template variables).
; WebView detection follows the Tauri MIT/Apache-2.0 installer contract.
Unicode true
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2
RequestExecutionLevel user
!if "{{compression}}" == "none"
  SetCompress off
!else
  SetCompressor /SOLID "{{compression}}"
!endif
{{#if signed_plugins_path}}
!addplugindir "{{signed_plugins_path}}"
{{/if}}
!addplugindir "{{additional_plugins_path}}"
!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh
!include x64.nsh
!include WordFunc.nsh
!define PRODUCTNAME "{{product_name}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MANUPRODUCTKEY "Software\{{manufacturer}}\{{product_name}}"
!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define WEBVIEWMODE "{{install_webview2_mode}}"
!define WEBVIEWARGS "{{webview2_installer_args}}"
!define MINWEBVIEW "{{minimum_webview2_version}}"
!define INSTALLER_DIAGNOSTIC_VERSION "{{version}}"
{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}
Name "${PRODUCTNAME}"
OutFile "{{out_file}}"
InstallDir "placeholder\${PRODUCTNAME}"
VIProductVersion "{{version_with_build}}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME} current-user installer"
VIAddVersionKey "FileVersion" "{{version}}"
VIAddVersionKey "ProductVersion" "{{version}}"
VIAddVersionKey "LegalCopyright" "{{copyright}}"
!if "{{installer_icon}}" != ""
  !define MUI_ICON "{{installer_icon}}"
!endif
Var PassiveMode
Var WebViewVersion
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_FINISH
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
{{#each language_files}}
!include "{{this}}"
{{/each}}
Function SkipIfPassive
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
FunctionEnd
Function .onInit
  SetShellVarContext current
  !insertmacro InstallerLog "init" "entered" "$EXEPATH"
  !if "{{arch}}" == "x64"
    SetRegView 64
  !else if "{{arch}}" == "arm64"
    SetRegView 64
  !endif
  StrCpy $PassiveMode 0
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $0
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}
  ClearErrors
  ${If} $INSTDIR == "placeholder\${PRODUCTNAME}"
    ReadRegStr $0 HKCU "${MANUPRODUCTKEY}" ""
    ${If} $0 == ""
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    ${Else}
      StrCpy $INSTDIR $0
    ${EndIf}
  ${EndIf}
  !insertmacro InstallerLog "install_target" "selected" "$INSTDIR"
FunctionEnd

Function .onInstFailed
  Push $0
  GetErrorLevel $0
  !insertmacro InstallerLog "installer_failed" "exitcode=$0" "$INSTDIR"
  Pop $0
FunctionEnd

Function .onInstSuccess
  Push $0
  GetErrorLevel $0
  ; GetErrorLevel returns -1 when no override was set. Successful NSIS exit is 0.
  ${If} $0 == -1
    StrCpy $0 0
  ${EndIf}
  !insertmacro InstallerLog "installer_succeeded" "exitcode=$0" "$INSTDIR"
  Pop $0
FunctionEnd

Function ReadWebViewVersion
  ; Machine runtime reads are permitted; installation still uses the current user's token.
  StrCpy $WebViewVersion ""
  ${If} ${RunningX64}
    ReadRegStr $WebViewVersion HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $WebViewVersion HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $WebViewVersion == ""
    ReadRegStr $WebViewVersion HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
FunctionEnd
Section "WebView2 runtime"
  !insertmacro InstallerLog "runtime_begin" "${WEBVIEWMODE}" "$INSTDIR"
  !if "${WEBVIEWMODE}" != "skip"
  !if "${WEBVIEWMODE}" != "fixedRuntime"
    Call ReadWebViewVersion
    ${If} $WebViewVersion == ""
      !insertmacro InstallerLog "runtime_detected" "missing" "$INSTDIR"
    ${Else}
      !insertmacro InstallerLog "runtime_detected" "present" "$INSTDIR"
    ${EndIf}
    ${If} $WebViewVersion != ""
      !if "${MINWEBVIEW}" == ""
        Goto runtime_ready
      !else
        ${VersionCompare} "$WebViewVersion" "${MINWEBVIEW}" $0
        !insertmacro InstallerLog "runtime_version_compare" "$0" "$INSTDIR"
        ${If} $0 != 2
          Goto runtime_ready
        ${EndIf}
      !endif
    ${EndIf}
    InitPluginsDir
    !if "${WEBVIEWMODE}" == "downloadBootstrapper"
      !insertmacro InstallerLog "runtime_download_begin" "requested" "$PLUGINSDIR\WebViewSetup.exe"
      ${If} ${Silent}
        NSISdl::download_quiet /TIMEOUT=90000 "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$PLUGINSDIR\WebViewSetup.exe"
      ${Else}
        NSISdl::download /TIMEOUT=90000 "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$PLUGINSDIR\WebViewSetup.exe"
      ${EndIf}
      Pop $0
      ${If} $0 != "success"
        !insertmacro InstallerLog "runtime_download_end" "error" "$PLUGINSDIR\WebViewSetup.exe"
        SetErrorLevel 1
        Abort "Could not download Microsoft WebView2. Install it and retry."
      ${EndIf}
      !insertmacro InstallerLog "runtime_download_end" "ok" "$PLUGINSDIR\WebViewSetup.exe"
    !else if "${WEBVIEWMODE}" == "embedBootstrapper"
      File "/oname=$PLUGINSDIR\WebViewSetup.exe" "{{webview2_bootstrapper_path}}"
    !else if "${WEBVIEWMODE}" == "offlineInstaller"
      File "/oname=$PLUGINSDIR\WebViewSetup.exe" "{{webview2_installer_path}}"
    !else
      !error "Unsupported WebView2 installation mode"
    !endif
    !insertmacro InstallerLog "runtime_install_begin" "requested" "$PLUGINSDIR\WebViewSetup.exe"
    ; Never invoke a machine updater or request elevation. This child inherits our user token.
    ${If} ${Silent}
      nsExec::ExecToStack /TIMEOUT=180000 '"$PLUGINSDIR\WebViewSetup.exe" /silent /install'
    ${Else}
      nsExec::ExecToStack /TIMEOUT=180000 '"$PLUGINSDIR\WebViewSetup.exe" ${WEBVIEWARGS} /install'
    ${EndIf}
    Pop $0
    Pop $1
    !insertmacro InstallerLog "runtime_install_end" "exitcode=$0" "$PLUGINSDIR\WebViewSetup.exe"
    ${If} $0 != "0"
      SetErrorLevel 1
      Abort "Microsoft WebView2 installation did not complete. Install it and retry."
    ${EndIf}
    Call ReadWebViewVersion
    ${If} $WebViewVersion == ""
      !insertmacro InstallerLog "runtime_verify" "missing" "$INSTDIR"
      SetErrorLevel 1
      Abort "Microsoft WebView2 was not detected after installation."
    ${EndIf}
    runtime_ready:
    !insertmacro InstallerLog "runtime_ready" "present" "$INSTDIR"
  !endif
  !endif
SectionEnd

Section "Chord Control"
  ; Download/runtime preparation precedes stopping the old installation.
  !insertmacro NSIS_HOOK_PREINSTALL
  !insertmacro InstallerLog "files_begin" "requested" "$INSTDIR"
  ClearErrors
  SetOutPath "$INSTDIR"
  File "{{main_binary_path}}"
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}
  !insertmacro InstallerLogResult "files_end" "$INSTDIR"
  ${If} ${Errors}
    SetErrorLevel 1
    Abort "Could not replace application files. Close Chord Control and retry."
  ${EndIf}
  !insertmacro InstallerLog "metadata_begin" "requested" "$INSTDIR"
  ; Remove only the previous installation's legacy shell registrations.
  ReadRegStr $0 HKCU "${MANUPRODUCTKEY}" ""
  ${If} $0 == $INSTDIR
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
    Delete "$INSTDIR\uninstall.exe"
    Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}
  ClearErrors
  WriteRegStr HKCU "${MANUPRODUCTKEY}" "" "$INSTDIR"
  WriteRegStr HKCU "${MANUPRODUCTKEY}" "Version" "{{version}}"
  !insertmacro InstallerLogResult "metadata_end" "$INSTDIR"
  ${If} ${Errors}
    SetErrorLevel 1
    Abort "Could not save current-user installation metadata."
  ${EndIf}
  !insertmacro NSIS_HOOK_POSTINSTALL
  ; Launch as soon as installation succeeds, before displaying the finish page.
  !insertmacro InstallerLog "launch_requested" "requested" "$INSTDIR\${MAINBINARYNAME}.exe"
  ClearErrors
  Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --background'
  ${If} ${Errors}
    !insertmacro InstallerLog "launch_failed" "nsis_error" "$INSTDIR\${MAINBINARYNAME}.exe"
    DetailPrint "Could not start Chord Control. Open it from the installation folder."
    MessageBox MB_OK|MB_ICONEXCLAMATION "安装已完成，但程序未能启动。请从安装目录打开 Chord Control。" /SD IDOK
  ${Else}
    ; Exec only confirms CreateProcess; the host records startup_ready separately.
    !insertmacro InstallerLog "application_spawned" "ok" "$INSTDIR\${MAINBINARYNAME}.exe"
  ${EndIf}
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd
