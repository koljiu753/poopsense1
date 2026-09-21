"""Pure offline tests: never contact Reader or require a real device credential."""
import importlib.util
import io
import json
from pathlib import Path
import urllib.error
import warnings

import pytest


ROOT = Path(__file__).resolve().parents[2]
DELIVERY = ROOT / "backend" / "scripts"
SPEC = importlib.util.spec_from_file_location("reader_device_client_under_test", DELIVERY / "reader_device.py")
client = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(client)
KEY = "offline-only-private-device-key-000000000001"


@pytest.fixture(autouse=True)
def forbid_network(monkeypatch):
    monkeypatch.setattr(client.urllib.request, "build_opener", lambda *a: pytest.fail("Real network forbidden"))


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "original.json"
    # Keep a BOM, CRLFs, non-ASCII text and deliberate whitespace byte-for-byte.
    data = json.loads((DELIVERY / "request-simulated.json").read_text(encoding="utf-8"))
    data["quality"]["reasons"].append("离线测试，不是硬件测量")
    body = b"\xef\xbb\xbf" + json.dumps(data, ensure_ascii=False, indent=3).replace("\n", "\r\n").encode("utf-8") + b"\r\n"
    path.write_bytes(body)
    return path


class Response:
    def __init__(self, data, status):
        self.status = status
        self.body = io.BytesIO(json.dumps(data).encode())

    def read(self, limit):
        return self.body.read(limit)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class Transport:
    def __init__(self, result=None, status=202, error=None):
        self.result, self.status, self.error = result, status, error
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        if self.error:
            raise self.error
        return Response(self.result, self.status)


def test_archive_preserves_original_bytes_and_identical_retries(source, tmp_path):
    body, payload = client.read_payload(source)
    archive = client.archive_payload(body, payload, tmp_path / "outbox")
    assert archive.read_bytes() == source.read_bytes()
    assert client.archive_payload(body, payload, archive.parent) == archive
    assert len(list(archive.parent.glob("*.json"))) == 1
    changed = body + b" "
    with pytest.raises(client.ClientError, match="OUTBOX_ID_ALREADY_HAS_DIFFERENT_BYTES"):
        client.archive_payload(changed, payload, archive.parent)
    assert archive.read_bytes() == body


def test_distinct_identity_has_distinct_archive_even_on_windows(source, tmp_path):
    body, payload = client.read_payload(source)
    first = client.archive_payload(body, payload, tmp_path)
    other = dict(payload, device_id=payload["device_id"].upper())
    second = client.archive_payload(body, other, tmp_path)
    assert first.name.lower() != second.name.lower()


def test_upload_sends_exact_saved_body_and_uses_only_device_header(source, tmp_path, monkeypatch, capsys):
    body, payload = client.read_payload(source)
    transport = Transport({"session_id": payload["session_id"], "duplicate": False, "assessment_status": "unable_to_determine"})
    monkeypatch.setattr(client.urllib.request, "build_opener", lambda *a: transport)
    monkeypatch.setenv("POOPSENSE_DEVICE_KEY", KEY)
    outbox = tmp_path / "outbox"
    assert client.main(["upload", "--file", str(source), "--outbox", str(outbox)]) == 0
    assert len(transport.calls) == 1
    request, timeout = transport.calls[0]
    assert request.full_url == client.BASE_URL + "/api/v1/device-sessions"
    assert request.get_method() == "POST" and request.data == body and timeout == 30
    assert request.get_header("X-device-key") == KEY
    assert not request.get_header("Authorization") and not request.get_header("X-household-key")
    output = capsys.readouterr()
    report = json.loads(output.out)
    assert Path(report["saved_file"]).read_bytes() == body
    assert report["http_status"] == 202 and report["result"]["duplicate"] is False
    assert KEY not in output.out + output.err


def test_upload_outbox_conflict_stops_before_prompt_or_network(source, tmp_path, monkeypatch, capsys):
    body, payload = client.read_payload(source)
    client.archive_payload(body, payload, tmp_path / "outbox")
    source.write_bytes(body + b" ")
    monkeypatch.setattr(client, "device_key", lambda: pytest.fail("Do not ask for key after archive failure"))
    assert client.main(["upload", "--file", str(source), "--outbox", str(tmp_path / "outbox")]) == 1
    assert "OUTBOX_ID_ALREADY_HAS_DIFFERENT_BYTES" in capsys.readouterr().err


def test_archive_modified_before_upload_is_not_sent(source, tmp_path, monkeypatch, capsys):
    altered = tmp_path / "altered.json"
    altered.write_bytes(b'{"device_id":"different"}')
    monkeypatch.setattr(client, "archive_payload", lambda *a: altered)
    monkeypatch.setattr(client, "device_key", lambda: pytest.fail("Do not ask for key after changed archive"))
    assert client.main(["upload", "--file", str(source)]) == 1
    assert "OUTBOX_CHANGED_BEFORE_UPLOAD" in capsys.readouterr().err


def test_status_uses_same_file_identity_without_household_credentials(source):
    _, payload = client.read_payload(source)
    transport = Transport({"session_id": payload["session_id"], "device_id": payload["device_id"],
                           "raw_observations": {"color": {"value": "red", "template_similarity": 0.72}},
                           "sampling": {"duration_s": 10}, "processing": {"rules_complete": True}}, status=200)
    result = client.request_once(payload, KEY, opener=transport)
    request, _ = transport.calls[0]
    assert request.full_url == client.BASE_URL + f'/api/v1/devices/{payload["device_id"]}/sessions/{payload["session_id"]}'
    assert request.get_method() == "GET" and request.data is None
    assert result["result"]["raw_observations"]["color"]["template_similarity"] == .72


def test_status_rejects_a_receipt_for_another_device(source):
    _, payload = client.read_payload(source)
    transport = Transport({"session_id":payload["session_id"], "device_id":"other-device"}, status=200)
    with pytest.raises(client.ClientError, match="RESPONSE_DEVICE_MISMATCH"):
        client.request_once(payload, KEY, opener=transport)


@pytest.mark.parametrize("action", ["check", "save"])
def test_offline_actions_never_prompt_for_key_or_contact_server(source, tmp_path, monkeypatch, capsys, action):
    monkeypatch.setattr(client, "device_key", lambda: pytest.fail("Offline actions do not read credentials"))
    assert client.main([action, "--file", str(source), "--outbox", str(tmp_path / "outbox")]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["ok"]
    if action == "check":
        assert "NOT_FULL_SERVER_SCHEMA" in report["validation"]


@pytest.mark.parametrize("raw", [
    b'{"x":NaN}', b'{"x":Infinity}', b'{"x":1e1000}', b'{"x":1,"x":2}',
    b'{"api_key":"must-not-be-posted"}', b'{"observations":{"device_key":"secret"}}',
    b'[]', b'{"session_id":"../../escape"}',
])
def test_invalid_or_sensitive_json_is_refused_without_exposing_values(tmp_path, raw):
    file = tmp_path / "bad.json"
    file.write_bytes(raw)
    with pytest.raises(client.ClientError) as caught:
        client.read_payload(file)
    assert "must-not-be-posted" not in str(caught.value) and "../../escape" not in str(caught.value)


@pytest.mark.parametrize("status", [301, 307, 401, 403, 404, 409, 422, 500, 503])
def test_http_failure_is_single_request_with_safe_error_only(source, status):
    body, payload = client.read_payload(source)
    error = urllib.error.HTTPError(client.BASE_URL, status, KEY, {}, io.BytesIO(KEY.encode()))
    transport = Transport(error=error)
    with pytest.raises(client.ClientError) as caught:
        client.request_once(payload, KEY, body, transport)
    assert len(transport.calls) == 1
    assert caught.value.http_status == status
    assert KEY not in str(caught.value)
    if status in (301,307):
        assert caught.value.code == "REDIRECT_REFUSED"


def test_redirect_handler_never_forwards_device_key(source):
    assert client.NoRedirect().redirect_request(None, None, 302, "Moved", {}, "https://other.example") is None


def test_network_failure_keeps_original_and_never_leaks_key(source, tmp_path, monkeypatch, capsys):
    transport = Transport(error=urllib.error.URLError(KEY))
    monkeypatch.setattr(client.urllib.request, "build_opener", lambda *a: transport)
    monkeypatch.setenv("POOPSENSE_DEVICE_KEY", KEY)
    outbox = tmp_path / "outbox"
    assert client.main(["upload", "--file", str(source), "--outbox", str(outbox)]) == 1
    assert next(outbox.glob("*.json")).read_bytes() == source.read_bytes()
    output = capsys.readouterr()
    assert "RECEIPT_UNKNOWN_KEEP_ORIGINAL" in output.err
    assert KEY not in output.out + output.err
    assert len(transport.calls) == 1


def test_response_omits_private_data_and_redacts_echoed_key(source):
    body, payload = client.read_payload(source)
    transport = Transport({"session_id": payload["session_id"], "duplicate": True, "member_id": "private-person",
                           "device_key": KEY, "message": "unexpected echo " + KEY,
                           "raw_observations": {KEY: {"value": KEY, "api_key": KEY}}})
    result = client.request_once(payload, KEY, body, transport)
    rendered = json.dumps(result)
    assert KEY not in rendered and "private-person" not in rendered and "api_key" not in rendered


@pytest.mark.parametrize("overrides", [{"session_id":"wrong"}, {"duplicate":"true"}])
def test_unrelated_or_malformed_receipt_is_not_success(source, overrides):
    body, payload = client.read_payload(source)
    transport = Transport({"session_id":payload["session_id"], "duplicate":False, **overrides})
    with pytest.raises(client.ClientError):
        client.request_once(payload, KEY, body, transport)


def test_cli_key_argument_is_never_echoed(source, capsys):
    assert client.main(["upload", "--file", str(source), "--device-key", KEY]) == 1
    output = capsys.readouterr()
    assert KEY not in output.out + output.err


def test_environment_key_is_used_without_hidden_prompt(monkeypatch):
    monkeypatch.setattr(client.getpass, "getpass", lambda *a: pytest.fail("Environment key should be used"))
    assert client.device_key({"POOPSENSE_DEVICE_KEY": KEY}) == KEY
    with pytest.raises(client.ClientError):
        client.device_key({"POOPSENSE_DEVICE_KEY": ""})


def test_hidden_input_refuses_echo_fallback(monkeypatch):
    def unsafe(prompt):
        warnings.warn("No terminal", client.getpass.GetPassWarning)
        pytest.fail("No input after unsafe fallback")
    monkeypatch.setattr(client.getpass, "getpass", unsafe)
    with pytest.raises(client.ClientError, match="HIDDEN_KEY_INPUT_UNAVAILABLE"):
        client.device_key({})
