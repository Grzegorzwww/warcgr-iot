import hashlib
import hmac
import re
import secrets
import time
from collections import defaultdict, deque
from typing import Optional


# scrypt z biblioteki standardowej – brak dodatkowych zależności
SCRYPT_N = 2 ** 14
SCRYPT_R = 8
SCRYPT_P = 1

MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128

EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s.]+(\.[^@\s.]+)+$")


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode(),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
    )

    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt_hex, digest_hex = stored.split("$")

        if scheme != "scrypt":
            return False

        expected = bytes.fromhex(digest_hex)
        digest = hashlib.scrypt(
            password.encode(),
            salt=bytes.fromhex(salt_hex),
            n=int(n),
            r=int(r),
            p=int(p),
        )
    except (ValueError, TypeError):
        return False

    return hmac.compare_digest(digest, expected)


# Hash używany, gdy użytkownik nie istnieje – wyrównuje czas odpowiedzi logowania
DUMMY_HASH = hash_password("dummy-password-for-timing")


def normalize_email(email: str) -> Optional[str]:
    email = email.strip().lower()

    if len(email) > 254 or not EMAIL_RE.match(email):
        return None

    return email


def new_device_token() -> str:
    # 24 losowe bajty = 192 bity entropii, 32 znaki (A-Z a-z 0-9 - _),
    # bezpieczne jako segment topicu MQTT (bez /, + i #)
    return secrets.token_urlsafe(24)


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def hash_session_token(token: str) -> str:
    # W bazie trzymamy tylko skrót – wyciek bazy nie daje działających sesji
    return hashlib.sha256(token.encode()).hexdigest()


class Throttle:
    """Proste ograniczanie liczby prób w oknie czasowym (w pamięci procesu)."""

    def __init__(self, limit: int, window_seconds: int):
        self.limit = limit
        self.window = window_seconds
        self.hits = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        queue = self.hits[key]

        while queue and now - queue[0] > self.window:
            queue.popleft()

        if len(queue) >= self.limit:
            return False

        queue.append(now)
        return True

    def prune(self):
        now = time.monotonic()

        for key in list(self.hits):
            queue = self.hits[key]

            while queue and now - queue[0] > self.window:
                queue.popleft()

            if not queue:
                del self.hits[key]
