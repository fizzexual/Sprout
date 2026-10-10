/* Binary buffers are distinct from UTF-8 text and can contain embedded NUL. */
static char *bytes_to_hex(Value v) {
  const char *digits = "0123456789abcdef";
  char *out = malloc(v.length * 2 + 1);
  if (!out) fail_kind(0, "memory", "could not encode byte buffer.");
  for (size_t i = 0; i < v.length; i++) { unsigned char c = (unsigned char)v.str[i]; out[i * 2] = digits[c >> 4]; out[i * 2 + 1] = digits[c & 15]; }
  out[v.length * 2] = 0; return out;
}
static int bytes_hex_digit(unsigned char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
static Value bytes_from_hex(const char *text, int line) {
  size_t n = strlen(text);
  if (n % 2 || n > 33554432) fail_kind(line, "data", "hex bytes need complete byte pairs and at most 16 MiB.");
  Value v = vbytes(NULL, 0); v.length = n / 2; v.str = gc_alloc(GC_STR, v.length + 1);
  for (size_t i = 0; i < v.length; i++) {
    int hi = bytes_hex_digit((unsigned char)text[i * 2]), lo = bytes_hex_digit((unsigned char)text[i * 2 + 1]);
    if (hi < 0 || lo < 0) fail_kind(line, "data", "hex bytes contain a character outside 0-9 and a-f.");
    v.str[i] = (char)((hi << 4) | lo);
  }
  v.str[v.length] = 0; return v;
}
static int bytes_builtin_name(const char *name) {
  return !strcmp(name, "bytes") || !strcmp(name, "bytes_hex") || !strcmp(name, "bytes_from_hex") || !strcmp(name, "bytes_text") || !strcmp(name, "bytes_list");
}
static int bytes_valid_utf8(const unsigned char *p, size_t n) {
  for (size_t i = 0; i < n;) {
    unsigned c = p[i++]; if (!c) return 0; if (c < 128) continue;
    int extra; unsigned cp;
    if (c >= 0xc2 && c <= 0xdf) { extra = 1; cp = c & 31; }
    else if (c >= 0xe0 && c <= 0xef) { extra = 2; cp = c & 15; }
    else if (c >= 0xf0 && c <= 0xf4) { extra = 3; cp = c & 7; }
    else return 0;
    if (i + extra > n) return 0;
    for (int k = 0; k < extra; k++) { c = p[i++]; if ((c & 0xc0) != 0x80) return 0; cp = (cp << 6) | (c & 63); }
    if ((extra == 1 && cp < 128) || (extra == 2 && cp < 2048) || (extra == 3 && cp < 65536) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return 0;
  }
  return 1;
}
static int bytes_builtin(const char *name, int n, Value *a, int line, Value *out) {
  if (!bytes_builtin_name(name)) return 0;
  if (n != 1) arity_error(line, name, "one value", n);
  if (!strcmp(name, "bytes_from_hex")) { want_str(line, name, 1, a[0], "bytes_from_hex(\"00ff\")"); *out = bytes_from_hex(a[0].str, line); return 1; }
  if (!strcmp(name, "bytes")) {
    if (a[0].type == V_STR) { size_t size = strlen(a[0].str); if (size > 16777216) fail_kind(line, "limit", "a byte buffer is limited to 16 MiB."); *out = vbytes((unsigned char *)a[0].str, size); return 1; }
    if (a[0].type == V_LIST) {
      SList *l = a[0].list; if (l->n > 16777216) fail_kind(line, "limit", "a byte buffer is limited to 16 MiB.");
      unsigned char *data = malloc((size_t)l->n + 1); if (!data) fail_kind(line, "memory", "could not allocate byte buffer.");
      for (int i = 0; i < l->n; i++) {
        Value v = l->items[i]; double x = v.type == V_INT ? (double)v.exact : v.num;
        if ((v.type != V_NUM && v.type != V_INT) || x != floor(x) || x < 0 || x > 255) { free(data); fail_kind(line, "type", "bytes(list) needs whole byte values from 0 to 255."); }
        data[i] = (unsigned char)x;
      }
      *out = vbytes(data, (size_t)l->n); free(data); return 1;
    }
  }
  if (a[0].type != V_BYTES) arg_error(line, name, 1, "bytes", a[0], "bytes([0, 255])");
  if (!strcmp(name, "bytes") ) *out = vbytes((unsigned char *)a[0].str, a[0].length);
  else if (!strcmp(name, "bytes_hex")) *out = vstr_take(bytes_to_hex(a[0]));
  else if (!strcmp(name, "bytes_text")) {
    if (!bytes_valid_utf8((unsigned char *)a[0].str, a[0].length)) fail_kind(line, "data", "bytes_text needs valid UTF-8 without embedded NUL.");
    *out = vstr(a[0].str);
  } else {
    SList *l = list_new(); for (size_t i = 0; i < a[0].length; i++) list_push(l, vnum((unsigned char)a[0].str[i])); *out = vlist(l);
  }
  return 1;
}
