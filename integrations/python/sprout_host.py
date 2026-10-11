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

MAX_JSON_NESTING = 128


def _check_depth(depth):
    if depth > MAX_JSON_NESTING:
        raise ValueError(f"JSON nesting exceeds {MAX_JSON_NESTING} containers")


def _scalar_text(value):
    if "\x00" in value:
        raise ValueError("Sprout text cannot contain NUL")
    if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise ValueError("JSON text contains an unpaired surrogate")
    return value


def _check_strings(value):
    if isinstance(value, str):
        _scalar_text(value)
    elif isinstance(value, dict):
        for key, item in value.items():
            _scalar_text(key)
            _check_strings(item)
    elif isinstance(value, list):
        for item in value:
            _check_strings(item)


def _tagged(key, value, depth, budget=None):
    _check_depth(depth + 1)
    if budget is not None:
        budget.add(3)  # Braces and colon.
        budget.text(key)
        budget.text(value)
    return {key: value}


class SproutError(RuntimeError):
    def __init__(self, message, code, *, stderr="", exit_code=None):
        super().__init__(message)
        self.code, self.stderr, self.exit_code = code, stderr, exit_code


class _JsonBudget:
    """Count the actual compact UTF-8 wire shape before expanding more input."""
    def __init__(self, maximum):
        self.remaining = maximum

    def add(self, amount):
        if amount > self.remaining:
            raise SproutError("JSON input exceeds its byte limit", "input-limit")
        self.remaining -= amount

    def text(self, value):
        self.add(2)  # String quotes.
        for character in value:
            unit = ord(character)
            if unit == 0:
                raise ValueError("Sprout text cannot contain NUL")
            if 0xD800 <= unit <= 0xDFFF:
                raise ValueError("JSON text contains an unpaired surrogate")
            if character in '"\\\b\f\n\r\t':
                size = 2
            elif unit < 0x20:
                size = 6
            else:
                size = 1 if unit < 0x80 else 2 if unit < 0x800 else 3 if unit < 0x10000 else 4
            self.add(size)
        return value


def _encode(value, active=None, depth=0, budget=None):
    active = set() if active is None else active
    if isinstance(value, str):
        return budget.text(value) if budget is not None else _scalar_text(value)
    if value is None or isinstance(value, bool):
        if budget is not None:
            budget.add(4 if value is None or value is True else 5)
        return value
    if isinstance(value, int):
        if not -(2**63) <= value < 2**63:
            raise ValueError("Sprout integers are signed 64-bit values")
        if abs(value) > 2**53 - 1:
            return _tagged("$sprout.integer", str(value), depth, budget)
        if budget is not None:
            budget.add(len(str(value)))
        return value
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("Sprout decimals must be finite")
        sign, digits, exponent = value.as_tuple()
        # Reject huge coefficients/exponents before integer conversion or fixed
        # point formatting can construct an arbitrarily large intermediate.
        if exponent > 18 or exponent < -18 or len(digits) + max(exponent, 0) > 19:
            raise ValueError("Decimal exceeds Sprout's 64-bit coefficient or 18 fractional places")
        coefficient = 0
        for digit in digits:
            coefficient = coefficient * 10 + digit
        coefficient *= (-1 if sign else 1) * 10**max(exponent, 0)
        if not -(2**63) <= coefficient < 2**63:
            raise ValueError("Decimal exceeds Sprout's 64-bit coefficient or 18 fractional places")
        return _tagged("$sprout.decimal", format(value, "f"), depth, budget)
    if isinstance(value, (bytes, bytearray)):
        if budget is not None:
            _check_depth(depth + 1)
            budget.add(20 + 2 * len(value))  # Count hex before allocating it.
        return _tagged("$sprout.bytes", bytes(value).hex(), depth)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("JSON numbers must be finite")
        if value.is_integer() and abs(value) > 2**53 - 1:
            raise ValueError("Use int instead of an unsafe floating-point integer")
        if budget is not None:
            budget.add(len(json.dumps(value, allow_nan=False)))
        return value
    if isinstance(value, (dict, list, tuple)):
        _check_depth(depth + 1)
        if id(value) in active:
            raise ValueError("JSON input cannot contain cycles")
        if budget is not None:
            budget.add(2)  # Brackets or braces.
        active.add(id(value))
        try:
            if isinstance(value, dict):
                encoded = {}
                for key, item in value.items():
                    if not isinstance(key, str):
                        raise TypeError("JSON map keys must be text")
                    if budget is not None:
                        budget.add(1 + bool(encoded))  # Colon and optional comma.
                        key = budget.text(key)
                    else:
                        key = _scalar_text(key)
                    encoded[key] = _encode(item, active, depth + 1, budget)
                return encoded
            encoded = []
            for item in value:
                if budget is not None and encoded:
                    budget.add(1)
                encoded.append(_encode(item, active, depth + 1, budget))
            return encoded
        finally:
            active.remove(id(value))
    raise TypeError("Input must contain JSON values, int64, Decimal, or bytes")


def _object(pairs):
    result = {}
    for key, value in pairs:
        _scalar_text(key)
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
    if isinstance(text, (bytes, bytearray)):
        text = text.decode("utf-8-sig")
    if not isinstance(text, str):
        raise TypeError("JSON input must be text or UTF-8 bytes")
    # Scan before parsing so even a small, deeply nested request cannot consume
    # the Python parser's recursion budget. Brackets inside text do not count.
    depth = 0
    quoted = escaped = False
    for character in text:
        if quoted:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quoted = False
        elif character == '"':
            quoted = True
        elif character in "[{":
            depth += 1
            _check_depth(depth)
        elif character in "]}":
            depth -= 1
    def invalid(value):
        raise ValueError("non-finite JSON number: " + value)
    def finite(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("non-finite JSON number")
        return number
    try:
        value = json.loads(text, object_pairs_hook=_object, parse_constant=invalid, parse_float=finite)
        _check_strings(value)
        return value
    except RecursionError as error:
        raise ValueError("JSON input is nested too deeply") from error


def encode(value, *, max_bytes=None):
    """Encode compact JSON; optional max_bytes bounds UTF-8 before expansion."""
    if max_bytes is not None and (isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes < 0):
        raise ValueError("max_bytes must be a nonnegative integer")
    budget = None if max_bytes is None else _JsonBudget(max_bytes)
    try:
        return json.dumps(_encode(value, budget=budget), ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except RecursionError as error:
        raise ValueError("JSON input is nested too deeply") from error


def _positive(value, name, maximum=2**31-1):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise ValueError(f"{name} must be an integer from 1 to {maximum}")
    return value


def _stop_child(child):
    if os.name != "nt":
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    elif child.poll() is None:
        # Native process operations additionally own Windows kill-on-close jobs.
        try:
            subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=2, creationflags=subprocess.CREATE_NO_WINDOW)
        except (OSError, subprocess.TimeoutExpired):
            pass
    if child.poll() is None:
        child.kill()


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
    if cancel and cancel.is_set():
        raise SproutError("Sprout request canceled", "canceled")
    request = (encode(input_value, max_bytes=min(max_input_bytes, 1048576) - 1) + "\n").encode("utf-8")
    if len(request) > min(max_input_bytes, 1048576):
        raise SproutError("JSON input exceeds its byte limit", "input-limit")
    if cancel and cancel.is_set():
        raise SproutError("Sprout request canceled", "canceled")
    filename = Path(program).resolve()
    args = [str(command), "run", str(filename), "--max-steps", str(max_steps),
            "--timeout-ms", str(runtime_timeout_ms)]
    if sandbox:
        args.append("--sandbox")
    # Prepare state and thread objects before launching the owned worker.
    chunks = [bytearray(), bytearray()]
    failed = threading.Event()
    errors = []
    lock = threading.Lock()

    def fail(message, code):
        with lock:
            if not errors:
                errors.append((message, code))
                failed.set()

    def read(index, maximum):
        stream = child.stdout if index == 0 else child.stderr
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
        except OSError:
            pass
        finally:
            try:
                child.stdin.close()
            except OSError:
                pass

    readers = [threading.Thread(target=read, args=(0, max_output_bytes), daemon=True),
               threading.Thread(target=read, args=(1, max_error_bytes), daemon=True)]
    writer = threading.Thread(target=write, daemon=True)
    threads = readers + [writer]
    try:
        child = subprocess.Popen(args, cwd=str(cwd or filename.parent), stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=os.name != "nt",
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    except OSError as error:
        raise SproutError(f"Could not start Sprout: {error}", "spawn") from error
    try:
        for thread in threads:
            thread.start()
    except BaseException as error:
        # OS thread/task exhaustion can happen after any start. Cleanup must
        # also cover this path, before the ordinary deadline loop exists.
        _stop_child(child)
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=2)
        for thread in threads:
            if thread.ident is not None:
                thread.join(timeout=.5)
        for stream, thread in ((child.stdout, readers[0]), (child.stderr, readers[1]), (child.stdin, writer)):
            # A detached/external pipe owner may keep an I/O thread blocked.
            # Closing its buffered stream here would wait for that thread's
            # internal lock indefinitely; its own finally block owns closure.
            if thread.is_alive():
                continue
            try:
                stream.close()
            except OSError:
                pass
        if isinstance(error, Exception):
            raise SproutError("Could not start Sprout I/O threads", "io") from error
        raise
    deadline = time.monotonic() + timeout_ms / 1000
    while child.poll() is None or any(t.is_alive() for t in readers):
        if cancel and cancel.is_set():
            fail("Sprout request canceled", "canceled")
        if time.monotonic() >= deadline:
            fail("Sprout request exceeded its host deadline", "timeout")
        if failed.is_set():
            _stop_child(child)
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
