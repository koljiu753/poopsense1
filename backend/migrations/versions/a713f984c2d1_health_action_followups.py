"""add longitudinal health action follow-ups

Revision ID: a713f984c2d1
Revises: a76c20d9e451
"""
from alembic import op
import sqlalchemy as sa

revision = "a713f984c2d1"
down_revision = "a76c20d9e451"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "health_action_followups",
        sa.Column("id", sa.String(100), primary_key=True),
        sa.Column("household_id", sa.String(100), sa.ForeignKey("households.id"), nullable=False),
        sa.Column("subject_member_id", sa.String(100), sa.ForeignKey("household_members.id"), nullable=False),
        sa.Column("source_session_id", sa.Integer(), sa.ForeignKey("sessions.id"), nullable=False),
        sa.Column("recommendation_categories", sa.JSON(), nullable=False),
        sa.Column("adoption_status", sa.String(30), nullable=False),
        sa.Column("perceived_outcome", sa.String(30), nullable=False),
        sa.Column("observed_outcome", sa.String(30), nullable=False),
        sa.Column("observed_from_session_id", sa.Integer(), sa.ForeignKey("sessions.id"), nullable=True),
        sa.Column("observed_outcome_note", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by_user_id", sa.String(100), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("updated_by_user_id", sa.String(100), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint(
            "household_id", "subject_member_id", "source_session_id",
            name="uq_health_action_source_session",
        ),
    )
    for column in ("household_id", "subject_member_id", "source_session_id",
                   "adoption_status", "observed_outcome"):
        op.create_index(
            f"ix_health_action_followups_{column}",
            "health_action_followups", [column],
        )


def downgrade() -> None:
    for column in ("observed_outcome", "adoption_status", "source_session_id",
                   "subject_member_id", "household_id"):
        op.drop_index(
            f"ix_health_action_followups_{column}",
            table_name="health_action_followups",
        )
    op.drop_table("health_action_followups")
