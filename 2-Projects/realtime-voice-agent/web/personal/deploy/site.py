"""Publish non-secret build assets and an isolated nginx site via ECS Cloud Assistant."""
import argparse
import base64
import hashlib
import io
import shlex
import subprocess
import tarfile
from pathlib import Path

base = Path(__file__).resolve().parent
app = base.parent
edge_runner = app.parents[1] / "ops/personal-edge/ecs-run.py"
dist = app / "dist"
names = ["index.html", "style.css", "voice.js", "LIVEKIT-LICENSE"]
bundle = io.BytesIO()
with tarfile.open(fileobj=bundle, mode="w:gz") as archive:
    for name in names:
        archive.add(dist / name, arcname=name)
    for name in ["http.conf", "https.conf"]:
        archive.add(base / name, arcname=name)
sdk = hashlib.sha256((dist / "livekit.js").read_bytes()).hexdigest()
release = hashlib.sha256(b"".join((dist / n).read_bytes() for n in [*names, "livekit.js"])).hexdigest()[:16]
parser = argparse.ArgumentParser()
parser.add_argument("--activate-domain", action="store_true", help="Publish the configured hostname once its cloud filing is active")
args = parser.parse_args()
encoded = base64.b64encode(bundle.getvalue()).decode()
script = r'''
set -eu
cd /opt/personal-edge
install -d -m 0755 clients
stage=$(mktemp -d /opt/personal-edge/clients/.release.XXXXXX)
trap 'rm -rf "$stage"' EXIT
cd "$stage"
printf %s PAYLOAD | base64 -d | tar --no-same-owner -xz
curl -fsSL --retry 1 --max-time 45 https://registry.npmjs.org/livekit-client/-/livekit-client-2.15.6.tgz -o sdk.tgz
tar -xOzf sdk.tgz package/dist/livekit-client.umd.js > livekit.js
printf '%s  livekit.js\n' HASH | sha256sum -c -
rm sdk.tgz
dest=/opt/personal-edge/clients/RELEASE_ID
install -d -m 0755 "$dest"
install -m 0644 index.html style.css voice.js LIVEKIT-LICENSE livekit.js "$dest"
cd /opt/personal-edge
ln -s "$dest" "$stage/next"
mv -Tf "$stage/next" public/talk
if test DOMAIN_ENABLED = 0; then
    sha256sum "$dest/index.html" "$dest/voice.js" "$dest/livekit.js"
    exit 0
fi
cd "$stage"
install -d -m 0755 /var/www/personal-voice-acme
install -m 0644 http.conf /etc/nginx/conf.d/xiaoke-voice-http.conf
nginx -t && systemctl reload nginx
if ! test -s /etc/letsencrypt/live/xiaoke-voice.hahaxiong.cc/fullchain.pem; then
    certbot certonly --webroot -w /var/www/personal-voice-acme --non-interactive --agree-tos --register-unsafely-without-email -d xiaoke-voice.hahaxiong.cc
fi
install -m 0644 https.conf /etc/nginx/conf.d/xiaoke-voice-https.conf
cd /opt/personal-edge
nginx -t
ln -s "$dest" client-next-RELEASE_ID
mv -Tf client-next-RELEASE_ID client-current
systemctl reload nginx
curl -fsS --resolve xiaoke-voice.hahaxiong.cc:443:127.0.0.1 https://xiaoke-voice.hahaxiong.cc/ | grep -q 'data-theme="glass"'
sha256sum "$dest/index.html" "$dest/voice.js" "$dest/livekit.js"
'''
script = script.replace("DOMAIN_ENABLED", str(int(args.activate_domain))).replace("PAYLOAD", shlex.quote(encoded)).replace("RELEASE_ID", release).replace("HASH", sdk)
subprocess.run(["python3", "-B", str(edge_runner), "voice-web", "--timeout", "160"], input=script, text=True, check=True)
