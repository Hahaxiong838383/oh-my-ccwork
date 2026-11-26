#!/usr/bin/env python3
"""TV DNS relay. Keep sing-box DNS primary; retry selected A queries via independent DoT."""
import argparse
import asyncio
import json
import logging
from pathlib import Path
import socket
import ssl
import struct
import time

MEDIA_DOMAINS = tuple(tuple(name.split(b".")) for name in (
    b"youtube.com", b"googlevideo.com", b"ytimg.com", b"youtubei.googleapis.com"))
DOT_PATHS = (("hk-hy2", "8.8.8.8", "dns.google"),
             ("hk-v6", "1.1.1.1", "cloudflare-dns.com"))
PROBE_BASE = 19201  # dsh-gen-probe.py indexes the deployed probe-map.json from this port.
PRIMARY_BUDGET = 1.0
DOT_BUDGET = 1.55
IO_ERRORS = (OSError, TimeoutError, ValueError, asyncio.IncompleteReadError)


def name_at(packet, offset):
    labels = []
    end = None
    seen = set()
    while offset < len(packet) and offset not in seen:
        seen.add(offset)
        length = packet[offset]
        offset += 1
        if length == 0:
            return tuple(labels), end if end is not None else offset
        if length >= 192 and offset < len(packet):
            if end is None:
                end = offset + 1
            offset = ((length & 63) << 8) | packet[offset]
        elif 0 < length < 64 and offset + length <= len(packet) and len(labels) < 127:
            labels.append(packet[offset:offset+length].lower())
            offset += length
        else:
            break
    raise ValueError("invalid DNS name")


def questions(packet):
    if len(packet) < 12:
        raise ValueError("short DNS header")
    count = int.from_bytes(packet[4:6], "big")
    offset = 12
    result = []
    for _ in range(count):
        labels, offset = name_at(packet, offset)
        if offset + 4 > len(packet):
            raise ValueError("short DNS question")
        result.append((labels, *struct.unpack_from("!HH", packet, offset)))
        offset += 4
    return result, offset


def media_a(qs):
    if len(qs) != 1:
        return False
    labels, qtype, qclass = qs[0]
    return (qtype, qclass) == (1, 1) and any(labels[-len(tail):] == tail for tail in MEDIA_DOMAINS)


def check_reply(query, qs, reply):
    if (len(reply) < 12 or reply[:2] != query[:2] or not reply[2] & 0x80
            or (reply[2] ^ query[2]) & 0x78 or questions(reply)[0] != qs):
        raise ValueError("unmatched DNS reply")
    return reply


def frame(data):
    return struct.pack("!H", len(data)) + data


async def read_frame(reader):
    length = int.from_bytes(await reader.readexactly(2), "big")
    return await reader.readexactly(length)


async def primary(host, port, query, tcp):
    if tcp:
        reader, writer = await asyncio.open_connection(host, port)
        try:
            writer.write(frame(query))
            await writer.drain()
            return await read_frame(reader)
        finally:
            writer.close()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setblocking(False)
        loop = asyncio.get_running_loop()
        await loop.sock_connect(sock, (host, port))
        await loop.sock_sendall(sock, query)
        return await loop.sock_recv(sock, 65535)


async def dot(proxy_port, address, hostname, tls, query):
    reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
    try:
        writer.write(b"\x05\x01\x00")
        if await reader.readexactly(2) != b"\x05\x00":
            raise OSError("SOCKS greeting failed")
        writer.write(b"\x05\x01\x00\x01" + socket.inet_aton(address) + struct.pack("!H", 853))
        version, status, reserved, kind = await reader.readexactly(4)
        if (version, status, reserved) != (5, 0, 0):
            raise OSError("SOCKS connect failed")
        if kind == 3:
            size = (await reader.readexactly(1))[0]
        elif kind in (1, 4):
            size = 4 if kind == 1 else 16
        else:
            raise OSError("invalid SOCKS address")
        await reader.readexactly(size + 2)
        await writer.start_tls(tls, server_hostname=hostname)
        writer.write(frame(query))
        await writer.drain()
        return await read_frame(reader)
    finally:
        writer.close()


class Resolver:
    def __init__(self, host, port, probe_map):
        self.host = host
        self.port = port
        self.probe_map = probe_map
        self.tls = ssl.create_default_context()
        self.last_report = {}

    def report(self, path, result):
        key = (path, result)
        now = time.monotonic()
        if now - self.last_report.get(key, -60) >= 60:
            logging.info("media A fallback %s via %s", result, path)
            self.last_report[key] = now

    async def resolve(self, query, tcp=False):
        if len(query) < 12 or query[2] & 0x80:
            return None
        try:
            qs, end = questions(query)
        except ValueError:
            return None
        allowed = not query[2] & 0x78 and media_a(qs)
        original = None
        try:
            reply = await asyncio.wait_for(primary(self.host, self.port, query, tcp),
                                          PRIMARY_BUDGET if allowed else 6)
            original = check_reply(query, qs, reply)
            if not allowed or (reply[3] & 15) != 2:  # Preserve NODATA, NXDOMAIN, REFUSED and TC.
                return original
        except IO_ERRORS:
            pass
        if not allowed:
            return None
        try:
            tags = json.loads(self.probe_map.read_text())
            if not isinstance(tags, list):
                raise ValueError("invalid probe map")
        except (OSError, ValueError):
            tags = []
        for tag, address, hostname in DOT_PATHS:
            if tag not in tags:
                continue
            try:
                reply = await asyncio.wait_for(dot(PROBE_BASE + tags.index(tag), address, hostname,
                                                   self.tls, query), DOT_BUDGET)
                check_reply(query, qs, reply)
                if (reply[3] & 15) not in (0, 3):
                    continue
                self.report(tag, "answered")
                if not tcp and len(reply) > 512:
                    # A conservative truncated reply lets an EDNS or legacy client retry via TCP.
                    return reply[:2] + bytes([reply[2] | 2, reply[3]]) + query[4:6] + bytes(6) + query[12:end]
                return reply
            except IO_ERRORS:
                continue
        self.report("all", "unavailable")
        return original or (query[:2] + bytes([query[2] | 0x80, 0x82]) + query[4:6] + bytes(6) + query[12:end])


class UDP(asyncio.DatagramProtocol):
    def __init__(self, resolver):
        self.resolver = resolver
        self.tasks = set()

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, peer):
        if len(self.tasks) < 128:
            task = asyncio.create_task(self.reply(data, peer))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)

    async def reply(self, query, peer):
        result = await self.resolver.resolve(query)
        if result:
            self.transport.sendto(result, peer)


async def tcp_client(resolver, reader, writer):
    try:
        while True:
            query = await asyncio.wait_for(read_frame(reader), 10)
            result = await resolver.resolve(query, tcp=True)
            if not result:
                return
            writer.write(frame(result))
            await asyncio.wait_for(writer.drain(), 5)
    except IO_ERRORS:
        pass
    finally:
        writer.close()


async def serve(args):
    resolver = Resolver(args.upstream, args.upstream_port, args.probe_map)
    udp, _ = await asyncio.get_running_loop().create_datagram_endpoint(
        lambda: UDP(resolver), local_addr=(args.udp_host, args.udp_port))
    try:
        tcp = await asyncio.start_server(lambda r, w: tcp_client(resolver, r, w), args.tcp_host, args.tcp_port)
        async with tcp:
            await tcp.serve_forever()
    finally:
        udp.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--udp-host", default="192.168.1.19")
    parser.add_argument("--udp-port", type=int, default=53)
    parser.add_argument("--tcp-host", default="127.0.0.1")
    parser.add_argument("--tcp-port", type=int, default=19553)
    parser.add_argument("--upstream", default="8.8.8.8")
    parser.add_argument("--upstream-port", type=int, default=53)
    parser.add_argument("--probe-map", type=Path, default=Path("/var/lib/dsh/probe-map.json"))
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    asyncio.run(serve(parser.parse_args()))
