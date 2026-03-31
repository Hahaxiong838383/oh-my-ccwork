"""Home Assistant + xiaomusic 控制"""

import requests
from config import HA_URL, HA_TOKEN, XIAOMUSIC_URL, XIAOMUSIC_DID, DEVICES


def control_device(entity_id: str, action: str) -> str:
    """控制 HA 设备"""
    domain = entity_id.split(".")[0]
    service = action  # turn_on / turn_off
    try:
        resp = requests.post(
            f"{HA_URL}/api/services/{domain}/{service}",
            headers={"Authorization": f"Bearer {HA_TOKEN}", "Content-Type": "application/json"},
            json={"entity_id": entity_id},
            timeout=5,
        )
        return "done" if resp.status_code == 200 else f"error:{resp.status_code}"
    except Exception as e:
        return f"error:{e}"


def play_music(song: str = "") -> str:
    """通过 xiaomusic 播放音乐"""
    try:
        if not song or song == "random":
            song = "随机播放"
        requests.post(
            f"{XIAOMUSIC_URL}/cmd",
            json={"did": XIAOMUSIC_DID, "cmd": "播放歌曲", "arg1": song},
            timeout=5,
        )
        return f"playing:{song}"
    except Exception as e:
        return f"error:{e}"


def stop_music() -> str:
    """停止播放"""
    try:
        requests.post(
            f"{XIAOMUSIC_URL}/cmd",
            json={"did": XIAOMUSIC_DID, "cmd": "停止"},
            timeout=5,
        )
        return "stopped"
    except Exception as e:
        return f"error:{e}"


def find_device(name: str) -> str | None:
    """模糊匹配设备名"""
    name = name.strip()
    # 精确匹配
    if name in DEVICES:
        return DEVICES[name]
    # 模糊匹配
    for dev_name, entity_id in DEVICES.items():
        if name in dev_name or dev_name in name:
            return entity_id
    return None
