#!/usr/bin/env python3
"""RK3562 <-> MCU 协议校验算法参考实现 + 自校验。

用途：实现方（C/Rust/Python 任一语言）写完 CRC 后，用本脚本的测试向量对拍，
      对不上就是实现错了，别上板。

    python3 crc_reference.py          # 跑自校验
    python3 crc_reference.py 5A 01 00 A1 00 01 00 00   # 对任意字节序列算 CRC8

来源：飞书文档《RK3562 - MCU 通讯协议》V2.1 §五 校验算法。
CRC8 的测试向量取自文档原文，已复算通过。
"""
import sys

# --- CRC8: CRC-8/SAE-J1850, poly=0x1D, init=0xFF, xorout=0xFF, 不反射 -------
CRC8_POLY, CRC8_INIT, CRC8_XOROUT = 0x1D, 0xFF, 0xFF


def _crc8_table():
    tab = []
    for i in range(256):
        c = i
        for _ in range(8):
            c = ((c << 1) ^ CRC8_POLY) & 0xFF if c & 0x80 else (c << 1) & 0xFF
        tab.append(c)
    return tab


CRC8_TAB = _crc8_table()


def crc8(data: bytes) -> int:
    """协议帧 CRC8。覆盖范围 = Header + FrameType + SerialCount + CMD + Length + Payload
    （即整帧去掉末尾的 CRC8 与 End 两个字节）。"""
    crc = CRC8_INIT
    for b in data:
        crc = CRC8_TAB[crc ^ b]
    return crc ^ CRC8_XOROUT


# --- CRC32: poly=0xEDB88320（反射式），最终异或 0xFFFFFFFF -------------------
CRC32_POLY = 0xEDB88320


def _crc32_table():
    tab = []
    for i in range(256):
        c = i
        for _ in range(8):
            c = (c >> 1) ^ CRC32_POLY if c & 1 else c >> 1
        tab.append(c)
    return tab


CRC32_TAB = _crc32_table()


def crc32(data: bytes, init: int = 0xFFFFFFFF) -> int:
    """OTA 文件 CRC32。文档注明最终结果需异或 0xFFFFFFFF。
    init 对应文档 calc_crc32() 的 cal_crc 入参；文档未规定其取值，
    此处默认 0xFFFFFFFF（= 标准 CRC-32/ISO-HDLC），实现前请与硬件确认，见 ISSUE-06。"""
    crc = init
    for b in data:
        crc = ((crc >> 8) & 0x00FFFFFF) ^ CRC32_TAB[(crc ^ b) & 0xFF]
    return crc ^ 0xFFFFFFFF


# --- 帧封装（依赖大端字节序，见 protocol.yaml byte_order，标 inferred）------
HEADER, END = 0x5A, 0xA5


def build_frame(frame_type: int, serial: int, cmd: int, payload: bytes = b"") -> bytes:
    body = bytes([HEADER, frame_type]) + serial.to_bytes(2, "big") \
        + cmd.to_bytes(2, "big") + len(payload).to_bytes(2, "big") + payload
    return body + bytes([crc8(body), END])


def _selftest() -> int:
    fails = 0

    # 1) 文档 §五 原文测试向量
    vec = bytes([0x5A, 0x01, 0x00, 0xA1, 0x00, 0x01, 0x00, 0x00])
    got = crc8(vec)
    ok = got == 0x08
    fails += not ok
    print(f"[{'PASS' if ok else 'FAIL'}] 文档 CRC8 向量 {vec.hex(' ')} -> 0x{got:02X} (期望 0x08)")

    # 2) 该向量按大端解读应还原为 CMD 0x0001 / Length 0，与命令表自洽
    cmd, length = int.from_bytes(vec[4:6], "big"), int.from_bytes(vec[6:8], "big")
    ok = (cmd, length) == (0x0001, 0)
    fails += not ok
    print(f"[{'PASS' if ok else 'FAIL'}] 大端解读 CMD=0x{cmd:04X} Length={length} (期望 0x0001 / 0)")

    # 3) build_frame 应能重建出同一向量的前 8 字节
    frame = build_frame(0x01, 0x00A1, 0x0001, b"")
    ok = frame[:8] == vec and frame[8] == 0x08 and frame[9] == END
    fails += not ok
    print(f"[{'PASS' if ok else 'FAIL'}] build_frame -> {frame.hex(' ')}")

    # 4) 负向验证：改一个 bit，CRC 必须变（防止实现恒返回定值）
    bad = bytearray(vec); bad[3] ^= 0x01
    ok = crc8(bytes(bad)) != 0x08
    fails += not ok
    print(f"[{'PASS' if ok else 'FAIL'}] 负向：单 bit 翻转后 CRC8 = 0x{crc8(bytes(bad)):02X} (必须 != 0x08)")

    # 5) CRC32 对拍 zlib（确认与标准 CRC-32/ISO-HDLC 一致）
    import zlib
    probe = b"123456789"
    ok = crc32(probe) == zlib.crc32(probe)
    fails += not ok
    print(f"[{'PASS' if ok else 'FAIL'}] CRC32(\"123456789\") = 0x{crc32(probe):08X} "
          f"(zlib 0x{zlib.crc32(probe):08X}) — 注：init 取值待硬件确认，见 ISSUE-06")

    print("\n" + ("全部通过" if not fails else f"{fails} 项失败"))
    return fails


if __name__ == "__main__":
    if len(sys.argv) > 1:
        data = bytes(int(x, 16) for x in sys.argv[1:])
        print(f"CRC8({data.hex(' ')}) = 0x{crc8(data):02X}")
    else:
        sys.exit(_selftest())
