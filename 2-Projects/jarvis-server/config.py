"""贾维斯配置"""

# MiniMax API
MINIMAX_API_KEY = "sk-cp-QrDYLN3gmi9S6CkJu3uDtFA9U8yr1RPrCSg6kTw4_WfJTuU-_nMnNTMvgIt_ZbAgYae1YSJfCKsKfIeb8b-xW1HxpIwjKTSP7iwal49u5Z-dkyeb9Ox-TKc"
MINIMAX_BASE_URL = "https://api.minimax.chat/v1/text/chatcompletion_v2"
MINIMAX_MODEL = "MiniMax-M2.7-highspeed"

# Gemini API（备用）
GEMINI_API_KEY = "fq8-1NLtsbVsiJhZaISmNeobvqY0bIZMoafPnKfkuz4"
GEMINI_BASE_URL = "http://23.226.135.149:4000/v1"
GEMINI_MODEL = "gemini-2.5-flash"

# Home Assistant
HA_URL = "http://192.168.1.115:8123"
HA_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJlNWRiMjU5MzBkMzE0ZmU4YTVkNWNkNDc5ZDY5ZjEyZSIsImlhdCI6MTc3NDQ0Mjk4NSwiZXhwIjoyMDg5ODAyOTg1fQ.nDn0EiqzNcyWZvlhPCP_3v0uTjULOUtc_zneeIXggjo"

# xiaomusic
XIAOMUSIC_URL = "http://192.168.1.115:58090"
XIAOMUSIC_DID = "663409132"

# WebSocket 服务
WS_HOST = "0.0.0.0"
WS_PORT = 8201  # 新端口，不和小智后端冲突

# 设备列表
DEVICES = {
    "客厅灯": "light.yeelink_ceiling4_6952_main_light",
    "客厅吸顶灯": "light.yeelink_ceiling4_6952_main_light",
    "台灯": "light.yeelink_lamp4_94a0_light",
    "南卧灯": "light.jdjz_jdjzu1_d142_light",
    "熊熊吸顶灯": "light.yeelink_ceil26_ae3b_light",
    "厨房灯": "switch.sonoff_10015c515c",
    "北卧灯": "switch.sonoff_10023144e6_1",
    "主卧灯": "switch.sonoff_10023f5da2_1",
    "机顶盒": "switch.sonoff_1001f8e9e1_1",
    "家庭影院": "switch.sonoff_1002543357_1",
    "飞牛": "switch.sonoff_10027bfc82_1",
    "游戏本": "switch.sonoff_10022103c8_1",
}

# 系统提示词
SYSTEM_PROMPT = """你是贾维斯，川哥的AI管家。简洁回答，用中文。
控制设备回复不超过10个字。闲聊不超过50个字。
只控制北京设备，杭州不操作。"""

# 设备列表注入到提示词
DEVICE_LIST = "\n".join(f"  {name} = {eid}" for name, eid in DEVICES.items())
FULL_PROMPT = SYSTEM_PROMPT + f"\n\n可控设备：\n{DEVICE_LIST}"
