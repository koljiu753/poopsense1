import importlib.util
import json
from pathlib import Path

import httpx
import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "model_setup.py"
spec = importlib.util.spec_from_file_location("model_setup_under_test", SCRIPT)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


def provider(monkeypatch, *, content="观察记录不等于疾病诊断。", finish="stop", status=200, on_request=None):
    requests = []

    def respond(request):
        requests.append(request)
        if on_request:
            on_request()
        return httpx.Response(status, json={"choices": [{
            "finish_reason": finish, "message": {"content": content},
        }]})

    return requests, lambda **kwargs: httpx.Client(transport=httpx.MockTransport(respond), **kwargs)


def answers(monkeypatch, *values, key="test-entered-key"):
    choices = iter(values)
    monkeypatch.setattr("builtins.input", lambda prompt: next(choices))
    monkeypatch.setattr(setup.getpass, "getpass", lambda prompt: key)


@pytest.mark.parametrize("selection,name,key_env", [
    ("1", "deepseek", "DEEPSEEK_API_KEY"), ("2", "baichuan", "BAICHUAN_API_KEY"),
])
def test_success_checks_once_without_echoing_key_and_preserves_other_settings(tmp_path, monkeypatch, capsys, selection, name, key_env):
    path = tmp_path / ".env.local"
    original = b'# keep this comment\r\nOTHER_SETTING="unchanged"\r\nPOOPSENSE_LLM_ROUTES={"general_chat":"deepseek"}\r\n'
    path.write_bytes(original)
    requests, factory = provider(monkeypatch)
    answers(monkeypatch, selection)
    assert setup.main([], env_path=path, environ={}, client_factory=factory) == 0
    assert len(requests) == 1
    assert requests[0].headers["Authorization"] == "Bearer test-entered-key"
    payload = json.loads(requests[0].content)
    assert payload["max_tokens"] == 256
    assert payload["model"] == setup.PRESETS[name]["model"]
    if name == "baichuan":
        assert payload["metadata"]["output_style"] == "patient"
        assert all(item["role"] != "system" for item in payload["messages"])
        assert "thinking" not in payload
    else:
        assert payload["thinking"] == {"type": "disabled"}
    assert path.read_bytes().startswith(original)
    assert setup.read_local_env(path)[1][key_env] == "test-entered-key"
    output = capsys.readouterr()
    assert "test-entered-key" not in output.out + output.err
    assert "需重启" in output.out and "重新部署" in output.out


def test_custom_profile_is_merged_and_existing_routes_and_key_kept(tmp_path, monkeypatch):
    path = tmp_path / ".env.local"
    existing = {"existing": {"adapter": "openai_compatible", "base_url": "https://first.example/v1", "model": "first", "api_key_env": "FIRST_KEY"}}
    path.write_text("FIRST_KEY=old-test-key\nPOOPSENSE_LLM_PROFILES=" + json.dumps(existing) + '\nPOOPSENSE_LLM_ROUTES={"general_chat":"existing"}\n', encoding="utf-8")
    requests, factory = provider(monkeypatch)
    answers(monkeypatch, "3", "local_model", "https://custom.example/v1/", "custom-model")
    assert setup.main([], env_path=path, environ={}, client_factory=factory) == 0
    values = setup.read_local_env(path)[1]
    profiles = json.loads(values[setup.PROFILES_ENV])
    assert profiles["existing"] == existing["existing"]
    assert profiles["local_model"] == {
        "adapter": "openai_compatible", "base_url": "https://custom.example/v1", "model": "custom-model",
        "api_key_env": "POOPSENSE_MODEL_LOCAL_MODEL_API_KEY", "max_tokens": 1024, "timeout_seconds": 30,
    }
    assert values["FIRST_KEY"] == "old-test-key"
    assert values["POOPSENSE_LLM_ROUTES"] == '{"general_chat":"existing"}'
    assert str(requests[0].url) == "https://custom.example/v1/chat/completions"
    assert "metadata" not in json.loads(requests[0].content)


@pytest.mark.parametrize("status,finish,content", [(401, "stop", "secret echo"), (200, "length", "partial"), (200, "stop", ""), (200, "stop", None)])
def test_failed_checks_never_overwrite_config_or_echo_provider_body(tmp_path, monkeypatch, capsys, status, finish, content):
    path = tmp_path / ".env.local"
    original = b"DEEPSEEK_API_KEY=keep-old-test-key\nOTHER=keep\n"
    path.write_bytes(original)
    requests, factory = provider(monkeypatch, status=status, finish=finish, content=content)
    answers(monkeypatch, "1")
    assert setup.main([], env_path=path, environ={}, client_factory=factory) == 1
    assert path.read_bytes() == original
    assert len(requests) == 1
    output = capsys.readouterr()
    assert "test-entered-key" not in output.out + output.err
    assert "secret echo" not in output.out + output.err


@pytest.mark.parametrize("command", ["list", "dry-run", "--dry-run"])
def test_status_commands_only_show_names_and_configuration_without_network_or_input(tmp_path, monkeypatch, capsys, command):
    path = tmp_path / ".env.local"
    original = b"DEEPSEEK_API_KEY=private-test-value\n"
    path.write_bytes(original)
    def unexpected(*args, **kwargs):
        pytest.fail("Read-only commands must not prompt or connect")
    monkeypatch.setattr("builtins.input", unexpected)
    monkeypatch.setattr(setup.getpass, "getpass", unexpected)
    assert setup.main([command], env_path=path, environ={}, client_factory=unexpected) == 0
    assert path.read_bytes() == original
    output = capsys.readouterr()
    assert "deepseek: 已配置" in output.out and "baichuan: 未配置" in output.out
    assert "private-test-value" not in output.out + output.err


def test_enable_auto_requires_both_keys_and_preserves_custom_routes(tmp_path, capsys):
    path = tmp_path / ".env.local"
    original = 'DEEPSEEK_API_KEY=first-test-key\nPOOPSENSE_LLM_ROUTES={"weekly_summary":"deepseek"}\n'
    path.write_text(original, encoding="utf-8")
    assert setup.main(["enable-auto"], env_path=path, environ={}) == 1
    assert path.read_text(encoding="utf-8") == original
    assert setup.main(["enable-auto"], env_path=path, environ={"BAICHUAN_API_KEY": "second-test-key"}) == 0
    values = setup.read_local_env(path)[1]
    assert values[setup.ROUTING_ENV] == "true"
    assert values["POOPSENSE_LLM_ROUTES"] == '{"weekly_summary":"deepseek"}'
    assert "BAICHUAN_API_KEY" not in values
    output = capsys.readouterr()
    assert "first-test-key" not in output.out + output.err
    assert "second-test-key" not in output.out + output.err


def test_changed_file_during_probe_is_not_overwritten(tmp_path, monkeypatch):
    path = tmp_path / ".env.local"
    path.write_text("OTHER=before\n", encoding="utf-8")
    requests, factory = provider(monkeypatch, on_request=lambda: path.write_text("OTHER=concurrent-update\n", encoding="utf-8"))
    answers(monkeypatch, "1")
    assert setup.main([], env_path=path, environ={}, client_factory=factory) == 1
    assert path.read_text(encoding="utf-8") == "OTHER=concurrent-update\n"
    assert len(requests) == 1


def test_terminal_without_hidden_input_does_not_fall_back_to_echo_or_write(tmp_path, monkeypatch):
    path = tmp_path / ".env.local"
    answers(monkeypatch, "1")
    def insecure_terminal(prompt):
        import warnings
        warnings.warn("cannot hide input", setup.getpass.GetPassWarning)
        pytest.fail("The insecure echo fallback must not run")
    monkeypatch.setattr(setup.getpass, "getpass", insecure_terminal)
    assert setup.main([], env_path=path, environ={}) == 1
    assert not path.exists()


@pytest.mark.parametrize("base_url", ["http://api.example/v1", "https://127.0.0.1/v1", "https://user:password@api.example/v1"])
def test_runtime_incompatible_endpoint_is_rejected_before_reading_key(tmp_path, monkeypatch, base_url):
    path = tmp_path / ".env.local"
    answers(monkeypatch, "3", "custom", base_url, "test-model")
    def unexpected(prompt):
        pytest.fail("Do not ask for a key for a rejected endpoint")
    monkeypatch.setattr(setup.getpass, "getpass", unexpected)
    assert setup.main([], env_path=path, environ={}) == 1
    assert not path.exists()


def test_command_line_secret_is_rejected_without_echo(tmp_path, capsys):
    with pytest.raises(SystemExit) as error:
        setup.main(["setup", "--api-key", "must-not-be-printed"], env_path=tmp_path / ".env.local", environ={})
    assert error.value.code == 2
    output = capsys.readouterr()
    assert "must-not-be-printed" not in output.out + output.err


def test_invalid_existing_profiles_are_not_replaced(tmp_path, monkeypatch):
    path = tmp_path / ".env.local"
    original = b'POOPSENSE_LLM_PROFILES={"invalid":{"api_key":"do-not-print"}}\n'
    path.write_bytes(original)
    assert setup.main(["enable-auto"], env_path=path, environ={}) == 1
    assert path.read_bytes() == original


def test_enable_auto_reuses_only_the_registry_valid_existing_provider_key(tmp_path):
    path = tmp_path / ".env.local"
    original = (
        "DEEPSEEK_API_KEY=deepseek-test-key\nPOOPSENSE_LLM_API_KEY=existing-medical-test-key\n"
        "POOPSENSE_LLM_BASE_URL=https://api.baichuan-ai.com/v1\nPOOPSENSE_LLM_MODEL=Baichuan-M3-Plus\n"
    )
    path.write_text(original, encoding="utf-8")
    assert setup.main(["enable-auto"], env_path=path, environ={"BAICHUAN_API_KEY": ""}) == 1
    assert path.read_text(encoding="utf-8") == original
    assert setup.main(["enable-auto"], env_path=path, environ={}) == 0
    values = setup.read_local_env(path)[1]
    assert values[setup.ROUTING_ENV] == "true"
    assert "BAICHUAN_API_KEY" not in values
