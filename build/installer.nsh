; SiberSentez NSIS customisations, included through package.json -> build.nsis.include.
; electron-builder includes this file after it defines its command-line tests (isUpdated, isForAllUsers ...)
; and before common.nsh, multiUser.nsh and the .onInit function, which is what the overrides below rely on.
; The same file goes into both builds: the installer and the uninstaller (makensis -DBUILD_UNINSTALLER).
; electron-builder compiles with -WX: a variable or function that one of the two builds never uses fails the build.

!include LogicLib.nsh

; Prefix of the functions defined below: they live in the uninstaller ("un.") or in the installer ("")
!ifdef BUILD_UNINSTALLER
  !define SIBERSENTEZ_UN "un."
!else
  !define SIBERSENTEZ_UN ""
!endif

; --- Texts shown to the user -----------------------------------------------------------------------------
; English (1033) and Turkish (1055), the installer languages in package.json. Numeric ids like electron-builder's
; own messages: LANG_ENGLISH and LANG_TURKISH are only defined later, when the language files are loaded.
LangString sibersentezMsgNoCustomDir 1033 "${PRODUCT_NAME} is always installed into its own folder; the /D option is not supported."
LangString sibersentezMsgNoCustomDir 1055 "${PRODUCT_NAME} her zaman kendi klasörüne kurulur; /D seçeneği desteklenmez."
LangString sibersentezMsgInstallDir 1033 "${PRODUCT_NAME} can only be installed into %LOCALAPPDATA%\Programs\${APP_FILENAME}."
LangString sibersentezMsgInstallDir 1055 "${PRODUCT_NAME} yalnız %LOCALAPPDATA%\Programs\${APP_FILENAME} klasörüne kurulabilir."
LangString sibersentezMsgNotUninstalled 1033 "${PRODUCT_NAME} was not uninstalled and nothing was removed: its program folder could not be confirmed."
LangString sibersentezMsgNotUninstalled 1055 "${PRODUCT_NAME} kaldırılmadı ve hiçbir şey silinmedi: program klasörü doğrulanamadı."
LangString sibersentezMsgOldVersionKept 1033 "Setup could not remove the installed version of ${PRODUCT_NAME} and stopped. Close every program that uses its files, then run Setup again."
LangString sibersentezMsgOldVersionKept 1055 "Kurulum, yüklü ${PRODUCT_NAME} sürümünü kaldıramadı ve durdu. Dosyalarını kullanan bütün programları kapatıp kurulumu yeniden çalıştır."

; --- Current user only -------------------------------------------------------------------------------
; The "for all users" page is skipped and no elevation (UAC) prompt can appear. Together with
; allowElevation: false and packElevateHelper: false in package.json.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; The /allusers switch must never select the all-users mode: ${isForAllUsers} is redefined to be always
; false (the page PRE function tests it before our customInstallMode choice).
!macroundef _isForAllUsers
!macro _isForAllUsers _a _b _t _f
  StrCmp "current-user-only" "" `${_t}` `${_f}`
!macroend

; There is no all-users mode at all. electron-builder defines INSTALL_MODE_PER_ALL_USERS_REQUIRED for every
; assisted installer, and multiUser.nsh then defines setInstallModePerAllUsers. Its uninstaller branch
; relaunches the uninstaller elevated (UAC) from un.onInit -> initMultiUser on /allusers or on an HKLM entry,
; before any custom hook runs. Undefining the symbol here, before multiUser.nsh is read, makes the template
; skip its version; the one below is used everywhere instead (initMultiUser, the install-mode page, the silent
; upgrade branch of the installer) and always selects the current user, so nothing can ask for elevation.
!ifdef INSTALL_MODE_PER_ALL_USERS_REQUIRED
  !undef INSTALL_MODE_PER_ALL_USERS_REQUIRED
  Var perMachineInstallationFolder
  !macro setInstallModePerAllUsers
    !insertmacro setInstallModePerUser
  !macroend
!endif

; --- The one program folder ----------------------------------------------------------------------------
; SiberSentez is only ever installed into %LOCALAPPDATA%\Programs\SiberSentez, and that is the only folder the
; uninstaller may delete. The hub (%USERPROFILE%\SiberSentez, user data) must never be the program folder.
Var sibersentezDir     ; the folder being checked, trailing backslashes removed
Var sibersentezReason  ; "" when it is the program folder, otherwise why it is refused
Var sibersentezTmp

; Sets $sibersentezReason to "" only when CANDIDATE is exactly LOCAL_APP_DATA\Programs\<app folder name>
; (case-insensitive like Windows, trailing backslashes ignored). No other spelling is accepted: "..",
; forward slashes or short names are refused rather than resolved. Pure string checks, nothing is touched.
!macro sibersentezCheckProgramDir CANDIDATE LOCAL_APP_DATA PROFILE_DIR
  StrCpy $sibersentezDir "${CANDIDATE}"
  StrCpy $sibersentezReason ""
  ${Do}
    StrCpy $sibersentezTmp $sibersentezDir 1 -1
    ${If} $sibersentezTmp != "\"
      ${ExitDo}
    ${EndIf}
    StrCpy $sibersentezDir $sibersentezDir -1
  ${Loop}
  StrLen $sibersentezTmp $sibersentezDir
  ${If} $sibersentezDir == ""
    StrCpy $sibersentezReason "empty"
  ${ElseIf} "${LOCAL_APP_DATA}" == ""
    StrCpy $sibersentezReason "user folders unknown"
  ${ElseIf} "${PROFILE_DIR}" == ""
    StrCpy $sibersentezReason "user folders unknown"
  ${ElseIf} $sibersentezTmp <= 3
    StrCpy $sibersentezReason "drive root"
  ${ElseIf} $sibersentezDir == "${PROFILE_DIR}"
    StrCpy $sibersentezReason "home folder"
  ${ElseIf} $sibersentezDir == "${PROFILE_DIR}\SiberSentez"
    StrCpy $sibersentezReason "hub folder"
  ${ElseIf} $sibersentezDir != "${LOCAL_APP_DATA}\Programs\${APP_FILENAME}"
    StrCpy $sibersentezReason "not the program folder"
  ${EndIf}
!macroend

; Shows why the folder was refused and stops with exit code 2 before anything is changed
!macro sibersentezRefuse MESSAGE
  MessageBox MB_ICONSTOP|MB_OK "$(${MESSAGE})$\r$\n$\r$\n$sibersentezDir ($sibersentezReason)" /SD IDOK
  SetErrorLevel 2
  Quit
!macroend

; Uninstaller: decide which folder gets deleted, or stop before anything is removed or closed.
; Source: InstallLocation under HKCU\Software\<app GUID>, written only by the installer (registryAddInstallInfo).
; Not trusted: /D= (read again from the raw command line by the template's setInstallModePerUser, so it wins
; whenever the uninstaller runs in place, i.e. with _?=), the _?= value (any caller text; the self-copy in
; %TEMP%\~nsuX.tmp passes the /D= value there) and $EXEDIR (the temp copy's folder).
!macro sibersentezPinProgramDir
  SetShellVarContext current
  ReadRegStr $sibersentezDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  !insertmacro sibersentezPinDir $sibersentezDir $LOCALAPPDATA $PROFILE
!macroend

; The pin itself, apart from the registry read so the tests can run it with made-up folders: CANDIDATE must be the
; program folder, hold the uninstaller and be a real folder, not a junction or symbolic link (whose target would be
; emptied); then $INSTDIR is set to it. Otherwise the uninstaller stops with exit code 2.
!macro sibersentezPinDir CANDIDATE LOCAL_APP_DATA PROFILE_DIR
  !insertmacro sibersentezCheckProgramDir "${CANDIDATE}" "${LOCAL_APP_DATA}" "${PROFILE_DIR}"
  ${If} $sibersentezReason == ""
  ${AndIfNot} ${FileExists} "$sibersentezDir\${UNINSTALL_FILENAME}"
    StrCpy $sibersentezReason "no SiberSentez uninstaller in it"
  ${EndIf}
  ${If} $sibersentezReason == ""
    ; FILE_ATTRIBUTE_REPARSE_POINT (0x400); a failed call (-1) has every bit set and is refused as well
    Push $sibersentezDir
    System::Call 'kernel32::GetFileAttributesW(w s) i .s'
    Pop $sibersentezTmp
    IntOp $sibersentezTmp $sibersentezTmp & 1024
    ${If} $sibersentezTmp != 0
      StrCpy $sibersentezReason "the folder is a link"
    ${EndIf}
  ${EndIf}
  ${If} $sibersentezReason != ""
    !insertmacro sibersentezRefuse sibersentezMsgNotUninstalled
  ${EndIf}
  StrCpy $INSTDIR "${LOCAL_APP_DATA}\Programs\${APP_FILENAME}"
!macroend

; Sets $sibersentezReason to "" when VALUE (an UninstallString) is empty or starts with the program folder's uninstaller
; in quotes: "LOCAL_APP_DATA\Programs\<app folder name>\<uninstaller file>" (case-insensitive, like Windows), which is
; how the installer writes it. electron-builder's uninstallOldVersion runs a copy of the file between the first two
; quotes and, when InstallLocation is empty, passes that file's folder as _?=. With this start, that file is the
; program folder's uninstaller and its folder is the program folder. $sibersentezDir keeps VALUE for the refusal message.
; Pure string checks, nothing is touched.
!macro sibersentezCheckUninstallString VALUE LOCAL_APP_DATA
  StrCpy $sibersentezDir "${VALUE}"
  StrCpy $sibersentezReason ""
  ${If} $sibersentezDir != ""
    StrCpy $sibersentezTmp `"${LOCAL_APP_DATA}\Programs\${APP_FILENAME}\${UNINSTALL_FILENAME}"`
    ; $sibersentezReason holds the length of that start, then the same number of characters of VALUE
    StrLen $sibersentezReason $sibersentezTmp
    StrCpy $sibersentezReason $sibersentezDir $sibersentezReason
    ${If} "${LOCAL_APP_DATA}" == ""
    ${OrIf} $sibersentezReason != $sibersentezTmp
      StrCpy $sibersentezReason "the uninstall entry names another program"
    ${Else}
      StrCpy $sibersentezReason ""
    ${EndIf}
  ${EndIf}
!macroend

; Sets $sibersentezReason to "" only when everything electron-builder's install section acts on passes the uninstaller's
; check: INSTALL_DIR (the folder it installs into), INSTALL_LOCATION when set, and UNINSTALL_STRING when set. The old
; uninstaller that runs is then always the program folder's own, and its _?= is always the program folder, whether
; uninstallOldVersion takes that folder from InstallLocation or, when InstallLocation is empty, from UninstallString.
; Apart from the registry reads so the tests can run it with made-up values.
!macro sibersentezCheckInstallDirs INSTALL_DIR INSTALL_LOCATION UNINSTALL_STRING LOCAL_APP_DATA PROFILE_DIR
  !insertmacro sibersentezCheckProgramDir "${INSTALL_DIR}" "${LOCAL_APP_DATA}" "${PROFILE_DIR}"
  ${If} $sibersentezReason == ""
    !insertmacro sibersentezCheckUninstallString "${UNINSTALL_STRING}" "${LOCAL_APP_DATA}"
  ${EndIf}
  ${If} $sibersentezReason == ""
  ${AndIf} "${INSTALL_LOCATION}" != ""
    !insertmacro sibersentezCheckProgramDir "${INSTALL_LOCATION}" "${LOCAL_APP_DATA}" "${PROFILE_DIR}"
  ${EndIf}
!macroend

; Installer: the folder it installs into and the values the template's uninstallOldVersion reads again before it runs
; the old uninstaller (InstallLocation, and UninstallString from the same keys it uses) must pass the uninstaller's
; check. $R8 and $R9 hold the two values and are restored afterwards.
!macro sibersentezRecheckInstallDir
  SetShellVarContext current
  Push $R8
  Push $R9
  ReadRegStr $R8 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R9 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ${If} $R9 == ""
      ReadRegStr $R9 HKCU "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    ${EndIf}
  !endif
  !insertmacro sibersentezCheckInstallDirs $INSTDIR $R8 $R9 $LOCALAPPDATA $PROFILE
  Pop $R9
  Pop $R8
  ${If} $sibersentezReason != ""
    !insertmacro sibersentezRefuse sibersentezMsgInstallDir
  ${EndIf}
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${APP_FILENAME}"
!macroend

; --- Install -------------------------------------------------------------------------------------------
; initMultiUser (in .onInit) reads /allusers by itself and would elevate a silent install; customInit runs
; right after it and switches back to the current-user mode.
; A custom folder from /D=... is refused: the program folder is deleted on uninstall, so it must stay the
; default %LOCALAPPDATA%\Programs\SiberSentez and can never be a folder that holds user data. The folder the
; template picked (InstallLocation of an earlier install, otherwise the per-user program files folder) must
; pass the same check as in the uninstaller, so every installed copy can also be uninstalled.
!macro customInit
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  !insertmacro setInstallModePerUser
  !insertmacro GetDParameter $R0
  ${If} $R0 != ""
    MessageBox MB_ICONSTOP|MB_OK "$(sibersentezMsgNoCustomDir)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  !insertmacro sibersentezRecheckInstallDir
!macroend

; Replaces the end of electron-builder's handleUninstallResult, which runs right after the old uninstaller: when that
; uninstaller did not finish (exit code in $R0 other than 0) the template shows "uninstallFailed" in a message box
; without /SD, which also opens during a silent update and waits for someone to press OK. Here the box has /SD IDOK,
; the text is a LangString, and the installer stops with exit code 2 before any new file is written. An old uninstaller
; that could not be started at all (error flag) is only noted, as the template does, and the install goes on.
!macro customUnInstallCheck
  ${If} ${Errors}
    DetailPrint "Uninstall was not successful. Not able to launch uninstaller!"
  ${ElseIf} $R0 != 0
    DetailPrint "Uninstall was not successful. Uninstaller error code: $R0."
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(sibersentezMsgOldVersionKept)$\r$\n$\r$\n($R0)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

; The same for the template's HKEY_CURRENT_USER pass (only reached in the all-users mode, which never exists here)
!macro customUnInstallCheckCurrentUser
  !insertmacro customUnInstallCheck
!macroend

; --- Closing the running app (installer and uninstaller) ------------------------------------------------
; electron-builder's CHECK_APP_RUNNING inserts this macro instead of its own check. Its own check stops every
; process whose path starts with '$INSTDIR' (the folder pasted into a PowerShell string, and in the uninstaller
; before the folder was pinned), or, without PowerShell, every SiberSentez.exe of the user by name. Here the folder
; is confirmed first (the uninstaller pins it, the installer checks it again), then only processes whose exe lies
; inside that folder are closed.
!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    !insertmacro sibersentezPinProgramDir
  !else
    !insertmacro sibersentezRecheckInstallDir
  !endif
  !insertmacro sibersentezCloseApp $LOCALAPPDATA
!macroend

; The processes to close, as PowerShell text. The folder comes from an environment variable, never from the command
; text, so no character in it (a quote, for example) can change the command. It must end with a backslash, so a
; sibling such as ...\Programs\SiberSentez2 does not match by prefix. Ordinal comparison: independent of the user's
; culture (the Turkish dotless i). The uninstaller's own process is left out (it may run in place with _?=).
!define SIBERSENTEZ_PS_APP_PROCESSES "$$d = $$env:SIBERSENTEZ_PROGRAM_DIR; $$s = [int]$$env:SIBERSENTEZ_SELF_PID; if (-not $$d -or $$d.Length -lt 4 -or -not $$d.EndsWith('\')) { exit 2 }; $$p = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ProcessId -ne $$s -and $$_.ExecutablePath.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) })"

; $0: 0 when Windows PowerShell runs and may run commands, anything else otherwise. The same two checks as electron-
; builder's IS_POWERSHELL_AVAILABLE, which starts PowerShell with neither switch: -NoProfile keeps the user's profile
; script from running inside the installer or uninstaller (one that waits for input would hang a silent run), and
; -NonInteractive makes anything that would prompt fail instead.
!macro sibersentezPowerShellWorks
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -Command "if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"`
  Pop $0
  ${If} $0 == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -Command "if ((Get-ExecutionPolicy -Scope Process) -eq 'Restricted') { exit 1 } else { exit 0 }"`
    Pop $0
  ${EndIf}
!macroend

; $R0: 0 = a process of the program folder runs, 1 = none, anything else = the check itself failed
!macro sibersentezFindAppProcess
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -Command "${SIBERSENTEZ_PS_APP_PROCESSES}; if ($$p.Count -gt 0) { exit 0 }; exit 1"`
  Pop $R0
!macroend

!macro sibersentezStopAppProcesses FORCE
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -Command "${SIBERSENTEZ_PS_APP_PROCESSES}; $$p | ForEach-Object { Stop-Process -Id $$_.ProcessId${FORCE} -ErrorAction SilentlyContinue }"`
  Pop $0
!macroend

; Closes the app's processes in the program folder, the same flow as electron-builder's check (ask unless it is an
; update, close, then force-close, then ask the user to close it). Registers $0, $R0 and $R1 are used as the
; template's own check uses them.
!macro sibersentezCloseApp LOCAL_APP_DATA
  ; Only ever the pinned program folder (the pin or the check right before this set it)
  ${If} "${LOCAL_APP_DATA}" == ""
  ${OrIf} $INSTDIR != "${LOCAL_APP_DATA}\Programs\${APP_FILENAME}"
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $0 "$INSTDIR\"
  System::Call 'kernel32::SetEnvironmentVariableW(w "SIBERSENTEZ_PROGRAM_DIR", w r0) i'
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  System::Call 'kernel32::SetEnvironmentVariableW(w "SIBERSENTEZ_SELF_PID", w r0) i'
  ; Windows PowerShell rebuilds its module path when none is inherited; a PowerShell 7 session's value (when the
  ; uninstaller is started from pwsh) makes it fail to load its own modules
  System::Call 'kernel32::SetEnvironmentVariableW(w "PSModulePath", p 0) i'
  !insertmacro sibersentezPowerShellWorks
  ${If} $0 == 0
    ${If} ${isUpdated}
      Sleep 300 ; the app may still be exiting by itself
    ${EndIf}
    !insertmacro sibersentezFindAppProcess
    ${If} $R0 == 0
      ${IfNot} ${isUpdated}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
        Quit
      ${Else}
        Sleep 1000
      ${EndIf}
      DetailPrint "$(appClosing)"
      !insertmacro sibersentezStopAppProcesses ""
      Sleep 300
      StrCpy $R1 0
      ${Do}
        IntOp $R1 $R1 + 1
        !insertmacro sibersentezFindAppProcess
        ${If} $R0 != 0
          ${ExitDo}
        ${EndIf}
        Sleep 1000
        !insertmacro sibersentezStopAppProcesses " -Force"
        !insertmacro sibersentezFindAppProcess
        ${If} $R0 != 0
          ${ExitDo}
        ${EndIf}
        Sleep 2000
        ${If} $R1 > 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY +2
          Quit
        ${EndIf}
      ${Loop}
    ${EndIf}
  ${Else}
    ; Without PowerShell nothing is closed by name: while the app's exe is in use (a running exe cannot be opened
    ; for writing) the user is asked to close it
    ${Do}
      ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        ${ExitDo}
      ${EndIf}
      ClearErrors
      FileOpen $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" a
      ${IfNot} ${Errors}
        FileClose $0
        ${ExitDo}
      ${EndIf}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY +2
      Quit
    ${Loop}
  ${EndIf}
!macroend

; --- Removing folders without following links -------------------------------------------------------------
; NSIS's own RMDir /r (3.0.4) enters junctions and deletes the files of their targets. This function empties the
; folder on the stack and returns on the stack how many entries could not be removed. A junction or symbolic link
; inside is removed itself (RMDir or Delete of the link); what it points to is never entered. The uninstaller file
; in $INSTDIR is left for the caller, which removes it last. Only an absolute drive path ("X:\...") is emptied.
!macro sibersentezEmptyFolderFunction
  Function ${SIBERSENTEZ_UN}sibersentezEmptyFolder
    Exch $R0 ; folder
    Push $R1 ; search handle
    Push $R2 ; entry name
    Push $R3 ; attributes, or the failures of a subfolder
    Push $R4 ; full path of the entry
    Push $R5 ; failures
    StrCpy $R5 0
    StrCpy $R3 $R0 2 1
    StrLen $R4 $R0
    ${If} $R3 != ":\"
    ${OrIf} $R4 < 4
      StrCpy $R5 1
    ${Else}
      FindFirst $R1 $R2 "$R0\*.*"
      ${DoWhile} $R2 != ""
        ${If} $R2 != "."
        ${AndIf} $R2 != ".."
          StrCpy $R4 "$R0\$R2"
          ${If} $R4 != "$INSTDIR\${UNINSTALL_FILENAME}"
            System::Call 'kernel32::GetFileAttributesW(w R4) i .R3'
            ${If} $R3 <> -1
              ; directory (0x10) and reparse point (0x400) bits
              IntOp $R3 $R3 & 1040
              ClearErrors
              ${If} $R3 = 1040
                RMDir $R4 ; a junction or a directory symbolic link: the link only
              ${ElseIf} $R3 = 1024
                Delete $R4 ; a file symbolic link: the link only
              ${ElseIf} $R3 = 16
                Push $R4
                Call ${SIBERSENTEZ_UN}sibersentezEmptyFolder
                Pop $R3
                IntOp $R5 $R5 + $R3
                ClearErrors
                RMDir $R4
              ${Else}
                Delete $R4
              ${EndIf}
              ${If} ${Errors}
                IntOp $R5 $R5 + 1
              ${EndIf}
            ${EndIf}
          ${EndIf}
        ${EndIf}
        FindNext $R1 $R2
      ${Loop}
      FindClose $R1
    ${EndIf}
    StrCpy $R0 $R5
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
  FunctionEnd
!macroend

; Moves every entry of one folder into another, each as a whole and as itself (Rename): a file, a real folder with
; everything in it, or a junction or symbolic link (the link is renamed, what it points to is never entered). Nothing
; is copied or deleted. Windows refuses to rename a file in use, and a folder holding one, so such an entry stays where
; it is. Left out: the uninstaller file in $INSTDIR, and the target folder when it lies in the source folder.
; Stack: push the target folder, then the source folder; returns on the stack how many entries could not be moved.
!macro sibersentezMoveEntriesFunction
  Function ${SIBERSENTEZ_UN}sibersentezMoveEntries
    Exch $R0 ; source folder
    Exch
    Exch $R1 ; target folder
    Push $R2 ; search handle
    Push $R3 ; entry name
    Push $R4 ; full path of the entry
    Push $R5 ; failures
    StrCpy $R5 0
    FindFirst $R2 $R3 "$R0\*.*"
    ${DoWhile} $R3 != ""
      ${If} $R3 != "."
      ${AndIf} $R3 != ".."
        StrCpy $R4 "$R0\$R3"
        ${If} $R4 != "$INSTDIR\${UNINSTALL_FILENAME}"
        ${AndIf} $R4 != $R1
          ClearErrors
          Rename $R4 "$R1\$R3"
          ${If} ${Errors}
            IntOp $R5 $R5 + 1
          ${EndIf}
        ${EndIf}
      ${EndIf}
      FindNext $R2 $R3
    ${Loop}
    FindClose $R2
    StrCpy $R0 $R5
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
  FunctionEnd
!macroend

; customHeader is inserted at the top level after common.nsh (which defines UNINSTALL_FILENAME)
!macro customHeader
  !ifdef BUILD_UNINSTALLER
    !insertmacro sibersentezEmptyFolderFunction
    !insertmacro sibersentezMoveEntriesFunction
  !endif
!macroend

; Removes DIR without following links: a missing DIR is fine, a DIR that is itself a link loses only the link
!macro sibersentezRemoveFolder DIR
  StrCpy $0 "${DIR}"
  System::Call 'kernel32::GetFileAttributesW(w r0) i .r1'
  ${If} $1 <> -1
    IntOp $1 $1 & 1024
    ${If} $1 != 0
      RMDir "${DIR}"
    ${Else}
      Push "${DIR}"
      Call ${SIBERSENTEZ_UN}sibersentezEmptyFolder
      Pop $1
      RMDir "${DIR}"
    ${EndIf}
  ${EndIf}
!macroend

; Removes the pinned program folder.
; During an update nothing is deleted before the whole old version is out of the way. Every entry of the folder is
; first moved into a new staging folder inside it, ~sibersentez-old-<process id> (same volume, nothing entered). When one
; cannot be moved (a file in use, or a folder holding one), everything moved so far goes back, nothing is deleted and
; the uninstaller stops with exit code 2, keeping its own file in the folder: the new installer retries while the exit
; code is not 0, and each retry must be able to pin the folder again. Once everything is moved, the staging folder is
; emptied without following links; what still cannot be deleted stays in it (the next update or the uninstall removes
; it) and the update goes on, since the old version no longer occupies the folder.
; A real uninstall removes what it can and goes on, as electron-builder's own removal does.
!macro sibersentezRemoveProgramDir
  SetOutPath $TEMP
  ${If} ${isUpdated}
    System::Call 'kernel32::GetCurrentProcessId() i .r0'
    StrCpy $1 "$INSTDIR\~sibersentez-old-$0"
    ; A new real folder: CreateDirectoryW fails when the name already exists (a folder, a file or a link)
    System::Call 'kernel32::CreateDirectoryW(w r1, p 0) i .r0'
    ${If} $0 = 0
      DetailPrint "Staging folder could not be created: $1"
      SetErrorLevel 2
      Abort
    ${EndIf}
    Push $1
    Push $INSTDIR
    Call ${SIBERSENTEZ_UN}sibersentezMoveEntries
    Pop $0
    ${If} $0 != 0
      DetailPrint "$0 entries are in use; the previous version is restored and nothing is removed"
      Push $INSTDIR
      Push $1
      Call ${SIBERSENTEZ_UN}sibersentezMoveEntries
      Pop $0
      RMDir $1
      SetErrorLevel 2
      Abort
    ${EndIf}
    Push $1
    Call ${SIBERSENTEZ_UN}sibersentezEmptyFolder
    Pop $0
    RMDir $1
  ${Else}
    Push $INSTDIR
    Call ${SIBERSENTEZ_UN}sibersentezEmptyFolder
    Pop $0
  ${EndIf}
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  RMDir $INSTDIR
!macroend

; --- Uninstall -----------------------------------------------------------------------------------------
; un.onInit runs initMultiUser (which may take $INSTDIR from /D=) and then this macro: the folder is pinned
; to the checked one, or the uninstaller quits with nothing changed. (A silent uninstall has already pinned it
; once in un.checkAppRunning, before any process is closed.)
!macro customUnInit
  StrCpy $installMode CurrentUser
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  !insertmacro sibersentezPinProgramDir
!macroend

; Pinned again right before the uninstall section removes anything: when the uninstaller is not silent, its
; install-mode page runs after un.onInit and calls setInstallModePerUser, which reads /D= once more.
; Then, only on a real uninstall (not during an update):
; - the "Start at login" entry the app may have written (value name = LOGIN_ITEM_NAME in electron/helpers.mjs);
; - the installer copy electron-builder keeps for updates in %LOCALAPPDATA%\sibersentez-updater (about 110 MB).
; The hub folder lives outside the program folder and is never touched here.
!macro customUnInstall
  !insertmacro sibersentezPinProgramDir
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "app.sibersentez.panel"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "app.sibersentez.panel"
    ${if} "$LOCALAPPDATA" != ""
      !insertmacro sibersentezRemoveFolder "$LOCALAPPDATA\sibersentez-updater"
    ${endif}
  ${endIf}
!macroend

; Replaces the template's removal of $INSTDIR (RMDir /r, and during an update a rename of every file into the
; plugins folder; both enter junctions): pinned once more, then removed without following links.
!macro customRemoveFiles
  !insertmacro sibersentezPinProgramDir
  !insertmacro sibersentezRemoveProgramDir
!macroend
