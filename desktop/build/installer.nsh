; Is TypeR Studio still running, before its files are replaced? The builder's own check asks
; PowerShell, which on Windows PowerShell 5.1 answers "no" when only the app's main process is
; left, as when it's quitting for an update: its files are then locked, the old version can't be
; removed and the update gives up without a word. It can also hang there. tasklist has neither.
!macro typerFindApp _RETURN
  nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop ${_RETURN}
!macroend

!macro customCheckAppRunning
  ${if} ${isUpdated}
    ; The app is on its way out: a moment to finish
    Sleep 300
  ${endIf}
  !insertmacro typerFindApp $R0
  ${if} $R0 == 0
    ${ifNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK typerStop
      Quit
    ${endIf}
    typerStop:
    DetailPrint "$(appClosing)"
    ; Asked to close, then made to after a few seconds
    nsExec::Exec `"$CmdPath" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
    Pop $R0
    StrCpy $R1 0
    typerWait:
      Sleep 1000
      IntOp $R1 $R1 + 1
      !insertmacro typerFindApp $R0
      ${if} $R0 != 0
        Goto typerClosed
      ${endIf}
      ${if} $R1 >= 3
        nsExec::Exec `"$CmdPath" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
        Pop $R0
      ${endIf}
      ${if} $R1 < 10
        Goto typerWait
      ${endIf}
    ; Still there, maybe run as administrator: the user closes it
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY typerStop
    Quit
    typerClosed:
  ${endIf}
!macroend

; TypeR Studio joins "Open with" for PSD and PSB files. It never takes the double-click away
; from Photoshop: a typesetter who wants that sets it in Windows.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\TypeRStudio.psd" "" "Photoshop Document"
  WriteRegStr HKCU "Software\Classes\TypeRStudio.psd\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\TypeRStudio.psd\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\.psd\OpenWithProgids" "TypeRStudio.psd" ""
  WriteRegStr HKCU "Software\Classes\.psb\OpenWithProgids" "TypeRStudio.psd" ""
  ; typer-studio:// : TypeR for Photoshop's "Open in TypeR Studio"
  WriteRegStr HKCU "Software\Classes\typer-studio" "" "URL:TypeR Studio"
  WriteRegStr HKCU "Software\Classes\typer-studio" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\typer-studio\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ; The builder keeps a copy of this installer, only to make the next app update a smaller
  ; download. App updates are rare, and it would weigh as much as the download forever.
  Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\typer-studio-updater"
    DeleteRegKey HKCU "Software\Classes\typer-studio"
  ${endIf}
  DeleteRegValue HKCU "Software\Classes\.psd\OpenWithProgids" "TypeRStudio.psd"
  DeleteRegValue HKCU "Software\Classes\.psb\OpenWithProgids" "TypeRStudio.psd"
  DeleteRegKey HKCU "Software\Classes\TypeRStudio.psd"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
