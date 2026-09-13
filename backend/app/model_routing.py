"""Server-configured model profiles and deterministic, request-local routing."""

from __future__ import annotations

import ipaddress
import json
import math
import os
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Mapping
from urllib.parse import unquote, urlsplit

from .model_provider import is_baichuan_medical_plus, provider_name


TASK_LABELS = {
    "general_chat": "日常问答",
    "product_help": "使用帮助",
    "record_explanation": "记录与趋势解释",
    "weekly_summary": "每周总结",
    "health_knowledge": "健康知识",
    "urgent_care": "紧急情况说明",
    "session_report": "单次记录报告",
    "structured_action": "后台动作选择",
}
POLICY_TASKS = {"session_report", "structured_action"}
TEXT_TASKS = frozenset(TASK_LABELS) - POLICY_TASKS
DEFAULT_ROUTES = {
    task: "policy" if task in POLICY_TASKS else "baichuan" if task == "health_knowledge" else "deepseek"
    for task in TASK_LABELS
}
_ADAPTERS = {"openai_compatible", "deepseek", "baichuan_medical"}
_PROFILE_FIELDS = {"model", "base_url", "api_key_env", "adapter", "timeout_seconds", "max_tokens"}
_IDENTIFIER = re.compile(r"[a-z][a-z0-9_-]{0,63}\Z")
_ENVIRONMENT_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}\Z")


@dataclass(frozen=True)
class ModelSpec:
    id: str
    provider: str
    model: str
    base_url: str
    api_key: str = field(repr=False)
    timeout_seconds: float
    max_tokens: int
    adapter: str

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.api_key.strip())


def _object_json(value: Any) -> dict:
    def unique_pairs(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise ValueError("MODEL_ROUTING_CONFIG_INVALID")
            result[key] = item
        return result

    try:
        result = json.loads(value, object_pairs_hook=unique_pairs)
    except (TypeError, ValueError):
        raise ValueError("MODEL_ROUTING_CONFIG_INVALID") from None
    if not isinstance(result, dict):
        raise ValueError("MODEL_ROUTING_CONFIG_INVALID")
    return result


def _safe_base_url(value: Any, adapter: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("MODEL_ENDPOINT_INVALID")
    decoded = unquote(value)
    if (any(char.isspace() or unicodedata.category(char).startswith("C") for char in value + decoded)
            or any(char in value for char in "\\?#")):
        raise ValueError("MODEL_ENDPOINT_INVALID")
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        if (parsed.scheme != "https" or not host or parsed.username is not None
                or parsed.password is not None or "%" in parsed.netloc
                or (parsed.port is not None and not 1 <= parsed.port <= 65535)):
            raise ValueError
        host = host.encode("idna").decode("ascii").lower()
        if host.endswith("."):
            raise ValueError
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None:
            if not address.is_global or address.is_multicast:
                raise ValueError
        else:
            labels = host.rstrip(".").split(".")
            if (len(labels) < 2 or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part) for part in labels)
                    or host.endswith((".localhost", ".local", ".localdomain", ".internal", ".lan", ".home.arpa"))
                    or re.fullmatch(r"(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*", host)):
                raise ValueError
        expected_host = {"deepseek": "api.deepseek.com", "baichuan_medical": "api.baichuan-ai.com"}.get(adapter)
        if expected_host and host != expected_host:
            raise ValueError
    except (TypeError, ValueError, UnicodeError):
        raise ValueError("MODEL_ENDPOINT_INVALID") from None
    return value.rstrip("/")


def _adapter(base_url: str) -> str:
    provider = provider_name(base_url)
    return "deepseek" if provider == "deepseek" else "baichuan_medical" if provider == "baichuan" else "openai_compatible"


def _legacy(settings: Any) -> ModelSpec:
    return ModelSpec(
        id="legacy", provider=provider_name(settings.llm_base_url), model=settings.llm_model,
        base_url=settings.llm_base_url, api_key=settings.llm_api_key,
        timeout_seconds=settings.llm_timeout_seconds, max_tokens=settings.llm_chat_max_tokens,
        adapter=_adapter(settings.llm_base_url),
    )


def _registry(settings: Any, environ: Mapping[str, str]) -> tuple[dict[str, ModelSpec], dict[str, str], set[str]]:
    builtin = {
        "deepseek": {"model": "deepseek-v4-pro", "base_url": "https://api.deepseek.com",
                     "api_key_env": "DEEPSEEK_API_KEY", "adapter": "deepseek"},
        "baichuan": {"model": "Baichuan-M3-Plus", "base_url": "https://api.baichuan-ai.com/v1",
                     "api_key_env": "BAICHUAN_API_KEY", "adapter": "baichuan_medical"},
    }
    overrides = _object_json(getattr(settings, "llm_profiles_json", "{}"))
    profiles = {}
    for identifier in builtin.keys() | overrides.keys():
        if not isinstance(identifier, str) or not _IDENTIFIER.fullmatch(identifier) or identifier in {"legacy", "policy"}:
            raise ValueError("MODEL_PROFILE_INVALID")
        override = overrides.get(identifier, {})
        if not isinstance(override, dict) or set(override) - _PROFILE_FIELDS:
            raise ValueError("MODEL_PROFILE_INVALID")
        data = {**builtin.get(identifier, {}), **override}
        adapter = data.get("adapter", "openai_compatible")
        if not isinstance(adapter, str) or adapter not in _ADAPTERS:
            raise ValueError("MODEL_PROFILE_INVALID")
        model = data.get("model")
        if (not isinstance(model, str) or not model.strip() or model != model.strip()
                or len(model) > 100 or any(unicodedata.category(char).startswith("C") for char in model)):
            raise ValueError("MODEL_PROFILE_INVALID")
        base_url = _safe_base_url(data.get("base_url"), adapter)
        secret_name = data.get("api_key_env")
        if not isinstance(secret_name, str) or not _ENVIRONMENT_NAME.fullmatch(secret_name):
            raise ValueError("MODEL_PROFILE_INVALID")
        # Moving a built-in profile to another service must explicitly name its
        # new secret: never send a built-in provider key to an overridden host.
        if identifier in builtin and "api_key_env" not in override:
            if urlsplit(base_url).hostname != urlsplit(builtin[identifier]["base_url"]).hostname:
                raise ValueError("MODEL_PROFILE_INVALID")
        timeout = data.get("timeout_seconds", settings.llm_timeout_seconds)
        tokens = data.get("max_tokens", settings.llm_chat_max_tokens)
        if (type(timeout) not in {int, float} or not math.isfinite(timeout) or not 0 < timeout <= 300
                or type(tokens) is not int or not 1 <= tokens <= 32768):
            raise ValueError("MODEL_PROFILE_INVALID")
        key = environ.get(secret_name, "")
        if not isinstance(key, str):
            raise ValueError("MODEL_PROFILE_INVALID")
        # The existing generic secret belongs only to its exact configured
        # endpoint/model pair. Explicitly configured empty secrets stay empty.
        # Legacy settings also fall back to DEEPSEEK_API_KEY. That fallback is
        # not proof that the key belongs to a separately configured endpoint.
        deepseek_fallback = (
            "POOPSENSE_LLM_API_KEY" not in environ
            and "DEEPSEEK_API_KEY" in environ
            and settings.llm_api_key == environ["DEEPSEEK_API_KEY"]
            and provider_name(base_url) != "deepseek"
        )
        if (secret_name not in environ and base_url.rstrip("/") == settings.llm_base_url.rstrip("/")
                and model == settings.llm_model and not deepseek_fallback):
            key = settings.llm_api_key
        profiles[identifier] = ModelSpec(identifier, provider_name(base_url), model, base_url,
                                          key, float(timeout), tokens, adapter)
    configured_routes = _object_json(getattr(settings, "llm_routes_json", "{}"))
    routes = dict(DEFAULT_ROUTES)
    for task, target in configured_routes.items():
        if task not in TASK_LABELS:
            raise ValueError("MODEL_ROUTE_UNKNOWN")
        if not isinstance(target, str):
            raise ValueError("MODEL_ROUTING_CONFIG_INVALID")
        if task in POLICY_TASKS:
            if target != "policy":
                raise ValueError("MODEL_ROUTE_POLICY_ONLY")
        elif target not in profiles:
            raise ValueError("MODEL_PROFILE_UNKNOWN")
        routes[task] = target
    return profiles, routes, set(configured_routes)


def resolve_model(task: str, settings: Any, *, environ: Mapping[str, str] | None = None) -> ModelSpec:
    if task not in TASK_LABELS:
        raise ValueError("MODEL_ROUTE_UNKNOWN")
    if task in POLICY_TASKS:
        raise ValueError("MODEL_ROUTE_POLICY_ONLY")
    if not getattr(settings, "llm_routing_enabled", False):
        return _legacy(settings)
    profiles, routes, _ = _registry(settings, os.environ if environ is None else environ)
    return profiles[routes[task]]


def routing_status(settings: Any, *, environ: Mapping[str, str] | None = None) -> dict:
    automatic = getattr(settings, "llm_routing_enabled", False)
    if automatic:
        profiles, routes, configured_routes = _registry(settings, os.environ if environ is None else environ)
    else:
        legacy = _legacy(settings)
        profiles = {"legacy": legacy}
        medical_policy = is_baichuan_medical_plus(legacy.base_url, legacy.model)
        routes = {task: "policy" if task in POLICY_TASKS and medical_policy else "legacy" for task in TASK_LABELS}
        configured_routes = set()
    result = []
    for task, identifier in routes.items():
        if identifier == "policy":
            result.append({"task": task, "label": TASK_LABELS[task], "source": "policy", "configured": True})
        else:
            spec = profiles[identifier]
            result.append({"task": task, "label": TASK_LABELS[task], "source": "model",
                           "reason": "configured" if task in configured_routes else "default" if automatic else "legacy",
                           "model": spec.model, "provider": spec.provider, "configured": spec.configured})
    return {"mode": "auto" if automatic else "single",
            "profiles": [{"id": spec.id, "provider": spec.provider, "model": spec.model,
                          "configured": spec.configured} for _, spec in sorted(profiles.items())],
            "routes": result}


def classify_task(message: str, decision: str, skill: str, previous_task: str | None = None) -> str:
    if decision == "urgent_care" or skill == "urgent_care":
        return "urgent_care"
    text = message.strip().lower()
    health_terms = ("便秘", "腹泻", "拉肚子", "腹痛", "肚子疼", "胀气", "消化", "肠道", "肠胃", "益生菌",
                    "症状", "疾病", "病因", "就医", "医生", "药物", "用药", "饮食", "纤维", "喝水", "饮水", "运动",
                    "粪便", "大便", "便便", "排便", "恶心", "呕吐", "发烧")
    health_question = any(term in text for term in health_terms)
    product_terms = ("绑定", "解绑", "登录", "登陆", "退出", "怎么记录", "如何记录",
                     "怎么打开", "如何打开", "打不开", "设置", "提醒开关", "关闭提醒", "开启提醒", "授权", "认领",
                     "添加成员", "删除成员", "切换成员", "连接设备", "上传", "导出", "删除记录", "api", "接口", "软件", "网页")
    how_to_use = any(term in text for term in ("怎么用", "如何使用", "怎么使用", "怎么操作", "如何操作"))
    if skill == "manage_household" or any(term in text for term in product_terms) or (how_to_use and not health_question):
        return "product_help"
    if len(text) <= 16 and previous_task in TEXT_TASKS and re.fullmatch(
        r"(?:那.{0,8}呢[？?]?|继续(?:说|讲|解释)?[。！!？?]?|再说一点[。！!]?|然后呢[？?]?|为什么[？?]?|详细(?:一点|说说)[。！!？?]?)", text,
    ):
        return previous_task
    record_terms = ("这份记录", "这条记录", "我的记录", "本次记录", "最近记录", "这次记录", "个人记录",
                    "这份报告", "这次报告", "我的报告", "本次报告", "看报告", "趋势", "基线", "最近变化", "我的数据")
    specific_record = re.search(r"(?:我的|最近|这(?:次|份|条)|本次).{0,5}(?:记录|报告|数据)", text)
    observation_definition = re.search(r"(?:颜色|形状|气味).{0,30}(?:观察|表示|记录|区别|分别)", text)
    if any(term in text for term in record_terms) or specific_record or observation_definition:
        return "record_explanation"
    if health_question:
        return "health_knowledge"
    if decision == "explain_trend" or any(term in text for term in ("记录", "报告", "颜色", "形状", "气味")):
        return "record_explanation"
    return "general_chat"
