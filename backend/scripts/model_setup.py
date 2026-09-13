"""Local-only model onboarding. Importing this module never loads app config."""

from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from types import SimpleNamespace
from typing import Mapping
from urllib.parse import urlsplit
import warnings

import httpx

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.model_provider import prepare_model_payload
from app.model_routing import routing_status


PRESETS = {
    "deepseek": {"base_url": "https://api.deepseek.com", "model": "deepseek-v4-pro",
                 "api_key_env": "DEEPSEEK_API_KEY"},
    "baichuan": {"base_url": "https://api.baichuan-ai.com/v1", "model": "Baichuan-M3-Plus",
                 "api_key_env": "BAICHUAN_API_KEY"},
}
PROFILES_ENV = "POOPSENSE_LLM_PROFILES"
ROUTING_ENV = "POOPSENSE_LLM_ROUTING_ENABLED"
PROFILE_ID = re.compile(r"[a-z][a-z0-9_]{0,31}\Z")
PROBE_MESSAGE = "这是虚构的接口连通检查，不涉及真实个人。请用一句话说明日常观察记录不等于疾病诊断。"
RESTART_NOTICE = "本地服务需重启后读取新配置；线上环境需单独配置并重新部署，本工具不会更新 Vercel。"


class SetupError(Exception):
    """Only fixed, non-secret messages are allowed to reach the terminal."""


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, "命令无效。密钥只能在交互提示中输入，不能作为命令行参数。\n")


def checked_routing_status(values: Mapping[str, str]) -> dict:
    try:
        config = SimpleNamespace(
            llm_routing_enabled=True,
            llm_profiles_json=values.get(PROFILES_ENV, "{}"),
            llm_routes_json=values.get("POOPSENSE_LLM_ROUTES", "{}"),
            llm_base_url=values.get("POOPSENSE_LLM_BASE_URL", "https://api.deepseek.com"),
            llm_model=values.get("POOPSENSE_LLM_MODEL", "deepseek-v4-pro"),
            llm_api_key=values.get("POOPSENSE_LLM_API_KEY", ""),
            llm_timeout_seconds=float(values.get("POOPSENSE_LLM_TIMEOUT_SECONDS", "30")),
            llm_chat_max_tokens=int(values.get("POOPSENSE_LLM_CHAT_MAX_TOKENS", "1024")),
        )
        return routing_status(config, environ=values)
    except (ValueError, TypeError, AttributeError):
        raise SetupError("模型或路由配置无效，未修改文件；请核对模型地址、标识与路由。") from None


def read_local_env(path: Path) -> tuple[bytes | None, dict[str, str]]:
    raw = path.read_bytes() if path.exists() else None
    values: dict[str, str] = {}
    try:
        text = raw.decode("utf-8-sig") if raw is not None else ""
    except UnicodeDecodeError:
        raise SetupError("本地配置不是 UTF-8，未修改文件。") from None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        # Match the application's first-assignment-wins loader.
        values.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return raw, values


def read_profiles(values: Mapping[str, str]) -> dict:
    try:
        profiles = json.loads(values.get(PROFILES_ENV, "{}"))
    except (ValueError, TypeError):
        raise SetupError("已有模型列表 JSON 无效，未修改配置。") from None
    if not isinstance(profiles, dict):
        raise SetupError("已有模型列表格式无效，未修改配置。")
    return profiles


def merge_local_env(path: Path, original: bytes | None, updates: dict[str, str]) -> None:
    """Replace only selected keys, atomically; reject edits made during the probe."""
    current = path.read_bytes() if path.exists() else None
    if current != original:
        raise SetupError("连通检查期间配置已被其他操作更新，本次未覆盖，请重新运行。")
    text = original.decode("utf-8-sig") if original is not None else ""
    newline = "\r\n" if "\r\n" in text else "\n"
    pending = dict(updates)
    lines = []
    for line in text.splitlines(keepends=True):
        stripped = line.strip()
        key = stripped.split("=", 1)[0].strip() if "=" in stripped and not stripped.startswith("#") else None
        if key in updates:
            if key in pending:
                lines.append(f"{key}={pending.pop(key)}{newline}")
            # Remove duplicate definitions only for the keys being updated.
        else:
            lines.append(line)
    merged = "".join(lines)
    if pending:
        if merged and not merged.endswith(("\n", "\r")):
            merged += newline
        merged += "".join(f"{key}={value}{newline}" for key, value in pending.items())
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".env.model-", suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            os.chmod(temporary, 0o600)
            output.write(merged.encode("utf-8"))
            output.flush()
            os.fsync(output.fileno())
        # A second check covers changes made while the temporary file was written.
        if (path.read_bytes() if path.exists() else None) != original:
            raise SetupError("配置已被其他操作更新，本次未覆盖，请重新运行。")
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def validate_target(profile: dict) -> None:
    checked_routing_status({PROFILES_ENV: json.dumps({"setup_probe": profile})})


def check_connection(profile: dict, api_key: str, *, client_factory=None) -> None:
    validate_target(profile)
    payload = prepare_model_payload(
        profile["base_url"], profile["model"],
        [{"role": "system", "content": "只回答本次虚构连通检查，不诊断，不索取个人信息，最多一句话。"},
         {"role": "user", "content": PROBE_MESSAGE}],
        max_tokens=256,
        disable_thinking=urlsplit(profile["base_url"]).hostname == "api.deepseek.com",
    )
    try:
        factory = client_factory or httpx.Client
        with factory(timeout=profile.get("timeout_seconds", 30), follow_redirects=False) as client:
            response = client.post(
                profile["base_url"].rstrip("/") + "/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"}, json=payload,
            )
        if response.status_code != 200:
            raise SetupError("连通检查未返回 HTTP 200，未保存；请核对接口、模型权限和密钥。")
        choice = response.json()["choices"][0]
        if choice.get("finish_reason") != "stop":
            raise SetupError("连通检查回答未完整结束，未保存配置。")
        content = choice["message"]["content"]
        if not isinstance(content, str) or not content.strip():
            raise SetupError("连通检查没有返回正文，未保存配置。")
    except SetupError:
        raise
    except Exception:
        # Provider exceptions can include URLs, headers or echoed credentials.
        raise SetupError("连通检查失败，未保存；请核对网络、接口和模型配置。") from None


def list_models(values: Mapping[str, str], status: dict) -> None:
    print("本地模型配置（已配置只表示密钥非空，不代表当前连通）：")
    for profile in status["profiles"]:
        print(f"  {profile['id']}: {'已配置' if profile['configured'] else '未配置'}")
    enabled = values.get(ROUTING_ENV, "false").lower() in {"1", "true", "yes"}
    print(f"自动路由: {'已启用' if enabled else '未启用'}")


def main(argv=None, *, env_path: Path | None = None, environ: Mapping[str, str] | None = None,
         client_factory=None) -> int:
    parser = SafeArgumentParser(description="本地配置模型：密钥不回显，连通成功后才保存；不更新线上环境。")
    parser.add_argument("command", nargs="?", default="setup", choices=["setup", "list", "dry-run", "enable-auto"])
    parser.add_argument("--dry-run", action="store_true", help="只列出配置状态，不输入密钥、不发送请求、不写文件")
    args = parser.parse_args(argv)
    path = env_path if env_path is not None else BACKEND_ROOT / ".env.local"
    process_env = dict(os.environ if environ is None else environ)
    try:
        original, local_values = read_local_env(path)
        effective = {**local_values, **process_env}
        profiles = read_profiles(effective)
        status = checked_routing_status(effective)
        if args.dry_run or args.command in {"list", "dry-run"}:
            list_models(effective, status)
            return 0
        if args.command == "enable-auto":
            configured = {profile["id"]: profile["configured"] for profile in status["profiles"]}
            if not all(configured.get(name, False) for name in PRESETS):
                raise SetupError("自动路由需要先配置 DeepSeek 和百川两枚密钥，本次未修改。")
            if any(not route["configured"] for route in status["routes"]):
                raise SetupError("已有路由指向尚未配置的模型，本次未启用；请先完成对应模型配置。")
            if ROUTING_ENV in process_env and process_env[ROUTING_ENV].lower() not in {"1", "true", "yes"}:
                raise SetupError("当前进程环境变量关闭了自动路由，请先同步该变量；本次未修改文件。")
            merge_local_env(path, original, {ROUTING_ENV: "true"})
            print("已在本地配置启用自动路由，保留已有路由规则。")
            print(RESTART_NOTICE)
            return 0
        print("选择接入模型：1. DeepSeek  2. 百川医疗  3. 通用 OpenAI-compatible")
        choice = input("请选择 [1/2/3]：").strip().lower()
        name = {"1": "deepseek", "2": "baichuan", "3": "custom"}.get(choice, choice)
        if name in PRESETS:
            profile = dict(PRESETS[name])
            override = profiles.get(name, {})
            if any(override.get(key, value) != value for key, value in profile.items()):
                raise SetupError("此预设已有自定义地址、型号或密钥变量，请使用通用兼容选项配置；未修改文件。")
        elif name == "custom":
            name = input("模型配置名称（小写字母、数字、下划线）：").strip()
            if not PROFILE_ID.fullmatch(name) or name in {*PRESETS, "legacy", "policy"}:
                raise SetupError("配置名称无效或与内置名称重复，未修改配置。")
            profile = {
                "adapter": "openai_compatible",
                "base_url": input("API 基址（通常以 /v1 结尾）：").strip().rstrip("/"),
                "model": input("供应商模型标识：").strip(),
                "api_key_env": f"POOPSENSE_MODEL_{name.upper()}_API_KEY",
                "max_tokens": 1024, "timeout_seconds": 30,
            }
        else:
            raise SetupError("请选择 1、2 或 3，未修改配置。")
        validate_target(profile)
        print("将发送一次虚构的简短连通检查；这不是医学能力验证。")
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            api_key = getpass.getpass("API 密钥（输入不回显）：").strip()
        if (not api_key or any(character.isspace() or not character.isprintable() for character in api_key)
                or '"' in api_key or "'" in api_key):
            raise SetupError("密钥不能为空，也不能包含空白、控制字符或引号；未发送请求。")
        check_connection(profile, api_key, client_factory=client_factory)
        updates = {profile["api_key_env"]: api_key}
        if name not in PRESETS:
            profiles[name] = profile
            updates[PROFILES_ENV] = json.dumps(profiles, ensure_ascii=False, separators=(",", ":"))
        checked_routing_status({**effective, **updates})
        merge_local_env(path, original, updates)
        print(f"{name}: 连通检查通过，已保存本地配置。")
        if any(key in process_env for key in updates):
            print("注意：当前进程同名环境变量优先于本地文件，请同步后再启动服务。")
        print("自动路由状态未变；两种预设配置完成后，可运行 enable-auto。")
        print(RESTART_NOTICE)
        return 0
    except getpass.GetPassWarning:
        print("当前终端不支持安全隐藏输入，请在交互终端运行；未读取或保存密钥。", file=sys.stderr)
        return 1
    except SetupError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError):
        print("无法完成本地配置操作；未输出任何密钥或服务端原文。", file=sys.stderr)
        return 1
    except (EOFError, KeyboardInterrupt):
        print("已取消模型配置。", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
