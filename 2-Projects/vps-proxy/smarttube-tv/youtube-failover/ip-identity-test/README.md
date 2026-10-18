# DNS TLS 身份与生产形态一致性测试

仅本地一次性验证；没有修改guard Java源码、DEX或默认配置，也没有操作电视。

运行：`./run.sh`。使用已有JDK/SDK以及父目录build/classes、build/json.jar（先执行父目录build.sh及test.sh，可用TASK_BUILD_DIR覆盖）。证书、测试密码和临时配置在0700临时目录生成，结束自动删除，无外部网络请求。

7项验证均通过：

1. Config.load接受并原样保留dns.server_name=1.1.1.1。
2. dns.server_ip仍为1.1.1.1。
3. 实际回环SOCKS→TLS→DoT，正确IP SAN1.1.1.1成功。
4. TLS ClientHello不包含SNI（JVM TLS服务端读取真实ExtendedSSLSession）。
5. SOCKS CONNECT目标仍为数值1.1.1.1:853。
6. 证书受信任但IP SAN=1.0.0.1，必须SSLHandshakeException。
7. 证书受信任且DNS SAN=cloudflare-dns.com，但无1.1.1.1 IP SAN，必须SSLHandshakeException。

因此numeric server_name不是关闭验证，而是严格验证IP SAN，并与原生产DoT（server=1.1.1.1，无域名TLS server_name）保持同样身份与SNI形态。

父任务的真实Android正锚（2026-10-18）进一步确认：执行原生产dotProbe、仅设dnsName=1.1.1.1后，SOCKS19111 Rack返回161字节/1525ms，19112 ZGO返回161字节/1961ms。父任务随后只重启guardian，主proxy及两worker PID保持。这里记录的是父任务回报，测试作者没有操作设备。

参考Android11 AOSP Conscrypt源码亦符合实测：

- NativeSsl.java 348行：仅当getUseSni且AddressUtils.isValidSniHostname(hostname)时设置TLS SNI。
- AddressUtils.java 38–48行：isValidSniHostname明确排除literal IP。
- TrustManagerImpl.java 403–409行：endpoint identification为HTTPS时，必须经过hostname verifier；不匹配subjectAltNames则失败。

来源：
https://android.googlesource.com/platform/external/conscrypt/+/refs/tags/android-11.0.0_r1/common/src/main/java/org/conscrypt/NativeSsl.java
https://android.googlesource.com/platform/external/conscrypt/+/refs/tags/android-11.0.0_r1/common/src/main/java/org/conscrypt/AddressUtils.java
https://android.googlesource.com/platform/external/conscrypt/+/refs/tags/android-11.0.0_r1/common/src/main/java/org/conscrypt/TrustManagerImpl.java

此前“ZGO可能按TLS域名SNI做destOverride”仍为解释线索，不能把它写成已查实服务器配置；已经直接验明的是域名TLS身份与IP TLS身份的实际表现不同，以及IP身份与生产一致后Android两lane均通过。
