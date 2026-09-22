"""User-triggered, versioned explanations of demo materials, never health reports."""
import asyncio
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import hashlib
import json
import math
import re
import time
import uuid
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .agent import ModelReply, logger as model_logger, model_for_task
from .model_provider import prepare_model_payload
from .models import DemoExplanation, MemberAssignment, Observation
from .service import authorize_household, authorize_member_view, household_session_record, is_manual_sampling


INPUT_VERSION = "demo-facts-v1"
PROMPT_VERSION = "demo-explanation-v1"
LEASE_SECONDS = 120
MODEL_DEADLINE_SECONDS = 30
COLOR_LABELS = {"red": "红色", "green": "绿色", "blue": "蓝色", "yellow": "黄色"}
SHAPE_LABELS = {"elongated": "长条形", "compact": "紧实形", "scattered": "散落形", "irregular": "不规则形"}
BOUNDARY = (
    "系统演示边界：本解读仅适用于卡纸、橡皮泥等演示样本，不是真实粪便分类或健康报告。"
    "模板相似度不是识别准确率，手动采样时长不是如厕时长。"
    "本次没有可用于解读的气味、温湿度和在场读数，缺失保持未知。"
)
ERRORS = {
    "GENERATION_INTERRUPTED": "上次生成未完成，请手动重试。",
    "MODEL_NOT_CONFIGURED": "演示解读模型尚未配置，请稍后重试。",
    "DEEPSEEK_REQUIRED": "演示解读需要已配置的 DeepSeek，请联系维护者。",
    "MODEL_ROUTING_CONFIG_INVALID": "演示解读模型配置暂不可用。",
    "MODEL_TIMEOUT": "生成超时，请手动重试。",
    "MODEL_PROVIDER_FAILED": "模型暂未返回结果，请手动重试。",
    "MODEL_RESPONSE_INCOMPLETE": "模型回复不完整，请手动重试。",
    "MODEL_OUTPUT_REJECTED": "回复未通过演示事实检查，未展示该内容；可以手动重试。",
    "INPUT_CHANGED": "记录事实已变化，请刷新后重新生成。",
}


def now_utc():
    return datetime.now(timezone.utc)


def utc(value):
    return value.replace(tzinfo=value.tzinfo or timezone.utc).astimezone(timezone.utc)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def authorized_record(db, household_id, session_id, key):
    # Reload credentials, active grants and assignment after a model request too.
    db.expire_all()
    auth = authorize_household(db, household_id, key)
    record = household_session_record(db, household_id, session_id)
    assignment = db.scalar(select(MemberAssignment).where(
        MemberAssignment.session_id == record.id, MemberAssignment.active.is_(True)))
    if assignment is None:
        raise HTTPException(409, detail={"code": "ASSIGNMENT_STATE_MISSING"})
    if assignment.assignment_status == "confirmed" and assignment.member_id:
        authorize_member_view(db, auth, assignment.member_id)
    elif auth.role not in {"owner", "caregiver"}:
        raise HTTPException(403, detail={"code": "HOUSEHOLD_ROLE_DENIED"})
    return auth, record


def input_facts(db, record):
    if not is_manual_sampling(record):
        raise HTTPException(409, detail={"code": "DEMO_EXPLANATION_NOT_APPLICABLE"})
    observations = {row.dimension: row for row in db.scalars(select(Observation).where(Observation.session_id == record.id))}
    shape, color, odor = (observations.get(name) for name in ("shape", "color", "odor"))
    if (record.data_kind not in {"simulated", "hardware_test"} or not shape or not color or not odor
            or shape.value not in {*SHAPE_LABELS, None} or color.value not in {*COLOR_LABELS, None}
            or odor.value is not None or record.temperature_c is not None or record.humidity_pct is not None
            or record.presence_state != "unknown"
            or record.quality.get("duration_semantics") != "manual_sampling_seconds"
            or any(row.confidence is not None for row in (shape, color, odor))):
        raise HTTPException(409, detail={"code": "DEMO_INPUT_UNSUPPORTED"})
    score = (color.extra or {}).get("template_similarity")
    scale = (color.extra or {}).get("similarity_scale", "unknown")
    if (scale not in {"0_1", "0_100", "unknown"}
            or (score is not None and (type(score) not in (int, float) or not math.isfinite(score)
                or color.value is None or (scale != "unknown" and not 0 <= score <= (1 if scale == "0_1" else 100))))):
        raise HTTPException(409, detail={"code": "DEMO_INPUT_UNSUPPORTED"})
    # Never forward source/model_version/reasons/missing_reason or identifiers.
    facts = {"input_version": INPUT_VERSION, "data_kind": record.data_kind,
             "shape": shape.value, "color": color.value, "template_similarity": score,
             "similarity_scale": scale, "sampling_seconds": record.duration_s,
             "odor": None, "temperature_c": None, "humidity_pct": None, "presence": "unknown"}
    return facts, hashlib.sha256(encoded(facts).encode()).hexdigest()


def allowed_clauses(facts):
    """An intentionally small factual language; no open-ended health semantics."""
    clauses = ["本次为手动采样演示记录", "可在现场核对标签与演示材料", "可将记录标签与眼前的卡纸或橡皮泥核对"]
    for field, labels, dimension in (("color", COLOR_LABELS, "颜色"), ("shape", SHAPE_LABELS, "形状")):
        if facts[field] is None:
            clauses.extend([f"本次未记录{dimension}标签", f"{dimension}标签缺失，保持未知"])
        else:
            clauses.extend([f"记录的{dimension}标签为{labels[facts[field]]}",
                            f"本次{dimension}标签记录为{labels[facts[field]]}"])
    score = facts["template_similarity"]
    if score is None:
        clauses.append("本次未记录模板相似度分数")
    else:
        clauses.extend([f"模板相似度原始分数为{score}", f"记录的模板相似度分数为{score}"])
        clauses.append({"unknown": "该分数的量纲未知", "0_1": "该分数采用零至一量纲",
                        "0_100": "该分数采用零至一百量纲"}[facts["similarity_scale"]])
    clauses.extend([f"手动采样窗口为{facts['sampling_seconds']}秒", f"本次手动采样时长为{facts['sampling_seconds']}秒"])
    return clauses


def messages_for(facts):
    return [{"role": "system", "content": (
        "你是PoopSense演示测量解释助手，只解释卡纸和橡皮泥的手动采样事实。"
        "只返回JSON对象，且只有facts_echo与explanation两个键。facts_echo完整原样复制输入JSON。"
        "explanation用中文写2至3个简短句子（30至160字），仅复述当前颜色和形状标签、"
        "存在的模板相似度原始分数及手动采样秒数；可提醒将标签与眼前演示材料核对。"
        "形状翻译：elongated长条形、compact紧实形、scattered散落形、irregular不规则形。"
        "颜色翻译：red红色、green绿色、blue蓝色、yellow黄色。空值只能说明未记录。"
        "相似度不转换、不比较高低、不解释成准确率；未知量纲保持未知。"
        "不加新的读数、类别、建议、阈值、排名、医学信息或真实粪便分类。"
        "不把标签当作已验证实物；采用‘记录的颜色标签为…’等表述。"
        "正文不要讨论健康、疾病、准确率、气味、温湿度、在场或如厕，连否定句也不要，"
        "系统会单独添加这些固定边界。不要Markdown、链接、英文或小标题。"
        "只依据下面结构化数据，不猜测空值。为了严格限制在演示范围，explanation的每个分句"
        "只能从以下白名单选择原文，可自行组织顺序并用句号或分号连接；至少包含颜色和形状分句。"
        "不要添加其他分句，不需要逐条全部使用。分句白名单：" + encoded(allowed_clauses(facts))
    )}, {"role": "user", "content": encoded(facts)}]


async def _request_model(messages, spec):
    payload = prepare_model_payload(spec.base_url, spec.model, messages,
                                    max_tokens=min(spec.max_tokens, 1000), disable_thinking=True)
    payload["response_format"] = {"type": "json_object"}
    # No provider/SDK retries. The total deadline includes connect, body reads
    # and client cleanup; a slowly trickling response cannot outlive the lease.
    async with asyncio.timeout(MODEL_DEADLINE_SECONDS):
        async with httpx.AsyncClient(timeout=min(spec.timeout_seconds, 25), follow_redirects=False) as client:
            async with client.stream("POST", spec.base_url.rstrip("/") + "/chat/completions",
                                     headers={"Authorization": "Bearer " + spec.api_key}, json=payload) as response:
                response.raise_for_status()
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > 65_536:
                        raise ValueError("response too large")
    body = json.loads(content)
    choice = body["choices"][0]
    if choice.get("finish_reason") != "stop":
        raise HTTPException(502, detail={"code": "MODEL_RESPONSE_INCOMPLETE"})
    text = choice["message"]["content"]
    if not isinstance(text, str) or not text.strip():
        raise ValueError("empty model response")
    actual = body.get("model")
    model = actual if isinstance(actual, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./:+-]{0,99}", actual) else spec.model
    return ModelReply(text, {"source": "model", "provider": spec.provider, "model": model})


def call_demo_model(messages, spec):
    started = time.perf_counter()
    status, model = "MODEL_PROVIDER_FAILED", spec.model
    try:
        reply = asyncio.run(_request_model(messages, spec))
        model, status = reply.route["model"], "succeeded"
        return reply
    except (TimeoutError, httpx.TimeoutException):
        status = "MODEL_TIMEOUT"
        raise
    except HTTPException as exc:
        status = "MODEL_RESPONSE_INCOMPLETE" if exc.detail == {"code": "MODEL_RESPONSE_INCOMPLETE"} else status
        raise
    finally:
        model_logger.info("demo_model_call %s", json.dumps({
            "task": "demo_explanation", "model": model, "status": status,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
        }))


def validate_output(reply, facts):
    def unique_pairs(pairs):
        output = {}
        for key, value in pairs:
            if key in output:
                raise ValueError("duplicate key")
            output[key] = value
        return output

    route = getattr(reply, "route", {})
    if (route.get("source") != "model" or route.get("provider") != "deepseek"
            or not isinstance(route.get("model"), str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./:+-]{0,99}", route["model"])):
        raise ValueError("unverified model source")
    output = json.loads(reply, object_pairs_hook=unique_pairs)
    echo = output.get("facts_echo") if isinstance(output, dict) else None
    if not isinstance(output, dict) or set(output) != {"facts_echo", "explanation"} or not isinstance(echo, dict) or set(echo) != set(facts):
        raise ValueError("facts differ")
    for key, value in facts.items():
        actual = echo[key]
        if type(value) in (int, float):
            if type(actual) not in (int, float) or not math.isfinite(actual) or Decimal(str(actual)) != Decimal(str(value)):
                raise ValueError("numeric fact differs")
        elif actual != value or type(actual) is not type(value):
            raise ValueError("fact differs")
    text = output["explanation"]
    if not isinstance(text, str) or not 20 <= len(text) <= 500:
        raise ValueError("invalid explanation")
    # Positive full-clause validation is the primary boundary. Even a new,
    # euphemistic health claim cannot pass by avoiding a list of banned words.
    # A model must actually return these statements; failure never substitutes
    # an assembled rule answer and never gets recorded as model completion.
    def normalize_numbers(value):
        return re.sub(r"-?\d+(?:\.\d+)?", lambda match: format(Decimal(match[0]).normalize(), "f"), value)

    allowed = {normalize_numbers(clause) for clause in allowed_clauses(facts)}
    clauses = [part.strip() for part in re.split(r"[。；;\n]+", text) if part.strip()]
    if not clauses or any(normalize_numbers(clause) not in allowed for clause in clauses):
        raise ValueError("unsupported statement")
    # This narrow demonstration mode deliberately rejects even medical
    # disclaimers in free text. The only such wording is the fixed boundary.
    prohibited = (
        r"[A-Za-z<>%％]|https|健康|疾病|病|医|诊|治|血|癌|肠|药|排便|如厕|粪|大便|便便|布里斯托|"
        r"气味|酒精|温度|湿度|温湿|在场|有人|无人|准确|精度|置信|概率|百分|含水|干硬|软硬|"
        r"正常|异常|风险|安全|可靠|较高|较低|很高|很低|成功|失败|采集完成|完成采集|改善|饮食|"
        r"运动|认证|保证|证明|确定是|识别出|检测到|确认为|真实样本|真实材料|实际颜色|实际形状"
    )
    if re.search(prohibited, text, re.I) or any(ord(char) < 32 and char not in "\n\t" for char in text):
        raise ValueError("outside demo scope")
    # No invented colors/shapes or numeric values, including a percentage
    # conversion of a score whose scale is unknown.
    for value, label in COLOR_LABELS.items():
        if label in text and value != facts["color"]:
            raise ValueError("wrong color")
    for value, label in SHAPE_LABELS.items():
        if label in text and value != facts["shape"]:
            raise ValueError("wrong shape")
    if re.search(r"棕|褐|黑|白|紫|橙|圆形|球形|条状|颗粒|水样|糊状|硬块", text):
        raise ValueError("unsupported class")
    if facts["color"] and COLOR_LABELS[facts["color"]] not in text:
        raise ValueError("missing color label")
    if facts["shape"] and SHAPE_LABELS[facts["shape"]] not in text:
        raise ValueError("missing shape label")
    allowed_numbers = {str(facts["sampling_seconds"])}
    if facts["template_similarity"] is not None:
        allowed_numbers.add(str(facts["template_similarity"]))
    if any(normalize_numbers(number) not in {normalize_numbers(value) for value in allowed_numbers}
           for number in re.findall(r"-?\d+(?:\.\d+)?", text)):
        raise ValueError("invented numeric value")
    if "标签" not in text or not any(word in text for word in ("演示", "采样", "记录")):
        raise ValueError("missing measurement framing")
    return text.strip() + "\n\n" + BOUNDARY


def lookup(db, record_id, digest):
    return db.scalar(select(DemoExplanation).where(
        DemoExplanation.session_id == record_id, DemoExplanation.input_hash == digest,
        DemoExplanation.prompt_version == PROMPT_VERSION).execution_options(populate_existing=True))


def public_result(session_id, row):
    result = {"session_id": session_id, "status": "not_generated", "input_version": INPUT_VERSION,
              "prompt_version": PROMPT_VERSION, "attempt": 0, "retry_allowed": False}
    if row is None:
        return result
    expired = row.status == "generating" and utc(row.lease_expires_at) <= now_utc()
    status = "failed" if expired else row.status
    error = "GENERATION_INTERRUPTED" if expired else row.error_code
    result.update(status=status, text=row.text if status == "completed" else None,
                  provider=row.provider, model=row.model, input_version=row.input_version,
                  prompt_version=row.prompt_version, attempt=row.attempt,
                  started_at=utc(row.started_at), completed_at=utc(row.completed_at) if row.completed_at else None,
                  lease_expires_at=utc(row.lease_expires_at), error_code=error,
                  error_message=ERRORS.get(error), retry_allowed=status == "failed")
    return result


def read(db, household_id, session_id, key):
    _, record = authorized_record(db, household_id, session_id, key)
    _, digest = input_facts(db, record)
    return public_result(session_id, lookup(db, record.id, digest))


def generate(db: Session, household_id, session_id, key, *, retry=False, model_caller=None):
    auth, record = authorized_record(db, household_id, session_id, key)
    facts, digest = input_facts(db, record)
    record_id = record.id
    row = lookup(db, record_id, digest)
    token = uuid.uuid4().hex
    started = now_utc()
    values = dict(status="generating", lease_token=token, lease_expires_at=started + timedelta(seconds=LEASE_SECONDS),
                  requested_by_user_id=auth.user_id, started_at=started, completed_at=None,
                  provider=None, model=None, text=None, error_code=None)
    owned = False
    if row is None:
        row = DemoExplanation(id="demo_" + uuid.uuid4().hex, session_id=record_id, input_hash=digest,
                              input_version=INPUT_VERSION, prompt_version=PROMPT_VERSION,
                              input_facts=facts, attempt=1, attempt_history=[], **values)
        db.add(row)
        try:
            db.commit()
            owned = True
        except IntegrityError:
            db.rollback()
            # Another instance created this exact version while we were reading.
            authorized_record(db, household_id, session_id, key)
            row = lookup(db, record_id, digest)
            if row is None:
                raise
    if not owned:
        state = public_result(session_id, row)
        if state["status"] != "failed" or not retry:
            return state
        history = list(row.attempt_history) + [{
            "attempt": row.attempt, "status": "failed", "error_code": state["error_code"],
            "provider": row.provider, "model": row.model, "started_at": utc(row.started_at).isoformat(),
            "completed_at": utc(row.completed_at).isoformat() if row.completed_at else None,
        }]
        acquired = db.execute(update(DemoExplanation).where(
            DemoExplanation.id == row.id, DemoExplanation.lease_token == row.lease_token,
            DemoExplanation.status == row.status, DemoExplanation.attempt == row.attempt,
        ).values(**values, attempt=row.attempt + 1, attempt_history=history),
            execution_options={"synchronize_session": False}).rowcount
        db.commit()
        if acquired != 1:
            return read(db, household_id, session_id, key)
    row_id = row.id
    db.commit()
    # No transaction/row lock remains held while the provider runs.
    provider = model = text = error = None
    try:
        spec = model_for_task("record_explanation")
        if spec.provider != "deepseek" or urlsplit(spec.base_url).hostname != "api.deepseek.com":
            raise HTTPException(503, detail={"code": "DEEPSEEK_REQUIRED"})
        provider, model = spec.provider, spec.model
        if not spec.configured:
            raise HTTPException(503, detail={"code": "MODEL_NOT_CONFIGURED"})
        reply = (model_caller or call_demo_model)(messages_for(facts), spec)
        try:
            text = validate_output(reply, facts)
        except (ValueError, TypeError, KeyError, OverflowError):
            raise HTTPException(502, detail={"code": "MODEL_OUTPUT_REJECTED"}) from None
        provider, model = reply.route["provider"], reply.route["model"]
    except (TimeoutError, httpx.TimeoutException):
        error = "MODEL_TIMEOUT"
    except HTTPException as exc:
        candidate = exc.detail.get("code") if isinstance(exc.detail, dict) else None
        error = candidate if candidate in ERRORS else "MODEL_PROVIDER_FAILED"
    except Exception:
        # No provider response, private payload or credential in error messages.
        error = "MODEL_PROVIDER_FAILED"
    ended = now_utc()
    model_logger.info("demo_explanation_result %s", json.dumps({
        "task": "demo_explanation", "model": model, "status": error or "validated",
        "elapsed_ms": round((ended - started).total_seconds() * 1000, 1),
    }))
    db.execute(update(DemoExplanation).where(
        DemoExplanation.id == row_id, DemoExplanation.lease_token == token,
        DemoExplanation.status == "generating", DemoExplanation.lease_expires_at > ended,
    ).values(status="failed" if error else "completed", text=None if error else text,
             provider=provider, model=model, error_code=error, completed_at=ended),
        execution_options={"synchronize_session": False})
    db.commit()
    # A concurrent claim, revocation or lease takeover must never leak a stale
    # result or replace a newer attempt's text on this response.
    _, current = authorized_record(db, household_id, session_id, key)
    _, current_digest = input_facts(db, current)
    if current.id != record_id or current_digest != digest:
        raise HTTPException(409, detail={"code": "INPUT_CHANGED"})
    return public_result(session_id, lookup(db, record_id, digest))
