@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ==============================
echo   Xray Manager 安装程序 (Windows)
echo ==============================
echo.

set "XRAY_HOME=%USERPROFILE%\xray"
set "XRAY_BIN=%XRAY_HOME%\xray.exe"
set "CONFIG_PATH=%XRAY_HOME%\config.json"
set "LOG_PATH=%XRAY_HOME%\xray.log"
set "MANAGER=%XRAY_HOME%\xray-manager.py"
set "TASK_NAME=XrayProxy"
set "SCRIPT_DIR=%~dp0"

:: 1. 创建目录
echo [1/7] 创建目录 %XRAY_HOME% ...
if not exist "%XRAY_HOME%" mkdir "%XRAY_HOME%"

:: 2. 检查/复制 xray
echo [2/7] 检查 xray ...
if exist "%XRAY_BIN%" (
    echo   已存在: %XRAY_BIN%
) else (
    :: 尝试从 V2RayN 复制
    set "V2RAYN_DIR=%LOCALAPPDATA%\v2rayN\bin\xray"
    if exist "!V2RAYN_DIR!\xray.exe" (
        echo   从 V2RayN 复制 xray ...
        copy "!V2RAYN_DIR!\xray.exe" "%XRAY_BIN%" >nul
    ) else (
        echo   请手动下载 xray-core 到 %XRAY_BIN%
        echo   下载地址: https://github.com/XTLS/Xray-core/releases
        echo   选择 Xray-windows-64.zip
        pause
    )
)

:: 3. 复制 geo 文件
echo [3/7] 复制 GeoIP/GeoSite 数据文件 ...
set "V2RAYN_BIN=%LOCALAPPDATA%\v2rayN\bin"
for %%f in (geoip.dat geosite.dat) do (
    if not exist "%XRAY_HOME%\%%f" (
        if exist "%V2RAYN_BIN%\%%f" (
            copy "%V2RAYN_BIN%\%%f" "%XRAY_HOME%\%%f" >nul
            echo   %%f 已复制
        ) else if exist "%SCRIPT_DIR%\%%f" (
            copy "%SCRIPT_DIR%\%%f" "%XRAY_HOME%\%%f" >nul
            echo   %%f 已从安装包复制
        ) else (
            echo   [!] %%f 未找到，请手动下载
        )
    ) else (
        echo   %%f 已存在
    )
)

:: 4. 复制配置
echo [4/7] 复制配置文件 ...
if not exist "%CONFIG_PATH%" (
    if exist "%SCRIPT_DIR%config\config.json" (
        copy "%SCRIPT_DIR%config\config.json" "%CONFIG_PATH%" >nul
        echo   配置已复制
    ) else (
        echo   [!] 未找到配置模板，请手动配置 %CONFIG_PATH%
    )
) else (
    echo   配置已存在
)

:: 5. 复制管理工具
echo [5/7] 安装管理工具 ...
copy "%SCRIPT_DIR%xray-manager.py" "%MANAGER%" >nul
echo   管理工具已安装

:: 6. 注册 Windows 任务计划（开机自启）
echo [6/7] 配置开机自启 ...
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1
schtasks /Create /TN "%TASK_NAME%" /TR "\"%XRAY_BIN%\" run -c \"%CONFIG_PATH%\"" /SC ONLOGON /RL HIGHEST /F >nul
if !errorlevel! equ 0 (
    echo   任务计划已注册
) else (
    echo   [!] 任务计划注册失败，请以管理员身份运行
)

:: 7. 配置代理环境变量
echo [7/8] 配置代理环境变量 ...
setx http_proxy "http://127.0.0.1:20171" >nul 2>&1
setx https_proxy "http://127.0.0.1:20171" >nul 2>&1
setx no_proxy "localhost,127.0.0.1" >nul 2>&1
echo   http_proxy/https_proxy 已设置为 http://127.0.0.1:20171

:: 8. 启动 xray
echo [8/8] 启动 xray ...
taskkill /F /IM xray.exe >nul 2>&1
timeout /t 1 /nobreak >nul
start /B "" "%XRAY_BIN%" run -c "%CONFIG_PATH%" >"%LOG_PATH%" 2>&1
timeout /t 2 /nobreak >nul

:: 验证
tasklist /FI "IMAGENAME eq xray.exe" /NH | find "xray.exe" >nul
if !errorlevel! equ 0 (
    echo.
    echo   Xray 运行中
) else (
    echo   [!] Xray 未启动，查看日志: type %LOG_PATH%
)

echo.
echo ==============================
echo   安装完成!
echo ==============================
echo.
echo 使用方法:
echo   python "%MANAGER%"          启动 Web 管理界面
echo   浏览器打开 http://127.0.0.1:8888
echo.
echo 代理端口:
echo   SOCKS 代理:  127.0.0.1:10808
echo   HTTP 代理:   127.0.0.1:20171
echo.
echo 环境变量 http_proxy/https_proxy 已设置（新终端窗口生效）
echo CLI 工具 (claude, npm, curl 等) 将自动使用 HTTP 代理
echo.
echo 如需系统全局代理，在 Windows 设置 - 网络 - 代理 中配置:
echo   手动代理: 127.0.0.1:10808
echo.
pause
