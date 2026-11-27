#!/usr/bin/env python3
"""Read-only probe from the TV via the normal app route, run on the ADB host."""
import argparse
import base64
import concurrent.futures
import re
import secrets
import socket
import ssl
import struct
import subprocess

TV = "192.168.1.144"
ADB = ["adb", "-s", TV + ":5555", "shell", "-T"]
host = "i.ytimg.com"


def dns(tcp, port):
    tid = secrets.token_bytes(2)
    labels = b"".join(bytes([len(label)]) + label.encode() for label in host.split("."))
    query = tid + struct.pack("!5H", 256, 1, 0, 0, 0) + labels + b"\0\0\1\0\1"
    wire = struct.pack("!H", len(query)) + query if tcp else query
    data = base64.b64encode(wire).decode()
    bb = "/data/local/tmp/busybox"
    command = (f"(echo {data} | {bb} base64 -d; sleep 1) | "
               f"{bb} nc -n {' ' if tcp else '-u'} -p {port} -w 2 8.8.8.8 53")
    out = subprocess.run(ADB + [command], capture_output=True, timeout=8, check=True).stdout
    if tcp:
        assert len(out) >= 2 and len(out) - 2 == int.from_bytes(out[:2], "big")
        out = out[2:]
    assert len(out) >= 12 and out[:2] == tid and out[2] & 128 and out[3] & 15 == 0
    assert out[12:len(query)].lower() == query[12:] and int.from_bytes(out[6:8], "big") > 0
    return int.from_bytes(out[6:8], "big")


def https(port):
    # ADB carries TLS bytes to/from a normal TV TCP socket. Certificate and
    # hostname are verified on the ADB host; no cached application session is used.
    address = socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
    a, b = socket.socketpair()
    with a, b, subprocess.Popen(ADB + [f"/data/local/tmp/busybox nc -n -p {port} -w 4 {address} 443"],
                                 stdin=b, stdout=b, stderr=subprocess.DEVNULL) as proc:
        b.close()
        a.settimeout(6)
        try:
            with ssl.create_default_context().wrap_socket(a, server_hostname=host) as tls:
                tls.sendall(f"GET /vi/jNQXAC9IVRw/default.jpg HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\n\r\n".encode())
                data = bytearray()
                while len(data) < 32768:
                    chunk = tls.recv(8192)
                    if not chunk:
                        break
                    data.extend(chunk)
                    hdr, sep, body = data.partition(b"\r\n\r\n")
                    length = re.search(rb"\r\nContent-Length: *(\d+)", hdr, re.I)
                    if sep and length and len(body) >= int(length[1]):
                        break
                headers, body = data.split(b"\r\n\r\n", 1)
                assert b" 200 " in headers.splitlines()[0] and body.startswith(b"\xff\xd8\xff") and body.endswith(b"\xff\xd9")
                return len(body)
        finally:
            proc.terminate()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("expected", choices=["192.168.1.19", "192.168.1.254"])
    args = parser.parse_args()
    neighbour = subprocess.check_output(ADB + [f"ip neigh show to {args.expected} dev eth0"], text=True)
    mac = re.search(r"lladdr ([0-9a-f:]{17})", neighbour).group(1)
    port = 30000 + secrets.randbelow(18000)
    capture = (f"/system/xbin/su 0 timeout 8 tcpdump -p -i eth0 -e -q -nn -l "
               f"'src host {TV} and src portrange {port}-{port+2} and (dst port 443 or dst port 53)'")
    with subprocess.Popen(ADB + [capture], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as proc:
        try:
            while True:
                line = proc.stderr.readline()
                if not line:
                    raise RuntimeError("tcpdump failed to start")
                if "listening on" in line:
                    break
            with concurrent.futures.ThreadPoolExecutor(3) as pool:
                udp = pool.submit(dns, False, port)
                tcp = pool.submit(dns, True, port + 1)
                web = pool.submit(https, port + 2)
                print(f"DNS answers UDP={udp.result()} TCP={tcp.result()}, TLS JPEG bytes={web.result()}")
            packets, _ = proc.communicate(timeout=10)
        finally:
            proc.terminate()
    for offset, target in [(0, re.escape(args.expected)+r"\.53"), (1, re.escape(args.expected)+r"\.53"),
                           (2, r"[0-9.]+\.443")]:
        assert any(f"> {mac}," in line and re.search(rf"{re.escape(TV)}\.{port+offset} > {target}:", line)
                   for line in packets.splitlines()), f"missing next-hop evidence for source port {port+offset}: {packets[:1300]}"
    print(f"Verified outbound Ethernet next hop {args.expected} ({mac}) for DNS UDP, DNS TCP and HTTPS")


if __name__ == "__main__":
    main()
