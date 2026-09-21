#!/root/voice-venv/bin/python
"""在 47.239（LiveKit 机）上现签 demo 页的房间级 token，只输出 JWT 到 stdout（供 deploy_demo_page.sh 注入页面）。
密钥来自 /root/realtime-voice-agent/.env 的 LIVEKIT_API_KEY / LIVEKIT_API_SECRET，不落盘、不进 git。
"""
import argparse, datetime, re, sys
from livekit import api

p = argparse.ArgumentParser()
p.add_argument('--room', default='voice-test-rust')
p.add_argument('--identity', default='voice-test-user-rust')
p.add_argument('--agent', default='rust-worker-demo')
p.add_argument('--ttl-days', type=int, default=180)
p.add_argument('--env', default='/root/realtime-voice-agent/.env')
a = p.parse_args()
env = open(a.env, encoding='utf-8').read()

def val(k):
    m = re.search(r'^' + k + r'=(.*)$', env, re.M)
    v = (m.group(1) if m else '').strip()
    return v[1:-1] if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'' else v

key, sec = val('LIVEKIT_API_KEY'), val('LIVEKIT_API_SECRET')
if not key or not sec:
    sys.exit('LIVEKIT_API_KEY / LIVEKIT_API_SECRET 缺失')
tok = (
    api.AccessToken(key, sec)
    .with_identity(a.identity)
    .with_name(a.identity)
    .with_ttl(datetime.timedelta(days=a.ttl_days))
    .with_grants(api.VideoGrants(room_join=True, room=a.room, can_publish=True, can_subscribe=True, can_publish_data=True))
    .with_room_config(api.RoomConfiguration(agents=[api.RoomAgentDispatch(agent_name=a.agent)]))
    .to_jwt()
)
print(tok)
