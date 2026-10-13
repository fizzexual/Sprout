"""Decision oracle/source controls by default; an explicit trusted binary selects four native CI calls."""
from __future__ import annotations

import argparse
import copy
import importlib.util
import os
import stat
import tempfile
from dataclasses import dataclass
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import unittest

sys.dont_write_bytecode = True

REPO = Path(__file__).resolve().parents[2]
SOURCE = REPO / "lib/decision.sprout"
SHARED = REPO / "src/tests/decision_library_test.sprout"
EXAMPLE = REPO / "examples/rules/item_handling.sprout"
LIMITS = {
    "rules": 32, "conditions": 8, "fields": 32, "map": 128, "list": 256,
    "edges": 16, "nodes": 4096, "text": 65536, "leaf": 1024,
    "key": 128, "id": 64, "alternatives": 16, "response": 32768,
}
MESSAGES = {
    "invalid_table": "The decision table is invalid.",
    "table_limit": "The decision table exceeds the fixed limits.",
    "invalid_input": "The decision input is invalid.",
    "input_limit": "The decision input exceeds the fixed limits.",
    "output_limit": "The complete decision response exceeds the fixed output limit.",
}


@dataclass(frozen=True)
class Integer:
    value: int


@dataclass(frozen=True)
class ExactDecimal:
    coefficient: int
    scale: int
    text: str

    @property
    def rational(self):
        return Fraction(self.coefficient, 10 ** self.scale)


def integer(value):
    return {"$sprout.integer": str(value)}


def decimal(value):
    return {"$sprout.decimal": str(value)}


def typed(value):
    """Decode only fixture tags; never accept Python bool as an integer."""
    if type(value) is dict:
        if set(value) == {"$sprout.integer"}:
            text = value["$sprout.integer"]
            if type(text) is not str or not re.fullmatch(r"-?(?:0|[1-9][0-9]*)", text):
                raise ValueError("bad exact fixture")
            number = int(text)
            if not -(1 << 63) <= number < (1 << 63):
                raise ValueError("bad exact fixture")
            return Integer(number)
        if set(value) == {"$sprout.decimal"}:
            text = value["$sprout.decimal"]
            if type(text) is not str or not re.fullmatch(r"-?[0-9]+(?:\.[0-9]{1,18})?", text):
                raise ValueError("bad exact fixture")
            scale = len(text.rpartition(".")[2]) if "." in text else 0
            coefficient = int(text.replace(".", ""))
            if not -(1 << 63) <= coefficient < (1 << 63):
                raise ValueError("bad exact fixture")
            return ExactDecimal(coefficient, scale, text)
        return {key: typed(child) for key, child in value.items()}
    if type(value) is list:
        return [typed(child) for child in value]
    return value


def wire(value):
    if type(value) is Integer:
        return integer(value.value)
    if type(value) is ExactDecimal:
        return decimal(value.text)
    if type(value) is list:
        return [wire(child) for child in value]
    if type(value) is dict:
        return {key: wire(child) for key, child in value.items()}
    return value


def kind(value):
    return {
        type(None): "nothing", str: "text", bool: "yes-no", int: "number",
        float: "number", Integer: "integer", ExactDecimal: "decimal",
        list: "list", dict: "map",
    }.get(type(value), "unsupported")


def scalar_equal(left, right):
    if kind(left) != kind(right):
        return False
    if type(left) is ExactDecimal:
        return left.rational == right.rational
    return left == right


def numeric(value):
    if type(value) is Integer:
        return Fraction(value.value)
    if type(value) is ExactDecimal:
        return value.rational
    raise ValueError("exact comparison only")


class Rejected(Exception):
    pass


def admit(value, state, depth=0):
    """Independent bounded graph walk, charging every repeated occurrence."""
    if depth > LIMITS["edges"] or state["nodes"] >= LIMITS["nodes"]:
        raise Rejected("limit")
    state["nodes"] += 1
    k = kind(value)
    if k == "unsupported":
        raise Rejected("invalid")
    if k == "number" and (abs(value) > 9007199254740991 or not math.isfinite(value)):
        raise Rejected("invalid")
    if k == "text":
        admit_text(value, LIMITS["leaf"], state)
    elif k == "list":
        if len(value) > LIMITS["list"]:
            raise Rejected("limit")
        for child in value:
            admit(child, state, depth + 1)
    elif k == "map":
        if len(value) > LIMITS["map"]:
            raise Rejected("limit")
        if len(value) == 1 and next(iter(value)) in {"$sprout.integer", "$sprout.decimal", "$sprout.bytes"}:
            raise Rejected("invalid")
        for key, child in value.items():
            if type(key) is not str:
                raise Rejected("invalid")
            admit_text(key, LIMITS["key"], state)
            admit(child, state, depth + 1)


def admit_text(value, cap, state):
    if len(value) > cap or state["text"] + len(value) > LIMITS["text"]:
        raise Rejected("limit")
    state["text"] += len(value)
    try:
        value.encode("utf-8", "strict")
    except UnicodeError:
        raise Rejected("invalid") from None


def shape(value, required, optional=()):
    return type(value) is dict and set(required) <= set(value) <= set(required) | set(optional)


def valid_schema(schema, field=False, depth=0, budget=None):
    """Validator profile oracle; it does not invoke the Sprout implementation."""
    if budget is None:
        budget = {"nodes": 0, "allowed": 0, "text": 0}
    if depth > 16 or type(schema) is not dict:
        return False
    budget["nodes"] += 1
    if budget["nodes"] > 1024 or len(schema) > 9:
        return False
    k = schema.get("kind")
    if type(k) is not str or k not in {"text", "yes-no", "number", "integer", "decimal", "list", "map"}:
        return False
    permitted = {"kind", "required", "nullable"}
    permitted |= {"fields", "allow_unknown"} if k == "map" else {"items", "min_length", "max_length"} if k == "list" else {"allowed", "min_length", "max_length"} if k == "text" else {"allowed"}
    if set(schema) - permitted or ("required" in schema and not field):
        return False
    if type(schema.get("required", True)) is not bool or type(schema.get("nullable", False)) is not bool:
        return False
    if k in {"text", "list"}:
        ceiling = 1048576 if k == "text" else 10000
        def whole(value):
            if type(value) is Integer:
                value = value.value
            return type(value) in {int, float} and math.isfinite(value) and 0 <= value <= ceiling and value % 1 == 0
        minimum, maximum = schema.get("min_length", 0), schema.get("max_length", ceiling)
        if not whole(minimum) or not whole(maximum):
            return False
        minimum = minimum.value if type(minimum) is Integer else minimum
        maximum = maximum.value if type(maximum) is Integer else maximum
        if minimum > maximum:
            return False
    if "allowed" in schema:
        choices = schema["allowed"]
        if type(choices) is not list or not 1 <= len(choices) <= 256:
            return False
        budget["allowed"] += len(choices)
        if budget["allowed"] > 4096:
            return False
        for value in choices:
            if value is None and schema.get("nullable", False):
                continue
            if kind(value) != k:
                return False
            if type(value) is str:
                budget["text"] += len(value)
                if budget["text"] > 16384:
                    return False
    if k == "map":
        fields = schema.get("fields", {})
        if type(schema.get("allow_unknown", False)) is not bool or type(fields) is not dict or len(fields) > 128:
            return False
        for name, child in fields.items():
            if type(name) is not str or not 1 <= len(name) <= 128:
                return False
            budget["text"] += len(name)
            if budget["text"] > 16384 or not valid_schema(child, True, depth + 1, budget):
                return False
    if k == "list" and ("items" not in schema or not valid_schema(schema["items"], False, depth + 1, budget)):
        return False
    return True


def conforms(value, schema):
    if value is None:
        return schema.get("nullable", False) and ("allowed" not in schema or any(item is None for item in schema["allowed"]))
    k = kind(value)
    if k != schema["kind"]:
        return False
    if "allowed" in schema and not any(scalar_equal(value, item) for item in schema["allowed"]):
        return False
    if k in {"text", "list"}:
        minimum, maximum = schema.get("min_length", 0), schema.get("max_length", 1048576 if k == "text" else 10000)
        minimum = minimum.value if type(minimum) is Integer else minimum
        maximum = maximum.value if type(maximum) is Integer else maximum
        if not minimum <= len(value) <= maximum:
            return False
    if k == "map":
        fields = schema.get("fields", {})
        if not schema.get("allow_unknown", False) and set(value) - set(fields):
            return False
        return all((not child.get("required", True)) if name not in value else conforms(value[name], child) for name, child in fields.items())
    if k == "list":
        return all(conforms(child, schema["items"]) for child in value)
    return True


def error(code):
    return {"ok": False, "matched": False, "selection": None, "output": None, "error": {"code": code, "message": MESSAGES[code]}}


def success(selection="none", index=None, label=None, output=None):
    return {"ok": True, "matched": selection == "rule", "selection": {"kind": selection, "index": integer(index) if index is not None else None, "id": label}, "output": output, "error": None}


def operand(value, schema):
    if schema["kind"] not in {"text", "yes-no", "number", "integer", "decimal"}:
        return False
    return schema.get("nullable", False) if value is None else kind(value) == schema["kind"]


def valid_condition(condition, fields):
    if type(condition) is not dict or type(condition.get("field")) is not str or type(condition.get("op")) is not str or condition["field"] not in fields:
        return False
    op = condition.get("op")
    schema = fields[condition["field"]]
    if op in {"exists", "missing"}:
        return shape(condition, {"field", "op"})
    if op == "in":
        choices = condition.get("values")
        return shape(condition, {"field", "op", "values"}) and type(choices) is list and 1 <= len(choices) <= 16 and all(operand(value, schema) for value in choices)
    if op not in {"eq", "ne", "lt", "lte", "gt", "gte"} or not shape(condition, {"field", "op", "value"}) or not operand(condition["value"], schema):
        return False
    return op in {"eq", "ne"} or condition["value"] is not None and schema["kind"] in {"integer", "decimal"}


def predicate(condition, data):
    op, field = condition["op"], condition["field"]
    if op == "exists":
        return field in data
    if op == "missing":
        return field not in data
    if field not in data:
        return False
    value = data[field]
    if op in {"eq", "ne"}:
        equal = scalar_equal(value, condition["value"])
        return equal if op == "eq" else not equal
    if op == "in":
        return any(scalar_equal(value, item) for item in condition["values"])
    if value is None:
        return False
    left, right = numeric(value), numeric(condition["value"])
    return {"lt": left < right, "lte": left <= right, "gt": left > right, "gte": left >= right}[op]


def evaluate_oracle(data, table):
    state = {"nodes": 0, "text": 0}
    try:
        admit(table, state)
    except Rejected as problem:
        return error("table_limit" if str(problem) == "limit" else "invalid_table")
    if not shape(table, {"schema", "input_schema", "rules"}, {"fallback"}) or type(table["schema"]) not in {int, float} or table["schema"] != 1:
        return error("invalid_table")
    schema = table["input_schema"]
    if not valid_schema(schema) or schema["kind"] != "map" or schema.get("nullable", False) or schema.get("allow_unknown", False):
        return error("invalid_table")
    fields = schema.get("fields", {})
    rules = table["rules"]
    if type(rules) is not list:
        return error("invalid_table")
    if len(fields) > 32 or len(rules) > 32:
        return error("table_limit")
    labels = set()
    for rule in rules:
        if not shape(rule, {"id", "conditions", "output"}) or type(rule["id"]) is not str or not 1 <= len(rule["id"]) <= 64 or rule["id"] in labels or type(rule["conditions"]) is not list or not rule["conditions"]:
            return error("invalid_table")
        labels.add(rule["id"])
        if len(rule["conditions"]) > 8:
            return error("table_limit")
        if not all(valid_condition(condition, fields) for condition in rule["conditions"]):
            return error("invalid_table")
    if type(data) is not dict:
        return error("invalid_input")
    if len(data) > 32:
        return error("input_limit")
    try:
        admit(data, state)
    except Rejected as problem:
        return error("input_limit" if str(problem) == "limit" else "invalid_input")
    if not conforms(data, schema):
        return error("invalid_input")
    result = success("fallback", output=wire(copy.deepcopy(table["fallback"]))) if "fallback" in table else success()
    for index, rule in enumerate(rules, 1):
        if all(predicate(condition, data) for condition in rule["conditions"]):
            result = success("rule", index, rule["id"], wire(copy.deepcopy(rule["output"])))
            break
    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return error("output_limit") if len(encoded) + 2 > 32768 else result


def semantic_cases():
    """Expected envelopes are authored directly, never derived with the oracle."""
    cases = []
    def add(name, data, table, expected):
        cases.append({"name": name, "input": data, "table": table, "expected": expected})
    def table(k="integer", op="eq", value=None, *, optional=False, nullable=False, values=None):
        field = {"kind": k}
        if optional:
            field["required"] = False
        if nullable:
            field["nullable"] = True
        condition = {"field": "x", "op": op}
        if op == "in":
            condition["values"] = values
        elif op not in {"exists", "missing"}:
            condition["value"] = value
        return {"schema": 1, "input_schema": {"kind": "map", "fields": {"x": field}}, "rules": [{"id": "first", "conditions": [condition], "output": {"bucket": "selected"}}]}
    selected = success("rule", 1, "first", {"bucket": "selected"})
    none = success()
    for op, data, threshold, win in [("eq", 5, 5, True), ("eq", 4, 5, False), ("ne", 4, 5, True), ("ne", 5, 5, False), ("lt", -1, 0, True), ("lt", 0, 0, False), ("lte", 0, 0, True), ("gt", 1, 0, True), ("gt", 0, 0, False), ("gte", 0, 0, True)]:
        add("integer-" + op + "-" + str(data), {"x": integer(data)}, table(value=integer(threshold), op=op), selected if win else none)
    add("int64-positive-end", {"x": integer((1 << 63) - 1)}, table(op="gt", value=integer((1 << 63) - 2)), selected)
    add("int64-negative-end", {"x": integer(-(1 << 63))}, table(op="lt", value=integer(-(1 << 63) + 1)), selected)
    add("decimal-scale-equality", {"x": decimal("2.500")}, table("decimal", "eq", decimal("2.50")), selected)
    add("decimal-negative-order", {"x": decimal("-0.01")}, table("decimal", "lt", decimal("0.00")), selected)
    add("decimal-coefficient-bound", {"x": decimal("922337203685477580.7")}, table("decimal", "gte", decimal("922337203685477580.6")), selected)
    add("text-Unicode", {"x": "é🌱"}, table("text", "eq", "é🌱"), selected)
    add("text-case-sensitive", {"x": "Fragile"}, table("text", "eq", "fragile"), none)
    add("boolean-equality", {"x": True}, table("yes-no", "eq", True), selected)
    add("boolean-not-number", {"x": True}, table("number", "eq", 1), error("invalid_input"))
    add("number-no-order", {"x": 1}, table("number", "lt", 2), error("invalid_table"))
    add("integer-not-decimal-operand", {"x": integer(1)}, table("integer", "eq", decimal("1.0")), error("invalid_table"))
    add("integer-not-ordinary-input", {"x": 1}, table(value=integer(1)), error("invalid_input"))
    container_table = table("list", "eq", None, nullable=True)
    container_table["input_schema"]["fields"]["x"]["items"] = {"kind": "text"}
    add("container-null-comparison-rejected", {"x": None}, container_table, error("invalid_table"))
    unknown_condition = table(value=integer(1))
    unknown_condition["rules"][0]["conditions"][0]["field"] = "undeclared"
    add("undeclared-condition-field", {"x": integer(1)}, unknown_condition, error("invalid_table"))
    add("optional-missing-eq", {}, table("text", "eq", "x", optional=True), none)
    add("optional-missing-ne", {}, table("text", "ne", "x", optional=True), none)
    add("optional-missing", {}, table("text", "missing", optional=True, nullable=True), selected)
    add("explicit-null-exists", {"x": None}, table("text", "exists", optional=True, nullable=True), selected)
    add("explicit-null-ne-text", {"x": None}, table("text", "ne", "x", nullable=True), selected)
    add("explicit-null-equality", {"x": None}, table("text", "eq", None, nullable=True), selected)
    add("explicit-null-no-order", {"x": None}, table("integer", "lte", integer(1), nullable=True), none)
    add("membership-decimal", {"x": decimal("2.00")}, table("decimal", "in", values=[decimal("1.0"), decimal("2.0")]), selected)
    add("membership-null", {"x": None}, table("text", "in", nullable=True, values=["x", None]), selected)
    add("unknown-input-key", {"x": integer(1), "private-input-name": "secret"}, table(value=integer(1)), error("invalid_input"))
    priority = table(value=integer(1))
    priority["rules"].append({"id": "second", "conditions": [{"field": "x", "op": "eq", "value": integer(1)}], "output": "second-output"})
    add("list-priority-tie", {"x": integer(1)}, priority, selected)
    bad_later = copy.deepcopy(priority)
    bad_later["rules"][1]["conditions"][0]["op"] = "expression"
    add("bad-unreachable-rule", {"x": integer(1)}, bad_later, error("invalid_table"))
    duplicate = copy.deepcopy(priority)
    duplicate["rules"][1]["id"] = "first"
    add("duplicate-id", {"x": integer(1)}, duplicate, error("invalid_table"))
    base = {"schema": 1, "input_schema": {"kind": "map"}, "rules": []}
    add("no-match-empty-table", {}, copy.deepcopy(base), none)
    fallback = copy.deepcopy(base)
    fallback["fallback"] = None
    add("explicit-null-fallback", {}, fallback, success("fallback"))
    bad = copy.deepcopy(base)
    bad["input_schema"]["nullable"] = True
    add("nullable-root-before-invalid-input", None, bad, error("invalid_table"))
    for label, version in [("boolean-version", True), ("exact-version", integer(1))]:
        bad = copy.deepcopy(base)
        bad["schema"] = version
        add(label, None, bad, error("invalid_table"))
    return cases


def golden():
    # Directly authored expected fixtures; no private machine file dependency.
    return semantic_cases()


def supplied_wrapper(rows):
    validation = read_bounded(REPO / "lib/validate.sprout", 1048576).decode("utf-8").replace("\r\n", "\n")
    module = read_bounded(SOURCE, 1048576).decode("utf-8").replace("\r\n", "\n")
    module = module.replace('use "validate.sprout"\n', "").replace("private make d_validate = validate.check", "private make d_validate = check")
    records = json.dumps(rows, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return (validation + "\n" + module + "\nmake records = builtin::json_decode(" + json.dumps(records, ensure_ascii=False) + ")\nmake outputs = []\nfor each record in records:\n    builtin::add(outputs, evaluate(record.input, record.table))\nshow builtin::json_encode(outputs)\n").encode("utf-8")


class SourceOracleTests(unittest.TestCase):
    def test_independent_hand_oracle_cases(self):
        saved = golden()
        self.assertEqual(len({case["name"] for case in saved}), len(saved))
        self.assertLessEqual(len(saved), 48)
        for case in saved:
            with self.subTest(case=case["name"]):
                self.assertEqual(evaluate_oracle(typed(case["input"]), typed(case["table"])), case["expected"])

    def test_exact_scalar_and_missing_null_contracts(self):
        self.assertFalse(scalar_equal(True, 1))
        self.assertFalse(scalar_equal(Integer(1), ExactDecimal(10, 1, "1.0")))
        self.assertTrue(scalar_equal(ExactDecimal(250, 2, "2.50"), ExactDecimal(2500, 3, "2.500")))
        self.assertEqual(numeric(Integer(-(1 << 63))), Fraction(-(1 << 63)))
        self.assertLess(numeric(ExactDecimal(-1, 18, "-0.000000000000000001")), Fraction(0))
        base = {"field": "x", "op": "ne", "value": "present"}
        self.assertFalse(predicate(base, {}))
        self.assertTrue(predicate(base, {"x": None}))
        for code in MESSAGES:
            packet = error(code)
            self.assertLessEqual(len(packet["error"]["message"].encode("ascii")), 96)
            self.assertLess(len(json.dumps(packet, separators=(",", ":")).encode()) + 2, 320)
            self.assertNotIn("secret", json.dumps(packet))

    def test_limit_oracle_boundaries(self):
        admit([0] * 256, {"nodes": 0, "text": 0})
        with self.assertRaisesRegex(Rejected, "limit"):
            admit([0] * 257, {"nodes": 0, "text": 0})
        admit({str(i): i for i in range(128)}, {"nodes": 0, "text": 0})
        with self.assertRaisesRegex(Rejected, "limit"):
            admit({str(i): i for i in range(129)}, {"nodes": 0, "text": 0})
        cycle = []
        cycle.append(cycle)
        with self.assertRaisesRegex(Rejected, "limit"):
            admit(cycle, {"nodes": 0, "text": 0})
        alias = [0] * 255
        with self.assertRaisesRegex(Rejected, "limit"):
            admit([alias] * 17, {"nodes": 0, "text": 0})
        self.assertEqual(len(alias), 255)
        with self.assertRaisesRegex(Rejected, "limit"):
            admit("x" * 1025, {"nodes": 0, "text": 0})
        with self.assertRaisesRegex(Rejected, "limit"):
            admit("x", {"nodes": 0, "text": 65536})
        with self.assertRaisesRegex(Rejected, "invalid"):
            admit(float("inf"), {"nodes": 0, "text": 0})
        with self.assertRaisesRegex(Rejected, "invalid"):
            admit("\ud800", {"nodes": 0, "text": 0})

    def test_captured_helpers_intrinsics_and_no_effects_source(self):
        source = read_bounded(SOURCE, 1048576).decode("utf-8").replace("\r\n", "\n")
        tasks = re.findall(r"^(?:private|public) task (\w+)\(", source, re.M)
        self.assertEqual(len(tasks), 13)
        for task in tasks:
            self.assertRegex(source, rf"(?m)^(?:private|public) make {task} = {task}$")
        self.assertIn("private make d_validate = validate.check", source)
        self.assertNotRegex(source, r"(?<!::)\b(?:kind_of|is_a|contains|length|keys|add|integer|bytes|json_encode)\(")
        self.assertNotRegex(source, r"\b(?:read|write|get|ask|remember|store|recall|process|http|sqlite)\b")
        evaluate = source[source.index("public task evaluate"):source.index("private make d_plain =")]
        self.assertLess(evaluate.index("d_admit(table"), evaluate.index("d_validate({},"))
        self.assertLess(evaluate.index("d_admit(input"), evaluate.index("d_validate(input"))
        self.assertLess(evaluate.index("d_validate(input"), evaluate.index('d_result("rule"'))
        self.assertNotIn("d_copy(", evaluate)
        self.assertIn('give builtin::kind_of(condition.value) != "nothing"', source)
        self.assertIn('when builtin::kind_of(value) == "nothing":', source)
        self.assertIn("stop", evaluate)

    def test_fixture_and_example_oracle_shapes(self):
        shared = read_bounded(SHARED, 1048576).decode("utf-8")
        self.assertEqual(len(re.findall(r'^test "', shared, re.M)), 10)
        for evidence in ["9223372036854775807", "-9223372036854775808", "2.500", "callbacks", "before", "loop", "output_limit", "invalid_table"]:
            self.assertIn(evidence, shared)
        example = read_bounded(EXAMPLE, 1048576).decode("utf-8")
        self.assertIn('use "../../lib/decision.sprout"', example)
        self.assertEqual(len(re.findall(r"^    \{category:", example, re.M)), 4)
        expected = example_expected()
        self.assertEqual([packet["selection"]["kind"] for packet in expected], ["rule", "rule", "rule", "fallback"])
        self.assertEqual([packet["output"]["bucket"] for packet in expected], ["review", "small", "unclassified", "standard"])
        self.assertEqual([packet["selection"]["index"] for packet in expected[:3]], [integer(1), integer(2), integer(3)])
        self.assertEqual(len(golden()), 42)
        wrapper = supplied_wrapper(golden())
        self.assertIn(b"make records = builtin::json_decode(", wrapper)
        self.assertNotIn(b'use "validate.sprout"', wrapper)
        self.assertIn(b"private make d_validate = check", wrapper)
        complete_expected = json.dumps([case["expected"] for case in golden()], ensure_ascii=False, separators=(",", ":")).encode()
        self.assertLessEqual(len(complete_expected) + 2, 32768)

    def test_native_entry_disabled_prelaunch(self):
        self.assertEqual(main([], run_tests=False), 0)
        with self.assertRaisesRegex(ValueError, "Report directory"):
            main(["--report-dir", "unused-without-binary"], run_tests=False)
        source = read_bounded(Path(__file__), 1048576).decode("utf-8")
        self.assertNotRegex(source, r"(?m)^\s*(?:import subprocess|from subprocess|import sprout_host)")
        self.assertNotRegex(source, r"(?m)^\s*\w+\s*=\s*(?:subprocess\.)?Popen\(")
        schedule = public_schedule()
        self.assertEqual(schedule["caps"]["calls"], 4)
        self.assertEqual(len(schedule["calls"]), 4)
        self.assertEqual(schedule["calls"][1]["environment"], {"SPROUT_GC_STRESS": "1"})
        self.assertEqual(schedule["expected_semantic_cases"], 42)


def example_expected():
    return [success("rule", 1, "manual", {"bucket": "review"}),
            success("rule", 2, "small", {"bucket": "small"}),
            success("rule", 3, "unknown-age", {"bucket": "unclassified"}),
            success("fallback", output={"bucket": "standard"})]


def public_schedule():
    return {"expected_shared_tests": 10, "expected_semantic_cases": 42, "expected_example_results": 4,
            "caps": {"calls": 4, "vm_timeout_ms": 3000, "max_steps": 5000000, "host_seconds": 5, "capture_bytes_each": 32768, "stdin_bytes": 0, "retries": 0},
            "calls": [{"label": "shared-normal", "mode": "test", "environment": {}},
                      {"label": "shared-actual-gc", "mode": "test", "environment": {"SPROUT_GC_STRESS": "1"}},
                      {"label": "supplied-oracle-sandbox", "mode": "run", "environment": {}},
                      {"label": "synthetic-example", "mode": "run", "environment": {}}]}


def read_bounded(path, maximum):
    path = Path(path).resolve(strict=True)
    before = path.stat()
    if not stat.S_ISREG(before.st_mode) or not 0 <= before.st_size <= maximum:
        raise ValueError("Input is not a bounded regular file")
    chunks = []
    with path.open("rb") as stream:
        if os.fstat(stream.fileno()).st_size != before.st_size:
            raise ValueError("Input size changed before reading")
        remaining = before.st_size
        while remaining:
            chunk = stream.read(min(65536, remaining))
            if not chunk:
                raise ValueError("Input ended before credited size")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.fstat(stream.fileno()).st_size != before.st_size:
            raise ValueError("Input size changed while reading")
    return b"".join(chunks)


def file_identity(path, maximum, text=False):
    path = Path(path).resolve(strict=True)
    raw = read_bounded(path, maximum)
    identity = {"path": str(path), "bytes": len(raw), "raw_sha256": hashlib.sha256(raw).hexdigest()}
    if text:
        canonical = raw.decode("utf-8", "strict").replace("\r\n", "\n").encode("utf-8")
        identity["canonical_utf8_lf_sha256"] = hashlib.sha256(canonical).hexdigest()
    return identity


_HELPER = None


def bounded_helper():
    global _HELPER
    if _HELPER is None:
        path = REPO / "src/tests/gc_env_roots_test.py"
        read_bounded(path, 1048576)
        spec = importlib.util.spec_from_file_location("decision_owned_capture", path)
        helper = importlib.util.module_from_spec(spec)
        saved_argv = sys.argv
        try:
            sys.argv = [str(path)]
            spec.loader.exec_module(helper)
        finally:
            sys.argv = saved_argv
        if Path(helper.__file__).resolve() != path.resolve():
            raise ValueError("Actually loaded helper path differs")
        helper.CAPTURE_BYTES = 32768
        _HELPER = helper
    return _HELPER


def strict_equal(actual, expected):
    if type(actual) is not type(expected):
        return False
    if type(actual) is dict:
        return actual.keys() == expected.keys() and all(strict_equal(actual[key], expected[key]) for key in actual)
    if type(actual) is list:
        return len(actual) == len(expected) and all(strict_equal(left, right) for left, right in zip(actual, expected))
    return actual == expected


def unique_json(raw):
    def pairs(values):
        result = {}
        for name, value in values:
            if name in result:
                raise ValueError("Duplicate decoded JSON key")
            result[name] = value
        return result
    def floating(text):
        value = float(text)
        if not math.isfinite(value):
            raise ValueError("Nonfinite JSON number")
        return value
    def constant(text):
        raise ValueError("Nonfinite JSON constant")
    return json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=pairs, parse_float=floating, parse_constant=constant)


def one_json_line(raw):
    if raw.endswith(b"\r\n"):
        payload = raw[:-2]
    elif raw.endswith(b"\n"):
        payload = raw[:-1]
    else:
        raise AssertionError("Expected one complete JSON physical line")
    if b"\r" in payload or b"\n" in payload:
        raise AssertionError("Unexpected additional JSON physical line")
    return unique_json(payload)


def verify_shared_output(raw):
    clean = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", raw)
    if re.search(rb"\b0*[1-9][0-9]*[ \t]+failed\b", clean):
        raise AssertionError("Shared summary reports nonzero failure")
    summaries = [match for line in clean.splitlines() if (match := re.fullmatch(rb"[ \t]*([0-9]+) passed(?:,[ \t]*([0-9]+) failed)?[ \t]*", line))]
    if len(summaries) != 1 or summaries[0].group(1) != b"10" or summaries[0].group(2) not in (None, b"0"):
        raise AssertionError("Require exactly one full10/zero-failure summary")


def native_ci_checks(binary, report=None):
    """Explicit trusted binary only. No private seal/hash/path required by users."""
    if "SPROUT_GC_STRESS" in os.environ or "SPROUT_SANDBOX" in os.environ:
        raise ValueError("Explicit native mode requires both parent GC/sandbox variables to be absent")
    if binary is None:
        raise ValueError("An explicit trusted binary is required")
    binary = Path(binary).resolve(strict=True)
    native_identity = file_identity(binary, 67108864)
    host_identity = file_identity(Path(sys.executable).resolve(), 67108864)
    helper = bounded_helper()
    paths = {"module": SOURCE, "validator": REPO / "lib/validate.sprout", "shared": SHARED,
             "example": EXAMPLE, "executed_driver": Path(__file__).resolve(), "loaded_helper": Path(helper.__file__).resolve()}
    identities = {name: file_identity(path, 1048576, True) for name, path in paths.items()}
    rows = semantic_cases()
    expected = [row["expected"] for row in rows]
    expected_example = example_expected()
    if len(rows) != 42 or len(expected_example) != 4:
        raise ValueError("Fixed complete oracle counts differ")
    wrapper = supplied_wrapper(rows)
    if len(wrapper) > 1048576 or len(json.dumps(expected, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 2 > 32768:
        raise ValueError("Fixed fixture exceeds source/capture cap")
    if report is None:
        report = Path(tempfile.mkdtemp(prefix="sprout-decision-ci-")).resolve()
    else:
        report = Path(report).resolve()
        report.mkdir(parents=True, exist_ok=False)
    print("Decision native report: " + str(report), file=sys.stderr)
    wrapper_path = report / "supplied-oracle.sprout"
    wrapper_path.write_bytes(wrapper)
    (report / "oracle-vectors.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    (report / "synthetic-example-expected.json").write_text(json.dumps(expected_example, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    schedule = public_schedule()
    programs = [SHARED, SHARED, wrapper_path, EXAMPLE]
    scope = {"schema": "sprout.decision-public-ci-scope.v1", "schedule": schedule, "native": native_identity,
             "sources": identities, "host": host_identity, "host_version": sys.version, "platform": sys.platform,
             "wrapper_sha256": hashlib.sha256(wrapper).hexdigest(), "parent_gc_sandbox_variables": "absent",
             "boundary": "Explicit trusted binary/checked-out test sources; identities are evidence, not authentication/OS isolation. OS spawn and direct cleanup separate."}
    (report / "attempt.json").write_text(json.dumps(scope, indent=2) + "\n", encoding="utf-8", newline="\n")
    observations = []
    primary = None
    finalization = []
    interruption = None
    try:
        for index, call in enumerate(schedule["calls"]):
            child_env = dict(os.environ)
            child_env.pop("SPROUT_GC_STRESS", None)
            child_env.pop("SPROUT_SANDBOX", None)
            if index == 1:
                child_env["SPROUT_GC_STRESS"] = "1"
            argv = [str(binary), call["mode"], str(programs[index]), "--max-steps", "5000000", "--timeout-ms", "3000"]
            if index == 2:
                argv.append("--sandbox")
            observation = {"label": call["label"], "argv": argv, "phase": "reserved_before_helper", "gc_stress_environment": index == 1,
                           "exit": None, "stdout_bytes": None, "stderr_bytes": None, "capture_errors": [], "cleanup_errors": []}
            observations.append(observation)
            (report / "observations.json").write_text(json.dumps(observations, indent=2) + "\n", encoding="utf-8", newline="\n")
            result = helper.bounded_process(argv, cwd=REPO, data=None, timeout=5, env=child_env)
            observation.update({"phase": "helper_returned", "exit": result.returncode, "stdout_bytes": len(result.stdout), "stderr_bytes": len(result.stderr),
                                "stdout_sha256": hashlib.sha256(result.stdout).hexdigest(), "stderr_sha256": hashlib.sha256(result.stderr).hexdigest(),
                                "capture_errors": list(result.capture_errors), "cleanup_errors": list(result.cleanup_errors)})
            if result.returncode != 0 or result.stderr or result.capture_errors or result.cleanup_errors or len(result.stdout) > 32768 or len(result.stderr) > 32768:
                primary = {"kind": "native_result", "label": call["label"], "message": "First status/capture/cleanup/diagnostic failure retained"}
            for suffix, raw in [("stdout", result.stdout), ("stderr", result.stderr)]:
                try:
                    (report / (call["label"] + "." + suffix + ".bin")).write_bytes(raw)
                except OSError as issue:
                    finalization.append({"stage": suffix + "_write", "type": type(issue).__name__, "message": str(issue)[:512]})
                    if primary is None:
                        primary = {"kind": "artifact_write", "label": call["label"]}
            (report / "observations.json").write_text(json.dumps(observations, indent=2) + "\n", encoding="utf-8", newline="\n")
            if primary is not None:
                break
            if index < 2:
                verify_shared_output(result.stdout)
            elif not strict_equal(one_json_line(result.stdout), expected if index == 2 else expected_example):
                raise AssertionError("Complete typed/key-strict expected output differs")
            observation["accepted"] = True
            (report / "observations.json").write_text(json.dumps(observations, indent=2) + "\n", encoding="utf-8", newline="\n")
    except BaseException as issue:
        if primary is None:
            primary = {"kind": "adapter_or_acceptance", "type": type(issue).__name__, "message": str(issue)[:512]}
        else:
            finalization.append({"stage": "secondary_adapter", "type": type(issue).__name__, "message": str(issue)[:512]})
        if isinstance(issue, (KeyboardInterrupt, SystemExit)):
            interruption = issue
    finally:
        for name, path in paths.items():
            try:
                if file_identity(path, 1048576, True) != identities[name]:
                    raise ValueError("Executed source identity changed")
            except Exception as issue:
                finalization.append({"stage": "post_source_" + name, "type": type(issue).__name__, "message": str(issue)[:512]})
        for name, path, identity in [("native", binary, native_identity), ("host", Path(sys.executable).resolve(), host_identity)]:
            try:
                if file_identity(path, 67108864) != identity:
                    raise ValueError("Explicit executable identity changed")
            except Exception as issue:
                finalization.append({"stage": "post_" + name, "type": type(issue).__name__, "message": str(issue)[:512]})
        passed = primary is None and not finalization and len(observations) == 4 and all(row.get("accepted") is True for row in observations)
        record = {"schema": "sprout.decision-public-ci-result.v1", "passed": passed, "helper_invocations_reserved": len(observations),
                  "primary_error": primary, "finalization_errors": finalization, "observations": observations, "retries": 0,
                  "SDK_compiler_calls": 0, "qualification": "Finite pure synthetic decisions only; no sustained/production claim"}
        try:
            (report / "result.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8", newline="\n")
        except OSError as issue:
            passed = False
            print(json.dumps({"passed": False, "primary_error": primary, "result_write_error": str(issue)[:512]}), file=sys.stderr)
    if interruption is not None:
        raise interruption
    if not passed:
        raise AssertionError("First native failure preserved in " + str(report))
    (report / "passed.json").write_text('{"passed":true,"native_calls":4}\n', encoding="utf-8", newline="\n")
    return observations


def main(arguments=None, *, run_tests=True):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", nargs="?", type=Path, help="Explicit trusted binary selects four native CI payloads")
    parser.add_argument("--report-dir", type=Path, help="New exclusive retained report directory, only with a binary")
    args = parser.parse_args(sys.argv[1:] if arguments is None else arguments)
    if args.binary is not None:
        native_ci_checks(args.binary, args.report_dir)
        return 0
    if args.report_dir is not None:
        raise ValueError("Report directory requires an explicit binary")
    if not run_tests:
        return 0
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SourceOracleTests)
    result = unittest.TextTestRunner(verbosity=2, failfast=True).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
