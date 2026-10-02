"""add user_player_states

Состояние плеера юзера на сервере: открыл на другом устройстве — тот же трек,
очередь и позиция. См. app/models.UserPlayerState.

Revision ID: 0027_user_player_states
Revises: 0026_censor_evidence
"""

from alembic import op
import sqlalchemy as sa


revision = "0027_user_player_states"
down_revision = "0026_censor_evidence"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if "user_player_states" in sa.inspect(bind).get_table_names():
        return
    op.create_table(
        "user_player_states",
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("state", sa.JSON(), nullable=False),
        sa.Column("saved_at", sa.Float(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("user_player_states")
