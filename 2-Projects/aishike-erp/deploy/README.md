# ERPNext 测试环境部署

本目录用于在公司 Ubuntu 虚拟机上部署独立的爱视可 ERPNext 测试环境。

## 安全边界

- Web 端口只绑定虚拟机 `127.0.0.1:18080`；
- 不开放公网 80/443，不修改现有 FRP 与 SSH 端口；
- 浏览器通过本机 SSH 隧道访问；
- 数据库和管理员密码自动生成在 `deploy/secrets/`，不进入 Git；
- Docker Hub 在公司网络中解析异常，测试环境使用摘要锁定的镜像代理，摘要已与官方仓库逐项核对；
- 这是测试环境，正式上线前仍需域名、HTTPS、备份、监控和恢复演练。

## 服务器执行顺序

```bash
cd ~/aishike-erp
./deploy/prepare-host.sh
```

重新连接服务器后：

```bash
cd ~/aishike-erp
./deploy/bootstrap.sh
```

## 本机访问

```bash
ssh -N -L 18081:127.0.0.1:18080 company-vm
```

然后浏览器打开 `http://aishike.localhost:18081`，使用 `Administrator` 登录。
必须使用该地址而不是裸 `127.0.0.1`，以确保实时通知与后台任务进度连接正常。
本机 `18080` 已被 MyCC 使用，因此 ERP 隧道固定使用本机 `18081`；服务器端仍保持 `127.0.0.1:18080`。

管理员密码只在需要人工登录时从服务器读取：

```bash
ssh company-vm 'cat ~/aishike-erp/deploy/secrets/admin_password.txt'
```

## 运行检查

```bash
cd ~/aishike-erp
./deploy/doctor.sh
```

检查内容包括容器状态、站点应用列表、六个爱视可 DocType、SN 工作台和 HTTP 接口。
