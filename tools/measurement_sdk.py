"""Python SDK stopwatch boundary; input preparation/oracle checks are separate."""
from decimal import Decimal
import sys
import types
import math
from pathlib import Path


def load_sdk(root):
    from measure_workloads import bounded_file, INPUT_BOUNDS
    source = Path(root) / 'git/integrations/python/sprout_host.py'
    module = types.ModuleType('n007_frozen_sprout_host'); module.__file__ = str(source)
    sys.modules[module.__name__] = module
    exec(compile(bounded_file(source, INPUT_BOUNDS['source_file_bytes'], True)[1], str(source), 'exec'), module.__dict__)
    return module


def typed_equal(actual, wire):
    if type(wire) is dict:
        if len(wire) == 1 and '$sprout.integer' in wire:
            return type(actual) is int and actual == int(wire['$sprout.integer'])
        if len(wire) == 1 and '$sprout.decimal' in wire:
            expected = Decimal(wire['$sprout.decimal'])
            return type(actual) is Decimal and actual == expected and actual.as_tuple().exponent == expected.as_tuple().exponent
        return type(actual) is dict and actual.keys() == wire.keys() and all(typed_equal(actual[key], value) for key, value in wire.items())
    if type(wire) is list:
        return type(actual) is list and len(actual) == len(wire) and all(typed_equal(a, b) for a, b in zip(actual, wire))
    if type(wire) in (int, float):
        return type(actual) in (int, float) and math.isfinite(actual) and actual == wire
    return type(actual) is type(wire) and actual == wire


def one_call(run, program, value, options, clock):
    # The caller already constructed/restored value. No oracle comparison here.
    start = clock.now()
    try: result = run(program, value, **options)
    except BaseException as error:
        error.n007_start_ns = start
        raise
    try: end = clock.now()
    except BaseException as error:
        error.n007_start_ns = start
        error.n007_result_available = True
        raise
    return result, start, end
