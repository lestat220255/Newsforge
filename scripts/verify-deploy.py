#!/usr/bin/env python3
"""部署确认：轮询线上站点，确认今日 edition 真已上线（不是只推了 git）。

检查项（全部通过才算上线）：
  1. 首页 HTTP 200
  2. feed.xml HTTP 200，且含今日详情页链接（非沿用板块的 /detail/<今日>/…）；
     全沿用（无今日链接）时只要求 feed 200——沿用日本来就没有新链接
  3. edition 里抽查最多 2 张图片 URL：HTTP 200；以 .webp 结尾的还要求
     Content-Type 为 image/*

用法：python3 scripts/verify-deploy.py --date YYYY-MM-DD
  [--timeout 600] [--interval 30]
站点 URL 从仓库根 site.json 的 site.url 读；edition 从
data/editions/<今日>.json 读。退出码：0=已确认上线；1=超时未确认。
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def fetch(url, timeout=20):
    """返回 (status, content_type, body_text_or_None)。"""
    req = urllib.request.Request(url, headers={"User-Agent": "NewsforgeBot/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            text = None
            if "text" in (resp.headers.get_content_type() or "") or \
                    "xml" in (resp.headers.get_content_type() or ""):
                text = body.decode("utf-8", "replace")
            return resp.status, resp.headers.get_content_type() or "", text
    except urllib.error.HTTPError as exc:
        return exc.code, "", None
    except Exception as exc:  # 超时、DNS、连接失败都算未上线
        return 0, "", None


def collect_markers(edition, date_str):
    """今日详情页链接标记 + 抽查图片 URL（最多 2 张）。"""
    markers, images = [], []
    for sec in edition.get("sections", []) or []:
        if sec.get("empty") or sec.get("carried"):
            continue
        entries = ([sec["headline"]] if sec.get("headline") else []) + \
            (sec.get("items") or [])
        for idx, entry in enumerate(entries):
            markers.append(f"/detail/{date_str}/{sec['id']}-{idx}/")
            img = (entry or {}).get("image")
            if img and len(images) < 2:
                images.append(img)
    return markers, images


def check_once(base_url, edition, date_str):
    """一轮检查；返回 (ok, 原因)。"""
    home_status, _, _ = fetch(base_url + "/")
    if home_status != 200:
        return False, f"首页 HTTP {home_status}"
    feed_status, _, feed_text = fetch(base_url + "/feed.xml")
    if feed_status != 200:
        return False, f"feed.xml HTTP {feed_status}"
    markers, images = collect_markers(edition, date_str)
    if markers and not any(m in (feed_text or "") for m in markers):
        return False, "feed.xml 里还没有今日详情页链接（Pages 构建可能未完成）"
    for img in images:
        url = img if img.startswith("http") else base_url + img
        status, ctype, _ = fetch(url)
        if status != 200:
            return False, f"图片 {url} HTTP {status}"
        if url.endswith(".webp") and not ctype.startswith("image/"):
            return False, f"图片 {url} Content-Type 不是图片：{ctype}"
    return True, "首页、feed、抽查图片全部就绪"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Newsforge 部署确认")
    parser.add_argument("--date", required=True, help="今日日期 YYYY-MM-DD")
    parser.add_argument("--timeout", type=int, default=600, help="最长等待秒数")
    parser.add_argument("--interval", type=int, default=30, help="轮询间隔秒数")
    args = parser.parse_args(argv)

    try:
        site = json.loads((ROOT / "site.json").read_text(encoding="utf-8"))["site"]
    except (OSError, ValueError, KeyError):
        print("verify-deploy: 读不到合法的 site.json（Actions 模式要求它已提交）",
              file=sys.stderr)
        return 1
    base_url = (site.get("url") or "").rstrip("/")
    if not base_url.startswith("http"):
        print("verify-deploy: site.json 的 site.url 不是合法 http(s) 地址", file=sys.stderr)
        return 1
    edition_path = ROOT / "data" / "editions" / f"{args.date}.json"
    if not edition_path.is_file():
        print(f"verify-deploy: 找不到 {edition_path}", file=sys.stderr)
        return 1
    edition = json.loads(edition_path.read_text(encoding="utf-8"))

    deadline = time.time() + args.timeout
    attempt = 0
    while True:
        attempt += 1
        ok, reason = check_once(base_url, edition, args.date)
        if ok:
            print(f"verify-deploy: 已确认上线（第 {attempt} 次检查）：{reason}")
            return 0
        if time.time() + args.interval > deadline:
            print(f"verify-deploy: {args.timeout}s 内未确认上线，最后原因：{reason}",
                  file=sys.stderr)
            return 1
        print(f"verify-deploy: 第 {attempt} 次未就绪（{reason}），"
              f"{args.interval}s 后重试…")
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
