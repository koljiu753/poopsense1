import json
from dataclasses import FrozenInstanceError
from types import SimpleNamespace

import pytest

from app.model_routing import classify_task, resolve_model, routing_status


def settings(**updates):
    values = dict(llm_routing_enabled=True, llm_profiles_json="{}", llm_routes_json="{}",
                  llm_base_url="https://api.baichuan-ai.com/v1", llm_model="Baichuan-M3-Plus",
                  llm_api_key="fake-existing-baichuan-key", llm_timeout_seconds=30, llm_chat_max_tokens=1024)
    values.update(updates)
    return SimpleNamespace(**values)


def custom(**updates):
    value = {"model": "example-model", "base_url": "https://models.example.com/v1",
             "api_key_env": "EXAMPLE_MODEL_KEY", "adapter": "openai_compatible"}
    value.update(updates)
    return value


def custom_settings(profile=None, **updates):
    return settings(llm_profiles_json=json.dumps({"example": custom() if profile is None else profile}),
                    llm_routes_json=json.dumps({"general_chat": "example"}), **updates)


def test_automatic_defaults_do_not_reuse_other_providers_legacy_key():
    config = settings()
    general = resolve_model("general_chat", config, environ={})
    medical = resolve_model("health_knowledge", config, environ={})
    assert general.id == "deepseek" and not general.configured and general.api_key == ""
    assert medical.id == "baichuan" and medical.api_key == "fake-existing-baichuan-key"
    assert resolve_model("weekly_summary", config, environ={}).id == "deepseek"


def test_legacy_disabled_does_not_parse_or_apply_automatic_configuration():
    config = settings(llm_routing_enabled=False, llm_profiles_json="malformed", llm_routes_json="malformed")
    spec = resolve_model("product_help", config, environ={"DEEPSEEK_API_KEY": "other-secret"})
    assert spec.id == "legacy" and spec.model == config.llm_model and spec.api_key == config.llm_api_key
    assert spec.timeout_seconds == config.llm_timeout_seconds and spec.max_tokens == config.llm_chat_max_tokens


def test_explicit_keys_are_isolated_and_empty_environment_secret_is_not_overridden():
    environment = {"DEEPSEEK_API_KEY": "fake-deepseek", "BAICHUAN_API_KEY": "fake-baichuan"}
    assert resolve_model("general_chat", settings(), environ=environment).api_key == "fake-deepseek"
    assert resolve_model("health_knowledge", settings(), environ=environment).api_key == "fake-baichuan"
    assert not resolve_model("health_knowledge", settings(), environ={"BAICHUAN_API_KEY": ""}).configured
    config = settings(llm_model="other-baichuan-model")
    assert not resolve_model("health_knowledge", config, environ={}).configured


def test_legacy_deepseek_fallback_cannot_configure_a_baichuan_route():
    environment = {"DEEPSEEK_API_KEY": "fake-deepseek-only"}
    config = settings(llm_api_key=environment["DEEPSEEK_API_KEY"])
    medical = resolve_model("health_knowledge", config, environ=environment)
    assert not medical.configured and medical.api_key == ""
    general = resolve_model("general_chat", config, environ=environment)
    assert general.configured and general.api_key == "fake-deepseek-only"
    routes = {item["task"]: item for item in routing_status(config, environ=environment)["routes"]}
    assert not routes["health_knowledge"]["configured"]


def test_legacy_deepseek_fallback_cannot_configure_a_custom_endpoint():
    config = custom_settings(llm_base_url="https://models.example.com/v1", llm_model="example-model",
                             llm_api_key="fake-deepseek-only")
    spec = resolve_model("general_chat", config, environ={"DEEPSEEK_API_KEY": "fake-deepseek-only"})
    assert not spec.configured and spec.api_key == ""


def test_explicit_generic_key_remains_usable_for_its_exact_legacy_endpoint():
    environment = {"DEEPSEEK_API_KEY": "fake-shared-value", "POOPSENSE_LLM_API_KEY": "fake-shared-value"}
    config = settings(llm_api_key=environment["POOPSENSE_LLM_API_KEY"])
    assert resolve_model("health_knowledge", config, environ=environment).api_key == "fake-shared-value"


def test_custom_profile_and_alias_route_are_request_local_and_frozen():
    config = custom_settings(custom(timeout_seconds=12, max_tokens=1536))
    spec = resolve_model("general_chat", config, environ={"EXAMPLE_MODEL_KEY": "fake-custom-secret"})
    assert (spec.id, spec.provider, spec.adapter) == ("example", "openai-compatible", "openai_compatible")
    assert spec.timeout_seconds == 12 and spec.max_tokens == 1536 and spec.configured
    assert "fake-custom-secret" not in repr(spec)
    with pytest.raises(FrozenInstanceError):
        spec.model = "changed"
    assert resolve_model("health_knowledge", config, environ={}).id == "baichuan"


def test_existing_secret_is_not_inherited_for_a_different_endpoint_or_model():
    config = custom_settings(custom(model="Baichuan-M3-Plus"))
    assert not resolve_model("general_chat", config, environ={}).configured
    config = settings(llm_profiles_json=json.dumps({"baichuan": {"model": "Baichuan-M2-Plus"}}))
    assert not resolve_model("health_knowledge", config, environ={}).configured


def test_overriding_builtin_host_requires_an_explicit_new_secret_reference():
    config = settings(llm_profiles_json=json.dumps({"deepseek": {
        "adapter": "openai_compatible", "base_url": "https://models.example.com/v1",
    }}))
    with pytest.raises(ValueError, match="^MODEL_PROFILE_INVALID$"):
        resolve_model("general_chat", config, environ={"DEEPSEEK_API_KEY": "private-key"})


@pytest.mark.parametrize("url", [
    "http://models.example.com/v1", "https://u:private-password@models.example.com/v1",
    "https://models.example.com/v1?key=private", "https://models.example.com/v1#fragment",
    "https://localhost/v1", "https://sub.localhost/v1", "https://localhost.localdomain/v1", "https://metadata.google.internal/v1",
    "https://127.0.0.1/v1", "https://127.0.0.1./v1", "https://10.1.2.3/v1", "https://172.16.2.3/v1", "https://192.168.2.3/v1",
    "https://169.254.169.254/v1", "https://[::1]/v1", "https://[fe80::1]/v1", "https://[::ffff:127.0.0.1]/v1",
    "https://127.1/v1", "https://2130706433/v1", "https://0177.0.0.1/v1", "https://0x7f000001/v1",
    "https://%31%32%37.0.0.1/v1", "https://models.example.com:0/v1", "https://models.example.com:65536/v1",
    "https://models.example.com:wrong/v1", "https://models.example.com/\nprivate", "https://models.example.com/%0aprivate",
    "https://models.example.com\\@127.0.0.1/v1", "https://[broken/v1",
])
def test_invalid_endpoints_fail_without_echoing_configuration(url):
    with pytest.raises(ValueError, match="^MODEL_ENDPOINT_INVALID$"):
        resolve_model("general_chat", custom_settings(custom(base_url=url)), environ={})


@pytest.mark.parametrize("adapter,url", [
    ("deepseek", "https://other.example.com/v1"),
    ("baichuan_medical", "https://api.baichuan-ai.com.evil.example/v1"),
    ("deepseek", "https://api.baichuan-ai.com/v1"),
])
def test_official_adapters_require_exact_official_hostname(adapter, url):
    with pytest.raises(ValueError, match="^MODEL_ENDPOINT_INVALID$"):
        resolve_model("general_chat", custom_settings(custom(adapter=adapter, base_url=url)), environ={})


@pytest.mark.parametrize("profile", [
    custom(api_key="secret-must-not-be-inline"), custom(api_key_env="$(private)"), custom(adapter="eval(code)"), custom(adapter=[]),
    custom(timeout_seconds=0), custom(timeout_seconds=float("inf")), custom(timeout_seconds=True),
    custom(max_tokens=False), custom(max_tokens=0), custom(model="bad\nprivate"), custom(model=""),
])
def test_invalid_profile_fields_are_rejected(profile):
    with pytest.raises(ValueError, match="^MODEL_PROFILE_INVALID$"):
        resolve_model("general_chat", custom_settings(profile), environ={})


@pytest.mark.parametrize("value", ["not JSON", "[]", "null", '{"example":{},"example":{}}'])
def test_invalid_registry_json_is_not_silently_ignored(value):
    with pytest.raises(ValueError, match="^MODEL_ROUTING_CONFIG_INVALID$"):
        resolve_model("general_chat", settings(llm_profiles_json=value), environ={})


def test_unknown_routes_profiles_and_policy_override_are_rejected():
    with pytest.raises(ValueError, match="^MODEL_ROUTE_UNKNOWN$"):
        resolve_model("not_a_task", settings(), environ={})
    with pytest.raises(ValueError, match="^MODEL_ROUTE_UNKNOWN$"):
        resolve_model("general_chat", settings(llm_routes_json='{"typo":"deepseek"}'), environ={})
    with pytest.raises(ValueError, match="^MODEL_PROFILE_UNKNOWN$"):
        resolve_model("general_chat", settings(llm_routes_json='{"general_chat":"missing"}'), environ={})
    with pytest.raises(ValueError, match="^MODEL_ROUTE_POLICY_ONLY$"):
        resolve_model("session_report", settings(), environ={})
    with pytest.raises(ValueError, match="^MODEL_ROUTE_POLICY_ONLY$"):
        routing_status(settings(llm_routes_json='{"structured_action":"baichuan"}'), environ={})


def test_status_has_only_safe_profile_fields_and_explicit_route_sources():
    status = routing_status(custom_settings(), environ={"EXAMPLE_MODEL_KEY": "private-custom-key"})
    serialized = json.dumps(status)
    assert status["mode"] == "auto"
    assert "private-custom-key" not in serialized and "fake-existing-baichuan-key" not in serialized
    assert "https://" not in serialized and "EXAMPLE_MODEL_KEY" not in serialized and "api_key" not in serialized
    assert all(set(item) == {"id", "provider", "model", "configured"} for item in status["profiles"])
    routes = {item["task"]: item for item in status["routes"]}
    assert routes["general_chat"]["reason"] == "configured" and routes["general_chat"]["source"] == "model"
    assert routes["session_report"]["source"] == "policy" and routes["session_report"]["configured"]
    assert routes["weekly_summary"]["configured"] is False
    single = routing_status(settings(llm_routing_enabled=False), environ={})
    assert single["mode"] == "single" and single["profiles"][0]["id"] == "legacy"


@pytest.mark.parametrize("base_url,model,expected", [
    ("https://api.deepseek.com", "deepseek-v4-pro", "model"),
    ("https://models.example.com/v1", "custom-model", "model"),
    ("https://api.baichuan-ai.com/v1", "Baichuan-M3", "model"),
    ("https://api.baichuan-ai.com/v1", "Baichuan-M2-Plus", "policy"),
    ("https://api.baichuan-ai.com/v1", "Baichuan-M3-Plus", "policy"),
])
def test_single_mode_status_reflects_existing_report_and_action_implementation(base_url, model, expected):
    config = settings(llm_routing_enabled=False, llm_base_url=base_url, llm_model=model)
    routes = {item["task"]: item for item in routing_status(config, environ={})["routes"]}
    for task in ("session_report", "structured_action"):
        assert routes[task]["source"] == expected
        if expected == "model":
            assert routes[task]["model"] == model and routes[task]["reason"] == "legacy"
        with pytest.raises(ValueError, match="^MODEL_ROUTE_POLICY_ONLY$"):
            resolve_model(task, config, environ={})


@pytest.mark.parametrize("message,decision,skill,previous,expected", [
    ("怎么打开记录", "explain_trend", "summarize_trend", None, "product_help"),
    ("如何关闭提醒", "health_education", "health_education", None, "product_help"),
    ("便秘时怎么绑定设备", "health_education", "health_education", None, "product_help"),
    ("我有血便，怎么使用软件", "urgent_care", "urgent_care", None, "urgent_care"),
    ("为什么会便秘", "health_education", "health_education", None, "health_knowledge"),
    ("我最近便秘是什么原因", "explain_trend", "summarize_trend", None, "health_knowledge"),
    ("益生菌怎么使用", "health_education", "health_education", None, "health_knowledge"),
    ("怎么使用", "health_education", "health_education", None, "product_help"),
    ("如何记录排便", "health_education", "health_education", None, "product_help"),
    ("腹泻有哪些常见原因", "health_education", "health_education", None, "health_knowledge"),
    ("看看我的最近记录", "explain_trend", "summarize_trend", None, "record_explanation"),
    ("这份记录能证明完全正常吗", "health_education", "health_education", None, "record_explanation"),
    ("颜色形状气味表示什么", "health_education", "health_education", None, "record_explanation"),
    ("粪便颜色形状气味分别观察什么", "health_education", "health_education", None, "record_explanation"),
    ("你好", "health_education", "health_education", None, "general_chat"),
    ("讲个笑话", "health_education", "health_education", "health_knowledge", "general_chat"),
    ("继续说", "health_education", "health_education", "health_knowledge", "health_knowledge"),
    ("那颜色呢？", "health_education", "health_education", "record_explanation", "record_explanation"),
    ("那你呢？", "health_education", "health_education", "general_chat", "general_chat"),
    ("继续", "health_education", "health_education", "structured_action", "general_chat"),
    ("继续", "health_education", "health_education", "unknown", "general_chat"),
])
def test_task_classification_priorities_and_bounded_followups(message, decision, skill, previous, expected):
    assert classify_task(message, decision, skill, previous) == expected
