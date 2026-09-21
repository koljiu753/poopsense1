"""Reader test-device file uploader; Python 3 standard library, no USB reader.

Fixed Reader origin. Credentials come only from POOPSENSE_DEVICE_KEY or hidden
input. Uploads archive and send the exact original bytes; no automatic retries.
"""

import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request
import warnings


BASE_URL = "https://poopsense-reader-0912.vercel.app"
MAX_BYTES = 1024 * 1024
PRIVATE_FIELDS = {"api_key", "device_key", "household_key", "x-device-key", "x-household-key",
                  "authorization", "password", "access_token", "secret"}
RESPONSE_FIELDS = {
    "session_id", "device_id", "data_kind", "correlation_id", "received_at",
    "assignment_status", "assessment_status", "message", "duplicate",
    "raw_observations", "sampling", "processing",
}


class ClientError(Exception):
    def __init__(self, code, http_status=None):
        super().__init__(code)
        self.code = code
        self.http_status = http_status


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise ClientError("INVALID_ARGUMENTS_KEYS_ARE_NOT_COMMAND_LINE_ARGUMENTS")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the device credential to another origin or redirected URL.
        return None


def unique_object(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise ClientError("DUPLICATE_JSON_FIELD")
        if name.lower() in PRIVATE_FIELDS:
            raise ClientError("CREDENTIAL_FIELDS_FORBIDDEN_IN_PAYLOAD")
        result[name] = value
    return result


def reject_constant(value):
    raise ClientError("NON_FINITE_JSON_NUMBER")


def read_payload(path):
    try:
        with Path(path).open("rb") as source:
            body = source.read(MAX_BYTES + 1)
        if not body or len(body) > MAX_BYTES:
            raise ClientError("PAYLOAD_EMPTY_OR_TOO_LARGE")
        payload = json.loads(body, object_pairs_hook=unique_object, parse_constant=reject_constant)
        # parse_constant rejects NaN/Infinity tokens; this also catches numeric
        # overflow such as 1e1000 without changing the archived original bytes.
        json.dumps(payload, allow_nan=False)
    except (ValueError, UnicodeError, RecursionError):
        raise ClientError("INVALID_JSON") from None
    except OSError:
        raise ClientError("PAYLOAD_FILE_UNREADABLE") from None
    if not isinstance(payload, dict):
        raise ClientError("JSON_OBJECT_REQUIRED")
    for name in ("device_id", "household_id", "session_id", "correlation_id"):
        value = payload.get(name)
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", value):
            raise ClientError("INVALID_OR_MISSING_IDENTIFIER")
    if payload.get("data_kind") not in ("simulated", "hardware_test"):
        raise ClientError("EXPLICIT_TEST_DATA_KIND_REQUIRED")
    return body, payload


def archive_payload(body, payload, outbox):
    """Keep the byte-exact original; never overwrite an existing session file."""
    directory = Path(outbox)
    # Hash the two identifiers, not payload bytes: the same identity always maps
    # to one filename, including on case-insensitive Windows filesystems.
    identity = payload["device_id"] + "\0" + payload["session_id"]
    filename = hashlib.sha256(identity.encode("utf-8")).hexdigest() + ".json"
    archive = directory / filename
    try:
        directory.mkdir(parents=True, exist_ok=True)
        if archive.is_symlink():
            raise ClientError("OUTBOX_SYMLINK_REFUSED")
        try:
            with archive.open("xb") as saved:
                saved.write(body)
                saved.flush()
                os.fsync(saved.fileno())
        except FileExistsError:
            if archive.read_bytes() != body:
                raise ClientError("OUTBOX_ID_ALREADY_HAS_DIFFERENT_BYTES") from None
        if archive.read_bytes() != body:
            raise ClientError("OUTBOX_VERIFICATION_FAILED")
    except OSError:
        raise ClientError("OUTBOX_SAVE_FAILED_NO_UPLOAD") from None
    return archive


def device_key(environ=None):
    environment = os.environ if environ is None else environ
    if "POOPSENSE_DEVICE_KEY" in environment:
        key = environment["POOPSENSE_DEVICE_KEY"]
    else:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                key = getpass.getpass("Device key (hidden): ")
        except (getpass.GetPassWarning, EOFError, KeyboardInterrupt, OSError):
            raise ClientError("HIDDEN_KEY_INPUT_UNAVAILABLE") from None
    if (not re.fullmatch(r"[\x21-\x7e]{32,256}", key)
            or key in {"dev-secret", "household-secret", "viewer-secret"}):
        raise ClientError("PRIVATE_DEVICE_KEY_REQUIRED_32_TO_256_ASCII_CHARACTERS")
    return key


def sanitize(value, key):
    if isinstance(value, dict):
        return {name.replace(key, "[redacted]"): sanitize(item, key)
                for name, item in value.items() if name.lower() not in PRIVATE_FIELDS}
    if isinstance(value, list):
        return [sanitize(item, key) for item in value]
    if isinstance(value, str):
        return value.replace(key, "[redacted]")
    return value


def request_once(payload, key, body=None, opener=None):
    if body is not None:
        url = BASE_URL + "/api/v1/device-sessions"
        method, expected = "POST", 202
    else:
        url = BASE_URL + f'/api/v1/devices/{payload["device_id"]}/sessions/{payload["session_id"]}'
        method, expected = "GET", 200
    request = urllib.request.Request(url, data=body, method=method,
                                     headers={"Content-Type": "application/json", "X-Device-Key": key})
    transport = opener if opener is not None else urllib.request.build_opener(NoRedirect())
    try:
        with transport.open(request, timeout=30) as response:
            if response.status != expected:
                raise ClientError("UNEXPECTED_HTTP_STATUS_RECEIPT_UNCONFIRMED", response.status)
            raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ClientError("RESPONSE_TOO_LARGE_RECEIPT_UNCONFIRMED")
            result = json.loads(raw, parse_constant=reject_constant)
    except urllib.error.HTTPError as error:
        # Do not print arbitrary server bodies or urllib exceptions: they can
        # contain echoed input or sensitive headers. Query before retrying 5xx.
        codes = {401: "DEVICE_AUTH_FAILED", 403: "DEVICE_BINDING_DENIED", 404: "RECORD_OR_ROUTE_NOT_FOUND",
                 409: "IDEMPOTENCY_CONFLICT_KEEP_ORIGINAL", 422: "PAYLOAD_VALIDATION_FAILED"}
        code = "REDIRECT_REFUSED" if 300 <= error.code < 400 else codes.get(error.code, "HTTP_ERROR_RECEIPT_UNCONFIRMED")
        raise ClientError(code, error.code) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ClientError("NETWORK_ERROR_RECEIPT_UNKNOWN_KEEP_ORIGINAL") from None
    except (ValueError, UnicodeError, RecursionError):
        raise ClientError("INVALID_RESPONSE_RECEIPT_UNCONFIRMED") from None
    if not isinstance(result, dict) or result.get("session_id") != payload["session_id"]:
        raise ClientError("RESPONSE_ID_MISMATCH_RECEIPT_UNCONFIRMED")
    if method == "GET" and result.get("device_id") != payload["device_id"]:
        raise ClientError("RESPONSE_DEVICE_MISMATCH_RECEIPT_UNCONFIRMED")
    if method == "POST" and not isinstance(result.get("duplicate"), bool):
        raise ClientError("INVALID_RECEIPT_DUPLICATE_FIELD")
    return {"http_status": expected, "result": sanitize(
        {name: value for name, value in result.items() if name in RESPONSE_FIELDS}, key)}


def main(argv=None):
    parser = SafeParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("action", choices=("check", "save", "upload", "status"))
    parser.add_argument("--file", required=True, help="Original or archived JSON file")
    parser.add_argument("--outbox", default="reader-outbox", help="Local exact-payload archive directory")
    try:
        args = parser.parse_args(argv)
        key = None
        body, payload = read_payload(args.file)
        report = {"action": args.action, "base_url": BASE_URL,
                  "device_id": payload["device_id"], "session_id": payload["session_id"],
                  "data_kind": payload["data_kind"], "payload_sha256": hashlib.sha256(body).hexdigest()}
        if args.action in ("save", "upload"):
            archive = archive_payload(body, payload, args.outbox)
            report["saved_file"] = str(archive.resolve())
            saved_body = archive.read_bytes()
            if saved_body != body:
                raise ClientError("OUTBOX_CHANGED_BEFORE_UPLOAD")
            body = saved_body
        if args.action in ("upload", "status"):
            key = device_key()
            report.update(request_once(payload, key, body if args.action == "upload" else None))
        if args.action == "check":
            report["validation"] = "JSON_AND_IDENTIFIERS_ONLY_NOT_FULL_SERVER_SCHEMA"
        report["ok"] = True
        print(json.dumps(sanitize(report, key) if key else report, ensure_ascii=False, indent=2, allow_nan=False))
        return 0
    except ClientError as error:
        print(json.dumps({"ok": False, "code": error.code, "http_status": error.http_status}), file=sys.stderr)
    except (OSError, ValueError):
        print(json.dumps({"ok": False, "code": "LOCAL_OPERATION_FAILED_NO_CREDENTIAL_LOG"}), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
