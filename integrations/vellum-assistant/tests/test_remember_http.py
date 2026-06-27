"""Unit tests for the server-first remember client (_remember_http.py).

Covers the two fixes:
  * remember posts with run_in_background=true by default (opt out via
    COGNEE_REMEMBER_BACKGROUND=false) so the agent turn isn't blocked on a
    synchronous cognify;
  * a write *timeout* is surfaced as a non-fatal note (NOT UNREACHABLE), so the
    caller does not fall back to the CLI and risk a duplicate write — while a real
    connection failure still returns UNREACHABLE.

Run: python integrations/vellum-assistant/tests/test_remember_http.py (or via pytest).
"""

import os
import pathlib
import sys
import urllib.error

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))

import _remember_http as rh  # noqa: E402


class _Resp:
    def __init__(self, body=b"{}"):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._body


def _capturing_opener(captured, body=b"{}"):
    def _open(req, timeout=None):
        captured["req"] = req
        return _Resp(body)

    return _open


def test_background_flag_default_true():
    os.environ.pop("COGNEE_REMEMBER_BACKGROUND", None)
    assert rh._background_flag() == "true"


def test_background_flag_opt_out():
    try:
        for v in ("false", "0", "no", "off", "FALSE"):
            os.environ["COGNEE_REMEMBER_BACKGROUND"] = v
            assert rh._background_flag() == "false"
    finally:
        os.environ.pop("COGNEE_REMEMBER_BACKGROUND", None)


def test_payload_sends_run_in_background_true():
    os.environ.pop("COGNEE_REMEMBER_BACKGROUND", None)
    cap = {}
    rh.do_remember("http://x", "", "content", "ds", "user_context", opener=_capturing_opener(cap))
    body = cap["req"].data
    assert b'name="run_in_background"\r\n\r\ntrue' in body


def test_timeout_does_not_fall_back():
    def _timeout_opener(req, timeout=None):
        raise TimeoutError("timed out")

    res = rh.do_remember("http://x", "", "c", "ds", "user_context", opener=_timeout_opener)
    assert res != rh.UNREACHABLE  # caller must NOT fall back to the CLI
    assert isinstance(res, dict) and "error" in res


def test_timeout_wrapped_in_urlerror_does_not_fall_back():
    def _wrapped(req, timeout=None):
        raise urllib.error.URLError(TimeoutError("timed out"))

    res = rh.do_remember("http://x", "", "c", "ds", "user_context", opener=_wrapped)
    assert res != rh.UNREACHABLE
    assert isinstance(res, dict) and "error" in res


def test_connection_failure_is_unreachable():
    def _refused(req, timeout=None):
        raise urllib.error.URLError("Connection refused")

    res = rh.do_remember("http://x", "", "c", "ds", "user_context", opener=_refused)
    assert res == rh.UNREACHABLE


def test_2xx_returns_ok():
    res = rh.do_remember("http://x", "", "c", "ds", "user_context", opener=_capturing_opener({}))
    assert res == {"ok": True}


if __name__ == "__main__":
    failures = 0
    for _name, _fn in sorted(globals().items()):
        if _name.startswith("test_") and callable(_fn):
            try:
                _fn()
                print("PASS", _name)
            except AssertionError as exc:
                failures += 1
                print("FAIL", _name, exc)
    sys.exit(1 if failures else 0)
