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
  !if "${WEBVIEWMODE}" != "skip"
  !if "${WEBVIEWMODE}" != "fixedRuntime"
    Call ReadWebViewVersion
    ${If} $WebViewVersion != ""
      !if "${MINWEBVIEW}" == ""
        Goto runtime_ready
      !else
        ${VersionCompare} "$WebViewVersion" "${MINWEBVIEW}" $0
        ${If} $0 != 2
          Goto runtime_ready
        ${EndIf}
      !endif
    ${EndIf}
    InitPluginsDir
    !if "${WEBVIEWMODE}" == "downloadBootstrapper"
      NSISdl::download /TIMEOUT=90000 "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$PLUGINSDIR\WebViewSetup.exe"
      Pop $0
      ${If} $0 != "success"
        SetErrorLevel 1
        Abort "Could not download Microsoft WebView2. Install it and retry."
      ${EndIf}
    !else if "${WEBVIEWMODE}" == "embedBootstrapper"
      File "/oname=$PLUGINSDIR\WebViewSetup.exe" "{{webview2_bootstrapper_path}}"
    !else if "${WEBVIEWMODE}" == "offlineInstaller"
      File "/oname=$PLUGINSDIR\WebViewSetup.exe" "{{webview2_installer_path}}"
    !else
      !error "Unsupported WebView2 installation mode"
    !endif
    ; Never invoke a machine updater or request elevation. This child inherits our user token.
    nsExec::ExecToStack /TIMEOUT=180000 '$"$PLUGINSDIR\WebViewSetup.exe$" ${WEBVIEWARGS} /install'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      SetErrorLevel 1
      Abort "Microsoft WebView2 installation did not complete. Install it and retry."
    ${EndIf}
    Call ReadWebViewVersion
    ${If} $WebViewVersion == ""
      SetErrorLevel 1
      Abort "Microsoft WebView2 was not detected after installation."
    ${EndIf}
    runtime_ready:
  !endif
  !endif
SectionEnd

Section "Chord Control"
  ; Download/runtime preparation precedes stopping the old installation.
  !insertmacro NSIS_HOOK_PREINSTALL
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
  ${If} ${Errors}
    SetErrorLevel 1
    Abort "Could not replace application files. Close Chord Control and retry."
  ${EndIf}
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
  ${If} ${Errors}
    SetErrorLevel 1
    Abort "Could not save current-user installation metadata."
  ${EndIf}
  !insertmacro NSIS_HOOK_POSTINSTALL
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd
Function .onInstSuccess
  ; Fresh token, hidden startup, same current user. No shortcut or uninstaller is created.
  Exec '$"$INSTDIR\${MAINBINARYNAME}.exe$" --background'
FunctionEnd
