"""Store versioned manual-sampling model explanations separately from health data."""
from alembic import op
import sqlalchemy as sa

revision = "d3e42c180a77"
down_revision = "b92f17c03a64"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "demo_explanations",
        sa.Column("id", sa.String(100), primary_key=True),
        sa.Column("session_id", sa.Integer(), sa.ForeignKey("sessions.id"), nullable=False),
        sa.Column("input_hash", sa.String(64), nullable=False),
        sa.Column("input_version", sa.String(50), nullable=False),
        sa.Column("prompt_version", sa.String(50), nullable=False),
        sa.Column("input_facts", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("lease_token", sa.String(100), nullable=False),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("requested_by_user_id", sa.String(100), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("provider", sa.String(50), nullable=True),
        sa.Column("model", sa.String(100), nullable=True),
        sa.Column("text", sa.Text(), nullable=True),
        sa.Column("error_code", sa.String(100), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempt_history", sa.JSON(), nullable=False),
        sa.UniqueConstraint("session_id", "input_hash", "prompt_version", name="uq_demo_explanation_input"),
    )
    op.create_index("ix_demo_explanations_session_id", "demo_explanations", ["session_id"])


def downgrade() -> None:
    op.drop_table("demo_explanations")
