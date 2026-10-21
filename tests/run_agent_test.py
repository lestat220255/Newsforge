#!/usr/bin/env python3
"""scripts/run-agent 的离线集成测试：用 tests/fixtures/fake-* 冒充三家 CLI。

覆盖：
  - 三家后端成功路径：退出码 0、状态 JSON、RUN-SUMMARY 提取
  - prompt 一律走 stdin（大 playbook 250 KB 全量到达、且不出现在 argv 里）
  - Codex：apikey 模式先 login --with-api-key 喂 key；chatgpt 模式缺
    auth.json 时前置响亮失败（退出 13、不调用 exec）
  - 失败路径：CLI 非零退出 / 错误信封 / turn.failed → 退出 13，
    且 stderr 带出 agent 输出尾部
  - 超时 → 退出 11；二进制缺失 → 退出 13；后端可由 env 选择

用法：python3 tests/run_agent_test.py（仓库任意目录可跑）
退出码：0 = 全过；1 = 有失败项。
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / "scripts" / "run-agent"
FIXTURES = ROOT / "tests" / "fixtures"

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"（{detail}）" if detail and not ok else ""))


def run_runner(tmp, extra_args, extra_env):
    env = dict(os.environ)
    # 隔离真实环境里可能存在的 key 与后端设置
    for key in list(env):
        if key.startswith(("NEWSFORGE_", "FAKE_")) or key in (
                "OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY",
                "GEMINI_API_KEY", "CODEX_HOME"):
            del env[key]
    env.update(extra_env)
    proc = subprocess.run(
        [sys.executable, str(RUNNER), *extra_args],
        capture_output=True, encoding="utf-8", errors="replace",
        env=env, cwd=str(tmp), timeout=120)
    return proc


def fake_env(tmp, name, mode=None):
    env = {
        f"NEWSFORGE_{name.upper()}_BIN": str(FIXTURES / f"fake-{name}"),
        f"FAKE_{name.upper()}_ARGV_FILE": str(tmp / f"{name}-argv.txt"),
        f"FAKE_{name.upper()}_STDIN_FILE": str(tmp / f"{name}-stdin.txt"),
        f"FAKE_{name.upper()}_COUNT_FILE": str(tmp / f"{name}-count.txt"),
    }
    if mode:
        env[f"FAKE_{name.upper()}_MODE"] = mode
    return env


def read(path):
    path = Path(path)
    return path.read_text(encoding="utf-8") if path.exists() else ""


def main():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        playbook = tmp / "playbook.md"
        playbook.write_text("# 测试 playbook\n按契约执行。\n", encoding="utf-8")
        base = ["--playbook", str(playbook), "--cwd", str(tmp), "--date", "2026-10-21"]

        # 1. claude 成功路径
        env = fake_env(tmp, "claude", "ok")
        proc = run_runner(tmp, [*base, "--backend", "claude"], env)
        status = {}
        try:
            status = json.loads(proc.stdout.strip().splitlines()[-1])
        except (json.JSONDecodeError, IndexError):
            pass
        check("claude 成功：退出 0", proc.returncode == 0, proc.stderr[-200:])
        check("claude 成功：状态 JSON 带 summary",
              status.get("ok") is True and status.get("summary") == "fake-claude 3 新 1 沿用",
              proc.stdout[-200:])
        stdin_text = read(env["FAKE_CLAUDE_STDIN_FILE"])
        argv_text = read(env["FAKE_CLAUDE_ARGV_FILE"])
        check("claude：prompt 走 stdin（含 playbook 与注入日期）",
              "测试 playbook" in stdin_text and "2026-10-21" in stdin_text)
        check("claude：argv 带 -p 与 --allowedTools（含 Bash）",
              "-p" in argv_text.splitlines() and "Bash" in argv_text)

        # 2. claude 非零退出 → 13，stderr 带尾部
        env = fake_env(tmp, "claude", "fail")
        proc = run_runner(tmp, [*base, "--backend", "claude"], env)
        check("claude 失败：退出 13", proc.returncode == 13, f"rc={proc.returncode}")
        check("claude 失败：stderr 带出 agent 输出尾部",
              "invalid api key" in proc.stderr, proc.stderr[-200:])

        # 3. claude 错误信封（退出 0 也必须判失败）
        env = fake_env(tmp, "claude", "envelope-error")
        proc = run_runner(tmp, [*base, "--backend", "claude"], env)
        check("claude 错误信封：退出 13", proc.returncode == 13, f"rc={proc.returncode}")

        # 4. claude 超时 → 11
        env = fake_env(tmp, "claude", "hang")
        proc = run_runner(tmp, [*base, "--backend", "claude", "--timeout", "2"], env)
        check("claude 超时：退出 11", proc.returncode == 11, f"rc={proc.returncode}")

        # 5. codex 成功路径 + login 喂 key + argv 形状
        env = fake_env(tmp, "codex", "ok")
        env["OPENAI_API_KEY"] = "sk-test-dummy"
        env["FAKE_CODEX_LOGIN_FILE"] = str(tmp / "codex-login.txt")
        log_path = tmp / "agent.log"
        proc = run_runner(tmp, [*base, "--backend", "codex", "--log", str(log_path)], env)
        status = {}
        try:
            status = json.loads(proc.stdout.strip().splitlines()[-1])
        except (json.JSONDecodeError, IndexError):
            pass
        check("codex 成功：退出 0", proc.returncode == 0, proc.stderr[-200:])
        check("codex 成功：summary 来自 agent_message",
              status.get("summary") == "fake-codex 2 新 0 沿用", proc.stdout[-200:])
        check("codex：login 收到 env 里的 key",
              read(env["FAKE_CODEX_LOGIN_FILE"]) == "sk-test-dummy")
        argv_lines = read(env["FAKE_CODEX_ARGV_FILE"]).splitlines()
        check("codex：exec 形状（exec - / workspace-write / -C）",
              argv_lines[:2] == ["exec", "-"] and "workspace-write" in argv_lines
              and "-C" in argv_lines, str(argv_lines))
        check("codex：--log 落盘含事件流", "turn.completed" in read(log_path))

        # 6. codex 大 prompt：250 KB 只走 stdin，argv 里没有
        big = tmp / "big-playbook.md"
        marker = "BIGPLAYBOOKMARKER"
        big.write_text("# 大 playbook\n" + ("填充行 filler line\n" * 15000) + marker + "\n",
                       encoding="utf-8")
        env = fake_env(tmp, "codex", "ok")
        proc = run_runner(tmp, ["--playbook", str(big), "--cwd", str(tmp),
                                "--backend", "codex"], env)
        stdin_text = read(env["FAKE_CODEX_STDIN_FILE"])
        argv_text = read(env["FAKE_CODEX_ARGV_FILE"])
        check("codex 大 prompt：退出 0", proc.returncode == 0, proc.stderr[-200:])
        check("codex 大 prompt：stdin 全量到达（>250 KB）",
              len(stdin_text.encode("utf-8")) > 250_000, str(len(stdin_text.encode("utf-8"))))
        check("codex 大 prompt：argv 不含 playbook 内容", marker not in argv_text)

        # 7. codex turn.failed → 13
        env = fake_env(tmp, "codex", "turnfail")
        proc = run_runner(tmp, [*base, "--backend", "codex"], env)
        check("codex turn.failed：退出 13", proc.returncode == 13, f"rc={proc.returncode}")
        check("codex turn.failed：stderr 带出失败原因",
              "no credits remaining" in proc.stderr, proc.stderr[-200:])

        # 8. codex chatgpt 模式缺 auth.json → 前置失败、不调用 exec
        empty_home = tmp / "empty-codex-home"
        empty_home.mkdir()
        env = fake_env(tmp, "codex", "ok")
        env["NEWSFORGE_CODEX_AUTH"] = "chatgpt"
        env["CODEX_HOME"] = str(empty_home)
        count_before = read(env["FAKE_CODEX_COUNT_FILE"])
        proc = run_runner(tmp, [*base, "--backend", "codex"], env)
        check("codex chatgpt 缺 auth.json：退出 13", proc.returncode == 13, f"rc={proc.returncode}")
        check("codex chatgpt 缺 auth.json：stderr 指名 auth.json",
              "auth.json" in proc.stderr, proc.stderr[-200:])
        check("codex chatgpt 缺 auth.json：exec 未被调用（计数不变）",
              read(env["FAKE_CODEX_COUNT_FILE"]) == count_before)

        # 9. gemini 成功路径（后端经 env 选择，不传 --backend）
        env = fake_env(tmp, "gemini", "ok")
        env["NEWSFORGE_AGENT_BACKEND"] = "gemini"
        proc = run_runner(tmp, ["--playbook", str(playbook), "--cwd", str(tmp)], env)
        status = {}
        try:
            status = json.loads(proc.stdout.strip().splitlines()[-1])
        except (json.JSONDecodeError, IndexError):
            pass
        check("gemini 成功（env 选后端）：退出 0", proc.returncode == 0, proc.stderr[-200:])
        check("gemini：prompt 走 stdin、argv 带 -p",
              "测试 playbook" in read(env["FAKE_GEMINI_STDIN_FILE"])
              and "-p" in read(env["FAKE_GEMINI_ARGV_FILE"]).splitlines())
        check("gemini：summary 提取", status.get("summary") == "fake-gemini 1 新 0 沿用",
              proc.stdout[-200:])

        # 10. gemini 错误信封 → 13
        env = fake_env(tmp, "gemini", "error")
        proc = run_runner(tmp, [*base, "--backend", "gemini"], env)
        check("gemini 错误信封：退出 13", proc.returncode == 13, f"rc={proc.returncode}")

        # 11. 二进制缺失 → 13
        env = {"NEWSFORGE_CLAUDE_BIN": str(tmp / "no-such-binary")}
        proc = run_runner(tmp, [*base, "--backend", "claude"], env)
        check("二进制缺失：退出 13", proc.returncode == 13, f"rc={proc.returncode}")

    failed = [r for r in results if not r[1]]
    print(f"\n共 {len(results)} 项，通过 {len(results) - len(failed)}，失败 {len(failed)}")
    if failed:
        return 1
    print("run-agent 集成测试全过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
