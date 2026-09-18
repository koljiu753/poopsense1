"""Conservative presentation preferences; these never change safety or routing."""

import re


BRIEF_REPLY_FORMAT = (
    "手机阅读格式：首句直接回答当前问题，不重复自我介绍或复述背景。"
    "默认用100至180个中文字，分成2至3个短段，每段最多2句；有行动建议时最多列3条。"
    "只回答本题，不主动扩写完整疾病介绍、检查清单或无关的个人分析。"
    "段落之间空一行；不用大标题、表格、代码块或多层列表。"
    "安全提醒和不确定性说明必须完整，优先于篇幅要求；不要为字数截断句子。"
)
DETAILED_REPLY_FORMAT = (
    "手机阅读格式：用户本次明确希望详细解释，可以展开，不受默认短答字数限制。"
    "先用一两句说明要点，再按问题分成短段；需要时用单层列表，不重复同一结论。"
    "段落之间空一行，每段只讲一个要点，避免宽表格和多层列表。"
    "安全提醒和不确定性说明必须完整；不能因要求详细而新增没有依据的事实或越过授权。"
)


def reply_style(text: str) -> str:
    """Only the current request selects detail; old long replies are not a preference."""
    without_negated_brief = re.sub(
        r"(?:不要|不用|无需|不必|不需要|别)(?:再|太)?(?:简短|简洁|精简|简要)(?:回答|回复)?", "", text,
    )
    without_intro_brief = re.sub(
        r"(?:先|首先|开头)[^，。；;,\n]{0,16}(?:简短|简洁|精简|简要|一句话|一两句)"
        r"[^，。；;,\n]{0,16}[，,；;]\s*(?=(?:再|然后|接着).{0,8}(?:详细|展开|深入))",
        "", without_negated_brief,
    )
    if (re.search(r"(?:不要|不用|无需|不必|不需要|别)(?:再|太)?(?:详细|展开|长篇|深入)", text)
            or re.search(r"简短|简洁|精简|简要|一句话|长话短说|说重点|只说要点", without_intro_brief)):
        return "brief"
    if re.search(r"详细|展开(?:说|讲|解释|一点|一下)?|深入(?:说|讲|解释|分析)|完整(?:解释|说明)|逐步(?:解释|说明)|来龙去脉", text):
        return "detailed"
    return "brief"


def reply_format(style: str) -> str:
    return DETAILED_REPLY_FORMAT if style == "detailed" else BRIEF_REPLY_FORMAT


def question_only_context(text: str, *, inherited: bool = False, previous_scope: str | None = None) -> bool:
    """Omit stored personal data only when asked, or for unambiguously general learning."""
    excludes_history = re.search(
        r"(?:不(?:要|用|需(?:要)?)?|无需|别)(?:再)?(?:引用|使用|关联|参考|读取|结合|查看)"
        r"(?:任何)?(?:我的|个人|成员|家庭|历史|已有)(?:的)?(?:数据|记录|资料|病史|信息)", text,
    )
    if excludes_history:
        return True
    # A generic label cannot erase symptoms or a request about someone's records.
    personal = re.search(
        r"我(?:的|最近|这几天|今天|昨天|现在|有|出现|一直|已经|该|能|要|呢)|"
        r"本人|家人|孩子|宝宝|老人|父亲|母亲|爸爸|妈妈|(?:最近|这几天|今天|昨天|持续).{0,12}"
        r"(?:症状|腹痛|疼|便秘|腹泻|黑便|血便|不适)|(?:这次|本次|这份|这条|个人).{0,6}(?:记录|报告|数据)", text,
    )
    personal_duration = re.search(
        r"(?:便秘|腹泻|腹痛|黑便|血便|不适).{0,6}[一二两三四五六七八九十0-9]+(?:天|周|小时|个月)|"
        r"[一二两三四五六七八九十0-9]+(?:天|周|小时|个月).{0,6}(?:便秘|腹泻|腹痛|黑便|血便|不适)", text,
    )
    if personal or personal_duration:
        return False
    if re.search(r"一般(?:性)?(?:健康)?(?:知识|科普|问题)|健康科普|科普(?:一下|解释|角度)|"
                 r"(?:一般|普遍|通常)(?:而言|来说)|只(?:谈|讲|说|回答)(?:一般|通用)", text):
        return True
    # Follow-ups inherit this deliberately narrow scope, unless the new turn
    # introduces a personal question. This never affects provider selection.
    return inherited and previous_scope == "question_only"
