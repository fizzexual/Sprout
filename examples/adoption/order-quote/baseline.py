"""Synthetic prior Python rules, authored here; int/Decimal only for amounts."""
from decimal import Decimal, ROUND_HALF_UP, localcontext
import json
import math
import re
import sys

ID = re.compile(r'[1-9][0-9]{0,18}\Z')
PRICE = re.compile(r'(?:0|[1-9][0-9]*)\.[0-9]{2}\Z')
TAGS = {'$sprout.integer', '$sprout.decimal', '$sprout.bytes'}


def _map(value):
    return type(value) is dict and not (len(value) == 1 and next(iter(value)) in TAGS)


def _schema(request):
    errors = []
    truncated = False

    def reject(path):
        nonlocal truncated
        if len(errors) < 64:
            errors.append({'path': path, 'code': 'validation',
                           'message': 'Input does not match the declared field schema.'})
        else:
            truncated = True

    def text(value, path, minimum=0, maximum=1048576, allowed=None):
        if type(value) is not str:
            reject(path); return
        if allowed is not None and value not in allowed:
            reject(path)
        if not minimum <= len(value) <= maximum:
            reject(path)

    def record(value, path, fields):
        if not _map(value) or len(value) > 128:
            reject(path); return
        for key, check in fields:
            if truncated:
                return
            if key not in value:
                reject(path + [key])
            else:
                check(value[key], path + [key])
        known = {key for key, _ in fields}
        for key in value:
            if truncated:
                return
            if key not in known:
                reject(path + ['<unknown>'])

    def quantity(value, path):
        # The request field is an ordinary finite number, never bool/Decimal/tag.
        if not ((type(value) is int and abs(value) <= 9007199254740991) or
                (type(value) is float and math.isfinite(value))):
            reject(path)

    def member(value, path):
        if type(value) is not bool:
            reject(path)

    def lines(value, path):
        if type(value) is not list or len(value) > 10000:
            reject(path); return
        if not 1 <= len(value) <= 32:
            reject(path)
        for index, line in enumerate(value):
            if truncated:
                return
            record(line, path + [index], [
                ('sku_id', lambda v, p: text(v, p, 1, 19)),
                ('quantity', quantity), ('unit_price', lambda v, p: text(v, p, 4, 10))])

    record(request, [], [
        ('order_id', lambda v, p: text(v, p, 1, 19)),
        ('currency', lambda v, p: text(v, p, allowed={'USD'})), ('member', member),
        ('shipping', lambda v, p: text(v, p, allowed={'standard', 'express'})), ('lines', lines)])
    return errors, truncated


def _evaluate(request):
    result = {'ok': False, 'quote': None, 'decisions': [], 'errors': [], 'truncated': False}
    errors, truncated = _schema(request)
    if errors or truncated:
        result['errors'] = errors[:16]
        result['truncated'] = truncated or len(errors) > 16
        return result

    def reject(path, code, message):
        if len(result['errors']) < 16:
            result['errors'].append({'path': path, 'code': code, 'message': message})
        else:
            result['truncated'] = True

    def identifier(value, path):
        if not ID.fullmatch(value):
            reject(path, 'id_format', 'ID requires canonical positive decimal digits without a sign or leading zeros.')
        elif int(value) > 9223372036854775807:
            reject(path, 'id_range', 'ID exceeds the positive signed-int64 range.')
        else:
            return int(value)

    order_id = identifier(request['order_id'], ['order_id'])
    seen, lines, gross, units = set(), [], Decimal('0.00'), 0
    for index, line in enumerate(request['lines']):
        sku = identifier(line['sku_id'], ['lines', index, 'sku_id'])
        if sku is not None:
            if sku in seen:
                reject(['lines', index, 'sku_id'], 'duplicate_sku', 'SKU must be unique within the basket.')
            seen.add(sku)
        quantity = line['quantity']
        valid_quantity = 1 <= quantity <= 1000 and quantity == int(quantity)
        if not valid_quantity:
            reject(['lines', index, 'quantity'], 'quantity_range', 'Quantity requires a whole ordinary number from 1 to 1000.')
        price = None
        if not PRICE.fullmatch(line['unit_price']):
            reject(['lines', index, 'unit_price'], 'price_format', 'Price requires canonical nonnegative decimal text with exactly two fractional digits.')
        elif Decimal(line['unit_price']) > Decimal('1000000.00'):
            reject(['lines', index, 'unit_price'], 'price_range', 'Unit price exceeds 1000000.00 USD.')
        else:
            price = Decimal(line['unit_price'])
        if sku is not None and valid_quantity and price is not None:
            amount = price * int(quantity)
            units += int(quantity); gross += amount
            lines.append({'sku_id': sku, 'quantity': int(quantity), 'unit_price': price, 'gross': amount})
    if result['errors']:
        return result

    # Independent Decimal calculation: no port of Sprout's remainder division.
    offers = [('high_value', gross >= Decimal('500.00'), 1000),
              ('value', gross >= Decimal('200.00'), 750), ('bulk', units >= 20, 750),
              ('member', request['member'], 500)]
    eligible = [(rate, -index, rule) for index, (rule, allowed, rate) in enumerate(offers) if allowed]
    rate, _, selected = max(eligible, default=(0, 0, 'none'))
    discount = (gross * Decimal(rate) / Decimal(10000)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    net = gross - discount
    if request['shipping'] == 'express':
        shipping, shipping_rule = Decimal('14.99'), 'express_fixed'
    elif net >= Decimal('100.00'):
        shipping, shipping_rule = Decimal('0.00'), 'standard_free'
    else:
        shipping, shipping_rule = Decimal('4.99'), 'standard_paid'
    decisions = [{'rule': rule, 'eligible': allowed, 'rate_bps': offer_rate, 'selected': rule == selected}
                 for rule, allowed, offer_rate in offers]
    decisions += [{'rule': 'discount', 'code': selected, 'rate_bps': rate, 'rounding': 'half_up_once'},
                  {'rule': 'shipping', 'code': shipping_rule}]
    return {'ok': True, 'quote': {'order_id': order_id, 'currency': 'USD', 'lines': lines, 'units': units,
            'gross': gross, 'discount': discount, 'net': net, 'shipping': shipping, 'total': net + shipping},
            'decisions': decisions, 'errors': [], 'truncated': False}


def evaluate(request):
    with localcontext() as context:
        context.prec = 28
        return _evaluate(request)


def semantic(result):
    """Require exact host types, then compare decimal amounts as integral cents."""
    def integer(value):
        if type(value) is not int:
            raise TypeError('Expected an exact integer')
        return str(value)

    def money(value):
        if type(value) is not Decimal or not value.is_finite() or value * 100 != (value * 100).to_integral_value():
            raise TypeError('Expected exact integral cents')
        return str(int(value * 100))

    if not result['ok']:
        return result
    quote = result['quote']
    converted = {key: money(quote[key]) for key in ('gross', 'discount', 'net', 'shipping', 'total')}
    converted.update(order_id=integer(quote['order_id']), currency=quote['currency'], units=integer(quote['units']),
        lines=[{'sku_id': integer(line['sku_id']), 'quantity': integer(line['quantity']),
                'unit_price': money(line['unit_price']), 'gross': money(line['gross'])} for line in quote['lines']])
    decisions = [dict(decision, **({'rate_bps': integer(decision['rate_bps'])} if 'rate_bps' in decision else {}))
                 for decision in result['decisions']]
    return dict(result, quote=converted, decisions=decisions)


if __name__ == '__main__':
    print(json.dumps(semantic(evaluate(json.load(sys.stdin))), separators=(',', ':')))
