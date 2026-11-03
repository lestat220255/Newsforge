#!/usr/bin/env python3
"""离线契约测试：校验 Newsforge 的 Actions 日更（BYOK 模式）各文件一致性。

检查项：
  1. .github/workflows/daily.yml 可被 YAML 解析（需要 pyyaml；没有则本项判失败并提示安装）
  2. 守卫：edit job 级 if 含 NEWSFORGE_DAILY_ENABLED == 'true'（模板仓库自身惰性）；
     publish job needs edit
  3. 触发：schedule 默认 cron 为 30 21 * * *（= 北京时间 05:30）、workflow_dispatch、
     repository_dispatch（event_type newsforge-daily）三入口都在
  4. 步骤（跨 job 对账）：edit job 含 run-agent 跑 playbooks/daily.md、确定性抓取、
     Codex 的 AppArmor 放行步；publish job 含构建渲染、R2 上传（在 QA 之前）、
     npm test QA 门、密钥扫描、build-id 标记、git commit/push（含 build-id.json）、
     部署确认、push-telegram.py（且部署确认在 Telegram 之前）；任一 job
     含 failure() 时 upload-artifact
  4b. 日期不可变：edit job 定义 outputs.today，publish job 用
     needs.edit.outputs.today，不重算
  4c. R2 开关一致性：publish 配置校验含 var 与 site.json flag 对账断言
  4d. npm test 纳入契约测试与 agent 模拟测试（package.json 的 test 脚本）
  5. playbooks/daily.md 章节齐全（输入/步骤序列/输出清单/护栏/完成判据/失败时如何求助），
     且只引用编辑原则与抓取文档（不复制规则）、含 RUN-SUMMARY 约定
  6. 名称对账：workflow 里引用的 vars.*/secrets.* 集合与 docs/ACTIONS.md 清单
     里写全称的集合完全一致（改名必须两边同步）
  7. docs/ACTIONS.md 含必需章节（启用步骤/清单/定时抖动披露/成本/对照/故障排查）
  8. 本次新增/修改文件无模板原站品牌残留（新文件查全文；README/SETUP/PUSH-MODES 查 git diff 新增行）
  9. 权限隔离：workflow 级不得有 contents:write；edit job 为 contents:read 且
     checkout 不持久化凭证；agent 步骤 env 不含 R2_/TELEGRAM 密钥且只含模型 key；
     publish job 为 contents:write、checkout 锁定 github.sha

用法：python3 scripts/check-actions-contract.py（在仓库根目录运行）
退出码：0 = 全过；1 = 有失败项。
"""
import json
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
        edit = jobs.get("edit") or {}
        publish = jobs.get("publish") or {}
        check("含 edit 与 publish 两个 job", bool(edit) and bool(publish), str(sorted(jobs)))
        check("edit job 被 NEWSFORGE_DAILY_ENABLED 守卫",
              "NEWSFORGE_DAILY_ENABLED" in str(edit.get("if", "")), str(edit.get("if", "")))
        check("publish job needs edit",
              "edit" in (publish.get("needs") or []), str(publish.get("needs")))
        def job_runs(job):
            return "\n".join(str(step.get("run", ""))
                              for step in (job.get("steps") or []) if isinstance(step, dict))
        def job_uses(job):
            return [str(step.get("uses", ""))
                    for step in (job.get("steps") or []) if isinstance(step, dict)]
        def job_ifs(job):
            return [str(step.get("if", ""))
                    for step in (job.get("steps") or []) if isinstance(step, dict)]
        edit_runs, publish_runs = job_runs(edit), job_runs(publish)
        check("edit 步骤含 run-agent 跑 playbooks/daily.md",
              "scripts/run-agent" in edit_runs and "playbooks/daily.md" in edit_runs)
        check("edit 步骤含确定性抓取（--fetch-only）", "--fetch-only" in edit_runs)
        check("edit 步骤含 Codex AppArmor 放行（sysctl userns）",
              "apparmor_restrict_unprivileged_userns" in edit_runs)
        check("publish 步骤含构建渲染（pipeline/run.js）", "pipeline/run.js" in publish_runs)
        check("publish 步骤含 QA 门（npm test）", "npm test" in publish_runs)
        check("publish 步骤含 commit + push",
              "git commit" in publish_runs and "git push" in publish_runs)
        check("publish 步骤含密钥扫描（check-edition-secrets.py）",
              "check-edition-secrets.py" in publish_runs)
        check("publish 步骤含 build-id 标记（build-id.json）",
              "build-id.json" in publish_runs)
        check("publish 提交步含 build-id.json",
              "git add public/build-id.json" in publish_runs)
        check("publish 配置校验含 R2 开关一致性断言",
              "开关不一致" in publish_runs)
        publish_run_list = [str(step.get("run", ""))
                            for step in (publish.get("steps") or [])
                            if isinstance(step, dict)]
        upload_idx = next((i for i, r in enumerate(publish_run_list)
                           if "--upload-images" in r), -1)
        qa_idx = next((i for i, r in enumerate(publish_run_list)
                       if "npm test" in r), -1)
        check("R2 上传步在 QA 步之前",
              0 <= upload_idx < qa_idx, f"upload={upload_idx} qa={qa_idx}")
        upload_steps = [step for step in (publish.get("steps") or [])
                        if isinstance(step, dict)
                        and "--upload-images" in str(step.get("run", ""))]
        check("R2 上传步无 continue-on-error（失败即中止发布）",
              all(step.get("continue-on-error") is not True for step in upload_steps)
              and bool(upload_steps), str(upload_steps))
        check("publish QA 步设 NEWSFORGE_QA_AFTER_UPLOAD=1（R2 本地引用检查生效）",
              any("NEWSFORGE_QA_AFTER_UPLOAD=1" in r for r in publish_run_list))
        check("build-id 标记步写 editionSha256 字段",
              any("editionSha256" in r for r in publish_run_list))
        check("edit job 定义 outputs.today",
              "steps.date.outputs.TODAY" in str(edit.get("outputs", "")),
              str(edit.get("outputs")))
        check("edit 计算日期步写 GITHUB_OUTPUT",
              "GITHUB_OUTPUT" in edit_runs)
        check("publish job 用 needs.edit.outputs.today（不重算日期）",
              "needs.edit.outputs.today" in publish_runs)
        check("publish 步骤含部署确认（verify-deploy.py）",
              "verify-deploy.py" in publish_runs)
        publish_steps = publish.get("steps") or []
        publish_run_order = [str(step.get("run", "")) for step in publish_steps
                             if isinstance(step, dict)]
        verify_idx = next((i for i, r in enumerate(publish_run_order)
                           if "verify-deploy.py" in r), -1)
        telegram_idx = next((i for i, r in enumerate(publish_run_order)
                             if "push-telegram.py" in r), -1)
        check("部署确认在 Telegram 推送之前",
              0 <= verify_idx < telegram_idx, f"verify={verify_idx} telegram={telegram_idx}")
        check("失败时上传日志 artifact",
              any("upload-artifact" in u for u in job_uses(edit) + job_uses(publish))
              and any("failure()" in i for i in job_ifs(edit) + job_ifs(publish)))
        # 9. 权限隔离
        check("workflow 级不得有 contents:write",
              (doc.get("permissions") or {}).get("contents") != "write",
              str(doc.get("permissions")))
        check("edit job 权限为 contents:read",
              (edit.get("permissions") or {}).get("contents") == "read",
              str(edit.get("permissions")))
        check("publish job 权限为 contents:write",
              (publish.get("permissions") or {}).get("contents") == "write",
              str(publish.get("permissions")))
        edit_checkouts = [step for step in (edit.get("steps") or [])
                          if isinstance(step, dict)
                          and "actions/checkout" in str(step.get("uses", ""))]
        check("edit job checkout 不持久化凭证",
              any(step.get("with", {}).get("persist-credentials") is False
                  for step in edit_checkouts), str(edit_checkouts))
        publish_checkouts = [step for step in (publish.get("steps") or [])
                             if isinstance(step, dict)
                             and "actions/checkout" in str(step.get("uses", ""))]
        check("publish job checkout 锁定 github.sha",
              any("github.sha" in str(step.get("with", {}).get("ref", ""))
                  for step in publish_checkouts), str(publish_checkouts))
        agent_envs = []
        for job in (edit, publish):
            for step in (job.get("steps") or []):
                if isinstance(step, dict) and "scripts/run-agent" in str(step.get("run", "")):
                    agent_envs.append(str(step.get("env", "")))
        agent_secrets = set()
        for env_text in agent_envs:
            agent_secrets |= names_in(env_text, "secrets")
        check("agent 步骤 env 不含 R2_/TELEGRAM 密钥",
              not any(s.startswith("R2_") or s == "NEWSFORGE_TELEGRAM_BOT_TOKEN"
                      for s in agent_secrets), str(sorted(agent_secrets)))
        check("agent 步骤 env 只含模型 key",
              agent_secrets <= {"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"},
              str(sorted(agent_secrets)))

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

    # 4d. npm scripts 按职责拆分，test 依次跑四者
    try:
        pkg_scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8")
                                 ).get("scripts", {})
    except (OSError, ValueError):
        pkg_scripts = {}
    check("test:contract 跑契约测试",
          "check-actions-contract.py" in pkg_scripts.get("test:contract", ""))
    check("test:agent 跑 agent 模拟测试",
          "run_agent_test.py" in pkg_scripts.get("test:agent", ""))
    check("qa 跑 qa-check.py",
          "pipeline/qa-check.py" in pkg_scripts.get("qa", ""))
    check("test:unit 跑 node 单测",
          "node --test" in pkg_scripts.get("test:unit", ""))
    test_entry = pkg_scripts.get("test", "")
    check("test 依次跑 test:unit / test:contract / test:agent / qa",
          all(s in test_entry for s in
              ("test:unit", "test:contract", "test:agent", "qa")), test_entry[:160])

    # 4e. 渲染把 public/ 拷到 dist/（build-id.json 才能随构建上线）
    render_text = read(ROOT / "pipeline" / "lib" / "render.js")
    check("渲染复制 public/ 到 dist/（build-id.json 能上线）",
          "cpSync(pubDir, DIST" in render_text)

    # 8. 品牌残留
    new_files = [PLAYBOOK, ACTIONS_DOC, WORKFLOW,
                 ROOT / "scripts" / "run-agent",
                 ROOT / "scripts" / "check-actions-contract.py",
                 ROOT / "scripts" / "check-edition-secrets.py",
                 ROOT / "scripts" / "verify-deploy.py",
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
