"""SMTP transport configuration and message construction."""

from app import mailer


class FakeSMTP:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.calls = []
        self.message = None
        self.__class__.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def ehlo(self):
        self.calls.append("ehlo")

    def starttls(self, context):
        self.calls.append("starttls")

    def login(self, username, password):
        self.calls.append(("login", username, password))

    def send_message(self, message):
        self.calls.append("send")
        self.message = message


def _configure(monkeypatch, security="starttls"):
    FakeSMTP.instances.clear()
    monkeypatch.setattr(mailer, "SMTP_HOST", "smtp.example.com")
    monkeypatch.setattr(mailer, "SMTP_PORT", 587 if security != "ssl" else 465)
    monkeypatch.setattr(mailer, "SMTP_USER", "smtp-user")
    monkeypatch.setattr(mailer, "SMTP_PASSWORD", "smtp-password")
    monkeypatch.setattr(mailer, "SMTP_FROM", "noreply@example.com")
    monkeypatch.setattr(mailer, "SMTP_FROM_NAME", "Music Streaming")
    monkeypatch.setattr(mailer, "SMTP_REPLY_TO", "support@example.com")
    monkeypatch.setattr(mailer, "SMTP_SECURITY", security)
    monkeypatch.setattr(mailer, "SMTP_TIMEOUT", 10.0)


def test_smtp_configuration_rejects_partial_credentials(monkeypatch):
    _configure(monkeypatch)
    monkeypatch.setattr(mailer, "SMTP_PASSWORD", "")

    assert mailer.smtp_configured() is False
    assert "SMTP_USER and SMTP_PASSWORD must be set together" in mailer.smtp_configuration_errors()


def test_send_mail_uses_starttls_and_builds_multipart_message(monkeypatch):
    _configure(monkeypatch)
    monkeypatch.setattr(mailer.smtplib, "SMTP", FakeSMTP)

    sent = mailer.send_mail(
        "user@example.net",
        "Ваш код",
        "Код: 123456",
        html="<p>Код: <strong>123456</strong></p>",
    )

    assert sent is True
    smtp = FakeSMTP.instances[0]
    assert smtp.kwargs == {"host": "smtp.example.com", "port": 587, "timeout": 10.0}
    assert smtp.calls == [
        "ehlo",
        "starttls",
        "ehlo",
        ("login", "smtp-user", "smtp-password"),
        "send",
    ]
    assert smtp.message["From"] == "Music Streaming <noreply@example.com>"
    assert smtp.message["Reply-To"] == "support@example.com"
    assert smtp.message.is_multipart()
    assert smtp.message.get_body(preferencelist=("plain",)).get_content().strip() == "Код: 123456"
    assert "<strong>123456</strong>" in smtp.message.get_body(preferencelist=("html",)).get_content()


def test_send_mail_uses_implicit_tls(monkeypatch):
    _configure(monkeypatch, security="ssl")
    monkeypatch.setattr(mailer.smtplib, "SMTP_SSL", FakeSMTP)

    assert mailer.send_mail("user@example.net", "Subject", "Body") is True

    smtp = FakeSMTP.instances[0]
    assert smtp.kwargs["port"] == 465
    assert "context" in smtp.kwargs
    assert "starttls" not in smtp.calls

