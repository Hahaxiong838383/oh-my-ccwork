#!/usr/bin/env python3
"""Studio Ollama 网络暴露:0.0.0.0:11435 → 127.0.0.1:11434。

绕开 Electron Ollama app 只听 127.0.0.1 的限制(app 不读 OLLAMA_HOST),
纯 TCP 双向转发,不动 app。worker(dev198) 连 10.9.1.155:11435 即可用 Studio gemma4。
持久化:setsid nohup 后台跑(或后续 launchd)。"""
import socket
import threading

LISTEN = ("0.0.0.0", 11435)
TARGET = ("127.0.0.1", 11434)


def pipe(a: socket.socket, b: socket.socket) -> None:
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except Exception:
        pass
    finally:
        for s in (a, b):
            try:
                s.close()
            except Exception:
                pass


def main() -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(128)
    print(f"forwarding {LISTEN[0]}:{LISTEN[1]} -> {TARGET[0]}:{TARGET[1]}", flush=True)
    while True:
        client, _ = srv.accept()
        try:
            upstream = socket.create_connection(TARGET, timeout=5)
        except Exception:
            client.close()
            continue
        threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
        threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()


if __name__ == "__main__":
    main()
