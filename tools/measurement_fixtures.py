"""Finite synthetic N007 fixtures and independent semantic output models."""
import copy
import json

PURE_IDS = ('V1', 'V64', 'V512', 'Verrors', 'Csmall', 'Cmedium', 'Clarge',
            'Aselect1', 'Aselect32', 'Aresult2K', 'Aresult32K', 'P1', 'P128')
SDK_IDS = ('Hmin', 'Hecho16K', 'HpreviewValid', 'HpreviewInvalid')
SCHEMA = {'kind': 'map', 'fields': {'id': {'kind': 'integer'}, 'amount': {'kind': 'decimal'},
          'enabled': {'kind': 'yes-no'}, 'name': {'kind': 'text', 'min_length': 16, 'max_length': 16},
          'tags': {'kind': 'list', 'min_length': 3, 'max_length': 3, 'items': {'kind': 'text'}}}}


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def integer(value):
    return {'$sprout.integer': str(value)}


def decimal(value='0.10'):
    return {'$sprout.decimal': value}


def native_nodes(value):
    if type(value) is dict:
        if len(value) == 1 and next(iter(value)) in ('$sprout.integer', '$sprout.decimal'):
            return 1
        return 1 + sum(native_nodes(item) for item in value.values())
    if type(value) is list:
        return 1 + sum(native_nodes(item) for item in value)
    return 1


def strict_equal(actual, expected):
    if type(actual) is not type(expected):
        return False
    if type(expected) is dict:
        return actual.keys() == expected.keys() and all(strict_equal(actual[key], value) for key, value in expected.items())
    if type(expected) is list:
        return len(actual) == len(expected) and all(strict_equal(a, b) for a, b in zip(actual, expected))
    return actual == expected


def _record(index):
    return {'id': integer(9223372036854775807 - index), 'amount': decimal(), 'enabled': bool(index % 2),
            'name': 'Zoë🌱李雷' + '-' * 10, 'tags': ['a', 'b', 'c']}


def _filled(value, keys, physical_bytes, newline=2):
    result = copy.deepcopy(value)
    parent = result
    for key in keys[:-1]: parent = parent[key]
    initial = physical_bytes - newline - len(compact(result))
    if initial < 0: raise ValueError('Synthetic target is too short')
    parent[keys[-1]] += 'x' * initial
    assert len(compact(result)) + newline == physical_bytes
    return result


def _validation(count, errors=False):
    values = [_record(index) for index in range(count)]
    if errors:
        for record in values:
            record.update(id='wrong', amount=10, enabled='wrong', name=1, tags=[False] * 3)
        possible = []
        for index in range(count):
            for field, kind in [('id', 'integer'), ('amount', 'decimal'), ('enabled', 'yes-no'), ('name', 'text')]:
                possible.append({'path': [index, field], 'code': 'kind', 'message': 'Expected ' + kind + '.'})
            for tag in range(3):
                possible.append({'path': [index, 'tags', tag], 'code': 'kind', 'message': 'Expected text.'})
        expected = {'ok': False, 'errors': possible[:64], 'schema_error': None, 'truncated': True}
    else:
        expected = {'ok': True, 'errors': [], 'schema_error': None, 'truncated': False}
    return {'inputs': [values[0] if count == 1 else values,
                       SCHEMA if count == 1 else {'kind': 'list', 'items': SCHEMA}], 'expected': expected,
            'structural_nodes': 9 if count == 1 else 1 + 9 * count}


def _configuration(size, layers):
    def setting(index, label):
        return {'id': integer(9223372036854775807 - index), 'amount': decimal(), 'enabled': bool(index % 2), 'label': label}
    fields = {f'key{index:03}': {'kind': 'map', 'fields': {'id': {'kind': 'integer'},
              'amount': {'kind': 'decimal'}, 'enabled': {'kind': 'yes-no'}, 'label': {'kind': 'text'}}}
              for index in range(size)}
    defaults = {key: setting(index, 'default') for index, key in enumerate(fields)}
    files = [{'name': f'layer-{layer:02}', 'values': {key: setting(index, f'file-{layer:02}')
             for index, key in enumerate(fields) if index and index % 4 != layer % 4}} for layer in range(layers)]
    cli = {key: setting(index, 'cli') for index, key in enumerate(fields) if index % 4 == 3}
    values = copy.deepcopy(defaults)
    provenance = {key: {'source': 'defaults', 'index': None, 'name': None} for key in defaults}
    for index, item in enumerate(files):
        for key, value in item['values'].items():
            values[key] = copy.deepcopy(value)
            provenance[key] = {'source': 'file', 'index': index, 'name': item['name']}
    for key, value in cli.items():
        values[key] = copy.deepcopy(value); provenance[key] = {'source': 'cli', 'index': None, 'name': None}
    return {'inputs': [defaults, {'kind': 'map', 'fields': fields}, files, cli],
            'expected': {'ok': True, 'values': values, 'provenance': provenance, 'errors': [], 'truncated': False},
            'copied_occurrences': sum(native_nodes(item) for item in [defaults, *(layer['values'] for layer in files), cli]),
            'schema_nodes': 1 + 5 * size}


def _selection(count):
    body = _filled({'id': integer(9223372036854775807), 'amount': decimal(), 'text': 'Zoë🌱李雷'}, ['text'], 1024, 0)
    query = {'kind': 'map', 'fields': {'q': {'kind': 'list', 'items': {'kind': 'text'}}}}
    body_schema = {'kind': 'map', 'fields': {'id': {'kind': 'integer'}, 'amount': {'kind': 'decimal'}, 'text': {'kind': 'text'}}}
    routes = [{'id': f'route_{index:02}', 'method': 'POST', 'path': f'/route-{index:02}',
               'query': copy.deepcopy(query), 'body': copy.deepcopy(body_schema)} for index in range(count)]
    request = {'method': 'POST', 'path': routes[-1]['path'], 'query': {'q': ['one', 'two']}, 'body': body}
    return {'inputs': [request, routes], 'expected': {'ok': True, 'route': routes[-1]['id'], 'error': None, 'response': None}}


def _response(size):
    dto = _filled({'status': 200, 'headers': {'Cache-Control': 'no-store', 'X-Shape': 'synthetic'},
                   'body': {'id': integer(9223372036854775807), 'amount': decimal(), 'enabled': True,
                            'text': 'Zoë🌱李雷\n"\\'}}, ['body', 'text'], size)
    return {'inputs': [dto['status'], dto['body'], dto['headers']],
            'expected': {'ok': True, 'error': None, 'response': dto}, 'dto_physical_reserved_bytes': size}


def _progress(count):
    statuses = ['done'] if count == 1 else ['pending', 'running', 'done', 'failed'] * 32
    attempts = [3] if count == 1 else [0 if status == 'pending' else index % 7 + 1 for index, status in enumerate(statuses)]
    counts = {status: statuses.count(status) for status in ('pending', 'running', 'done', 'failed')}
    complete = counts['done'] == count
    expected_hash = 'a' * 64 if count == 1 else 'b' * 64
    data = {'ok': True, 'error': None, 'code': 'ok', 'version': 1, 'fingerprint': 'a' * 64, 'count': count,
            'complete': complete, 'counts': counts, 'jobs': [{'id': f'synthetic-{index:03}', 'status': status,
                'attempts': integer(attempts[index])} for index, status in enumerate(statuses)]}
    state = 'uncertain' if counts['running'] else 'failed' if counts['failed'] else 'complete' if complete else 'partial' if counts['done'] else 'pending'
    expected = {'ok': True, 'code': 'ok', 'error': None, 'state': state, 'fingerprint': 'a' * 64,
                'expected_matches': count == 1, 'count': count, 'counts': counts,
                'recorded_complete': complete, 'attempts_total': integer(sum(attempts))}
    return {'inputs': [data, expected_hash], 'expected': expected}


def fixtures():
    definitions = [
        ('V1', 'validate.check', 'validate.sprout', 8, _validation(1)),
        ('V64', 'validate.check', 'validate.sprout', 8, _validation(64)),
        ('V512', 'validate.check', 'validate.sprout', 4, _validation(512)),
        ('Verrors', 'validate.check', 'validate.sprout', 8, _validation(64, True)),
        ('Csmall', 'config.resolve', 'config.sprout', 8, _configuration(16, 1)),
        ('Cmedium', 'config.resolve', 'config.sprout', 8, _configuration(32, 4)),
        ('Clarge', 'config.resolve', 'config.sprout', 4, _configuration(128, 16)),
        ('Aselect1', 'api.select', 'api.sprout', 8, _selection(1)),
        ('Aselect32', 'api.select', 'api.sprout', 4, _selection(32)),
        ('Aresult2K', 'api.result', 'api.sprout', 8, _response(2048)),
        ('Aresult32K', 'api.result', 'api.sprout', 4, _response(32768)),
        ('P1', 'workflow_progress.summarize', 'workflow_progress.sprout', 8, _progress(1)),
        ('P128', 'workflow_progress.summarize', 'workflow_progress.sprout', 8, _progress(128))]
    return {identifier: dict(value, id=identifier, operation=operation, library=library, batch=batch)
            for identifier, operation, library, batch, value in definitions}


def sdk_fixtures():
    echo = _filled({'id': integer(9223372036854775807), 'amount': decimal(), 'text': 'Zoë🌱李雷'}, ['text'], 16384, 1)
    preview = {'method': 'POST', 'path': '/contacts/preview', 'query': {}, 'body': {'name': 'Zoë 🌱', 'email': 'synthetic@example.test'}}
    invalid = copy.deepcopy(preview); invalid['body']['synthetic-extra'] = 'never-echo'
    return {'Hmin': {'input': {}, 'expected': {'ok': True}, 'sandbox': True},
            'Hecho16K': {'input': echo, 'expected': echo, 'sandbox': True},
            'HpreviewValid': {'input': preview, 'expected': {'status': 200, 'headers': {}, 'body':
                {'valid': True, 'persisted': False, 'contact': copy.deepcopy(preview['body'])}}, 'sandbox': False},
            'HpreviewInvalid': {'input': invalid, 'expected': {'status': 400, 'headers': {'Cache-Control': 'no-store'},
                'body': {'error': 'invalid_request'}}, 'sandbox': False}}


def schedule():
    rows = [{'kind': 'prepared', 'id': case, 'sample': None, 'mode': mode, 'warmup': True}
            for case in PURE_IDS for mode in ('full', 'control')]
    for sample in range(5):
        order = ('full', 'control') if sample % 2 == 0 else ('control', 'full')
        rows.extend({'kind': 'prepared', 'id': case, 'sample': sample, 'mode': mode, 'warmup': False}
                    for case in PURE_IDS for mode in order)
    rows.extend({'kind': 'sdk', 'sdk': sdk, 'id': case, 'sample': None, 'warmup': True}
                for sdk in ('python', 'node') for case in SDK_IDS)
    rows.extend({'kind': 'sdk', 'sdk': sdk, 'id': case, 'sample': sample, 'warmup': False}
                for sample in range(5) for sdk in ('python', 'node') for case in SDK_IDS)
    assert len(rows) == 204
    return rows


def prepared_source(fixture, mode):
    value = {'inputs': fixture['inputs'], 'expected': fixture['expected']}
    data = json.dumps(compact(value).decode('utf-8'), ensure_ascii=False)
    operation = fixture['operation'] + '(' + ', '.join(f'fixture.inputs[{index}]' for index in range(len(fixture['inputs']))) + ')'
    operation = operation if mode == 'full' else 'fixture.expected'
    return ('use "../git/lib/' + fixture['library'] + '"\nmake fixture = builtin::json_decode(' + data + ')\n'
            'make original = builtin::json_encode(fixture)\n'
            'when builtin::ask("READY\\n") != "GO":\n    builtin::exit(91)\nmake sink = nothing\n'
            f'repeat {fixture["batch"]} times:\n    set sink = {operation}\n'
            'when builtin::ask("DONE\\n") != "ACK":\n    builtin::exit(92)\n'
            'show builtin::json_encode({result: sink, unchanged: builtin::json_encode(fixture) == original})\n')
