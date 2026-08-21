"""indexes for recommendation quality feedback lookups

Revision ID: 0018_recommendation_quality_indexes
Revises: 0017_recommendation_population
"""

from alembic import op
import sqlalchemy as sa


revision = "0018_recommendation_quality_indexes"
down_revision = "0017_recommendation_population"
branch_labels = None
depends_on = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    existing = {
        index["name"] for index in inspector.get_indexes("recommendation_events")
    }
    indexes = (
        (
            "ix_recommendation_events_user_flow_feedback",
            ["user_id", "surface", "event_type", "occurred_at"],
        ),
        (
            "ix_recommendation_events_item_flow_feedback",
            ["source", "external_id", "surface", "occurred_at"],
        ),
    )
    for name, columns in indexes:
        if name not in existing:
            op.create_index(name, "recommendation_events", columns)


def downgrade():
    op.drop_index(
        "ix_recommendation_events_item_flow_feedback",
        table_name="recommendation_events",
    )
    op.drop_index(
        "ix_recommendation_events_user_flow_feedback",
        table_name="recommendation_events",
    )
