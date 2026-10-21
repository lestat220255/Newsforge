#!/usr/bin/env python3
"""离线契约测试：校验 Newsforge 的 Actions 日更（BYOK 模式）各文件一致性。

检查项：
  1. .github/workflows/daily.yml 可被 YAML 解析（需要 pyyaml；没有则本项判失败并提示安装）
  2. 守卫：job 级 if 含 NEWSFORGE_DAILY_ENABLED == 'true'（模板仓库自身惰性）
  3. 触发：schedule 默认 cron 为 30 21 * * *（= 北京时间 05:30）、workflow_dispatch、
     repository_dispatch（event_type newsforge-daily）三入口都在
  4. 步骤：含 run-agent 跑 playbooks/daily.md、构建渲染、npm test QA 门、git commit/push、
     push-telegram.py、failure() 时 upload-artifact、Codex 的 AppArmor 放行步
  5. playbooks/daily.md 章节齐全（输入/步骤序列/输出清单/护栏/完成判据/失败时如何求助），
     且只引用编辑原则与抓取文档（不复制规则）、含 RUN-SUMMARY 约定
  6. 名称对账：workflow 里引用的 vars.*/secrets.* 集合与 docs/ACTIONS.md 清单
     里写全称的集合完全一致（改名必须两边同步）
  7. docs/ACTIONS.md 含必需章节（启用步骤/清单/定时抖动披露/成本/对照/故障排查）
  8. 本次新增/修改文件无模板原站品牌残留（新文件查全文；README/SETUP/PUSH-MODES 查 git diff 新增行）

用法：python3 scripts/check-actions-contract.py（在仓库根目录运行）
退出码：0 = 全过；1 = 有失败项。
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRAND = "heim" + "dall"  # 拼写拆开，避免脚本自身命中品牌检查
BRAND2 = BRAND + "daily"

WORKFLOW = ROOT / ".github" / "workflows" / "daily.yml"
PLAYBOOK = ROOT / "playbooks" / "daily.md"
ACTIONS_DOC = ROOT / "docs" / "ACTIONS.md"

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"（{detail}）" if detail and not ok else ""))


def read(path):
    return path.read_text(encoding="utf-8") if path.exists() else ""


def names_in(text, kind):
    return set(re.findall(rf"{kind}\.([A-Z][A-Z0-9_]*)", text))


def main():
    workflow_text = read(WORKFLOW)
    playbook_text = read(PLAYBOOK)
    doc_text = read(ACTIONS_DOC)

    check("workflow 存在", WORKFLOW.exists())
    check("playbooks/daily.md 存在", PLAYBOOK.exists())
    check("docs/ACTIONS.md 存在", ACTIONS_DOC.exists())

    # 1-4. workflow 结构
    doc = None
    try:
        import yaml  # type: ignore
        try:
            doc = yaml.safe_load(workflow_text)
        except Exception as exc:  # YAML 语法错误
            check("workflow YAML 可解析", False, str(exc)[:200])
    except ImportError:
        check("workflow YAML 可解析", False, "缺 pyyaml：pip install pyyaml 后重跑（GitHub 也会校验 YAML，先在本地过）")
    if isinstance(doc, dict):
        check("workflow YAML 可解析", True)
        triggers = doc.get(True) or doc.get("on") or {}  # YAML 1.1 把 on 解析成 True
        schedule = triggers.get("schedule") or []
        crons = [entry.get("cron") for entry in schedule if isinstance(entry, dict)]
        check("默认 cron 为 30 21 * * *（北京时间 05:30）", "30 21 * * *" in crons, str(crons))
        check("含 workflow_dispatch 触发", "workflow_dispatch" in triggers)
        dispatch = triggers.get("repository_dispatch") or {}
        check("含 repository_dispatch 触发（newsforge-daily）",
              "newsforge-daily" in (dispatch.get("types") or []), str(dispatch))
        jobs = doc.get("jobs") or {}
        job = jobs.get("daily") or {}
        check("job 被 NEWSFORGE_DAILY_ENABLED 守卫",
              "NEWSFORGE_DAILY_ENABLED" in str(job.get("if", "")), str(job.get("if", "")))
        steps = job.get("steps") or []
        runs = "\n".join(str(step.get("run", "")) for step in steps if isinstance(step, dict))
        uses = [str(step.get("uses", "")) for step in steps if isinstance(step, dict)]
        ifs = [str(step.get("if", "")) for step in steps if isinstance(step, dict)]
        check("步骤含 run-agent 跑 playbooks/daily.md",
              "scripts/run-agent" in runs and "playbooks/daily.md" in runs)
        check("步骤含确定性抓取（--fetch-only）", "--fetch-only" in runs)
        check("步骤含构建渲染（pipeline/run.js）", "pipeline/run.js" in runs)
        check("步骤含 QA 门（npm test）", "npm test" in runs)
        check("步骤含 commit + push", "git commit" in runs and "git push" in runs)
        check("步骤含 push-telegram.py", "push-telegram.py" in runs)
        check("步骤含 Codex AppArmor 放行（sysctl userns）",
              "apparmor_restrict_unprivileged_userns" in runs)
        check("失败时上传日志 artifact",
              any("upload-artifact" in u for u in uses) and any("failure()" in i for i in ifs))
        check("permissions 只给 contents: write",
              (doc.get("permissions") or {}).get("contents") == "write",
              str(doc.get("permissions")))

    # 5. daily playbook
    for section in ["## 2. 输入", "## 3. 步骤序列", "## 4. 输出清单",
                    "## 5. 护栏", "## 6. 完成判据", "## 7. 失败时如何求助"]:
        check(f"daily playbook 含章节「{section}」", section in playbook_text)
    check("daily playbook 引用 editorial-principles（只引用不复制）",
          "docs/editorial-principles.md" in playbook_text)
    check("daily playbook 引用 SCRAPING.md", "docs/SCRAPING.md" in playbook_text)
    check("daily playbook 含 RUN-SUMMARY 约定", "RUN-SUMMARY" in playbook_text)
    check("daily playbook 明令 QA 不过不提交", "QA 不过" in playbook_text)

    # 6. 名称对账
    wf_vars, doc_vars = names_in(workflow_text, "vars"), names_in(doc_text, "vars")
    wf_secrets, doc_secrets = names_in(workflow_text, "secrets"), names_in(doc_text, "secrets")
    check("vars 集合 workflow 与 ACTIONS.md 一致",
          wf_vars == doc_vars,
          f"workflow 独有 {sorted(wf_vars - doc_vars)}；文档独有 {sorted(doc_vars - wf_vars)}")
    check("secrets 集合 workflow 与 ACTIONS.md 一致",
          wf_secrets == doc_secrets,
          f"workflow 独有 {sorted(wf_secrets - doc_secrets)}；文档独有 {sorted(doc_secrets - wf_secrets)}")
    check("守卫变量在 vars 集合里", "NEWSFORGE_DAILY_ENABLED" in wf_vars)

    # 7. ACTIONS.md 章节
    for section in ["启用步骤", "Variables 清单", "Secrets 清单",
                    "定时与抖动", "成本量级", "对照", "故障排查"]:
        check(f"ACTIONS.md 含「{section}」", section in doc_text)
    check("ACTIONS.md 指向 playbooks/daily.md", "playbooks/daily.md" in doc_text)
    check("ACTIONS.md 披露 60 天无活动禁用 schedule", "60 天" in doc_text)

    # 8. 品牌残留
    new_files = [PLAYBOOK, ACTIONS_DOC, WORKFLOW,
                 ROOT / "scripts" / "run-agent",
                 ROOT / "scripts" / "check-actions-contract.py",
                 ROOT / "tests" / "run_agent_test.py",
                 ROOT / "tests" / "fixtures" / "fake-claude",
                 ROOT / "tests" / "fixtures" / "fake-codex",
                 ROOT / "tests" / "fixtures" / "fake-gemini"]
    for path in new_files:
        text = read(path).lower()
        check(f"{path.relative_to(ROOT)} 无原站品牌残留",
              BRAND not in text and BRAND2 not in text)
    try:
        diff = subprocess.run(
            ["git", "diff", "HEAD", "--", "README.md", "docs/SETUP.md", "docs/PUSH-MODES.md"],
            capture_output=True, text=True, cwd=str(ROOT), timeout=30).stdout
        added = "\n".join(line[1:] for line in diff.splitlines()
                          if line.startswith("+") and not line.startswith("+++"))
        check("README/SETUP/PUSH-MODES 本次新增行无品牌残留",
              BRAND not in added.lower() and BRAND2 not in added.lower())
    except (OSError, subprocess.SubprocessError) as exc:
        check("README/SETUP/PUSH-MODES 本次新增行无品牌残留", False, str(exc)[:120])

    failed = [r for r in results if not r[1]]
    print(f"\n共 {len(results)} 项，通过 {len(results) - len(failed)}，失败 {len(failed)}")
    if failed:
        return 1
    print("Actions 契约测试全过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
