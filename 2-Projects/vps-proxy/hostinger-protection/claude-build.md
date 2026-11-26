## Hostinger 的构建和备份约定

在 ~/mycc/2-Projects/ 下开发。在 Bash 中用 `hostinger-build 命令 参数...` 运行编译、打包、大型测试、依赖安装和大批量克隆。例如 `hostinger-build npm ci`、`hostinger-build python3 -m pytest`。收到磁盘空间不足提示时先查看告警。普通 Git 查询直接运行。备份包含工作区、未提交文件及本机保存的 Claude 对话，密钥由 Vaultwarden 管理。
