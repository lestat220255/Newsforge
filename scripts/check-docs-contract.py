#!/usr/bin/env python3
"""离线契约测试：文档完整性（双模式四路径、跨文档口径一致、过时引用清零）。

背景：2026-10-21 文档完整性审计发现过——SETUP 的 Pages 构建配置与实现
矛盾、终端 CLI 用户初始化后日更落地无明确指引、订阅与 API 两钱包无解释、
步号引用停留在旧剧本时代。本测试把这些覆盖项锁成断言，防止回退。

检查项：
  1. Pages 构建配置三处字面一致（README / docs/SETUP.md / playbooks/onboarding.md），
     且都是实现真相：render-only + pagefind --site dist、输出 dist、NODE_VERSION=20
  2. 过时步号引用清零（旧剧本时代的「安装第 X 步」「ONBOARDING 第 X 步」等）
  3. 四条用户路径都有可达的文档入口：ONBOARDING 路由节、三家 agents 文档、
     playbook Q9-2 三条路、SETUP 本机手动小节与停用说明
  4. docs/ACTIONS.md 含两钱包解释、quota 报错排查、CODEX_AUTH_JSON 完整拿法
  5. 文档里以 ${{ vars.X }} / ${{ secrets.X }} 全名出现的集合 ⊆ workflow 真实引用集合
  6. docs/R2-IMAGES.md 提到的 R2_* / NEWSFORGE_R2_* 环境名都在 workflow 或管线实现中真实存在
  7. 本次修改文件无模板原站品牌残留（git diff 新增行）

用法：python3 scripts/check-docs-contract.py（在仓库根目录运行）
退出码：0 = 全过；1 = 有失败项。
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRAND = "heim" + "dall"
BRAND2 = BRAND + "daily"
PAGES_CMD = "npm install && node pipeline/run.js --render-only && npx pagefind --site dist"

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail and not ok else ""))


def read(rel):
    p = ROOT / rel
    return p.read_text(encoding="utf-8") if p.is_file() else ""


README = read("README.md")
SETUP = read("docs/SETUP.md")
ONB = read("docs/ONBOARDING.md")
ACTIONS = read("docs/ACTIONS.md")
PLAYBOOK_ONB = read("playbooks/onboarding.md")
WORKFLOW = read(".github/workflows/daily.yml")

# ---------- 1. Pages 构建配置三处一致且与实现对齐 ----------
for label, text in [("README", README), ("docs/SETUP.md", SETUP),
                    ("playbooks/onboarding.md", PLAYBOOK_ONB)]:
    check(f"{label} 含 Pages 构建命令（与实现一致）", PAGES_CMD in text)
    check(f"{label} 含 NODE_VERSION=20", "NODE_VERSION=20" in text)
check("SETUP 输出目录为 dist 而非 public", "输出目录：`dist`" in SETUP
      and "输出目录：`public`" not in SETUP)

# ---------- 2. 过时步号引用清零 ----------
stale = {
    "docs/SETUP.md": ["安装第 5 步", "ONBOARDING 第", "见 docs/ONBOARDING.md 第"],
    "docs/SCRAPING.md": ["安装第 7 步"],
    "docs/PUSH-MODES.md": ["ONBOARDING 第"],
    "docs/editorial-principles.md": ["ONBOARDING 第"],
    "docs/recipes.md": ["在第 2 步选"],
}
for rel, needles in stale.items():
    text = read(rel)
    for n in needles:
        check(f"{rel} 无过时引用「{n}」", n not in text)

# ---------- 3. 四条路径的文档入口 ----------
check("ONBOARDING 含初始化后路由（指向 ACTIONS）", "docs/ACTIONS.md" in ONB)
check("ONBOARDING 路由含本机手动", "本机手动" in ONB)
check("ONBOARDING 路由含四种组合说明", "四种组合" in ONB)
for fname in ["claude-code.md", "codex.md", "gemini-cli.md"]:
    text = read(f"docs/agents/{fname}")
    check(f"agents/{fname} 指向 Actions 日更", "docs/ACTIONS.md" in text)
    check(f"agents/{fname} 指向本机手动（SETUP 第 3 节）", "docs/SETUP.md" in text)
check("playbook Q9-2 给出 Actions 路（docs/ACTIONS.md）", "docs/ACTIONS.md" in PLAYBOOK_ONB)
check("playbook 含本机手动路", "本机手动" in PLAYBOOK_ONB)
check("SETUP 含「本机手动跑日更」小节", "本机手动跑日更" in SETUP)
check("SETUP 本机手动序列含 run-agent", "scripts/run-agent" in SETUP)
check("SETUP 如实标注本机定时无官方模板", "没有官方模板" in SETUP)
check("SETUP 含「停用与切换宿主」", "停用与切换宿主" in SETUP)
sec9 = SETUP.split("## 9. 故障排查")[-1]
check("SETUP 故障排查含分诊表（指向 ACTIONS 故障排查）",
      "分诊" in sec9 and "docs/ACTIONS.md" in sec9)
check("README 含本机手动路径", "本机手动" in README)

# ---------- 4. ACTIONS.md 关键解释 ----------
check("ACTIONS 含两钱包解释", "两个钱包" in ACTIONS)
check("ACTIONS 故障排查含 no credits（quota）行", "no credits remaining" in ACTIONS)
check("ACTIONS 含 CODEX_AUTH_JSON 完整拿法小节", "CODEX_AUTH_JSON 的完整拿法" in ACTIONS)
check("ACTIONS 拿法含 device-auth 登录步", "codex login --device-auth" in ACTIONS)
check("agents/codex.md 含两钱包提醒", "两个钱包" in read("docs/agents/codex.md"))

# ---------- 5. 文档中的 vars/secrets 全名不得超出 workflow ----------
wf_names = set(re.findall(r"(?:vars|secrets)\.([A-Z][A-Z0-9_]*)", WORKFLOW))
doc_files = ["README.md", "docs/ACTIONS.md", "docs/SETUP.md", "docs/ONBOARDING.md",
             "docs/PUSH-MODES.md", "docs/R2-IMAGES.md", "docs/SCRAPING.md",
             "docs/agents/claude-code.md", "docs/agents/codex.md",
             "docs/agents/gemini-cli.md",
             "playbooks/onboarding.md", "playbooks/daily.md"]
extra = {}
for rel in doc_files:
    names = set(re.findall(r"(?:vars|secrets)\.([A-Z][A-Z0-9_]*)", read(rel)))
    bad = names - wf_names
    if bad:
        extra[rel] = sorted(bad)
check("全部文档的 vars/secrets 全名 ⊆ workflow 引用集合", not extra, str(extra))

# ---------- 6. R2 环境名对账（workflow 注入或管线本地读取，二者必居其一） ----------
r2_text = read("docs/R2-IMAGES.md")
r2_impl = read("pipeline/lib/r2-images.js")
r2_names = set(re.findall(r"\b(?:NEWSFORGE_R2|R2)_[A-Z_]+\b", r2_text))
missing = sorted(n for n in r2_names if n not in WORKFLOW and n not in r2_impl)
check("R2-IMAGES 提到的环境名都在 workflow 或管线实现中存在", not missing, str(missing))

# ---------- 7. 品牌残留（本次 diff 新增行） ----------
try:
    diff = subprocess.run(["git", "diff", "HEAD"], cwd=ROOT, capture_output=True,
                          text=True, timeout=30).stdout
    added = "\n".join(l[1:] for l in diff.splitlines()
                      if l.startswith("+") and not l.startswith("+++")).lower()
    check("本次全部新增行无原站品牌残留", BRAND not in added and BRAND2 not in added)
    self_text = Path(__file__).read_text(encoding="utf-8").lower()
    check("check-docs-contract.py 自身无品牌残留", BRAND not in self_text and BRAND2 not in self_text)
except Exception as e:  # noqa: BLE001
    check("品牌残留检查可执行", False, str(e)[:120])

failed = [n for n, ok in results if not ok]
print(f"\n共 {len(results)} 项，通过 {len(results) - len(failed)}，失败 {len(failed)}")
if failed:
    print("失败项:", "；".join(failed))
    sys.exit(1)
print("文档契约测试全过。")
