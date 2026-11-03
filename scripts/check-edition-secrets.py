#!/usr/bin/env python3
"""启发式密钥扫描：提交前检查待提交文件里有没有疑似密钥。

背景：publish job 的提交内容来自 edit job 的 artifact（agent 写过）。
即使 agent 被诱导读到了密钥、也只能把它藏进 edition/图片文件里带出来，
这一步就是最后一道网。注意：这是启发式检查，不是保证——
真正的安全边界是 edit job 里根本没有这些密钥（见 daily.yml 的 env 分工）。

检查规则（命中即失败，只报文件与规则名，绝不打印命中内容本身）：
  1. 已知密钥前缀：sk-ant-、sk-proj-、sk-、ghp_、gho_、github_pat_、
     AKIA、xox[baprs]-、-----BEGIN（PEM 私钥块）
  2. 赋值形：api_key/secret/token/password 之类的键名后跟 16 位以上引号值

用法：python3 scripts/check-edition-secrets.py <文件或目录>...
退出码：0=干净；1=命中疑似密钥。
"""
import re
import sys
from pathlib import Path

PATTERNS = [
    ("known-prefix", re.compile(
        r"sk-ant-|sk-proj-|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|"
        r"gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|"
        r"xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("key-assignment", re.compile(
        r"(?i)(api[_-]?key|secret|token|passwd|password)\s*[:=]\s*"
        r"[\"'][^\"'\s]{16,}[\"']")),
]


def iter_files(paths):
    for raw in paths:
        path = Path(raw)
        if path.is_file():
            yield path
        elif path.is_dir():
            yield from sorted(p for p in path.rglob("*") if p.is_file())


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if not args:
        print("用法：check-edition-secrets.py <文件或目录>...", file=sys.stderr)
        return 2
    hits = []
    for path in iter_files(args):
        try:
            text = path.read_text(encoding="utf-8", errors="strict")
        except (OSError, UnicodeDecodeError):
            continue  # 二进制文件（图片等）跳过
        for name, pattern in PATTERNS:
            if pattern.search(text):
                hits.append((str(path), name))
    if hits:
        for path, name in hits:
            print(f"FAIL  {path}：命中疑似密钥规则 {name}（内容已隐去）", file=sys.stderr)
        return 1
    print("密钥扫描通过：待提交文件无疑似密钥。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
