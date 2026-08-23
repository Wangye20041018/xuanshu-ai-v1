; 玄枢AI 自定义 NSIS 安装脚本
; 此文件通过 electron-builder 的 nsis.include 引入

!include "MUI2.nsh"

; 自定义 VC 运行时安装检测
!macro CheckVCRedist
  ReadRegDword $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\X64" "Installed"
  ReadRegDword $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64" "Installed"

  ${If} $0 == "1"
  ${OrIf} $1 == "1"
    DetailPrint "VC++ Redistributable 已安装，跳过"
  ${Else}
    DetailPrint "正在安装 VC++ Redistributable..."
    ExecWait '"$INSTDIR\resources\vc_redist\vc_redist.x64.exe" /quiet /norestart' $0
    ${If} $0 != "0"
      DetailPrint "VC++ Redistributable 安装返回码: $0"
    ${EndIf}
  ${EndIf}
!macroend

; 自定义安装后操作：修正桌面快捷方式
!macro customInstall
  ; 删除可能错误的默认快捷方式
  Delete "$DESKTOP\玄枢AI.lnk"
  Delete "$SMPROGRAMS\玄枢AI\玄枢AI.lnk"
  
  ; 创建桌面快捷方式（使用正确的exe路径和ico图标）
  CreateShortCut "$DESKTOP\玄枢AI.lnk" "$INSTDIR\玄枢AI.exe" "" "$INSTDIR\resources\icons\icon.ico" 0 SW_SHOWNORMAL
  
  ; 创建开始菜单快捷方式
  CreateDirectory "$SMPROGRAMS\玄枢AI"
  CreateShortCut "$SMPROGRAMS\玄枢AI\玄枢AI.lnk" "$INSTDIR\玄枢AI.exe" "" "$INSTDIR\resources\icons\icon.ico" 0 SW_SHOWNORMAL
!macroend

; 自定义卸载操作
!macro customUnInstall
  Delete "$DESKTOP\玄枢AI.lnk"
  RMDir /r "$SMPROGRAMS\玄枢AI"
!macroend
