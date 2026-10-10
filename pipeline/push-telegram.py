#!/usr/bin/env python3
"""Newsforge 每日 Telegram 推送：把当日新内容头条推送到频道（可选功能，默认关闭）。
用法: push-telegram.py [YYYY-MM-DD]（默认今天，按 site.json 的 timezone）

前置（安装时由 Agent 引导用户手动完成）：
  1. 找 @BotFather 创建机器人，拿到 token
  2. 创建频道，把机器人设为管理员（需要"发布消息"权限）
  3. token 存到 ~/.config/newsforge/telegram-token（文件权限 600），绝不进仓库
  4. site.json 的 features.telegram 设为 { "enabled": true, "channel": "你的频道名（不带@）" }

规则：
  - 沿用（carried:true）板块不进订阅通知，只推当天新内容
  - 待确认（unverified）条目不带 🔥
"""
import html
import json
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import quote
import urllib.request

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9 回退
    ZoneInfo = None

ROOT = Path(__file__).resolve().parent.parent

def load_site():
    p = ROOT / 'site.json'
    if not p.exists():
        p = ROOT / 'site.json.example'
    return json.loads(p.read_text())['site'], json.loads(p.read_text()).get('features', {})

TOKEN_FILE = Path.home() / '.config/newsforge/telegram-token'

def get_token():
    return TOKEN_FILE.read_text().strip()

def send(token, chat_id, text):
    url = f'https://api.telegram.org/bot{token}/sendMessage'
    payload = {'chat_id': chat_id, 'text': text, 'parse_mode': 'HTML',
               'disable_web_page_preview': False}
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        r = json.load(resp)
    if not r.get('ok'):
        raise RuntimeError(f"发送失败: {r}")
    return r['result']['message_id']

def main():
    site, features = load_site()
    tg = features.get('telegram', {})
    if not tg.get('enabled') or not tg.get('channel'):
        print('Telegram 未启用（site.json → features.telegram），跳过推送')
        return
    # 时区一律读 site.json → site.timezone（IANA），不再写死 +8
    tzname = site.get('timezone') or 'Asia/Shanghai'
    if ZoneInfo:
        try:
            tz = ZoneInfo(tzname)
        except Exception:
            print(f'[warn] site.json 的 timezone "{tzname}" 非法，已回退为 Asia/Shanghai。请检查拼写。')
            tz = ZoneInfo('Asia/Shanghai')
    else:
        from datetime import timezone as _tz, timedelta as _td
        tz = _tz(_td(hours=8))
    date = sys.argv[1] if len(sys.argv) > 1 else datetime.now(tz).strftime('%Y-%m-%d')
    ed_path = ROOT / f'data/editions/{date}.json'
    ed = json.loads(ed_path.read_text())
    # 沿用板块不进订阅通知：只推当天新内容
    sections = [s for s in ed['sections']
                if not s.get('hidden') and not s.get('empty')
                and not s.get('carried') and s.get('headline')]

    site_url = site['url'].rstrip('/')
    lines = [f"<b>{html.escape(site['name'])} · {date}</b>", '']
    for s in sections:
        h = s['headline']
        hot = '🔥' if h.get('hot') and not h.get('unverified') else ''
        link = f"{site_url}/detail/{quote(s.get('detailDate') or date)}/{quote(s['id'])}-0/"
        # parse_mode=HTML：标题/来源必须转义，否则含 < & 时发送失败或格式错乱
        lines.append(f"{hot}<b>{html.escape(h['title'])}</b>")
        lines.append(f'<a href="{html.escape(link, quote=True)}">阅读详情</a> · {html.escape(h.get("source", ""))}')
        lines.append('')
    mid = send(get_token(), '@' + tg['channel'], '\n'.join(lines).strip())
    print(f'头条推送成功 message_id={mid}，共 {len(sections)} 条')

if __name__ == '__main__':
    main()
