#!/bin/sh
# ssh/scp 的无交互密码回退。密码只从进程环境读取，不写文件、不进 argv。
printf '%s\n' "${VPS_ROOT_PASS:?VPS_ROOT_PASS is required}"
