"""Назначить пользователя администратором.

Использование (из каталога backend или контейнера):
    python -m scripts.make_admin <username>
"""
import sys

from app.database import SessionLocal
from app.models import User


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: python -m scripts.make_admin <username>")
        sys.exit(1)
    username = sys.argv[1]
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == username).first()
        if not user:
            print(f"User '{username}' not found")
            sys.exit(1)
        user.is_admin = True
        db.commit()
        print(f"User '{username}' is now an admin")
    finally:
        db.close()


if __name__ == "__main__":
    main()
