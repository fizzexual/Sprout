"""Version 1 process-isolated Sprout JSON boundary. Python 3.10+, no packages."""
from __future__ import annotations
import json
import math
import os
import re
from pathlib import Path
import signal
import subprocess
import threading
import time
from decimal import Decimal, InvalidOperation


class SproutError(RuntimeError):
    def __init__(self, message, code, *, stderr="", exit_code=None):
        super().__init__(message)
        self.code, self.stderr, self.exit_code = code, stderr, exit_code


def _encode(value, active=None):
    active = set() if active is None else active
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        if not -(2**63) <= value < 2**63:
            raise ValueError("Sprout integers are signed 64-bit values")
        return {"$sprout.integer": str(value)} if abs(value) > 2**53 - 1 else value
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("Sprout decimals must be finite")
        sign, digits, exponent = value.as_tuple()
        coefficient = int("".join(map(str, digits)) or "0") * (-1 if sign else 1)
        if exponent > 0:
            if exponent > 18:
                raise ValueError("Decimal coefficient exceeds signed 64-bit range")
            coefficient *= 10**exponent
        if exponent < -18 or not -(2**63) <= coefficient < 2**63:
            raise ValueError("Decimal exceeds Sprout's 64-bit coefficient or 18 fractional places")
        return {"$sprout.decimal": format(value, "f")}
    if isinstance(value, (bytes, bytearray)):
        return {"$sprout.bytes": bytes(value).hex()}
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("JSON numbers must be finite")
        if value.is_integer() and abs(value) > 2**53 - 1:
            raise ValueError("Use int instead of an unsafe floating-point integer")
        return value
    if isinstance(value, (dict, list, tuple)):
        if id(value) in active:
            raise ValueError("JSON input cannot contain cycles")
        active.add(id(value))
        try:
            if isinstance(value, dict):
                if not all(isinstance(k, str) for k in value):
                    raise TypeError("JSON map keys must be text")
                return {k: _encode(v, active) for k, v in value.items()}
            return [_encode(v, active) for v in value]
        finally:
            active.remove(id(value))
    raise TypeError("Input must contain JSON values, int64, Decimal, or bytes")


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON map key")
        result[key] = value
    if len(result) == 1:
        if "$sprout.integer" in result:
            value = result["$sprout.integer"]
            if not isinstance(value, str) or not re.fullmatch(r"[+-]?[0-9]+", value):
                raise ValueError("invalid exact integer tag")
            number = int(value)
            if not -(2**63) <= number < 2**63:
                raise ValueError("integer tag is outside signed 64-bit range")
            return number
        if "$sprout.decimal" in result:
            text = result["$sprout.decimal"]
            if not isinstance(text, str) or not re.fullmatch(r"[+-]?[0-9]+(?:\.[0-9]{1,18})?", text):
                raise ValueError("invalid exact decimal tag")
            try:
                value = Decimal(text)
            except InvalidOperation as error:
                raise ValueError("invalid exact decimal tag") from error
            _encode(value)
            return value
        if "$sprout.bytes" in result:
            text = result["$sprout.bytes"]
            if not isinstance(text, str) or len(text) % 2 or any(c not in "0123456789abcdefABCDEF" for c in text):
                raise ValueError("invalid bytes tag")
            return bytes.fromhex(text)
    return result


def decode(text):
    def invalid(value):
        raise ValueError("non-finite JSON number: " + value)
    def finite(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("non-finite JSON number")
        return number
    return json.loads(text, object_pairs_hook=_object, parse_constant=invalid, parse_float=finite)


def encode(value):
    return json.dumps(_encode(value), ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _positive(value, name, maximum=2**31-1):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise ValueError(f"{name} must be an integer from 1 to {maximum}")
    return value


def run(program, input_value, *, command="sprout", cwd=None, sandbox=True,
        timeout_ms=5000, runtime_timeout_ms=4000, max_steps=100000,
        max_input_bytes=1048576, max_output_bytes=1048576, max_error_bytes=65536,
        cancel: threading.Event | None = None):
    """Execute one request with streaming byte caps, host deadline, and cancellation.

    Default sandbox disables host I/O/imports. It is not OS isolation; run hostile
    source inside a restricted container or service account as well.
    """
    for value, name in ((timeout_ms, "timeout_ms"), (runtime_timeout_ms, "runtime_timeout_ms"),
                        (max_steps, "max_steps"), (max_input_bytes, "max_input_bytes"),
                        (max_output_bytes, "max_output_bytes"), (max_error_bytes, "max_error_bytes")):
        _positive(value, name)
    if not isinstance(sandbox, bool):
        raise TypeError("sandbox must be bool")
    request = (encode(input_value) + "\n").encode("utf-8")
    if len(request) > min(max_input_bytes, 1048576):
        raise SproutError("JSON input exceeds its byte limit", "input-limit")
    if cancel and cancel.is_set():
        raise SproutError("Sprout request canceled", "canceled")
    filename = Path(program).resolve()
    args = [str(command), "run", str(filename), "--max-steps", str(max_steps),
            "--timeout-ms", str(runtime_timeout_ms)]
    if sandbox:
        args.append("--sandbox")
    try:
        child = subprocess.Popen(args, cwd=str(cwd or filename.parent), stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=os.name != "nt",
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    except OSError as error:
        raise SproutError(f"Could not start Sprout: {error}", "spawn") from error
    chunks = [bytearray(), bytearray()]
    failed = threading.Event()
    errors = []
    lock = threading.Lock()

    def fail(message, code):
        with lock:
            if not errors:
                errors.append((message, code))
                failed.set()

    def read(stream, index, maximum):
        try:
            while True:
                chunk = stream.read1(4096)
                if not chunk:
                    return
                if len(chunks[index]) + len(chunk) > maximum:
                    fail("Sprout output exceeds its byte limit", "stdout-limit" if index == 0 else "stderr-limit")
                    return
                chunks[index].extend(chunk)
        except OSError:
            fail("Could not read Sprout output", "io")
        finally:
            stream.close()

    def write():
        try:
            child.stdin.write(request)
            child.stdin.close()
        except (OSError, BrokenPipeError):
            pass
        finally:
            child.stdin.close()

    readers = [threading.Thread(target=read, args=(child.stdout, 0, max_output_bytes), daemon=True),
               threading.Thread(target=read, args=(child.stderr, 1, max_error_bytes), daemon=True)]
    writer = threading.Thread(target=write, daemon=True)
    for thread in readers + [writer]:
        thread.start()
    deadline = time.monotonic() + timeout_ms / 1000
    while child.poll() is None or any(t.is_alive() for t in readers):
        if cancel and cancel.is_set():
            fail("Sprout request canceled", "canceled")
        if time.monotonic() >= deadline:
            fail("Sprout request exceeded its host deadline", "timeout")
        if failed.is_set():
            if os.name != "nt":
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            elif child.poll() is None:
                # Native process operations additionally own Windows kill-on-close jobs.
                subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=2, creationflags=subprocess.CREATE_NO_WINDOW)
            if child.poll() is None:
                child.kill()
            break
        failed.wait(.01)
    try:
        exit_code = child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        child.kill()
        exit_code = child.wait(timeout=2)
    for thread in readers + [writer]:
        thread.join(timeout=.5)
    stderr = bytes(chunks[1]).decode("utf-8", "replace")
    if errors:
        raise SproutError(*errors[0], stderr=stderr, exit_code=exit_code)
    if exit_code:
        raise SproutError(f"Sprout exited with {exit_code}", "runtime", stderr=stderr, exit_code=exit_code)
    try:
        text = bytes(chunks[0]).decode("utf-8", "strict")
        if text.endswith("\r\n"):
            text = text[:-2]
        elif text.endswith("\n"):
            text = text[:-1]
        if not text.strip() or "\n" in text or "\r" in text:
            raise ValueError("expected exactly one JSON line")
        return decode(text)
    except (ValueError, TypeError, UnicodeError) as error:
        raise SproutError(f"Invalid Sprout JSON response: {error}", "protocol", stderr=stderr) from error
