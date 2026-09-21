"""classify simulation and hardware test records without guessing legacy provenance

Revision ID: b92f17c03a64
Revises: a713f984c2d1
"""
from alembic import op
import sqlalchemy as sa

revision = "b92f17c03a64"
down_revision = "a713f984c2d1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("data_kind", sa.String(30), nullable=False, server_default="unknown"),
    )


def downgrade() -> None:
    op.drop_column("sessions", "data_kind")
