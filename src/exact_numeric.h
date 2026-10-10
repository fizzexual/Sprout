/* Explicit exact numbers preserve the existing floating-point `number` contract.
 * Signed 64-bit coefficient, up to 18 decimal places; overflow is an error.
 * GCC/Clang's 128-bit intermediate avoids undefined signed overflow. */
static Value vexact(int64_t coefficient, int scale, int decimal) {
  Value v = {0}; v.type = decimal ? V_DECIMAL : V_INT;
  v.exact = coefficient; v.scale = scale;
  v.num = (double)coefficient / pow(10.0, scale); return v;
}
static __int128 exact_pow10(int scale) {
  __int128 n = 1; while (scale-- > 0) n *= 10; return n;
}
static Value exact_checked(__int128 n, int scale, int decimal, int line) {
  while (scale > 0 && n % 10 == 0) { n /= 10; scale--; }
  if (scale > 18 || n > INT64_MAX || n < INT64_MIN)
    fail_kind(line, "math", "exact arithmetic overflowed its signed 64-bit coefficient or 18 decimal places.");
  return vexact((int64_t)n, scale, decimal);
}
static Value exact_operand(Value v, int line) {
  if (is_exact(v)) return v;
  if (v.type == V_NUM && isfinite(v.num) && v.num == floor(v.num) && fabs(v.num) <= 9007199254740991.0)
    return vexact((int64_t)v.num, 0, 0);
  fail_kind(line, "type", "exact arithmetic needs integers or decimals; construct fractions from text with decimal(\"0.25\").");
  return vnone();
}
static Value exact_parse(const char *text, int decimal, int line) {
  const char *p = text; int negative = 0, scale = 0, dot = 0, digits = 0;
  __int128 n = 0, limit;
  if (*p == '-' || *p == '+') { negative = *p == '-'; p++; }
  limit = (__int128)INT64_MAX + negative;
  for (; *p; p++) {
    if (*p == '.' && decimal && !dot && digits) { dot = 1; continue; }
    if (*p < '0' || *p > '9') fail_kind(line, "type", "an exact number needs decimal digits, an optional sign, and one decimal point.");
    if (dot && ++scale > 18) fail_kind(line, "math", "a decimal supports at most 18 fractional places.");
    digits++; n = n * 10 + (*p - '0');
    if (n > limit) fail_kind(line, "math", "that exact number exceeds a signed 64-bit coefficient.");
  }
  if (!digits || (dot && (!scale || text[0] == '.'))) fail_kind(line, "type", "that exact number is missing digits.");
  return vexact((int64_t)(negative ? -n : n), scale, decimal);
}
static char *exact_to_str(Value v) {
  char digits[32], out[80];
  uint64_t magnitude = v.exact < 0 ? (uint64_t)(-(v.exact + 1)) + 1 : (uint64_t)v.exact;
  snprintf(digits, sizeof digits, "%" PRIu64, magnitude);
  size_t count = strlen(digits), at = 0;
  if (v.exact < 0) out[at++] = '-';
  if (!v.scale) { strcpy(out + at, digits); return dup_str(out); }
  if ((int)count <= v.scale) {
    out[at++] = '0'; out[at++] = '.';
    for (int i = 0; i < v.scale - (int)count; i++) out[at++] = '0';
    memcpy(out + at, digits, count); at += count;
  } else {
    size_t whole = count - v.scale;
    memcpy(out + at, digits, whole); at += whole; out[at++] = '.';
    memcpy(out + at, digits + whole, v.scale); at += v.scale;
  }
  out[at] = 0; return dup_str(out);
}
static int exact_compare(Value a, Value b, int line) {
  a = exact_operand(a, line); b = exact_operand(b, line);
  int scale = a.scale > b.scale ? a.scale : b.scale;
  __int128 x = (__int128)a.exact * exact_pow10(scale - a.scale);
  __int128 y = (__int128)b.exact * exact_pow10(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}
static Value exact_arithmetic(char op, Value a, Value b, int line) {
  a = exact_operand(a, line); b = exact_operand(b, line);
  int decimal = a.type == V_DECIMAL || b.type == V_DECIMAL;
  int scale = a.scale > b.scale ? a.scale : b.scale;
  __int128 x = (__int128)a.exact * exact_pow10(scale - a.scale);
  __int128 y = (__int128)b.exact * exact_pow10(scale - b.scale);
  if (op == '+') return exact_checked(x + y, scale, decimal, line);
  if (op == '-') return exact_checked(x - y, scale, decimal, line);
  if (op == '*') return exact_checked((__int128)a.exact * b.exact, a.scale + b.scale, decimal, line);
  if (!y) fail_kind(line, "math", "you tried exact division or remainder with zero.");
  if (op == '%') return exact_checked(x % y, scale, decimal, line);
  /* `/` is exact: callers choose truncation explicitly with decimal_div. */
  if (x % y) fail_kind(line, "math", "this exact division has a fractional result; use decimal_div(a, b, places) to choose precision.");
  return exact_checked(x / y, 0, decimal, line);
}
static int exact_builtin_name(const char *name) {
  return !strcmp(name, "integer") || !strcmp(name, "decimal") || !strcmp(name, "decimal_div");
}
static int exact_builtin(const char *name, int n, Value *a, int line, Value *out) {
  if (!strcmp(name, "number") && n == 1 && is_exact(a[0])) { *out = vnum(a[0].num); return 1; }
  if (!exact_builtin_name(name)) return 0;
  if (!strcmp(name, "decimal_div")) {
    if (n != 3) arity_error(line, name, "two exact numbers and fractional places", n);
    Value x = exact_operand(a[0], line), y = exact_operand(a[1], line);
    double precision = want_num(line, name, 3, a[2], "decimal_div(decimal(\"1\"), decimal(\"3\"), 6)");
    if (!isfinite(precision) || precision < 0 || precision > 18 || precision != floor(precision)) fail_kind(line, "type", "decimal_div places must be a whole number from 0 to 18.");
    int places = (int)precision;
    if (!y.exact) fail_kind(line, "math", "you tried to divide by zero.");
    int shift = y.scale + places - x.scale;
    __int128 numerator = x.exact, denominator = y.exact;
    if (shift > 18) fail_kind(line, "math", "decimal_div intermediate precision exceeds 18 places.");
    if (shift >= 0) numerator *= exact_pow10(shift); else denominator *= exact_pow10(-shift);
    *out = exact_checked(numerator / denominator, places, 1, line); return 1;
  }
  if (n != 1) arity_error(line, name, "one text value or exact number", n);
  int decimal = !strcmp(name, "decimal");
  if (a[0].type == V_STR) { *out = exact_parse(a[0].str, decimal, line); return 1; }
  Value v = exact_operand(a[0], line);
  if (!decimal && v.scale) fail_kind(line, "type", "integer cannot silently discard fractional places.");
  *out = vexact(v.exact, v.scale, decimal); return 1;
}
