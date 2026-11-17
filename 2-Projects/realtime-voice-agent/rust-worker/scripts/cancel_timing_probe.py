"""cancel.ack → barge 首 PCM 时序探针(2026-08-16, codex 联调合同 §3.2)。

模拟 Android 打断路径的最紧形态,一房连续 3 轮:
  问长问题 → speaking=true+0.7s → 播打断短句(1.4s 真声,ASR 出 interim)
  → 播完立即发 cancel(src=android;Android 实际是 interim 确认即发,说完才发=偏晚=偏紧)
  → 收 cancel.ack → 等回复播完 → 下一轮(轮间 6s 出 5s boost 窗)

产出(stdout):每轮 cancel 发出/ack 到达本地时刻 + DataChannel 往返 ms。
服务端间隔(判读用 journal):`control cancel`(ack 发出) → 最近一条
`filler picked bucket=barge`(barge 入轨) 差值 = ack→barge 下界锚
(端侧感知还要叠音频轨 encode+jitter,只会更大)。
"""
import asyncio, datetime, json, os, sys, time, wave

from livekit import api, rtc

ROOM = sys.argv[1]
SR, CH, SPF = 16000, 1, 320
SILENCE = bytes(SPF * 2)
ASK_WAV = "/tmp/long-q.wav"
BARGE_WAV = "/tmp/interrupt-short.wav"
TR = f"cancel-timing-{int(time.time())}"
ROUNDS = 3


def mint() -> str:
    return (api.AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
            .with_identity("cancel-timing-probe").with_name("cancel-timing-probe")
            .with_grants(api.VideoGrants(room_join=True, room=ROOM, can_publish=True,
                                         can_subscribe=True, can_publish_data=True))
            .with_room_config(api.RoomConfiguration(
                agents=[api.RoomAgentDispatch(agent_name="rust-worker")]))
            .with_ttl(datetime.timedelta(minutes=10)).to_jwt())


async def main():
    room = rtc.Room()
    ev_speak = asyncio.Event()
    ev_idle = asyncio.Event()
    acks = {}  # seq -> (t_mono, payload)

    @room.on("data_received")
    def on_data(pkt: rtc.DataPacket):
        try:
            d = json.loads(pkt.data)
        except Exception:
            return
        if pkt.topic == "state" and d.get("k") == "speaking":
            (ev_speak if d.get("speaking") else ev_idle).set()
        elif pkt.topic == "control" and d.get("type") == "cancel.ack":
            acks[d.get("seq")] = (time.monotonic(), d.get("payload"))
            print(f"  ack seq={d.get('seq')} payload={d.get('payload')} "
                  f"t={time.strftime('%H:%M:%S')}", flush=True)

    await room.connect(os.environ["LIVEKIT_URL"], mint())
    src = rtc.AudioSource(SR, CH)
    await room.local_participant.publish_track(
        rtc.LocalAudioTrack.create_audio_track("mic", src),
        rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    print(f"connected room={ROOM} trace={TR} t={time.strftime('%H:%M:%S')}", flush=True)

    with wave.open(ASK_WAV, "rb") as w:
        ask_pcm = w.readframes(w.getnframes())
    with wave.open(BARGE_WAV, "rb") as w:
        barge_pcm = w.readframes(w.getnframes())[: int(1.4 * SR) * 2]

    stop = asyncio.Event()
    paused = asyncio.Event()

    async def feed():
        while not stop.is_set():
            if not paused.is_set():
                await src.capture_frame(rtc.AudioFrame(SILENCE, SR, CH, SPF))
            await asyncio.sleep(0.02)
    asyncio.create_task(feed())

    step = SPF * 2

    async def play(seg: bytes):
        paused.set()
        await asyncio.sleep(0.05)
        for i in range(0, len(seg) - step, step):
            await src.capture_frame(rtc.AudioFrame(seg[i:i + step], SR, CH, SPF))
            await asyncio.sleep(0.02)
        paused.clear()

    await asyncio.sleep(2.5)
    for rnd in range(ROUNDS):
        seq = 301 + rnd
        ev_speak.clear()
        ev_idle.clear()
        print(f"== round {rnd + 1} ask t={time.strftime('%H:%M:%S')}", flush=True)
        await play(ask_pcm)
        try:
            await asyncio.wait_for(ev_speak.wait(), timeout=15)
        except asyncio.TimeoutError:
            print("!! speaking 未等到,本轮跳过", flush=True)
            continue
        await asyncio.sleep(0.7)
        print(f"  barge-in t={time.strftime('%H:%M:%S')}", flush=True)
        await play(barge_pcm)
        # 说完立即 cancel(最紧现实形态)
        t_cancel = time.monotonic()
        await room.local_participant.publish_data(
            json.dumps({"trace_id": TR, "ts_ms": int(time.time() * 1000),
                        "src": "android", "type": "cancel", "lane": "L2",
                        "seq": seq, "payload": {"reason": "probe-barge"}}).encode(),
            reliable=True, topic="control")
        print(f"  cancel sent seq={seq} t={time.strftime('%H:%M:%S')}", flush=True)
        await asyncio.sleep(2.0)
        if seq in acks:
            rtt = (acks[seq][0] - t_cancel) * 1000
            print(f"  cancel→ack 往返 {rtt:.0f}ms", flush=True)
        else:
            print("  !! 2s 内未收到 ack", flush=True)
        # 等 barge+新正文播完(ev_idle 由打断后的 speaking=false 置位)
        ev_idle.clear()
        try:
            await asyncio.wait_for(ev_idle.wait(), timeout=25)
            print(f"  reply done t={time.strftime('%H:%M:%S')}", flush=True)
        except asyncio.TimeoutError:
            print("  !! 25s 回复未结束,继续下一轮", flush=True)
        await asyncio.sleep(6)  # 出 5s boost 窗

    print(f"probe done acks={sorted(acks)} t={time.strftime('%H:%M:%S')}", flush=True)
    stop.set()
    await room.disconnect()


asyncio.run(main())
