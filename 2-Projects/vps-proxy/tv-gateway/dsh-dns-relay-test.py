#!/usr/bin/env python3
"""Offline tests for scope, DNS responses, upstream selection and both wire protocols."""
import asyncio
import json
from pathlib import Path
import runpy
import socket
import ssl
import struct
import tempfile
from unittest.mock import AsyncMock, patch

mod = runpy.run_path(str(Path(__file__).with_name("dsh-dns-relay.py")))["serve"].__globals__


def query(name, qtype=1, qclass=1):
    labels = [part.encode() for part in name.split(".")]
    return (struct.pack("!6H", 149, 0x0100, 1, 0, 0, 0) +
            b"".join(bytes([len(label)])+label for label in labels) + struct.pack("!BHH", 0, qtype, qclass))


def answer(q, code=0, count=1):
    rr = bytes.fromhex("c00c000100010000003c000401020304")
    return q[:2] + struct.pack("!5H", 0x8180 | code, 1, count, 0, 0) + q[12:] + rr*count


class LocalUDP(asyncio.DatagramProtocol):
    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, peer):
        self.transport.sendto(answer(data), peer)


async def local_tcp(reader, writer):
    try:
        writer.write(mod["frame"](answer(await mod["read_frame"](reader))))
        await writer.drain()
    finally:
        writer.close()


async def test():
    q = query("WWW.YoUtUbE.CoM")
    resolver_class = mod["Resolver"]
    with tempfile.TemporaryDirectory() as tmp:
        mapping = Path(tmp)/"map.json"
        mapping.write_text(json.dumps(["irrelevant", "hk-v6", "hk-hy2"]))
        resolver = resolver_class("127.0.0.1", 53, mapping)
        assert resolver.tls.check_hostname and resolver.tls.verify_mode == ssl.CERT_REQUIRED
        # Healthy primary returns its exact DNS response for all types, including legitimate negatives.
        for code, count in ((0, 1), (0, 0), (3, 0), (5, 0)):
            expected = answer(q, code, count)
            fallback = AsyncMock()
            with patch.dict(mod, primary=AsyncMock(return_value=expected), dot=fallback):
                assert await resolver.resolve(q) == expected
                fallback.assert_not_awaited()

        # Only media A/IN queries can leave the primary. The name match respects DNS label boundaries.
        for packet in (query("myyoutube.com"), query("youtube.com.example"), query("example.org"),
                       query("i.ytimg.com", 28), query("i.ytimg.com", 65), query("i.ytimg.com", 1, 3)):
            fallback = AsyncMock()
            with patch.dict(mod, primary=AsyncMock(side_effect=TimeoutError()), dot=fallback):
                assert await resolver.resolve(packet) is None
                fallback.assert_not_awaited()

        for bad in (answer(q, 2, 0), b"\x00\x01"+answer(q)[2:], answer(query("different.test")), q,
                    b"\x00\x95\x81\x80\x00\x01"+bytes(6)+b"\xc0\x0c\x00\x01\x00\x01"):
            fallback = AsyncMock(side_effect=[OSError(), answer(q)])
            with patch.dict(mod, primary=AsyncMock(return_value=bad), dot=fallback):
                assert await resolver.resolve(q) == answer(q)
                assert [call.args[0] for call in fallback.await_args_list] == [19203, 19202]
        # A mismatched DoT response is discarded instead of cached or passed back to the TV.
        fallback = AsyncMock(side_effect=[answer(query("different.test")), answer(q, 3, 0)])
        with patch.dict(mod, primary=AsyncMock(side_effect=TimeoutError()), dot=fallback):
            assert await resolver.resolve(q) == answer(q, 3, 0)
        large = answer(q, 0, 40)
        with patch.dict(mod, primary=AsyncMock(side_effect=TimeoutError()), dot=AsyncMock(return_value=large)):
            truncated = await resolver.resolve(q)
            assert truncated[2] & 2 and truncated[6:12] == bytes(6)
            assert await resolver.resolve(q, tcp=True) == large
        with patch.dict(mod, primary=AsyncMock(return_value=answer(q, 2, 0)), dot=AsyncMock(side_effect=OSError())):
            assert await resolver.resolve(q) == answer(q, 2, 0)

        # Run normal and fallback-facing sockets locally with ordinary A, preserving upstream TCP/UDP.
        udp, _ = await asyncio.get_running_loop().create_datagram_endpoint(LocalUDP, local_addr=("127.0.0.1", 0))
        port = udp.get_extra_info("sockname")[1]
        server = await asyncio.start_server(local_tcp, "127.0.0.1", port)
        try:
            resolver.port = port
            for tcp in (False, True):
                assert await resolver.resolve(q, tcp=tcp) == answer(q)
            client_udp, _ = await asyncio.get_running_loop().create_datagram_endpoint(
                lambda: mod["UDP"](resolver), local_addr=("127.0.0.1", 0))
            client_tcp = await asyncio.start_server(lambda r, w: mod["tcp_client"](resolver, r, w), "127.0.0.1", 0)
            try:
                for tcp, port in ((False, client_udp.get_extra_info("sockname")[1]),
                                  (True, client_tcp.sockets[0].getsockname()[1])):
                    assert await mod["primary"]("127.0.0.1", port, q, tcp) == answer(q)
            finally:
                client_udp.close()
                client_tcp.close()
                await client_tcp.wait_closed()
        finally:
            udp.close()
            server.close()
            await server.wait_closed()


if __name__ == "__main__":
    asyncio.run(test())
    print("DNS relay regression checks passed")
