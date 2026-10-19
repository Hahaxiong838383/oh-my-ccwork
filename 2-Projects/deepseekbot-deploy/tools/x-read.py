#!/usr/bin/env python3
"""Read one public X post via the configured local HTTP proxy and official oEmbed."""
import argparse
import datetime
from html.parser import HTMLParser
import json
import re
import subprocess
import sys
from urllib.parse import urlencode, urlparse

PROXY = 'http://127.0.0.1:10808'
ENDPOINT = 'https://publish.x.com/oembed'


def canonical_post(value):
    url = urlparse(value)
    if url.scheme != 'https' or url.netloc.lower() not in ('x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'):
        raise ValueError('Provide a public HTTPS x.com or twitter.com post URL')
    match = re.fullmatch(r'/(?:(?P<user>[A-Za-z0-9_]{1,15})/status|i/web/status)/(?P<id>[0-9]{1,25})/?', url.path)
    if not match:
        raise ValueError('A single post URL is required; profile/search URLs need another authorized channel')
    return 'https://x.com/{}/status/{}'.format(match['user'] or 'i', match['id']), match['id']


class PostText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.inside = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == 'p':
            self.inside = True
        elif tag == 'br' and self.inside:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag == 'p':
            self.inside = False

    def handle_data(self, value):
        if self.inside:
            self.parts.append(value)


def extract_post(payload, canonical, post_id):
    if not isinstance(payload, dict) or payload.get('type') != 'rich' or not isinstance(payload.get('html'), str):
        raise ValueError('Unexpected oEmbed payload')
    parser = PostText()
    parser.feed(payload['html'])
    text = ''.join(parser.parts).strip()
    if not text or not payload.get('author_name'):
        raise ValueError('No readable public post text; do not treat a widget shell as a successful read')
    return {'ok': True, 'source': 'X official oEmbed', 'url': canonical, 'postId': post_id,
            'author': payload['author_name'], 'text': text, 'proxy': PROXY,
            'fetchedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'scope': 'one public post; no search, timeline, protected content or login access'}


def read_post(value):
    canonical, post_id = canonical_post(value)
    endpoint = ENDPOINT + '?' + urlencode({'url': canonical, 'omit_script': 'true', 'dnt': 'true'})
    command = ['/usr/bin/curl', '--proxy', PROXY, '--noproxy', '', '--proto', '=https',
               '--proto-redir', '=https', '--connect-timeout', '10', '--max-time', '35',
               '--max-redirs', '3', '--max-filesize', '1048576', '-sS', '-L',
               '--write-out', '\n%{http_code}', endpoint]
    result = subprocess.run(command, capture_output=True, text=True, timeout=40)
    if result.returncode:
        return {'ok': False, 'error': 'proxy_or_transport_failure', 'curlExit': result.returncode}
    body, _, status = result.stdout.rpartition('\n')
    if status != '200':
        return {'ok': False, 'error': 'rate_limited' if status == '429' else 'post_unavailable_or_access_restricted',
                'httpStatus': status, 'retry': False}
    return extract_post(json.loads(body), canonical, post_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url', help='Public HTTPS post URL; only one post per invocation')
    args = parser.parse_args()
    try:
        report = read_post(args.url)
    except ValueError as exc:
        report = {'ok': False, 'error': 'invalid_url_or_payload', 'detail': str(exc)}
    except subprocess.TimeoutExpired:
        report = {'ok': False, 'error': 'transport_timeout', 'retry': False}
    except Exception:
        report = {'ok': False, 'error': 'read_failed'}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
