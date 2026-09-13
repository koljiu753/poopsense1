import pytest

from app.agent_native import route_skill
from app.model_routing import classify_task
from app.skills import contract_for, should_pause_for_confirmation


@pytest.mark.parametrize("message,decision,agent,skill,task", [
    ("一般健康知识：膳食纤维如何帮助肠道保持规律？请用简短要点回答，不引用成员数据，不提供个性化诊断。",
     "health_education", "health_doctor", "health_education", "health_knowledge"),
    ("家庭成员需要了解哪些肠道健康常识？", "health_education", "health_doctor", "health_education", "health_knowledge"),
    ("家庭成员饮食中的纤维有什么作用？", "health_education", "life_coach", "lifestyle_coaching", "health_knowledge"),
    ("如何添加便秘的成员", "health_education", "household_steward", "manage_household", "product_help"),
    ("家庭有哪些功能", "health_education", "household_steward", "manage_household", "product_help"),
    ("帮我管理家庭成员", "health_education", "household_steward", "manage_household", "product_help"),
    ("如何管理家庭成员的健康", "health_education", "health_doctor", "health_education", "health_knowledge"),
    ("帮我看看家庭成员授权", "health_education", "household_steward", "manage_household", "product_help"),
    ("家人出现血便，如何添加家庭成员", "urgent_care", "health_doctor", "urgent_care", "urgent_care"),
    ("管理家庭授权，但是我出现血便", "urgent_care", "health_doctor", "urgent_care", "urgent_care"),
])
def test_skill_and_model_route_agree_without_bypassing_urgent_priority(message, decision, agent, skill, task):
    assert route_skill(message, decision) == (agent, skill)
    assert classify_task(message, decision, skill) == task


@pytest.mark.parametrize("message", [
    "帮我授权", "开启授权", "关闭授权", "撤回授权", "确认归属",
    "纠正归属", "添加成员", "删除成员", "邀请成员",
])
def test_existing_confirmation_actions_reach_the_unchanged_household_gate(message):
    assert route_skill(message, "health_education") == ("household_steward", "manage_household")
    assert should_pause_for_confirmation(contract_for("manage_household"), message)
    assert route_skill(message, "urgent_care") == ("health_doctor", "urgent_care")


def test_editing_member_assignment_remains_a_household_operation():
    message = "修改家庭成员归属"
    assert route_skill(message, "health_education") == ("household_steward", "manage_household")
    assert classify_task(message, "health_education", "manage_household") == "product_help"
    assert route_skill(message, "urgent_care") == ("health_doctor", "urgent_care")
