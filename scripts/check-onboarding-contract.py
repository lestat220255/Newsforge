#!/usr/bin/env python3
"""离线契约测试：校验 Newsforge 初始化契约（playbooks/onboarding.md）与配套文档的一致性。

检查项：
  1. playbook 存在且含必需章节（启动指令 / 执行者能力要求 / 必答问题集 / 产出物清单 / 完成判据 / 失败时如何求助）
  2. 问题集每个带选项的小节都以固定末项收尾（选项铁律）
  3. site.json.example 可解析、关键字段在，且 playbook 以它为 schema 依据并只引用编辑原则文档
  4. 三家 agent 文档存在、各自提到正确的 env var 名、且都指向 playbook
  5. docs/ONBOARDING.md 是瘦入口（指向 playbook 与三家文档、不含旧版整份问题集）
  6. 本次新增/修改文件无模板原站品牌残留（新文件查全文；README/SETUP 查 git diff 新增行）

用法：python3 scripts/check-onboarding-contract.py（在仓库根目录运行）
退出码：0 = 全过；1 = 有失败项。
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXED_LAST = "以上都不合适，我来填写"
BRAND = "heim" + "dall"  # 拼写拆开，避免脚本自身命中品牌检查
BRAND2 = BRAND + "daily"

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail and not ok else ""))


# ---------- 1. playbook 存在与必需章节 ----------
playbook_path = ROOT / "playbooks" / "onboarding.md"
check("playbook 存在", playbook_path.is_file())
playbook = playbook_path.read_text(encoding="utf-8") if playbook_path.is_file() else ""
for section in ["启动指令", "执行者能力要求", "必答问题集", "产出物清单", "完成判据", "失败时如何求助"]:
    check(f"playbook 含必需章节「{section}」", section in playbook)

# ---------- 2. 选项铁律：每个带选项的问题小节都有固定末项 ----------
q_sections = re.split(r"^### ", playbook, flags=re.M)[1:]
check("问题集至少 10 个小节", len(q_sections) >= 10, f"实际 {len(q_sections)}")
opt_sections = [s for s in q_sections if "选项" in s]
bad = [s.splitlines()[0].strip() for s in opt_sections if FIXED_LAST not in s]
check(f"带选项的小节共 {len(opt_sections)} 个、全部含固定末项", not bad, f"缺末项: {bad}")
check("固定末项在 playbook 中出现 >= 15 次", playbook.count(FIXED_LAST) >= 15,
      f"实际 {playbook.count(FIXED_LAST)}")

# ---------- 3. site.json.example ----------
example_path = ROOT / "site.json.example"
try:
    example = json.loads(example_path.read_text(encoding="utf-8"))
    parse_ok = True
except Exception as e:  # noqa: BLE001
    example, parse_ok = {}, False
    print(f"  解析错误: {e}")
check("site.json.example 可解析为 JSON", parse_ok)
for top in ["site", "features", "editorial"]:
    check(f"site.json.example 顶层键 {top}", top in example)
site_keys = ["name", "tagline", "timezone", "language", "url", "audience", "layout", "contactEmail"]
check("site.* 关键字段齐全", all(k in example.get("site", {}) for k in site_keys),
      f"缺: {[k for k in site_keys if k not in example.get('site', {})]}")
feat_keys = ["telegram", "r2", "topPicks", "aiComment", "aiAnalysis", "searchEngine",
             "correctionsPage", "qaChecks"]
check("features.* 关键字段齐全", all(k in example.get("features", {}) for k in feat_keys),
      f"缺: {[k for k in feat_keys if k not in example.get('features', {})]}")
check("playbook 以 site.json.example 为 schema 依据", "site.json.example" in playbook)
check("playbook 引用编辑原则文档（不复制）", "docs/editorial-principles.md" in playbook)
check("playbook 含 secrets 待办清单", "secrets 待办清单" in playbook and "~/.config/newsforge/" in playbook)
for doc in ["docs/PUSH-MODES.md", "docs/R2-IMAGES.md", "docs/SCRAPING.md", "docs/recipes.md"]:
    check(f"playbook 引用 {doc}", doc in playbook)

# ---------- 4. 三家 agent 文档 ----------
agents = {
    "claude-code.md": "ANTHROPIC_API_KEY",
    "codex.md": "OPENAI_API_KEY",
    "gemini-cli.md": "GEMINI_API_KEY",
}
for fname, envvar in agents.items():
    p = ROOT / "docs" / "agents" / fname
    check(f"docs/agents/{fname} 存在", p.is_file())
    if p.is_file():
        text = p.read_text(encoding="utf-8")
        check(f"docs/agents/{fname} 提到 {envvar}", envvar in text)
        check(f"docs/agents/{fname} 指向 playbook", "playbooks/onboarding.md" in text)

# ---------- 5. ONBOARDING.md 瘦入口 ----------
onb_path = ROOT / "docs" / "ONBOARDING.md"
onb = onb_path.read_text(encoding="utf-8") if onb_path.is_file() else ""
check("docs/ONBOARDING.md 指向 playbook", "playbooks/onboarding.md" in onb)
for fname in agents:
    check(f"docs/ONBOARDING.md 指向 agents/{fname}", f"docs/agents/{fname}" in onb)
check("docs/ONBOARDING.md 不保留旧版整份剧本（无旧步骤标题）",
      "强制 grill-me" not in onb and "第 11 步" not in onb)
check("docs/ONBOARDING.md 是瘦入口（<= 60 行）", len(onb.splitlines()) <= 60,
      f"实际 {len(onb.splitlines())} 行")

# ---------- 6. 品牌残留 ----------
new_files = [playbook_path, onb_path, ROOT / "scripts" / "check-onboarding-contract.py"] + \
            [ROOT / "docs" / "agents" / f for f in agents]
for p in new_files:
    if p.is_file():
        t = p.read_text(encoding="utf-8").lower()
        check(f"{p.relative_to(ROOT)} 无原站品牌残留", BRAND not in t and BRAND2 not in t)
try:
    diff = subprocess.run(["git", "diff", "HEAD", "--", "README.md", "docs/SETUP.md"],
                          cwd=ROOT, capture_output=True, text=True, timeout=30).stdout
    added = "\n".join(l[1:] for l in diff.splitlines()
                      if l.startswith("+") and not l.startswith("+++")).lower()
    check("README/SETUP 本次新增行无原站品牌残留", BRAND not in added and BRAND2 not in added)
except Exception as e:  # noqa: BLE001
    print(f"SKIP  git diff 品牌检查（{e}）")

# ---------- 汇总 ----------
failed = [n for n, ok, _ in results if not ok]
print(f"\n共 {len(results)} 项，通过 {len(results) - len(failed)}，失败 {len(failed)}")
if failed:
    print("失败项:", "；".join(failed))
    sys.exit(1)
print("契约测试全过。")
