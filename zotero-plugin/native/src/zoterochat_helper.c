#define _DARWIN_C_SOURCE 1

#include <arpa/inet.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#include <util.h>

#define ZC_VERSION "0.2.1"
#define MAX_CLIENTS 16
#define MAX_SESSIONS 32
#define MAX_HTTP 16384
#define MAX_WS_MESSAGE (1024U * 1024U)
#define MAX_JSON_TOKENS 2048
#define MAX_SESSIONS_PER_CLIENT 8
#define MAX_ARGV 64
#define MAX_ENV 64
#define MAX_OUTPUT_CHUNK 8192
#define MAX_INPUT_MESSAGE (64U * 1024U)
#define MAX_PENDING_INPUT (256U * 1024U)
#define MAX_MCP_LINE (1024U * 1024U)
#define MAX_CONTEXT_FILE (1024U * 1024U)
#define MAX_ZOTKIT_SNAPSHOT_FILE (64U * 1024U * 1024U)
#define MAX_ZOTKIT_SNAPSHOT_LINE (1024U * 1024U)
#define MAX_LIBRARY_RESULTS 500
#define MAX_LIBRARY_SCANNED 100000

typedef struct {
  char *data;
  size_t len;
  size_t cap;
} StrBuf;

static bool sb_reserve(StrBuf *sb, size_t extra) {
  if (extra > SIZE_MAX - sb->len - 1)
    return false;
  size_t need = sb->len + extra + 1;
  if (need <= sb->cap)
    return true;
  size_t cap = sb->cap ? sb->cap : 256;
  while (cap < need) {
    if (cap > SIZE_MAX / 2) {
      cap = need;
      break;
    }
    cap *= 2;
  }
  char *p = realloc(sb->data, cap);
  if (!p)
    return false;
  sb->data = p;
  sb->cap = cap;
  return true;
}

static bool sb_append_n(StrBuf *sb, const void *data, size_t n) {
  if (!sb_reserve(sb, n))
    return false;
  if (n)
    memcpy(sb->data + sb->len, data, n);
  sb->len += n;
  sb->data[sb->len] = '\0';
  return true;
}

static bool sb_append(StrBuf *sb, const char *s) {
  return sb_append_n(sb, s, strlen(s));
}

static bool sb_printf(StrBuf *sb, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  va_list copy;
  va_copy(copy, ap);
  int n = vsnprintf(NULL, 0, fmt, copy);
  va_end(copy);
  if (n < 0 || !sb_reserve(sb, (size_t)n)) {
    va_end(ap);
    return false;
  }
  vsnprintf(sb->data + sb->len, sb->cap - sb->len, fmt, ap);
  va_end(ap);
  sb->len += (size_t)n;
  return true;
}

static bool sb_json_string_n(StrBuf *sb, const char *s, size_t n) {
  if (!sb_append_n(sb, "\"", 1))
    return false;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    switch (c) {
    case '"':
      if (!sb_append(sb, "\\\""))
        return false;
      break;
    case '\\':
      if (!sb_append(sb, "\\\\"))
        return false;
      break;
    case '\b':
      if (!sb_append(sb, "\\b"))
        return false;
      break;
    case '\f':
      if (!sb_append(sb, "\\f"))
        return false;
      break;
    case '\n':
      if (!sb_append(sb, "\\n"))
        return false;
      break;
    case '\r':
      if (!sb_append(sb, "\\r"))
        return false;
      break;
    case '\t':
      if (!sb_append(sb, "\\t"))
        return false;
      break;
    default:
      if (c < 0x20) {
        if (!sb_printf(sb, "\\u%04x", c))
          return false;
      } else if (!sb_append_n(sb, &s[i], 1))
        return false;
    }
  }
  return sb_append_n(sb, "\"", 1);
}

static bool sb_json_string(StrBuf *sb, const char *s) {
  return sb_json_string_n(sb, s, strlen(s));
}

static void sb_free(StrBuf *sb) {
  free(sb->data);
  memset(sb, 0, sizeof(*sb));
}

/* Small, strict JSON tokenizer. Tokens retain their full raw JSON range. */
typedef enum {
  JT_OBJECT,
  JT_ARRAY,
  JT_STRING,
  JT_NUMBER,
  JT_TRUE,
  JT_FALSE,
  JT_NULL
} JType;
typedef struct {
  JType type;
  size_t start, end;
  int parent;
} JTok;
typedef struct {
  const char *s;
  size_t len, pos;
  JTok *toks;
  int count, cap;
  const char *error;
} JParser;

static void jp_ws(JParser *p) {
  while (p->pos < p->len && strchr(" \t\r\n", p->s[p->pos]))
    p->pos++;
}

static int jp_token(JParser *p, JType type, size_t start, int parent) {
  if (p->count >= p->cap) {
    p->error = "too many JSON tokens";
    return -1;
  }
  int i = p->count++;
  p->toks[i] =
      (JTok){.type = type, .start = start, .end = start, .parent = parent};
  return i;
}

static bool jp_hex4(const char *s) {
  for (int i = 0; i < 4; i++)
    if (!isxdigit((unsigned char)s[i]))
      return false;
  return true;
}

static int jp_value(JParser *p, int parent, int depth);

static int jp_string(JParser *p, int parent) {
  size_t start = p->pos;
  int t = jp_token(p, JT_STRING, start, parent);
  if (t < 0)
    return -1;
  p->pos++;
  while (p->pos < p->len) {
    unsigned char c = (unsigned char)p->s[p->pos++];
    if (c == '"') {
      p->toks[t].end = p->pos;
      return t;
    }
    if (c < 0x20) {
      p->error = "control character in JSON string";
      return -1;
    }
    if (c == '\\') {
      if (p->pos >= p->len) {
        p->error = "truncated JSON escape";
        return -1;
      }
      char e = p->s[p->pos++];
      if (e == 'u') {
        if (p->len - p->pos < 4 || !jp_hex4(p->s + p->pos)) {
          p->error = "invalid JSON unicode escape";
          return -1;
        }
        p->pos += 4;
      } else if (!strchr("\"\\/bfnrt", e)) {
        p->error = "invalid JSON escape";
        return -1;
      }
    }
  }
  p->error = "unterminated JSON string";
  return -1;
}

static int jp_value(JParser *p, int parent, int depth) {
  if (depth > 32) {
    p->error = "JSON nesting too deep";
    return -1;
  }
  jp_ws(p);
  if (p->pos >= p->len) {
    p->error = "expected JSON value";
    return -1;
  }
  size_t start = p->pos;
  char c = p->s[p->pos];
  if (c == '"')
    return jp_string(p, parent);
  if (c == '{') {
    int t = jp_token(p, JT_OBJECT, start, parent);
    if (t < 0)
      return -1;
    p->pos++;
    jp_ws(p);
    if (p->pos < p->len && p->s[p->pos] == '}') {
      p->pos++;
      p->toks[t].end = p->pos;
      return t;
    }
    for (;;) {
      jp_ws(p);
      if (p->pos >= p->len || p->s[p->pos] != '"') {
        p->error = "expected JSON object key";
        return -1;
      }
      if (jp_string(p, t) < 0)
        return -1;
      jp_ws(p);
      if (p->pos >= p->len || p->s[p->pos++] != ':') {
        p->error = "expected colon after JSON key";
        return -1;
      }
      if (jp_value(p, t, depth + 1) < 0)
        return -1;
      jp_ws(p);
      if (p->pos >= p->len) {
        p->error = "unterminated JSON object";
        return -1;
      }
      char d = p->s[p->pos++];
      if (d == '}') {
        p->toks[t].end = p->pos;
        return t;
      }
      if (d != ',') {
        p->error = "expected comma in JSON object";
        return -1;
      }
    }
  }
  if (c == '[') {
    int t = jp_token(p, JT_ARRAY, start, parent);
    if (t < 0)
      return -1;
    p->pos++;
    jp_ws(p);
    if (p->pos < p->len && p->s[p->pos] == ']') {
      p->pos++;
      p->toks[t].end = p->pos;
      return t;
    }
    for (;;) {
      if (jp_value(p, t, depth + 1) < 0)
        return -1;
      jp_ws(p);
      if (p->pos >= p->len) {
        p->error = "unterminated JSON array";
        return -1;
      }
      char d = p->s[p->pos++];
      if (d == ']') {
        p->toks[t].end = p->pos;
        return t;
      }
      if (d != ',') {
        p->error = "expected comma in JSON array";
        return -1;
      }
    }
  }
  const char *literal = NULL;
  JType type = JT_NULL;
  if (c == 't') {
    literal = "true";
    type = JT_TRUE;
  } else if (c == 'f') {
    literal = "false";
    type = JT_FALSE;
  } else if (c == 'n') {
    literal = "null";
    type = JT_NULL;
  }
  if (literal) {
    size_t n = strlen(literal);
    if (p->len - p->pos < n || memcmp(p->s + p->pos, literal, n)) {
      p->error = "invalid JSON literal";
      return -1;
    }
    int t = jp_token(p, type, start, parent);
    if (t < 0)
      return -1;
    p->pos += n;
    p->toks[t].end = p->pos;
    return t;
  }
  if (c == '-' || isdigit((unsigned char)c)) {
    size_t i = p->pos;
    if (p->s[i] == '-')
      i++;
    if (i >= p->len) {
      p->error = "invalid JSON number";
      return -1;
    }
    if (p->s[i] == '0')
      i++;
    else if (p->s[i] >= '1' && p->s[i] <= '9')
      while (i < p->len && isdigit((unsigned char)p->s[i]))
        i++;
    else {
      p->error = "invalid JSON number";
      return -1;
    }
    if (i < p->len && p->s[i] == '.') {
      i++;
      if (i >= p->len || !isdigit((unsigned char)p->s[i])) {
        p->error = "invalid JSON fraction";
        return -1;
      }
      while (i < p->len && isdigit((unsigned char)p->s[i]))
        i++;
    }
    if (i < p->len && (p->s[i] == 'e' || p->s[i] == 'E')) {
      i++;
      if (i < p->len && (p->s[i] == '+' || p->s[i] == '-'))
        i++;
      if (i >= p->len || !isdigit((unsigned char)p->s[i])) {
        p->error = "invalid JSON exponent";
        return -1;
      }
      while (i < p->len && isdigit((unsigned char)p->s[i]))
        i++;
    }
    int t = jp_token(p, JT_NUMBER, start, parent);
    if (t < 0)
      return -1;
    p->pos = i;
    p->toks[t].end = i;
    return t;
  }
  p->error = "invalid JSON value";
  return -1;
}

static bool json_parse(const char *s, size_t len, JTok *toks, int cap,
                       int *count, const char **error) {
  JParser p = {.s = s, .len = len, .toks = toks, .cap = cap};
  int root = jp_value(&p, -1, 0);
  jp_ws(&p);
  if (root != 0 || p.pos != len) {
    if (!p.error)
      p.error = "trailing data after JSON value";
    if (error)
      *error = p.error;
    return false;
  }
  *count = p.count;
  return true;
}

static int tok_next(const JTok *toks, int count, int i) {
  if (i < 0 || i >= count)
    return count;
  size_t end = toks[i].end;
  i++;
  while (i < count && toks[i].start < end)
    i++;
  return i;
}

static bool tok_string_eq(const char *js, const JTok *tok, const char *s) {
  if (tok->type != JT_STRING || tok->end < tok->start + 2)
    return false;
  size_t n = tok->end - tok->start - 2;
  return strlen(s) == n && memcmp(js + tok->start + 1, s, n) == 0 &&
         !memchr(js + tok->start + 1, '\\', n);
}

static int obj_get(const char *js, const JTok *toks, int count, int obj,
                   const char *key) {
  if (obj < 0 || obj >= count || toks[obj].type != JT_OBJECT)
    return -1;
  int i = obj + 1;
  while (i + 1 < count && toks[i].start < toks[obj].end) {
    int value = i + 1;
    if (tok_string_eq(js, &toks[i], key))
      return value;
    i = tok_next(toks, count, value);
  }
  return -1;
}

static unsigned hexval(char c) {
  if (c >= '0' && c <= '9')
    return (unsigned)(c - '0');
  if (c >= 'a' && c <= 'f')
    return (unsigned)(c - 'a' + 10);
  return (unsigned)(c - 'A' + 10);
}

static bool sb_utf8(StrBuf *sb, uint32_t cp) {
  unsigned char out[4];
  size_t n;
  if (cp <= 0x7f) {
    out[0] = (unsigned char)cp;
    n = 1;
  } else if (cp <= 0x7ff) {
    out[0] = 0xc0 | (cp >> 6);
    out[1] = 0x80 | (cp & 0x3f);
    n = 2;
  } else if (cp <= 0xffff) {
    out[0] = 0xe0 | (cp >> 12);
    out[1] = 0x80 | ((cp >> 6) & 0x3f);
    out[2] = 0x80 | (cp & 0x3f);
    n = 3;
  } else if (cp <= 0x10ffff) {
    out[0] = 0xf0 | (cp >> 18);
    out[1] = 0x80 | ((cp >> 12) & 0x3f);
    out[2] = 0x80 | ((cp >> 6) & 0x3f);
    out[3] = 0x80 | (cp & 0x3f);
    n = 4;
  } else
    return false;
  return sb_append_n(sb, out, n);
}

static char *tok_strdup(const char *js, const JTok *tok, size_t maxlen) {
  if (!tok || tok->type != JT_STRING || tok->end < tok->start + 2)
    return NULL;
  StrBuf out = {0};
  size_t i = tok->start + 1, end = tok->end - 1;
  while (i < end) {
    unsigned char c = (unsigned char)js[i++];
    if (c != '\\') {
      if (!sb_append_n(&out, &c, 1))
        goto fail;
      continue;
    }
    char e = js[i++];
    switch (e) {
    case '"':
    case '\\':
    case '/':
      if (!sb_append_n(&out, &e, 1))
        goto fail;
      break;
    case 'b':
      c = '\b';
      if (!sb_append_n(&out, &c, 1))
        goto fail;
      break;
    case 'f':
      c = '\f';
      if (!sb_append_n(&out, &c, 1))
        goto fail;
      break;
    case 'n':
      c = '\n';
      if (!sb_append_n(&out, &c, 1))
        goto fail;
      break;
    case 'r':
      c = '\r';
      if (!sb_append_n(&out, &c, 1))
        goto fail;
      break;
    case 't':
      c = '\t';
      if (!sb_append_n(&out, &c, 1))
        goto fail;
      break;
    case 'u': {
      uint32_t cp = (hexval(js[i]) << 12) | (hexval(js[i + 1]) << 8) |
                    (hexval(js[i + 2]) << 4) | hexval(js[i + 3]);
      i += 4;
      if (cp >= 0xd800 && cp <= 0xdbff && i + 6 <= end && js[i] == '\\' &&
          js[i + 1] == 'u') {
        uint32_t lo = (hexval(js[i + 2]) << 12) | (hexval(js[i + 3]) << 8) |
                      (hexval(js[i + 4]) << 4) | hexval(js[i + 5]);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
          i += 6;
        }
      }
      if (cp == 0 || (cp >= 0xd800 && cp <= 0xdfff))
        goto fail;
      if (!sb_utf8(&out, cp))
        goto fail;
      break;
    }
    default:
      goto fail;
    }
    if (out.len > maxlen)
      goto fail;
  }
  if (out.len > maxlen || !sb_reserve(&out, 0))
    goto fail;
  return out.data;
fail:
  sb_free(&out);
  return NULL;
}

static bool tok_int(const char *js, const JTok *tok, long min, long max,
                    long *out) {
  if (!tok || tok->type != JT_NUMBER || tok->end - tok->start >= 32)
    return false;
  char buf[32];
  size_t n = tok->end - tok->start;
  memcpy(buf, js + tok->start, n);
  buf[n] = 0;
  char *tail = NULL;
  errno = 0;
  long v = strtol(buf, &tail, 10);
  if (errno || !tail || *tail || v < min || v > max)
    return false;
  *out = v;
  return true;
}

/* SHA-1 is used only for the RFC 6455 handshake. */
typedef struct {
  uint32_t h[5];
  uint64_t bits;
  unsigned char block[64];
  size_t used;
} Sha1;
static uint32_t rol32(uint32_t x, unsigned n) {
  return (x << n) | (x >> (32 - n));
}
static void sha1_block(Sha1 *s, const unsigned char *b) {
  uint32_t w[80];
  for (int i = 0; i < 16; i++)
    w[i] = ((uint32_t)b[i * 4] << 24) | ((uint32_t)b[i * 4 + 1] << 16) |
           ((uint32_t)b[i * 4 + 2] << 8) | b[i * 4 + 3];
  for (int i = 16; i < 80; i++)
    w[i] = rol32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
  uint32_t a = s->h[0], c = s->h[2], d = s->h[3], e = s->h[4], f, k, temp,
           bb = s->h[1];
  for (int i = 0; i < 80; i++) {
    if (i < 20) {
      f = (bb & c) | ((~bb) & d);
      k = 0x5a827999;
    } else if (i < 40) {
      f = bb ^ c ^ d;
      k = 0x6ed9eba1;
    } else if (i < 60) {
      f = (bb & c) | (bb & d) | (c & d);
      k = 0x8f1bbcdc;
    } else {
      f = bb ^ c ^ d;
      k = 0xca62c1d6;
    }
    temp = rol32(a, 5) + f + e + k + w[i];
    e = d;
    d = c;
    c = rol32(bb, 30);
    bb = a;
    a = temp;
  }
  s->h[0] += a;
  s->h[1] += bb;
  s->h[2] += c;
  s->h[3] += d;
  s->h[4] += e;
}
static void sha1_init(Sha1 *s) {
  *s =
      (Sha1){.h = {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0}};
}
static void sha1_update(Sha1 *s, const void *data, size_t n) {
  const unsigned char *p = data;
  s->bits += (uint64_t)n * 8;
  while (n) {
    size_t take = 64 - s->used;
    if (take > n)
      take = n;
    memcpy(s->block + s->used, p, take);
    s->used += take;
    p += take;
    n -= take;
    if (s->used == 64) {
      sha1_block(s, s->block);
      s->used = 0;
    }
  }
}
static void sha1_final(Sha1 *s, unsigned char out[20]) {
  s->block[s->used++] = 0x80;
  if (s->used > 56) {
    while (s->used < 64)
      s->block[s->used++] = 0;
    sha1_block(s, s->block);
    s->used = 0;
  }
  while (s->used < 56)
    s->block[s->used++] = 0;
  for (int i = 7; i >= 0; i--)
    s->block[s->used++] = (unsigned char)(s->bits >> (i * 8));
  sha1_block(s, s->block);
  for (int i = 0; i < 5; i++) {
    out[i * 4] = s->h[i] >> 24;
    out[i * 4 + 1] = s->h[i] >> 16;
    out[i * 4 + 2] = s->h[i] >> 8;
    out[i * 4 + 3] = s->h[i];
  }
}

static const char b64tab[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static char *base64_encode(const unsigned char *p, size_t n, size_t *outlen) {
  if (n > (SIZE_MAX - 4) / 4 * 3)
    return NULL;
  size_t len = ((n + 2) / 3) * 4;
  char *out = malloc(len + 1);
  if (!out)
    return NULL;
  size_t i = 0, j = 0;
  while (i < n) {
    uint32_t v = (uint32_t)p[i++] << 16;
    bool b = i < n;
    if (b)
      v |= (uint32_t)p[i++] << 8;
    bool c = i < n;
    if (c)
      v |= p[i++];
    out[j++] = b64tab[(v >> 18) & 63];
    out[j++] = b64tab[(v >> 12) & 63];
    out[j++] = b ? b64tab[(v >> 6) & 63] : '=';
    out[j++] = c ? b64tab[v & 63] : '=';
  }
  out[j] = 0;
  if (outlen)
    *outlen = j;
  return out;
}
static int b64value(unsigned char c) {
  if (c >= 'A' && c <= 'Z')
    return c - 'A';
  if (c >= 'a' && c <= 'z')
    return c - 'a' + 26;
  if (c >= '0' && c <= '9')
    return c - '0' + 52;
  if (c == '+')
    return 62;
  if (c == '/')
    return 63;
  return -1;
}
static unsigned char *base64_decode(const char *s, size_t n, size_t *outlen) {
  if (n % 4)
    return NULL;
  size_t cap = n / 4 * 3;
  unsigned char *out = malloc(cap ? cap : 1);
  if (!out)
    return NULL;
  size_t j = 0;
  for (size_t i = 0; i < n; i += 4) {
    int a = b64value(s[i]), b = b64value(s[i + 1]);
    int c = s[i + 2] == '=' ? -2 : b64value(s[i + 2]);
    int d = s[i + 3] == '=' ? -2 : b64value(s[i + 3]);
    if (a < 0 || b < 0 || c == -1 || d == -1 || (c == -2 && d != -2) ||
        (i + 4 < n && (c == -2 || d == -2))) {
      free(out);
      return NULL;
    }
    uint32_t v = (uint32_t)a << 18 | (uint32_t)b << 12 |
                 (uint32_t)(c < 0 ? 0 : c) << 6 | (uint32_t)(d < 0 ? 0 : d);
    out[j++] = v >> 16;
    if (c >= 0)
      out[j++] = v >> 8;
    if (d >= 0)
      out[j++] = v;
  }
  *outlen = j;
  return out;
}

typedef enum { CLIENT_UNUSED, CLIENT_HTTP, CLIENT_WS } ClientState;
typedef struct {
  int fd;
  ClientState state;
  unsigned char *buf;
  size_t len, cap;
  unsigned char *frag;
  size_t frag_len, frag_cap;
  int frag_opcode;
} Client;

typedef struct {
  bool used;
  char id[65];
  pid_t pid;
  int master;
  int owner;
  bool is_pty;
  bool closing;
  unsigned char *pending_input;
  size_t pending_input_len;
  size_t pending_input_off;
  size_t pending_input_cap;
} Session;

static Client clients[MAX_CLIENTS];
static Session sessions[MAX_SESSIONS];
static volatile sig_atomic_t daemon_stop;

static void session_discard_input(Session *s);

static void on_signal(int sig) {
  (void)sig;
  daemon_stop = 1;
}

static bool secure_eq(const char *a, size_t an, const char *b) {
  size_t bn = strlen(b), n = an > bn ? an : bn;
  unsigned diff = (unsigned)(an ^ bn);
  for (size_t i = 0; i < n; i++) {
    unsigned char ac = i < an ? (unsigned char)a[i] : 0,
                  bc = i < bn ? (unsigned char)b[i] : 0;
    diff |= ac ^ bc;
  }
  return diff == 0;
}

static bool send_all(int fd, const void *data, size_t n) {
  const unsigned char *p = data;
  while (n) {
    ssize_t w = send(fd, p, n, 0);
    if (w < 0) {
      if (errno == EINTR)
        continue;
      return false;
    }
    if (w == 0)
      return false;
    p += w;
    n -= (size_t)w;
  }
  return true;
}

static bool ws_send_frame(int fd, int opcode, const void *data, size_t n) {
  unsigned char h[10];
  size_t hn = 0;
  h[hn++] = 0x80 | (opcode & 15);
  if (n <= 125)
    h[hn++] = (unsigned char)n;
  else if (n <= 65535) {
    h[hn++] = 126;
    h[hn++] = (unsigned char)(n >> 8);
    h[hn++] = (unsigned char)n;
  } else {
    h[hn++] = 127;
    for (int i = 7; i >= 0; i--)
      h[hn++] = (unsigned char)((uint64_t)n >> (i * 8));
  }
  return send_all(fd, h, hn) && send_all(fd, data, n);
}

static bool ws_send_json(int owner, const char *json, size_t n) {
  if (owner < 0 || owner >= MAX_CLIENTS || clients[owner].state != CLIENT_WS)
    return false;
  return ws_send_frame(clients[owner].fd, 1, json, n);
}

static void session_signal(Session *s, int sig) {
  if (!s->used || s->pid <= 0)
    return;
  if (kill(-s->pid, sig) < 0)
    kill(s->pid, sig);
}

static void client_close(int ci) {
  if (ci < 0 || ci >= MAX_CLIENTS || clients[ci].state == CLIENT_UNUSED)
    return;
  close(clients[ci].fd);
  free(clients[ci].buf);
  free(clients[ci].frag);
  memset(&clients[ci], 0, sizeof(clients[ci]));
  clients[ci].fd = -1;
  for (int i = 0; i < MAX_SESSIONS; i++)
    if (sessions[i].used && sessions[i].owner == ci) {
      sessions[i].owner = -1;
      sessions[i].closing = true;
      session_signal(&sessions[i], SIGHUP);
      if (sessions[i].master >= 0) {
        close(sessions[i].master);
        sessions[i].master = -1;
      }
      session_discard_input(&sessions[i]);
    }
}

static bool buf_append(unsigned char **buf, size_t *len, size_t *cap,
                       const void *data, size_t n, size_t max) {
  if (n > max - *len)
    return false;
  size_t need = *len + n;
  if (need + 1 > *cap) {
    size_t c = *cap ? *cap : 4096;
    while (c < need + 1)
      c *= 2;
    if (c > max + 1)
      c = max + 1;
    unsigned char *p = realloc(*buf, c);
    if (!p)
      return false;
    *buf = p;
    *cap = c;
  }
  memcpy(*buf + *len, data, n);
  *len = need;
  (*buf)[*len] = 0;
  return true;
}

static void json_error_to_client(int owner, const char *message) {
  StrBuf b = {0};
  sb_append(&b, "{\"type\":\"error\",\"message\":");
  sb_json_string(&b, message);
  sb_append(&b, "}");
  ws_send_json(owner, b.data, b.len);
  sb_free(&b);
}

static void session_discard_input(Session *s) {
  free(s->pending_input);
  s->pending_input = NULL;
  s->pending_input_len = 0;
  s->pending_input_off = 0;
  s->pending_input_cap = 0;
}

static size_t session_pending_input(const Session *s) {
  return s->pending_input_len - s->pending_input_off;
}

static bool session_queue_input(Session *s, const unsigned char *data,
                                size_t n) {
  size_t pending = session_pending_input(s);
  if (n > MAX_PENDING_INPUT - pending)
    return false;
  if (s->pending_input_off && pending)
    memmove(s->pending_input, s->pending_input + s->pending_input_off, pending);
  s->pending_input_off = 0;
  s->pending_input_len = pending;
  size_t need = pending + n;
  if (need > s->pending_input_cap) {
    size_t cap = s->pending_input_cap ? s->pending_input_cap : 16384;
    while (cap < need && cap < MAX_PENDING_INPUT)
      cap *= 2;
    if (cap > MAX_PENDING_INPUT)
      cap = MAX_PENDING_INPUT;
    unsigned char *next = realloc(s->pending_input, cap);
    if (!next)
      return false;
    s->pending_input = next;
    s->pending_input_cap = cap;
  }
  if (n)
    memcpy(s->pending_input + s->pending_input_len, data, n);
  s->pending_input_len += n;
  return true;
}

static void session_flush_input(Session *s) {
  while (s->master >= 0 && s->pending_input_off < s->pending_input_len) {
    ssize_t written = write(s->master, s->pending_input + s->pending_input_off,
                            session_pending_input(s));
    if (written > 0) {
      s->pending_input_off += (size_t)written;
      continue;
    }
    if (written < 0 && errno == EINTR)
      continue;
    if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
      return;
    json_error_to_client(s->owner, "PTY input failed");
    session_discard_input(s);
    return;
  }
  if (s->pending_input_off == s->pending_input_len) {
    s->pending_input_off = 0;
    s->pending_input_len = 0;
  }
}

static bool valid_session_id(const char *s) {
  size_t n = strlen(s);
  if (!n || n > 64)
    return false;
  for (size_t i = 0; i < n; i++)
    if (!(isalnum((unsigned char)s[i]) || strchr("._:-", s[i])))
      return false;
  return true;
}

typedef struct {
  char *command, *cwd;
  char *argv[MAX_ARGV + 1];
  int argc;
  char *env_key[MAX_ENV], *env_val[MAX_ENV];
  int envc;
  int rows, cols;
} SpawnSpec;

static void spawn_free(SpawnSpec *sp) {
  free(sp->command);
  free(sp->cwd);
  for (int i = 0; i < sp->argc; i++)
    free(sp->argv[i]);
  for (int i = 0; i < sp->envc; i++) {
    free(sp->env_key[i]);
    free(sp->env_val[i]);
  }
  memset(sp, 0, sizeof(*sp));
}

static bool valid_env_key(const char *s) {
  if (!s[0] || (!(isalpha((unsigned char)s[0]) || s[0] == '_')))
    return false;
  for (size_t i = 1; s[i]; i++)
    if (!(isalnum((unsigned char)s[i]) || s[i] == '_'))
      return false;
  return true;
}

static bool parse_string_array(const char *js, JTok *t, int count, int arr,
                               char **out, int *outc, int max,
                               const char **err) {
  *outc = 0;
  if (arr < 0 || t[arr].type != JT_ARRAY) {
    *err = "argv/args must be an array";
    return false;
  }
  int i = arr + 1, n = 0;
  while (i < count && t[i].start < t[arr].end) {
    if (n >= max) {
      *err = "too many arguments";
      goto fail;
    }
    out[n] = tok_strdup(js, &t[i], 8192);
    if (!out[n]) {
      *err = "argument must be a short string";
      goto fail;
    }
    n++;
    *outc = n;
    i = tok_next(t, count, i);
  }
  return true;
fail:
  for (int j = 0; j < n; j++) {
    free(out[j]);
    out[j] = NULL;
  }
  *outc = 0;
  return false;
}

static bool parse_spawn(const char *js, JTok *t, int count, SpawnSpec *sp,
                        const char **err) {
  sp->rows = 24;
  sp->cols = 80;
  int command = obj_get(js, t, count, 0, "command"),
      cwd = obj_get(js, t, count, 0, "cwd"),
      argv = obj_get(js, t, count, 0, "argv"),
      args = obj_get(js, t, count, 0, "args"),
      env = obj_get(js, t, count, 0, "env"),
      rows = obj_get(js, t, count, 0, "rows"),
      cols = obj_get(js, t, count, 0, "cols");
  if (command >= 0) {
    sp->command = tok_strdup(js, &t[command], PATH_MAX - 1);
    if (!sp->command || !sp->command[0]) {
      *err = "command must be a non-empty string";
      return false;
    }
  }
  if (cwd >= 0) {
    sp->cwd = tok_strdup(js, &t[cwd], PATH_MAX - 1);
    if (!sp->cwd || sp->cwd[0] != '/') {
      *err = "cwd must be an absolute path";
      return false;
    }
    struct stat st;
    if (stat(sp->cwd, &st) < 0 || !S_ISDIR(st.st_mode)) {
      *err = "cwd does not exist or is not a directory";
      return false;
    }
  }
  if (argv >= 0 && args >= 0) {
    *err = "use argv or args, not both";
    return false;
  }
  if (argv >= 0) {
    if (!parse_string_array(js, t, count, argv, sp->argv, &sp->argc, MAX_ARGV,
                            err))
      return false;
    if (sp->argc < 1 || !sp->argv[0][0]) {
      *err = "argv must contain argv[0]";
      return false;
    }
  } else if (args >= 0) {
    char *tmp[MAX_ARGV] = {0};
    int n = 0;
    if (!sp->command) {
      *err = "args requires command";
      return false;
    }
    if (!parse_string_array(js, t, count, args, tmp, &n, MAX_ARGV - 1, err))
      return false;
    sp->argv[0] = strdup(sp->command);
    if (!sp->argv[0]) {
      for (int i = 0; i < n; i++)
        free(tmp[i]);
      *err = "out of memory";
      return false;
    }
    sp->argc = 1;
    for (int i = 0; i < n; i++)
      sp->argv[sp->argc++] = tmp[i];
  } else if (sp->command) {
    sp->argv[0] = strdup(sp->command);
    if (!sp->argv[0]) {
      *err = "out of memory";
      return false;
    }
    sp->argc = 1;
  }
  if (!sp->command && sp->argc > 0) {
    sp->command = strdup(sp->argv[0]);
    if (!sp->command) {
      *err = "out of memory";
      return false;
    }
  }
  if (!sp->command || sp->argc < 1) {
    *err = "spawn requires command or argv";
    return false;
  }
  sp->argv[sp->argc] = NULL;
  long v;
  if (rows >= 0) {
    if (!tok_int(js, &t[rows], 2, 500, &v)) {
      *err = "rows must be 2..500";
      return false;
    }
    sp->rows = (int)v;
  }
  if (cols >= 0) {
    if (!tok_int(js, &t[cols], 2, 500, &v)) {
      *err = "cols must be 2..500";
      return false;
    }
    sp->cols = (int)v;
  }
  if (env >= 0) {
    if (t[env].type != JT_OBJECT) {
      *err = "env must be an object";
      return false;
    }
    int i = env + 1;
    while (i + 1 < count && t[i].start < t[env].end) {
      if (sp->envc >= MAX_ENV) {
        *err = "too many environment entries";
        return false;
      }
      char *k = tok_strdup(js, &t[i], 128),
           *val = tok_strdup(js, &t[i + 1], 8192);
      if (!k || !val || !valid_env_key(k)) {
        free(k);
        free(val);
        *err = "invalid environment entry";
        return false;
      }
      sp->env_key[sp->envc] = k;
      sp->env_val[sp->envc] = val;
      sp->envc++;
      i = tok_next(t, count, i + 1);
    }
  }
  return true;
}

static Session *session_find(const char *id) {
  for (int i = 0; i < MAX_SESSIONS; i++)
    if (sessions[i].used && !strcmp(sessions[i].id, id))
      return &sessions[i];
  return NULL;
}

static void configure_child(const SpawnSpec *sp, bool is_pty) {
  if (!is_pty) {
    int nullfd = open("/dev/null", O_WRONLY);
    if (nullfd >= 0) {
      dup2(nullfd, STDERR_FILENO);
      if (nullfd != STDERR_FILENO)
        close(nullfd);
    }
  }
  if (sp->cwd && chdir(sp->cwd) < 0) {
    if (is_pty)
      dprintf(STDERR_FILENO, "zoterochat-helper: chdir failed: %s\r\n",
              strerror(errno));
    _exit(126);
  }
  for (int i = 0; i < sp->envc; i++)
    if (setenv(sp->env_key[i], sp->env_val[i], 1) < 0)
      _exit(126);
  if (is_pty && !getenv("TERM"))
    setenv("TERM", "xterm-256color", 1);
  execvp(sp->command, sp->argv);
  if (is_pty)
    dprintf(STDERR_FILENO, "zoterochat-helper: exec failed: %s\r\n",
            strerror(errno));
  _exit(127);
}

static void handle_spawn(int owner, const char *js, JTok *t, int count,
                         const char *sid, bool use_pipe) {
  if (session_find(sid)) {
    json_error_to_client(owner, "sessionId already exists");
    return;
  }
  int owned = 0, slot = -1;
  for (int i = 0; i < MAX_SESSIONS; i++) {
    if (sessions[i].used && sessions[i].owner == owner)
      owned++;
    if (!sessions[i].used && slot < 0)
      slot = i;
  }
  if (owned >= MAX_SESSIONS_PER_CLIENT || slot < 0) {
    json_error_to_client(owner, "session limit reached");
    return;
  }
  SpawnSpec sp = {0};
  const char *err = NULL;
  if (!parse_spawn(js, t, count, &sp, &err)) {
    json_error_to_client(owner, err ? err : "invalid spawn request");
    spawn_free(&sp);
    return;
  }
  int master = -1;
  pid_t pid = -1;
  int pair[2] = {-1, -1};
  if (use_pipe) {
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) < 0) {
      json_error_to_client(owner, "socketpair failed");
      spawn_free(&sp);
      return;
    }
    pid = fork();
    if (pid == 0) {
      close(pair[0]);
      if (setpgid(0, 0) < 0)
        _exit(126);
      if (dup2(pair[1], STDIN_FILENO) < 0 ||
          dup2(pair[1], STDOUT_FILENO) < 0)
        _exit(126);
      if (pair[1] != STDIN_FILENO && pair[1] != STDOUT_FILENO)
        close(pair[1]);
      configure_child(&sp, false);
    }
    close(pair[1]);
    pair[1] = -1;
    master = pair[0];
  } else {
    struct winsize ws = {.ws_row = (unsigned short)sp.rows,
                         .ws_col = (unsigned short)sp.cols};
    pid = forkpty(&master, NULL, NULL, &ws);
  }
  if (pid < 0) {
    if (pair[0] >= 0)
      close(pair[0]);
    if (pair[1] >= 0)
      close(pair[1]);
    json_error_to_client(owner, use_pipe ? "fork failed" : "forkpty failed");
    spawn_free(&sp);
    return;
  }
  if (pid == 0)
    configure_child(&sp, true);
  if (use_pipe)
    (void)setpgid(pid, pid);
  fcntl(master, F_SETFL, fcntl(master, F_GETFL) | O_NONBLOCK);
  sessions[slot] = (Session){.used = true,
                             .pid = pid,
                             .master = master,
                             .owner = owner,
                             .is_pty = !use_pipe};
  strlcpy(sessions[slot].id, sid, sizeof(sessions[slot].id));
  char reply[192];
  int n = snprintf(reply, sizeof(reply),
                   "{\"type\":\"spawned\",\"sessionId\":\"%s\",\"pid\":%d}",
                   sid, pid);
  ws_send_json(owner, reply, (size_t)n);
  spawn_free(&sp);
}

static void handle_ws_json(int owner, const unsigned char *data, size_t len) {
  if (len == 0 || len > MAX_WS_MESSAGE) {
    json_error_to_client(owner, "invalid message length");
    return;
  }
  JTok *t = calloc(MAX_JSON_TOKENS, sizeof(*t));
  if (!t) {
    json_error_to_client(owner, "out of memory");
    return;
  }
  int count = 0;
  const char *err = NULL;
  if (!json_parse((const char *)data, len, t, MAX_JSON_TOKENS, &count, &err) ||
      t[0].type != JT_OBJECT) {
    json_error_to_client(owner, err ? err : "message must be a JSON object");
    free(t);
    return;
  }
  int typei = obj_get((const char *)data, t, count, 0, "type");
  char *type =
      typei >= 0 ? tok_strdup((const char *)data, &t[typei], 32) : NULL;
  if (!type) {
    json_error_to_client(owner, "message type is required");
    free(t);
    return;
  }
  if (!strcmp(type, "ping")) {
    ws_send_json(owner, "{\"type\":\"pong\"}", 15);
    goto done;
  }
  int sidi = obj_get((const char *)data, t, count, 0, "sessionId");
  char *sid = sidi >= 0 ? tok_strdup((const char *)data, &t[sidi], 64) : NULL;
  if (!sid || !valid_session_id(sid)) {
    json_error_to_client(owner, "valid sessionId is required");
    free(sid);
    goto done;
  }
  if (!strcmp(type, "spawn") || !strcmp(type, "spawnPipe")) {
    handle_spawn(owner, (const char *)data, t, count, sid,
                 !strcmp(type, "spawnPipe"));
    free(sid);
    goto done;
  }
  Session *s = session_find(sid);
  if (!s || s->owner != owner) {
    json_error_to_client(owner, "unknown sessionId");
    free(sid);
    goto done;
  }
  if (!strcmp(type, "input")) {
    int di = obj_get((const char *)data, t, count, 0, "data"),
        ei = obj_get((const char *)data, t, count, 0, "encoding");
    char *d = di >= 0 ? tok_strdup((const char *)data, &t[di], 131072) : NULL;
    char *enc = ei >= 0 ? tok_strdup((const char *)data, &t[ei], 16) : NULL;
    if (!d) {
      json_error_to_client(owner, "input data must be a string");
      free(enc);
      free(sid);
      goto done;
    }
    unsigned char *bytes = (unsigned char *)d;
    size_t n = strlen(d);
    if (enc && !strcmp(enc, "base64")) {
      bytes = base64_decode(d, n, &n);
      if (!bytes) {
        json_error_to_client(owner, "invalid base64 input");
        free(d);
        free(enc);
        free(sid);
        goto done;
      }
    } else if (enc && strcmp(enc, "utf8")) {
      json_error_to_client(owner, "unsupported input encoding");
      free(d);
      free(enc);
      free(sid);
      goto done;
    }
    if (n > MAX_INPUT_MESSAGE) {
      json_error_to_client(owner, "input exceeds 64 KiB");
    } else if (!session_queue_input(s, bytes, n)) {
      json_error_to_client(owner, "PTY input queue exceeds 256 KiB");
    } else {
      session_flush_input(s);
    }
    if (bytes != (unsigned char *)d)
      free(bytes);
    free(d);
    free(enc);
  } else if (!strcmp(type, "resize")) {
    if (!s->is_pty) {
      json_error_to_client(owner, "pipe sessions cannot be resized");
      free(sid);
      goto done;
    }
    int ri = obj_get((const char *)data, t, count, 0, "rows"),
        ci = obj_get((const char *)data, t, count, 0, "cols");
    long rows, cols;
    if (ri < 0 || ci < 0 ||
        !tok_int((const char *)data, &t[ri], 2, 500, &rows) ||
        !tok_int((const char *)data, &t[ci], 2, 500, &cols))
      json_error_to_client(owner, "rows and cols must be 2..500");
    else {
      struct winsize ws = {.ws_row = (unsigned short)rows,
                           .ws_col = (unsigned short)cols};
      if (ioctl(s->master, TIOCSWINSZ, &ws) < 0)
        json_error_to_client(owner, "PTY resize failed");
    }
  } else if (!strcmp(type, "close")) {
    s->closing = true;
    session_signal(s, SIGHUP);
    if (s->master >= 0) {
      close(s->master);
      s->master = -1;
    }
    session_discard_input(s);
    StrBuf b = {0};
    sb_printf(&b, "{\"type\":\"closing\",\"sessionId\":\"%s\"}", sid);
    ws_send_json(owner, b.data, b.len);
    sb_free(&b);
  } else
    json_error_to_client(owner, "unknown message type");
  free(sid);
done:
  free(type);
  free(t);
}

static void ws_protocol_close(int ci, uint16_t code, const char *reason) {
  unsigned char p[125];
  size_t n = strlen(reason);
  if (n > 123)
    n = 123;
  p[0] = code >> 8;
  p[1] = code;
  memcpy(p + 2, reason, n);
  ws_send_frame(clients[ci].fd, 8, p, n + 2);
  client_close(ci);
}

static bool valid_utf8(const unsigned char *s, size_t n) {
  size_t i = 0;
  while (i < n) {
    unsigned char c = s[i++];
    if (c <= 0x7f)
      continue;
    if (c >= 0xc2 && c <= 0xdf) {
      if (i >= n || (s[i++] & 0xc0) != 0x80)
        return false;
      continue;
    }
    if (c >= 0xe0 && c <= 0xef) {
      if (i + 1 >= n)
        return false;
      unsigned char a = s[i++], b = s[i++];
      if ((a & 0xc0) != 0x80 || (b & 0xc0) != 0x80 || (c == 0xe0 && a < 0xa0) ||
          (c == 0xed && a >= 0xa0))
        return false;
      continue;
    }
    if (c >= 0xf0 && c <= 0xf4) {
      if (i + 2 >= n)
        return false;
      unsigned char a = s[i++], b = s[i++], d = s[i++];
      if ((a & 0xc0) != 0x80 || (b & 0xc0) != 0x80 || (d & 0xc0) != 0x80 ||
          (c == 0xf0 && a < 0x90) || (c == 0xf4 && a >= 0x90))
        return false;
      continue;
    }
    return false;
  }
  return true;
}

static bool ws_process(int ci) {
  Client *c = &clients[ci];
  while (c->len >= 2) {
    unsigned char *b = c->buf;
    bool fin = b[0] & 0x80;
    int opcode = b[0] & 15;
    if (b[0] & 0x70) {
      ws_protocol_close(ci, 1002, "reserved bits");
      return false;
    }
    bool masked = b[1] & 0x80;
    uint64_t n = b[1] & 0x7f;
    unsigned length_tag = b[1] & 0x7f;
    size_t h = 2;
    if (n == 126) {
      if (c->len < 4)
        return true;
      n = ((uint64_t)b[2] << 8) | b[3];
      h = 4;
      if (n < 126) {
        ws_protocol_close(ci, 1002, "non-canonical length");
        return false;
      }
    } else if (n == 127) {
      if (c->len < 10)
        return true;
      n = 0;
      for (int i = 0; i < 8; i++)
        n = (n << 8) | b[2 + i];
      h = 10;
      if ((n >> 63) || n <= 65535) {
        ws_protocol_close(ci, 1002, "invalid length");
        return false;
      }
    }
    if (!masked) {
      ws_protocol_close(ci, 1002, "client frames must be masked");
      return false;
    }
    if ((opcode & 8) && (!fin || n > 125 || length_tag > 125)) {
      ws_protocol_close(ci, 1002, "invalid control frame");
      return false;
    }
    if (n > MAX_WS_MESSAGE) {
      ws_protocol_close(ci, 1009, "message too large");
      return false;
    }
    if (c->len < h + 4 + n)
      return true;
    unsigned char mask[4];
    memcpy(mask, b + h, 4);
    h += 4;
    for (uint64_t i = 0; i < n; i++)
      b[h + i] ^= mask[i & 3];
    unsigned char *p = b + h;
    if (opcode == 8) {
      if (n == 1 || (n > 2 && !valid_utf8(p + 2, (size_t)n - 2))) {
        ws_protocol_close(ci, 1002, "invalid close frame");
        return false;
      }
      ws_send_frame(c->fd, 8, p, (size_t)n);
      client_close(ci);
      return false;
    }
    if (opcode == 9)
      ws_send_frame(c->fd, 10, p, (size_t)n);
    else if (opcode == 10) {
    } else if (opcode == 2) {
      ws_protocol_close(ci, 1003, "binary unsupported");
      return false;
    } else if (opcode == 1) {
      if (c->frag_opcode) {
        ws_protocol_close(ci, 1002, "nested fragment");
        return false;
      }
      if (fin) {
        if (!valid_utf8(p, (size_t)n)) {
          ws_protocol_close(ci, 1007, "invalid UTF-8");
          return false;
        }
        handle_ws_json(ci, p, (size_t)n);
      } else {
        c->frag_opcode = 1;
        if (!buf_append(&c->frag, &c->frag_len, &c->frag_cap, p, (size_t)n,
                        MAX_WS_MESSAGE)) {
          ws_protocol_close(ci, 1009, "message too large");
          return false;
        }
      }
    } else if (opcode == 0) {
      if (!c->frag_opcode) {
        ws_protocol_close(ci, 1002, "unexpected continuation");
        return false;
      }
      if (!buf_append(&c->frag, &c->frag_len, &c->frag_cap, p, (size_t)n,
                      MAX_WS_MESSAGE)) {
        ws_protocol_close(ci, 1009, "message too large");
        return false;
      }
      if (fin) {
        if (!valid_utf8(c->frag, c->frag_len)) {
          ws_protocol_close(ci, 1007, "invalid UTF-8");
          return false;
        }
        handle_ws_json(ci, c->frag, c->frag_len);
        c->frag_len = 0;
        c->frag_opcode = 0;
      }
    } else {
      ws_protocol_close(ci, 1002, "unknown opcode");
      return false;
    }
    size_t consumed = h + (size_t)n;
    memmove(c->buf, c->buf + consumed, c->len - consumed);
    c->len -= consumed;
  }
  return true;
}

static bool header_copy(const char *headers, const char *name, char *out,
                        size_t outn) {
  size_t nl = strlen(name);
  const char *p = strstr(headers, "\r\n");
  if (!p)
    return false;
  p += 2;
  while (*p) {
    const char *end = strstr(p, "\r\n");
    if (!end || end == p)
      break;
    const char *colon = memchr(p, ':', (size_t)(end - p));
    if (colon && (size_t)(colon - p) == nl && !strncasecmp(p, name, nl)) {
      const char *v = colon + 1;
      while (v < end && (*v == ' ' || *v == '\t'))
        v++;
      while (end > v && (end[-1] == ' ' || end[-1] == '\t'))
        end--;
      size_t n = (size_t)(end - v);
      if (n >= outn)
        return false;
      memcpy(out, v, n);
      out[n] = 0;
      return true;
    }
    p = end + 2;
  }
  return false;
}
static bool header_has_token(const char *value, const char *word) {
  if (!value)
    return false;
  size_t wn = strlen(word);
  const char *p = value;
  while (*p) {
    while (*p == ' ' || *p == '\t' || *p == ',')
      p++;
    const char *e = p;
    while (*e && *e != ',')
      e++;
    while (e > p && (e[-1] == ' ' || e[-1] == '\t'))
      e--;
    if ((size_t)(e - p) == wn && !strncasecmp(p, word, wn))
      return true;
    p = *e ? e + 1 : e;
  }
  return false;
}

static bool request_token_ok(const char *target, const char *auth,
                             const char *x_token, const char *token) {
  if (x_token && secure_eq(x_token, strlen(x_token), token))
    return true;
  if (auth && !strncasecmp(auth, "Bearer ", 7) &&
      secure_eq(auth + 7, strlen(auth + 7), token))
    return true;
  const char *q = strchr(target, '?');
  if (!q)
    return false;
  q++;
  while (*q) {
    const char *k = q;
    const char *eq = strchr(k, '=');
    if (!eq)
      break;
    const char *amp = strchr(eq + 1, '&');
    if (!amp)
      amp = target + strlen(target);
    if ((size_t)(eq - k) == 5 && !memcmp(k, "token", 5) &&
        secure_eq(eq + 1, (size_t)(amp - (eq + 1)), token))
      return true;
    if (!*amp)
      break;
    q = amp + 1;
  }
  return false;
}

static void http_reply_close(int ci, int status, const char *reason,
                             const char *body) {
  char h[512];
  int n = snprintf(
      h, sizeof(h),
      "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: "
      "%zu\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
      status, reason, strlen(body));
  send_all(clients[ci].fd, h, (size_t)n);
  send_all(clients[ci].fd, body, strlen(body));
  client_close(ci);
}

static void handle_http(int ci, const char *token) {
  Client *c = &clients[ci];
  char *end = NULL;
  if (c->len >= 4)
    end = strstr((char *)c->buf, "\r\n\r\n");
  if (!end) {
    if (c->len >= MAX_HTTP)
      http_reply_close(ci, 431, "Request Header Fields Too Large",
                       "{\"error\":\"headers too large\"}");
    return;
  }
  size_t consumed = (size_t)(end - (char *)c->buf) + 4;
  char request[MAX_HTTP + 1];
  if (consumed > MAX_HTTP) {
    http_reply_close(ci, 431, "Request Header Fields Too Large",
                     "{\"error\":\"headers too large\"}");
    return;
  }
  memcpy(request, c->buf, consumed);
  request[consumed] = 0;
  char *line_end = strstr(request, "\r\n");
  if (!line_end) {
    http_reply_close(ci, 400, "Bad Request", "{\"error\":\"bad request\"}");
    return;
  }
  *line_end = 0;
  char method[8], target[2048], version[16];
  if (sscanf(request, "%7s %2047s %15s", method, target, version) != 3 ||
      strcmp(method, "GET") || strcmp(version, "HTTP/1.1")) {
    http_reply_close(ci, 400, "Bad Request", "{\"error\":\"bad request\"}");
    return;
  }
  *line_end = '\r';
  char auth[512], xt[512], upgrade[128], connection[512], key[256],
      version_h[64];
  bool has_auth = header_copy(request, "Authorization", auth, sizeof(auth)),
       has_xt = header_copy(request, "X-ZoteroChat-Token", xt, sizeof(xt)),
       has_upgrade = header_copy(request, "Upgrade", upgrade, sizeof(upgrade)),
       has_connection =
           header_copy(request, "Connection", connection, sizeof(connection)),
       has_key = header_copy(request, "Sec-WebSocket-Key", key, sizeof(key)),
       has_version = header_copy(request, "Sec-WebSocket-Version", version_h,
                                 sizeof(version_h));
  bool authorized = request_token_ok(target, has_auth ? auth : NULL,
                                     has_xt ? xt : NULL, token);
  char path[2048];
  strlcpy(path, target, sizeof(path));
  char *q = strchr(path, '?');
  if (q)
    *q = 0;
  if (!strcmp(path, "/health")) {
    if (!authorized)
      http_reply_close(ci, 401, "Unauthorized", "{\"error\":\"unauthorized\"}");
    else
      http_reply_close(ci, 200, "OK",
                       "{\"ok\":true,\"service\":\"zoterochat-helper\","
                       "\"version\":\"" ZC_VERSION "\"}");
    return;
  }
  if (strcmp(path, "/ws")) {
    http_reply_close(ci, 404, "Not Found", "{\"error\":\"not found\"}");
    return;
  }
  if (!authorized) {
    http_reply_close(ci, 401, "Unauthorized", "{\"error\":\"unauthorized\"}");
    return;
  }
  if (!has_upgrade || strcasecmp(upgrade, "websocket") || !has_connection ||
      !header_has_token(connection, "Upgrade") || !has_key || !has_version ||
      strcmp(version_h, "13")) {
    http_reply_close(ci, 400, "Bad Request",
                     "{\"error\":\"invalid websocket handshake\"}");
    return;
  }
  char combined[256];
  size_t decoded_key_len = 0;
  unsigned char *decoded_key =
      base64_decode(key, strlen(key), &decoded_key_len);
  if (strlen(key) > 128 || !decoded_key || decoded_key_len != 16) {
    free(decoded_key);
    http_reply_close(ci, 400, "Bad Request",
                     "{\"error\":\"invalid websocket key\"}");
    return;
  }
  free(decoded_key);
  snprintf(combined, sizeof(combined), "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
           key);
  Sha1 sh;
  unsigned char digest[20];
  sha1_init(&sh);
  sha1_update(&sh, combined, strlen(combined));
  sha1_final(&sh, digest);
  size_t alen;
  char *accept = base64_encode(digest, 20, &alen);
  if (!accept) {
    http_reply_close(ci, 500, "Internal Server Error",
                     "{\"error\":\"out of memory\"}");
    return;
  }
  char response[512];
  int n = snprintf(
      response, sizeof(response),
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: "
      "Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n",
      accept);
  free(accept);
  if (!send_all(c->fd, response, (size_t)n)) {
    client_close(ci);
    return;
  }
  c->state = CLIENT_WS;
  memmove(c->buf, c->buf + consumed, c->len - consumed);
  c->len -= consumed;
  if (c->len)
    ws_process(ci);
}

static void emit_session_output(Session *s, const unsigned char *out,
                                size_t n) {
  if (!n || s->owner < 0 || clients[s->owner].state != CLIENT_WS)
    return;
  size_t bn;
  char *b64 = base64_encode(out, n, &bn);
  if (!b64)
    return;
  StrBuf msg = {0};
  sb_printf(&msg,
            "{\"type\":\"output\",\"sessionId\":\"%s\",\"encoding\":\"base64\","
            "\"data\":",
            s->id);
  sb_json_string_n(&msg, b64, bn);
  sb_append(&msg, "}");
  if (!ws_send_json(s->owner, msg.data, msg.len))
    client_close(s->owner);
  sb_free(&msg);
  free(b64);
}

static void drain_session_output(Session *s) {
  if (s->master < 0)
    return;
  for (;;) {
    unsigned char out[MAX_OUTPUT_CHUNK];
    ssize_t n = read(s->master, out, sizeof(out));
    if (n > 0) {
      emit_session_output(s, out, (size_t)n);
      continue;
    }
    if (n < 0 && errno == EINTR)
      continue;
    break;
  }
}

static void reap_sessions(void) {
  for (int i = 0; i < MAX_SESSIONS; i++) {
    Session *s = &sessions[i];
    if (!s->used)
      continue;
    int status;
    pid_t r = waitpid(s->pid, &status, WNOHANG);
    if (r == 0 || (r < 0 && errno == EINTR))
      continue;
    if (r < 0 && errno != ECHILD)
      continue;
    if (s->master >= 0) {
      drain_session_output(s);
      close(s->master);
      s->master = -1;
    }
    session_discard_input(s);
    if (s->owner >= 0 && clients[s->owner].state == CLIENT_WS) {
      StrBuf b = {0};
      sb_printf(&b, "{\"type\":\"exit\",\"sessionId\":\"%s\",", s->id);
      if (r < 0)
        sb_append(&b, "\"exitCode\":null,\"signal\":null}");
      else if (WIFEXITED(status))
        sb_printf(&b, "\"exitCode\":%d,\"signal\":null}", WEXITSTATUS(status));
      else if (WIFSIGNALED(status))
        sb_printf(&b, "\"exitCode\":null,\"signal\":%d}", WTERMSIG(status));
      else
        sb_append(&b, "\"exitCode\":null,\"signal\":null}");
      ws_send_json(s->owner, b.data, b.len);
      sb_free(&b);
    }
    memset(s, 0, sizeof(*s));
    s->master = -1;
  }
}

static int make_listener(int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0)
    return -1;
  int yes = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
  struct sockaddr_in a = {.sin_family = AF_INET,
                          .sin_port = htons((uint16_t)port)};
  inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
  if (bind(fd, (struct sockaddr *)&a, sizeof(a)) < 0 || listen(fd, 16) < 0) {
    close(fd);
    return -1;
  }
  return fd;
}

static int run_daemon(int port, const char *token) {
  pid_t initial_parent = getppid();
  int listener = make_listener(port);
  if (listener < 0) {
    fprintf(stderr, "zoterochat-helper: cannot bind 127.0.0.1:%d: %s\n", port,
            strerror(errno));
    return 1;
  }
  for (int i = 0; i < MAX_CLIENTS; i++)
    clients[i].fd = -1;
  for (int i = 0; i < MAX_SESSIONS; i++)
    sessions[i].master = -1;
  signal(SIGPIPE, SIG_IGN);
  struct sigaction sa = {0};
  sa.sa_handler = on_signal;
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGTERM, &sa, NULL);
  fprintf(stderr, "zoterochat-helper %s listening on 127.0.0.1:%d\n",
          ZC_VERSION, port);
  while (!daemon_stop) {
    pid_t current_parent = getppid();
    if (current_parent <= 1 || current_parent != initial_parent) {
      fprintf(stderr, "zoterochat-helper: parent exited; shutting down\n");
      break;
    }
    struct pollfd pf[1 + MAX_CLIENTS + MAX_SESSIONS];
    int kind[1 + MAX_CLIENTS + MAX_SESSIONS],
        idx[1 + MAX_CLIENTS + MAX_SESSIONS], n = 0;
    pf[n] = (struct pollfd){.fd = listener, .events = POLLIN};
    kind[n] = 0;
    idx[n++] = -1;
    for (int i = 0; i < MAX_CLIENTS; i++)
      if (clients[i].state != CLIENT_UNUSED) {
        pf[n] = (struct pollfd){.fd = clients[i].fd, .events = POLLIN};
        kind[n] = 1;
        idx[n++] = i;
      }
    for (int i = 0; i < MAX_SESSIONS; i++)
      if (sessions[i].used && sessions[i].master >= 0) {
        short events = POLLIN;
        if (session_pending_input(&sessions[i]))
          events |= POLLOUT;
        pf[n] = (struct pollfd){.fd = sessions[i].master, .events = events};
        kind[n] = 2;
        idx[n++] = i;
      }
    int pr = poll(pf, (nfds_t)n, 100);
    if (pr < 0 && errno != EINTR) {
      fprintf(stderr, "zoterochat-helper: poll: %s\n", strerror(errno));
      break;
    }
    if (pr > 0)
      for (int k = 0; k < n; k++) {
        if (!pf[k].revents)
          continue;
        if (kind[k] == 0) {
          int fd = accept(listener, NULL, NULL);
          if (fd >= 0) {
            int yes = 1;
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
            int slot = -1;
            for (int i = 0; i < MAX_CLIENTS; i++)
              if (clients[i].state == CLIENT_UNUSED) {
                slot = i;
                break;
              }
            if (slot < 0)
              close(fd);
            else
              clients[slot] = (Client){.fd = fd, .state = CLIENT_HTTP};
          }
        } else if (kind[k] == 1) {
          int ci = idx[k];
          if (clients[ci].state == CLIENT_UNUSED)
            continue;
          if (pf[k].revents & (POLLERR | POLLHUP | POLLNVAL)) {
            client_close(ci);
            continue;
          }
          unsigned char tmp[16384];
          ssize_t r = recv(clients[ci].fd, tmp, sizeof(tmp), 0);
          if (r <= 0) {
            client_close(ci);
            continue;
          }
          size_t max = clients[ci].state == CLIENT_HTTP
                           ? MAX_HTTP
                           : MAX_WS_MESSAGE + 16384;
          if (!buf_append(&clients[ci].buf, &clients[ci].len, &clients[ci].cap,
                          tmp, (size_t)r, max)) {
            if (clients[ci].state == CLIENT_WS)
              ws_protocol_close(ci, 1009, "buffer too large");
            else
              http_reply_close(ci, 431, "Request Header Fields Too Large",
                               "{\"error\":\"headers too large\"}");
            continue;
          }
          if (clients[ci].state == CLIENT_HTTP)
            handle_http(ci, token);
          else
            ws_process(ci);
        } else {
          Session *s = &sessions[idx[k]];
          if (!s->used || s->master < 0)
            continue;
          if (pf[k].revents & POLLIN) {
            unsigned char out[MAX_OUTPUT_CHUNK];
            ssize_t r = read(s->master, out, sizeof(out));
            if (r > 0)
              emit_session_output(s, out, (size_t)r);
            else if (r == 0 || (r < 0 && errno != EAGAIN &&
                                errno != EWOULDBLOCK && errno != EINTR)) {
              close(s->master);
              s->master = -1;
              session_discard_input(s);
            }
          }
          if ((pf[k].revents & POLLOUT) && s->master >= 0)
            session_flush_input(s);
          if ((pf[k].revents & (POLLERR | POLLHUP | POLLNVAL)) &&
              s->master >= 0) {
            drain_session_output(s);
            close(s->master);
            s->master = -1;
            session_discard_input(s);
          }
        }
      }
    reap_sessions();
  }
  close(listener);
  for (int i = 0; i < MAX_CLIENTS; i++)
    if (clients[i].state != CLIENT_UNUSED)
      client_close(i);
  for (int i = 0; i < MAX_SESSIONS; i++)
    if (sessions[i].used)
      session_signal(&sessions[i], SIGHUP);
  for (int rounds = 0; rounds < 10; rounds++) {
    reap_sessions();
    bool any = false;
    for (int i = 0; i < MAX_SESSIONS; i++)
      if (sessions[i].used)
        any = true;
    if (!any)
      break;
    usleep(50000);
  }
  for (int i = 0; i < MAX_SESSIONS; i++)
    if (sessions[i].used) {
      session_signal(&sessions[i], SIGKILL);
      waitpid(sessions[i].pid, NULL, 0);
      if (sessions[i].master >= 0)
        close(sessions[i].master);
    }
  return 0;
}

/* -------------------------- MCP stdio mode -------------------------- */
typedef struct {
  char context_path[PATH_MAX];
  char context_dir[PATH_MAX];
  char library_root[PATH_MAX];
  char zotkit_snapshot[PATH_MAX];
  char zotkit_snapshot_error[256];
  char *json;
  size_t json_len;
  JTok *toks;
  int tok_count;
} McpContext;

enum {
  MCP_CONTEXT_LIBRARY_ROOT = 1u << 0,
  MCP_CONTEXT_SNAPSHOT = 1u << 1,
};

static bool path_within(const char *root, const char *path) {
  size_t n = strlen(root);
  return !strncmp(root, path, n) &&
         (path[n] == '\0' || (n == 1 && root[0] == '/') || path[n] == '/');
}
static char *read_regular_file(const char *path, size_t max, size_t *outlen) {
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0)
    return NULL;
  struct stat st;
  if (fstat(fd, &st) < 0 || !S_ISREG(st.st_mode) || st.st_size < 0 ||
      (uint64_t)st.st_size > max) {
    close(fd);
    errno = EINVAL;
    return NULL;
  }
  size_t n = (size_t)st.st_size;
  char *b = malloc(n + 1);
  if (!b) {
    close(fd);
    return NULL;
  }
  size_t off = 0;
  while (off < n) {
    ssize_t r = read(fd, b + off, n - off);
    if (r < 0) {
      if (errno == EINTR)
        continue;
      free(b);
      close(fd);
      return NULL;
    }
    if (r == 0)
      break;
    off += (size_t)r;
  }
  close(fd);
  b[off] = 0;
  if (outlen)
    *outlen = off;
  return b;
}

static void mcp_context_clear(McpContext *c) {
  free(c->json);
  free(c->toks);
  c->json = NULL;
  c->toks = NULL;
  c->json_len = 0;
  c->tok_count = 0;
  c->library_root[0] = 0;
  c->zotkit_snapshot[0] = 0;
  c->zotkit_snapshot_error[0] = 0;
}

static bool parent_directory(char *path) {
  size_t n = strlen(path);
  while (n > 1 && path[n - 1] == '/')
    path[--n] = 0;
  char *slash = strrchr(path, '/');
  if (!slash)
    return false;
  if (slash == path)
    slash[1] = 0;
  else
    *slash = 0;
  return true;
}

static void mcp_load_snapshot_reference(McpContext *c) {
  int si = obj_get(c->json, c->toks, c->tok_count, 0,
                   "zotkitLibrarySnapshot");
  if (si < 0 || c->toks[si].type == JT_NULL)
    return;
  int pi = obj_get(c->json, c->toks, c->tok_count, si, "path");
  char *raw = pi >= 0 ? tok_strdup(c->json, &c->toks[pi], PATH_MAX - 1) : NULL;
  if (!raw || raw[0] != '/') {
    strlcpy(c->zotkit_snapshot_error,
            "built-in Zotkit snapshot reference is invalid",
            sizeof(c->zotkit_snapshot_error));
    free(raw);
    return;
  }
  char allowed[PATH_MAX];
  strlcpy(allowed, c->context_dir, sizeof(allowed));
  if (!parent_directory(allowed) || !parent_directory(allowed) ||
      strlcat(allowed, "/library-snapshots", sizeof(allowed)) >=
          sizeof(allowed)) {
    strlcpy(c->zotkit_snapshot_error,
            "built-in Zotkit snapshot root is invalid",
            sizeof(c->zotkit_snapshot_error));
    free(raw);
    return;
  }
  char allowed_resolved[PATH_MAX], snapshot_resolved[PATH_MAX];
  struct stat lst, st;
  if (!realpath(allowed, allowed_resolved) || lstat(raw, &lst) < 0 ||
      S_ISLNK(lst.st_mode) || !S_ISREG(lst.st_mode) ||
      !realpath(raw, snapshot_resolved) ||
      !path_within(allowed_resolved, snapshot_resolved) ||
      stat(snapshot_resolved, &st) < 0 || !S_ISREG(st.st_mode) ||
      st.st_uid != geteuid()) {
    strlcpy(c->zotkit_snapshot_error,
            "built-in Zotkit snapshot is unavailable or unsafe",
            sizeof(c->zotkit_snapshot_error));
    free(raw);
    return;
  }
  strlcpy(c->zotkit_snapshot, snapshot_resolved,
          sizeof(c->zotkit_snapshot));
  free(raw);
}

static bool mcp_context_reload(McpContext *c, unsigned load_flags,
                               char *err, size_t errn) {
  mcp_context_clear(c);
  c->json = read_regular_file(c->context_path, MAX_CONTEXT_FILE, &c->json_len);
  if (!c->json) {
    snprintf(err, errn, "cannot read context.json: %s", strerror(errno));
    return false;
  }
  c->toks = calloc(MAX_JSON_TOKENS, sizeof(*c->toks));
  if (!c->toks) {
    snprintf(err, errn, "out of memory");
    return false;
  }
  const char *jerr = NULL;
  if (!json_parse(c->json, c->json_len, c->toks, MAX_JSON_TOKENS, &c->tok_count,
                  &jerr) ||
      c->toks[0].type != JT_OBJECT) {
    snprintf(err, errn, "invalid context.json: %s",
             jerr ? jerr : "root must be an object");
    return false;
  }
  int ri = obj_get(c->json, c->toks, c->tok_count, 0, "libraryRoot");
  if ((load_flags & MCP_CONTEXT_LIBRARY_ROOT) && ri >= 0 &&
      c->toks[ri].type != JT_NULL) {
    char *root = tok_strdup(c->json, &c->toks[ri], PATH_MAX - 1);
    if (!root || !root[0]) {
      free(root);
      snprintf(err, errn, "libraryRoot must be a non-empty path when provided");
      return false;
    }
    char resolved[PATH_MAX];
    if (!realpath(root, resolved)) {
      snprintf(err, errn, "invalid libraryRoot: %s", strerror(errno));
      free(root);
      return false;
    }
    free(root);
    struct stat st;
    if (stat(resolved, &st) < 0 || !S_ISDIR(st.st_mode)) {
      snprintf(err, errn, "libraryRoot is not a directory");
      return false;
    }
    strlcpy(c->library_root, resolved, sizeof(c->library_root));
  }
  if (load_flags & MCP_CONTEXT_SNAPSHOT)
    mcp_load_snapshot_reference(c);
  return true;
}

static bool mcp_context_init(McpContext *c, const char *input,
                             unsigned load_flags, char *err,
                             size_t errn) {
  char resolved[PATH_MAX];
  if (!realpath(input, resolved)) {
    snprintf(err, errn, "invalid --context path: %s", strerror(errno));
    return false;
  }
  struct stat st;
  if (stat(resolved, &st) < 0)
    return false;
  if (S_ISDIR(st.st_mode)) {
    if (snprintf(c->context_path, sizeof(c->context_path), "%s/context.json",
                 resolved) >= (int)sizeof(c->context_path)) {
      snprintf(err, errn, "context path too long");
      return false;
    }
    strlcpy(c->context_dir, resolved, sizeof(c->context_dir));
  } else if (S_ISREG(st.st_mode)) {
    strlcpy(c->context_path, resolved, sizeof(c->context_path));
    strlcpy(c->context_dir, resolved, sizeof(c->context_dir));
    char *slash = strrchr(c->context_dir, '/');
    if (!slash) {
      snprintf(err, errn, "context path must be absolute");
      return false;
    }
    if (slash == c->context_dir)
      slash[1] = 0;
    else
      *slash = 0;
  } else {
    snprintf(err, errn, "context path is not a file or directory");
    return false;
  }
  return mcp_context_reload(c, load_flags, err, errn);
}

static bool mcp_write_raw_id(StrBuf *b, const char *js, const JTok *t) {
  if (!t)
    return sb_append(b, "null");
  return sb_append_n(b, js + t->start, t->end - t->start);
}
static void mcp_emit_error(const char *js, const JTok *id, int code,
                           const char *message) {
  StrBuf b = {0};
  sb_append(&b, "{\"jsonrpc\":\"2.0\",\"id\":");
  mcp_write_raw_id(&b, js, id);
  sb_printf(&b, ",\"error\":{\"code\":%d,\"message\":", code);
  sb_json_string(&b, message);
  sb_append(&b, "}}\n");
  fwrite(b.data, 1, b.len, stdout);
  fflush(stdout);
  sb_free(&b);
}
static void mcp_emit_result(const char *js, const JTok *id,
                            const char *result_json) {
  StrBuf b = {0};
  sb_append(&b, "{\"jsonrpc\":\"2.0\",\"id\":");
  mcp_write_raw_id(&b, js, id);
  sb_append(&b, ",\"result\":");
  sb_append(&b, result_json);
  sb_append(&b, "}\n");
  fwrite(b.data, 1, b.len, stdout);
  fflush(stdout);
  sb_free(&b);
}
static void mcp_emit_tool(const char *js, const JTok *id, const char *payload) {
  StrBuf b = {0};
  sb_append(&b, "{\"content\":[{\"type\":\"text\",\"text\":");
  sb_json_string(&b, payload);
  sb_append(&b, "}],\"structuredContent\":");
  sb_append(&b, payload);
  sb_append(&b, ",\"isError\":false}");
  mcp_emit_result(js, id, b.data);
  sb_free(&b);
}
static void mcp_emit_tool_error(const char *js, const JTok *id,
                                const char *message) {
  StrBuf b = {0};
  sb_append(&b, "{\"content\":[{\"type\":\"text\",\"text\":");
  sb_json_string(&b, message);
  sb_append(&b, "}],\"isError\":true}");
  mcp_emit_result(js, id, b.data);
  sb_free(&b);
}

static bool sibling_text(McpContext *c, const char *name, StrBuf *out) {
  char p[PATH_MAX];
  if (snprintf(p, sizeof(p), "%s/%s", c->context_dir, name) >= (int)sizeof(p))
    return false;
  size_t n;
  char *data = read_regular_file(p, MAX_CONTEXT_FILE, &n);
  if (!data)
    return false;
  bool ok = sb_json_string_n(out, data, n);
  free(data);
  return ok;
}
static int context_index(McpContext *c, const char *primary,
                         const char *fallback) {
  int i = obj_get(c->json, c->toks, c->tok_count, 0, primary);
  return i >= 0
             ? i
             : (fallback ? obj_get(c->json, c->toks, c->tok_count, 0, fallback)
                         : -1);
}
static bool append_context_raw(McpContext *c, StrBuf *b, int i) {
  return i >= 0 ? sb_append_n(b, c->json + c->toks[i].start,
                              c->toks[i].end - c->toks[i].start)
                : sb_append(b, "null");
}
static char *context_payload(McpContext *c, const char *key,
                             const char *fallback, const char *sibling) {
  int i = context_index(c, key, fallback);
  StrBuf b = {0};
  sb_append(&b, "{");
  sb_json_string(&b, key);
  sb_append(&b, ":");
  append_context_raw(c, &b, i);
  if (sibling) {
    sb_append(&b, ",\"text\":");
    if (!sibling_text(c, sibling, &b))
      sb_append(&b, "null");
  }
  sb_append(&b, "}");
  return b.data;
}
static char *active_paper_payload(McpContext *c) {
  int i = context_index(c, "activePaper", NULL);
  StrBuf b = {0};
  sb_append(&b, "{\"activePaper\":");
  if (i >= 0)
    append_context_raw(c, &b, i);
  else {
    sb_append(&b, "{\"attachment\":");
    append_context_raw(c, &b, context_index(c, "attachment", NULL));
    sb_append(&b, ",\"parent\":");
    append_context_raw(c, &b, context_index(c, "parent", NULL));
    sb_append(&b, ",\"pdfPath\":");
    append_context_raw(c, &b, context_index(c, "pdfPath", NULL));
    sb_append(&b, "}");
  }
  sb_append(&b, "}");
  return b.data;
}

static char *reader_context_payload(McpContext *c) {
  int active = context_index(c, "activePaper", NULL);
  StrBuf b = {0};
  sb_append(&b, "{\"activePaper\":");
  if (active >= 0)
    append_context_raw(c, &b, active);
  else {
    sb_append(&b, "{\"attachment\":");
    append_context_raw(c, &b, context_index(c, "attachment", NULL));
    sb_append(&b, ",\"parent\":");
    append_context_raw(c, &b, context_index(c, "parent", NULL));
    sb_append(&b, ",\"pdfPath\":");
    append_context_raw(c, &b, context_index(c, "pdfPath", NULL));
    sb_append(&b, "}");
  }
  sb_append(&b, ",\"currentPage\":");
  append_context_raw(c, &b, context_index(c, "currentPage", "page"));
  sb_append(&b, ",\"currentPageText\":");
  if (!sibling_text(c, "current-page.md", &b))
    sb_append(&b, "null");
  sb_append(&b, ",\"currentSelection\":");
  append_context_raw(c, &b,
                     context_index(c, "currentSelection", "selection"));
  sb_append(&b, ",\"currentSelectionText\":");
  if (!sibling_text(c, "current-selection.md", &b))
    sb_append(&b, "null");
  sb_append(&b, "}");
  return b.data;
}

typedef struct {
  StrBuf json;
  int count, limit, scanned;
  bool truncated;
  const char *query;
} FileResults;
static bool contains_ci(const char *s, const char *q) {
  if (!*q)
    return true;
  size_t qn = strlen(q);
  for (; *s; s++) {
    size_t i = 0;
    while (i < qn && s[i] &&
           tolower((unsigned char)s[i]) == tolower((unsigned char)q[i]))
      i++;
    if (i == qn)
      return true;
  }
  return false;
}
static bool hidden_name(const char *name) {
  return name[0] == '.' || !strcmp(name, "__MACOSX");
}
static bool pdf_name(const char *name) {
  size_t n = strlen(name);
  return n > 4 && !strcasecmp(name + n - 4, ".pdf");
}
static void walk_library(const char *root, const char *dir, const char *rel,
                         int depth, FileResults *r) {
  if (depth > 32 || r->truncated)
    return;
  DIR *d = opendir(dir);
  if (!d)
    return;
  struct dirent *de;
  while ((de = readdir(d))) {
    if (hidden_name(de->d_name))
      continue;
    if (++r->scanned > MAX_LIBRARY_SCANNED) {
      r->truncated = true;
      break;
    }
    char path[PATH_MAX], childrel[PATH_MAX];
    if (snprintf(path, sizeof(path), "%s/%s", dir, de->d_name) >=
            (int)sizeof(path) ||
        snprintf(childrel, sizeof(childrel), "%s%s%s", rel, *rel ? "/" : "",
                 de->d_name) >= (int)sizeof(childrel))
      continue;
    struct stat st;
    if (lstat(path, &st) < 0 || S_ISLNK(st.st_mode))
      continue;
    char resolved[PATH_MAX];
    if (!realpath(path, resolved) || !path_within(root, resolved))
      continue;
    if (S_ISDIR(st.st_mode))
      walk_library(root, path, childrel, depth + 1, r);
    else if (S_ISREG(st.st_mode) && pdf_name(de->d_name) &&
             (!r->query || contains_ci(childrel, r->query))) {
      if (r->count >= r->limit) {
        r->truncated = true;
        break;
      }
      if (r->count++)
        sb_append(&r->json, ",");
      sb_append(&r->json, "{\"path\":");
      sb_json_string(&r->json, childrel);
      sb_printf(&r->json, ",\"size\":%lld}", (long long)st.st_size);
    }
  }
  closedir(d);
}

static bool resolve_library_dir(const char *root, const char *relative,
                                char *out, char *err, size_t errn) {
  if (!relative || !relative[0]) {
    strlcpy(out, root, PATH_MAX);
    return true;
  }
  if (relative[0] == '/') {
    snprintf(err, errn, "path must be relative");
    return false;
  }
  char current[PATH_MAX];
  strlcpy(current, root, sizeof(current));
  const char *p = relative;
  while (*p) {
    const char *slash = strchr(p, '/');
    size_t n = slash ? (size_t)(slash - p) : strlen(p);
    if (n == 0 || n > NAME_MAX || p[0] == '.' ||
        (n == strlen("__MACOSX") && !memcmp(p, "__MACOSX", n))) {
      snprintf(err, errn, "path contains an unsafe component");
      return false;
    }
    size_t used = strlen(current);
    if (used + 1 + n >= sizeof(current)) {
      snprintf(err, errn, "path is too long");
      return false;
    }
    current[used++] = '/';
    memcpy(current + used, p, n);
    current[used + n] = 0;
    struct stat st;
    if (lstat(current, &st) < 0) {
      snprintf(err, errn, "path does not exist");
      return false;
    }
    if (S_ISLNK(st.st_mode)) {
      snprintf(err, errn, "symlink paths are not allowed");
      return false;
    }
    if (!S_ISDIR(st.st_mode)) {
      snprintf(err, errn, "path is not a directory");
      return false;
    }
    if (!slash)
      break;
    p = slash + 1;
    if (!*p) {
      snprintf(err, errn, "path contains an empty component");
      return false;
    }
  }
  char resolved[PATH_MAX];
  if (!realpath(current, resolved) || !path_within(root, resolved)) {
    snprintf(err, errn, "path escapes libraryRoot or does not exist");
    return false;
  }
  strlcpy(out, resolved, PATH_MAX);
  return true;
}

static char *library_payload(McpContext *c, const char *js, JTok *t, int count,
                             int args, bool search, char *err, size_t errn) {
  const char *query = NULL;
  char *qowned = NULL, *relowned = NULL;
  long limit = 100;
  if (!c->library_root[0]) {
    snprintf(err, errn, "context.json requires libraryRoot for library tools");
    return NULL;
  }
  if (args >= 0 && t[args].type != JT_OBJECT) {
    snprintf(err, errn, "arguments must be an object");
    return NULL;
  }
  if (args >= 0) {
    int li = obj_get(js, t, count, args, "limit"),
        pi = obj_get(js, t, count, args, "path"),
        qi = obj_get(js, t, count, args, "query");
    if (li >= 0 && !tok_int(js, &t[li], 1, MAX_LIBRARY_RESULTS, &limit)) {
      snprintf(err, errn, "limit must be 1..%d", MAX_LIBRARY_RESULTS);
      return NULL;
    }
    if (pi >= 0) {
      relowned = tok_strdup(js, &t[pi], PATH_MAX - 1);
      if (!relowned) {
        snprintf(err, errn, "path must be a string");
        return NULL;
      }
    }
    if (search) {
      qowned = qi >= 0 ? tok_strdup(js, &t[qi], 256) : NULL;
      if (!qowned || !qowned[0]) {
        snprintf(err, errn, "query must be a non-empty string");
        free(relowned);
        free(qowned);
        return NULL;
      }
      query = qowned;
    }
  }
  char start[PATH_MAX];
  if (!resolve_library_dir(c->library_root, relowned, start, err, errn)) {
    free(relowned);
    free(qowned);
    return NULL;
  }
  const char *canonical_rel = start + strlen(c->library_root);
  if (*canonical_rel == '/')
    canonical_rel++;
  FileResults r = {.limit = (int)limit, .query = query};
  sb_append(&r.json, "{\"files\":[");
  walk_library(c->library_root, start, canonical_rel, 0, &r);
  sb_append(&r.json, "],\"truncated\":");
  sb_append(&r.json, r.truncated ? "true" : "false");
  sb_printf(&r.json, ",\"scanned\":%d}", r.scanned);
  free(relowned);
  free(qowned);
  return r.json.data;
}

typedef struct {
  int fd;
  FILE *stream;
  char *line;
  JTok *toks;
  int tok_count;
  bool complete;
} ZotkitSnapshotReader;

static void zotkit_snapshot_close(ZotkitSnapshotReader *r) {
  if (r->stream)
    fclose(r->stream);
  else if (r->fd >= 0)
    close(r->fd);
  free(r->line);
  free(r->toks);
  memset(r, 0, sizeof(*r));
  r->fd = -1;
}

static int zotkit_snapshot_next(ZotkitSnapshotReader *r, char *err,
                                size_t errn) {
  if (!fgets(r->line, MAX_ZOTKIT_SNAPSHOT_LINE + 2, r->stream)) {
    if (ferror(r->stream)) {
      snprintf(err, errn, "could not read built-in Zotkit snapshot");
      return -1;
    }
    return 0;
  }
  size_t n = strlen(r->line);
  bool ended = n > 0 && r->line[n - 1] == '\n';
  if (!ended && !feof(r->stream)) {
    snprintf(err, errn, "built-in Zotkit snapshot record is too large");
    return -1;
  }
  while (n > 0 && (r->line[n - 1] == '\n' || r->line[n - 1] == '\r'))
    n--;
  if (!n) {
    snprintf(err, errn, "built-in Zotkit snapshot contains an empty record");
    return -1;
  }
  const char *jerr = NULL;
  r->tok_count = 0;
  if (!json_parse(r->line, n, r->toks, MAX_JSON_TOKENS, &r->tok_count,
                  &jerr) ||
      r->toks[0].type != JT_OBJECT) {
    snprintf(err, errn, "built-in Zotkit snapshot is invalid");
    return -1;
  }
  return 1;
}

static bool zotkit_snapshot_open(McpContext *c, ZotkitSnapshotReader *r,
                                 char *err, size_t errn) {
  memset(r, 0, sizeof(*r));
  r->fd = -1;
  if (!c->zotkit_snapshot[0]) {
    strlcpy(err,
            c->zotkit_snapshot_error[0]
                ? c->zotkit_snapshot_error
                : "built-in Zotkit library snapshot is unavailable",
            errn);
    return false;
  }
  r->fd = open(c->zotkit_snapshot, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  struct stat st;
  if (r->fd < 0 || fstat(r->fd, &st) < 0 || !S_ISREG(st.st_mode) ||
      st.st_uid != geteuid() || st.st_size < 1 ||
      (uint64_t)st.st_size > MAX_ZOTKIT_SNAPSHOT_FILE) {
    snprintf(err, errn, "built-in Zotkit library snapshot is unavailable");
    zotkit_snapshot_close(r);
    return false;
  }
  r->stream = fdopen(r->fd, "r");
  if (!r->stream) {
    snprintf(err, errn, "could not open built-in Zotkit snapshot");
    zotkit_snapshot_close(r);
    return false;
  }
  r->fd = -1;
  r->line = malloc(MAX_ZOTKIT_SNAPSHOT_LINE + 2);
  r->toks = calloc(MAX_JSON_TOKENS, sizeof(*r->toks));
  if (!r->line || !r->toks) {
    snprintf(err, errn, "out of memory");
    zotkit_snapshot_close(r);
    return false;
  }
  if (zotkit_snapshot_next(r, err, errn) != 1) {
    zotkit_snapshot_close(r);
    return false;
  }
  int kind = obj_get(r->line, r->toks, r->tok_count, 0, "kind"),
      schema = obj_get(r->line, r->toks, r->tok_count, 0, "schemaVersion"),
      complete = obj_get(r->line, r->toks, r->tok_count, 0, "complete");
  long version = 0;
  if (kind < 0 || !tok_string_eq(r->line, &r->toks[kind], "meta") ||
      schema < 0 || !tok_int(r->line, &r->toks[schema], 1, 1, &version) ||
      complete < 0 || (r->toks[complete].type != JT_TRUE &&
                       r->toks[complete].type != JT_FALSE)) {
    snprintf(err, errn, "built-in Zotkit snapshot header is invalid");
    zotkit_snapshot_close(r);
    return false;
  }
  r->complete = r->toks[complete].type == JT_TRUE;
  return true;
}

static bool zotkit_record_kind(ZotkitSnapshotReader *r, const char *kind) {
  int i = obj_get(r->line, r->toks, r->tok_count, 0, "kind");
  return i >= 0 && tok_string_eq(r->line, &r->toks[i], kind);
}

static int zotkit_record_value(ZotkitSnapshotReader *r) {
  return obj_get(r->line, r->toks, r->tok_count, 0, "value");
}

static bool json_array_has_string(const char *js, JTok *t, int count, int arr,
                                  const char *needle) {
  if (arr < 0 || t[arr].type != JT_ARRAY)
    return false;
  for (int i = arr + 1; i < count && t[i].start < t[arr].end;
       i = tok_next(t, count, i)) {
    char *value = tok_strdup(js, &t[i], 4096);
    bool match = value && !strcmp(value, needle);
    free(value);
    if (match)
      return true;
  }
  return false;
}

static bool object_has_only_keys(const char *js, JTok *t, int count, int obj,
                                 const char *const *allowed,
                                 size_t allowed_count) {
  if (obj < 0 || t[obj].type == JT_NULL)
    return true;
  if (t[obj].type != JT_OBJECT)
    return false;
  for (int i = obj + 1; i + 1 < count && t[i].start < t[obj].end;
       i = tok_next(t, count, i + 1)) {
    bool known = false;
    for (size_t j = 0; j < allowed_count; j++)
      if (tok_string_eq(js, &t[i], allowed[j])) {
        known = true;
        break;
      }
    if (!known)
      return false;
  }
  return true;
}

static bool append_raw_value(StrBuf *b, const char *js, JTok *t, int index) {
  return index >= 0 && sb_append_n(b, js + t[index].start,
                                   t[index].end - t[index].start);
}

static bool append_item_summary(StrBuf *b, ZotkitSnapshotReader *r,
                                int value) {
  static const char *fields[] = {"key", "itemType", "title", "collections",
                                 "tags", "version"};
  if (!sb_append(b, "{"))
    return false;
  for (size_t i = 0; i < sizeof(fields) / sizeof(fields[0]); i++) {
    int field = obj_get(r->line, r->toks, r->tok_count, value, fields[i]);
    if (i && !sb_append(b, ","))
      return false;
    if (!sb_json_string(b, fields[i]) || !sb_append(b, ":"))
      return false;
    if (field < 0) {
      if (!sb_append(b, "null"))
        return false;
    } else if (!append_raw_value(b, r->line, r->toks, field))
      return false;
  }
  return sb_append(b, "}");
}

static bool zotkit_limit(const char *js, JTok *t, int count, int args,
                         long default_value, long maximum, long *out,
                         char *err, size_t errn) {
  *out = default_value;
  if (args < 0 || t[args].type == JT_NULL)
    return true;
  if (t[args].type != JT_OBJECT) {
    snprintf(err, errn, "tool arguments must be a JSON object");
    return false;
  }
  int li = obj_get(js, t, count, args, "limit");
  if (li >= 0 && !tok_int(js, &t[li], 1, maximum, out)) {
    snprintf(err, errn, "limit must be an integer from 1 to %ld", maximum);
    return false;
  }
  return true;
}

static char *zotkit_resolve_collection(McpContext *c, const char *name,
                                       char *err, size_t errn) {
  ZotkitSnapshotReader r;
  if (!zotkit_snapshot_open(c, &r, err, errn))
    return NULL;
  char *resolved = NULL;
  int next;
  while ((next = zotkit_snapshot_next(&r, err, errn)) == 1) {
    if (zotkit_record_kind(&r, "item"))
      break;
    if (!zotkit_record_kind(&r, "collection"))
      continue;
    int value = zotkit_record_value(&r),
        ni = obj_get(r.line, r.toks, r.tok_count, value, "name"),
        pi = obj_get(r.line, r.toks, r.tok_count, value, "path"),
        ki = obj_get(r.line, r.toks, r.tok_count, value, "key");
    char *n = ni >= 0 ? tok_strdup(r.line, &r.toks[ni], 16384) : NULL;
    char *p = pi >= 0 ? tok_strdup(r.line, &r.toks[pi], 16384) : NULL;
    if ((n && !strcmp(n, name)) || (p && !strcmp(p, name)))
      resolved = ki >= 0 ? tok_strdup(r.line, &r.toks[ki], 64) : NULL;
    free(n);
    free(p);
    if (resolved)
      break;
  }
  zotkit_snapshot_close(&r);
  if (next < 0)
    return NULL;
  if (!resolved)
    snprintf(err, errn, "no collection with that exact name or path");
  return resolved;
}

static char *zotkit_find_payload(McpContext *c, const char *js, JTok *t,
                                 int count, int args, char *err, size_t errn) {
  static const char *allowed[] = {"title", "tag", "collection", "limit"};
  if (!object_has_only_keys(js, t, count, args, allowed,
                            sizeof(allowed) / sizeof(allowed[0]))) {
    snprintf(err, errn, "unknown or invalid tool argument");
    return NULL;
  }
  long limit;
  if (!zotkit_limit(js, t, count, args, 50, 200, &limit, err, errn))
    return NULL;
  char *title = NULL, *tag = NULL, *collection = NULL, *collection_key = NULL;
  if (args >= 0 && t[args].type == JT_OBJECT) {
    int ti = obj_get(js, t, count, args, "title"),
        gi = obj_get(js, t, count, args, "tag"),
        ci = obj_get(js, t, count, args, "collection");
    title = ti >= 0 ? tok_strdup(js, &t[ti], 16384) : NULL;
    tag = gi >= 0 ? tok_strdup(js, &t[gi], 16384) : NULL;
    collection = ci >= 0 ? tok_strdup(js, &t[ci], 16384) : NULL;
    if ((ti >= 0 && !title) || (gi >= 0 && !tag) ||
        (ci >= 0 && !collection)) {
      snprintf(err, errn, "title, tag, and collection must be strings");
      goto fail;
    }
  }
  if (collection) {
    collection_key = zotkit_resolve_collection(c, collection, err, errn);
    if (!collection_key)
      goto fail;
  }
  ZotkitSnapshotReader r;
  if (!zotkit_snapshot_open(c, &r, err, errn))
    goto fail;
  StrBuf b = {0};
  sb_append(&b, "{\"items\":[");
  long total = 0, selected = 0;
  int next;
  while ((next = zotkit_snapshot_next(&r, err, errn)) == 1) {
    if (!zotkit_record_kind(&r, "item"))
      continue;
    int top = obj_get(r.line, r.toks, r.tok_count, 0, "topLevel");
    if (top < 0 || r.toks[top].type != JT_TRUE)
      continue;
    int value = zotkit_record_value(&r),
        title_i = obj_get(r.line, r.toks, r.tok_count, value, "title"),
        tags_i = obj_get(r.line, r.toks, r.tok_count, value, "tags"),
        collections_i = obj_get(r.line, r.toks, r.tok_count, value,
                                "collectionKeys");
    char *item_title = title_i >= 0
                           ? tok_strdup(r.line, &r.toks[title_i], 8192)
                           : NULL;
    bool match = (!title || (item_title && contains_ci(item_title, title))) &&
                 (!tag || json_array_has_string(r.line, r.toks, r.tok_count,
                                                tags_i, tag)) &&
                 (!collection_key ||
                  json_array_has_string(r.line, r.toks, r.tok_count,
                                        collections_i, collection_key));
    free(item_title);
    if (!match)
      continue;
    total++;
    if (selected < limit) {
      if (selected++)
        sb_append(&b, ",");
      if (!append_item_summary(&b, &r, value)) {
        snprintf(err, errn, "out of memory");
        next = -1;
        break;
      }
    }
  }
  bool snapshot_complete = r.complete;
  zotkit_snapshot_close(&r);
  if (next < 0) {
    sb_free(&b);
    goto fail;
  }
  sb_printf(&b, "],\"count\":%ld,\"total\":%ld,\"truncated\":%s}",
            selected, total,
            (selected < total || !snapshot_complete) ? "true" : "false");
  free(title);
  free(tag);
  free(collection);
  free(collection_key);
  return b.data;
fail:
  free(title);
  free(tag);
  free(collection);
  free(collection_key);
  return NULL;
}

static char *zotkit_get_payload(McpContext *c, const char *js, JTok *t,
                                int count, int args, char *err, size_t errn) {
  static const char *allowed[] = {"key"};
  if (!object_has_only_keys(js, t, count, args, allowed, 1) || args < 0 ||
      t[args].type != JT_OBJECT) {
    snprintf(err, errn, "key must be exactly 8 ASCII letters or digits");
    return NULL;
  }
  int ki = obj_get(js, t, count, args, "key");
  char *key = ki >= 0 ? tok_strdup(js, &t[ki], 8) : NULL;
  if (!key || strlen(key) != 8) {
    free(key);
    snprintf(err, errn, "key must be exactly 8 ASCII letters or digits");
    return NULL;
  }
  for (size_t i = 0; i < 8; i++) {
    if (!isascii((unsigned char)key[i]) || !isalnum((unsigned char)key[i])) {
      free(key);
      snprintf(err, errn, "key must be exactly 8 ASCII letters or digits");
      return NULL;
    }
    key[i] = (char)toupper((unsigned char)key[i]);
  }
  ZotkitSnapshotReader r;
  if (!zotkit_snapshot_open(c, &r, err, errn)) {
    free(key);
    return NULL;
  }
  StrBuf b = {0};
  int next;
  while ((next = zotkit_snapshot_next(&r, err, errn)) == 1) {
    if (!zotkit_record_kind(&r, "item"))
      continue;
    int value = zotkit_record_value(&r),
        item_key_i = obj_get(r.line, r.toks, r.tok_count, value, "key");
    char *item_key = item_key_i >= 0
                         ? tok_strdup(r.line, &r.toks[item_key_i], 64)
                         : NULL;
    bool match = item_key && !strcasecmp(item_key, key);
    free(item_key);
    if (!match)
      continue;
    sb_append(&b, "{\"item\":");
    append_raw_value(&b, r.line, r.toks, value);
    sb_append(&b, "}");
    break;
  }
  zotkit_snapshot_close(&r);
  free(key);
  if (next < 0) {
    sb_free(&b);
    return NULL;
  }
  if (!b.data) {
    snprintf(err, errn, "no Zotero item with that key in the local snapshot");
    return NULL;
  }
  return b.data;
}

static char *zotkit_list_payload(McpContext *c, const char *js, JTok *t,
                                 int count, int args, bool tags, char *err,
                                 size_t errn) {
  static const char *collection_allowed[] = {"limit"};
  static const char *tag_allowed[] = {"query", "limit"};
  const char *const *allowed = tags ? tag_allowed : collection_allowed;
  size_t allowed_count = tags ? 2 : 1;
  if (!object_has_only_keys(js, t, count, args, allowed, allowed_count)) {
    snprintf(err, errn, "unknown or invalid tool argument");
    return NULL;
  }
  long limit;
  if (!zotkit_limit(js, t, count, args, 200, 500, &limit, err, errn))
    return NULL;
  char *query = NULL;
  if (tags && args >= 0 && t[args].type == JT_OBJECT) {
    int qi = obj_get(js, t, count, args, "query");
    query = qi >= 0 ? tok_strdup(js, &t[qi], 4096) : NULL;
    if (qi >= 0 && !query) {
      snprintf(err, errn, "query must be a string");
      return NULL;
    }
  }
  ZotkitSnapshotReader r;
  if (!zotkit_snapshot_open(c, &r, err, errn)) {
    free(query);
    return NULL;
  }
  StrBuf b = {0};
  const char *array_name = tags ? "tags" : "collections";
  sb_append(&b, "{");
  sb_json_string(&b, array_name);
  sb_append(&b, ":[");
  long total = 0, selected = 0;
  int next;
  while ((next = zotkit_snapshot_next(&r, err, errn)) == 1) {
    if (!zotkit_record_kind(&r, tags ? "tag" : "collection")) {
      if (zotkit_record_kind(&r, "item"))
        break;
      continue;
    }
    int value = zotkit_record_value(&r);
    if (tags && query) {
      int ti = obj_get(r.line, r.toks, r.tok_count, value, "tag");
      char *tag = ti >= 0 ? tok_strdup(r.line, &r.toks[ti], 4096) : NULL;
      bool match = tag && contains_ci(tag, query);
      free(tag);
      if (!match)
        continue;
    }
    total++;
    if (selected < limit) {
      if (selected++)
        sb_append(&b, ",");
      if (!append_raw_value(&b, r.line, r.toks, value)) {
        snprintf(err, errn, "out of memory");
        next = -1;
        break;
      }
    }
  }
  bool snapshot_complete = r.complete;
  zotkit_snapshot_close(&r);
  free(query);
  if (next < 0) {
    sb_free(&b);
    return NULL;
  }
  sb_printf(&b, "],\"count\":%ld,\"total\":%ld,\"truncated\":%s}",
            selected, total,
            (selected < total || !snapshot_complete) ? "true" : "false");
  return b.data;
}

static char *zotkit_tool_payload(McpContext *c, const char *name,
                                 const char *js, JTok *t, int count, int args,
                                 char *err, size_t errn) {
  if (!strcmp(name, "zotkit_find_items"))
    return zotkit_find_payload(c, js, t, count, args, err, errn);
  if (!strcmp(name, "zotkit_get_item"))
    return zotkit_get_payload(c, js, t, count, args, err, errn);
  if (!strcmp(name, "zotkit_list_collections"))
    return zotkit_list_payload(c, js, t, count, args, false, err, errn);
  if (!strcmp(name, "zotkit_list_tags"))
    return zotkit_list_payload(c, js, t, count, args, true, err, errn);
  snprintf(err, errn, "unknown read-only tool");
  return NULL;
}

static const char tools_list_json[] =
    "{\"tools\":["
    "{\"name\":\"get_reader_context\",\"description\":\"Recommended single "
    "read of the active paper, current page, and current selection. Do not call "
    "this server concurrently.\",\"inputSchema\":{\"type\":\"object\","
    "\"additionalProperties\":false}},"
    "{\"name\":\"get_active_paper\",\"description\":\"Return the active Zotero "
    "Reader paper metadata from "
    "context.json.\",\"inputSchema\":{\"type\":\"object\","
    "\"additionalProperties\":false}},"
    "{\"name\":\"get_current_page\",\"description\":\"Return current page "
    "metadata and the read-only current-page.md "
    "snapshot.\",\"inputSchema\":{\"type\":\"object\",\"additionalProperties\":"
    "false}},"
    "{\"name\":\"get_current_selection\",\"description\":\"Return current "
    "selection metadata and the read-only current-selection.md "
    "snapshot.\",\"inputSchema\":{\"type\":\"object\",\"additionalProperties\":"
    "false}},"
    "{\"name\":\"list_library_files\",\"description\":\"List non-hidden PDF files "
    "below libraryRoot without following "
    "symlinks.\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"path\":"
    "{\"type\":\"string\"},\"limit\":{\"type\":\"integer\",\"minimum\":1,"
    "\"maximum\":500}},\"additionalProperties\":false}},"
    "{\"name\":\"search_library_files\",\"description\":\"Case-insensitively "
    "search non-hidden PDF paths below libraryRoot without following "
    "symlinks.\",\"inputSchema\":{\"type\":\"object\",\"required\":[\"query\"],"
    "\"properties\":{\"query\":{\"type\":\"string\",\"minLength\":1,"
    "\"maxLength\":256},\"path\":{\"type\":\"string\"},\"limit\":{\"type\":"
    "\"integer\",\"minimum\":1,\"maximum\":500}},\"additionalProperties\":"
    "false}}"
    "]}";

static const char zotkit_tools_list_json[] =
    "{\"tools\":["
    "{\"name\":\"zotkit_find_items\",\"description\":\"Search top-level "
    "Zotero library items by title substring, exact tag, and/or collection. "
    "This tool is read-only.\",\"inputSchema\":{\"type\":\"object\","
    "\"properties\":{\"title\":{\"type\":\"string\",\"maxLength\":4096,\"description\":"
    "\"Case-insensitive title substring.\"},\"tag\":{\"type\":\"string\",\"maxLength\":4096,"
    "\"description\":\"Exact Zotero tag.\"},\"collection\":{\"type\":"
    "\"string\",\"maxLength\":4096,\"description\":\"Exact collection name or 'Parent :: Child' "
    "path.\"},\"limit\":{\"type\":\"integer\",\"minimum\":1,\"maximum\":"
    "200,\"default\":50}},\"additionalProperties\":false}},"
    "{\"name\":\"zotkit_get_item\",\"description\":\"Get stable "
    "bibliographic metadata for one Zotero item key. This tool is read-only and "
    "does not download attachments.\",\"inputSchema\":{\"type\":\"object\","
    "\"properties\":{\"key\":{\"type\":\"string\",\"minLength\":8,"
    "\"maxLength\":8,\"pattern\":\"^[A-Za-z0-9]{8}$\",\"description\":"
    "\"Eight-character Zotero item key (case-insensitive).\"}},\"required\":"
    "[\"key\"],\"additionalProperties\":false}},"
    "{\"name\":\"zotkit_list_collections\",\"description\":\"List Zotero "
    "collections with keys, parent keys, and full paths. This tool is read-only."
    "\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"limit\":{"
    "\"type\":\"integer\",\"minimum\":1,\"maximum\":500,\"default\":200}},"
    "\"additionalProperties\":false}},"
    "{\"name\":\"zotkit_list_tags\",\"description\":\"List tags used by "
    "top-level Zotero items and their item counts. Optionally filter by a "
    "case-insensitive substring. This tool is read-only.\",\"inputSchema\":{"
    "\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\",\"maxLength\":4096,"
    "\"description\":\"Optional tag substring.\"},\"limit\":{\"type\":"
    "\"integer\",\"minimum\":1,\"maximum\":500,\"default\":200}},"
    "\"additionalProperties\":false}}]}";

static void mcp_handle(McpContext *c, const char *line, size_t len,
                       bool zotkit_only) {
  JTok *t = calloc(MAX_JSON_TOKENS, sizeof(*t));
  if (!t) {
    mcp_emit_error("", NULL, -32603, "out of memory");
    return;
  }
  int count = 0;
  const char *perr = NULL;
  if (!json_parse(line, len, t, MAX_JSON_TOKENS, &count, &perr) ||
      t[0].type != JT_OBJECT) {
    mcp_emit_error("", NULL, -32700, perr ? perr : "parse error");
    free(t);
    return;
  }
  int idi = obj_get(line, t, count, 0, "id"),
      mi = obj_get(line, t, count, 0, "method");
  JTok *id = idi >= 0 ? &t[idi] : NULL;
  char *method = mi >= 0 ? tok_strdup(line, &t[mi], 128) : NULL;
  if (!method) {
    if (id)
      mcp_emit_error(line, id, -32600, "invalid request");
    free(t);
    return;
  }
  if (!strcmp(method, "notifications/initialized") ||
      !strncmp(method, "notifications/", 14)) {
    free(method);
    free(t);
    return;
  }
  if (!strcmp(method, "initialize")) {
    if (zotkit_only)
      mcp_emit_result(line, id,
                      "{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{"
                      "\"tools\":{\"listChanged\":false}},\"serverInfo\":{"
                      "\"name\":\"zotkit-library\",\"version\":\"" ZC_VERSION
                      "\"},\"instructions\":\"Built-in, read-only Zotero Desktop "
                      "library discovery. No exposed tool can create, modify, "
                      "move, upload, download, or delete library data.\"}");
    else
      mcp_emit_result(line, id,
                    "{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{"
                    "\"tools\":{\"listChanged\":false}},\"serverInfo\":{"
                    "\"name\":\"zotkit-reader\",\"version\":\"" ZC_VERSION
                    "\"},\"instructions\":\"Use get_reader_context once for ordinary "
                    "paper questions. Never call tools from this server concurrently "
                    "or through Promise.all; await any granular calls serially. This "
                    "is authoritative read-only context for the active Zotero PDF "
                    "Reader. Cite one-based PDF pages. Never modify the "
                    "original PDF, its directory, Zotero items, collections, tags, "
                    "annotations, links, or storage.\"}");
  } else if (!strcmp(method, "ping"))
    mcp_emit_result(line, id, "{}");
  else if (!strcmp(method, "tools/list"))
    mcp_emit_result(line, id,
                    zotkit_only ? zotkit_tools_list_json : tools_list_json);
  else if (!strcmp(method, "tools/call")) {
    int params = obj_get(line, t, count, 0, "params"),
        ni = params >= 0 ? obj_get(line, t, count, params, "name") : -1,
        args = params >= 0 ? obj_get(line, t, count, params, "arguments") : -1;
    char *name = ni >= 0 ? tok_strdup(line, &t[ni], 128) : NULL;
    if (!name) {
      mcp_emit_error(line, id, -32602, "tools/call requires params.name");
    } else {
      char err[256] = "out of memory";
      unsigned load_flags = zotkit_only
                                ? MCP_CONTEXT_SNAPSHOT
                                : ((!strcmp(name, "list_library_files") ||
                                    !strcmp(name, "search_library_files"))
                                       ? MCP_CONTEXT_LIBRARY_ROOT
                                       : 0);
      if (!mcp_context_reload(c, load_flags, err, sizeof(err)))
        mcp_emit_tool_error(line, id, err);
      else if (zotkit_only) {
        char *p = zotkit_tool_payload(c, name, line, t, count, args, err,
                                      sizeof(err));
        if (p) {
          mcp_emit_tool(line, id, p);
          free(p);
        } else
          mcp_emit_tool_error(line, id, err);
      } else if (!strcmp(name, "get_reader_context")) {
        char *p = reader_context_payload(c);
        if (p) {
          mcp_emit_tool(line, id, p);
          free(p);
        } else
          mcp_emit_tool_error(line, id, err);
      } else if (!strcmp(name, "get_active_paper")) {
        char *p = active_paper_payload(c);
        if (p) {
          mcp_emit_tool(line, id, p);
          free(p);
        } else
          mcp_emit_tool_error(line, id, err);
      } else if (!strcmp(name, "get_current_page")) {
        char *p = context_payload(c, "currentPage", "page", "current-page.md");
        if (p) {
          mcp_emit_tool(line, id, p);
          free(p);
        } else
          mcp_emit_tool_error(line, id, err);
      } else if (!strcmp(name, "get_current_selection")) {
        char *p = context_payload(c, "currentSelection", "selection",
                                  "current-selection.md");
        if (p) {
          mcp_emit_tool(line, id, p);
          free(p);
        } else
          mcp_emit_tool_error(line, id, err);
      } else if (!strcmp(name, "list_library_files") ||
                 !strcmp(name, "search_library_files")) {
        char *p = library_payload(c, line, t, count, args,
                                  !strcmp(name, "search_library_files"), err,
                                  sizeof(err));
        if (p) {
          mcp_emit_tool(line, id, p);
          free(p);
        } else
          mcp_emit_tool_error(line, id, err);
      } else
        mcp_emit_tool_error(line, id, "unknown tool");
      free(name);
    }
  } else
    mcp_emit_error(line, id, -32601, "method not found");
  free(method);
  free(t);
}

static int run_mcp(const char *context, bool zotkit_only) {
  McpContext c = {0};
  char err[256];
  if (!mcp_context_init(&c, context,
                        zotkit_only ? MCP_CONTEXT_SNAPSHOT : 0, err,
                        sizeof(err))) {
    fprintf(stderr, "zoterochat-helper: %s\n", err);
    mcp_context_clear(&c);
    return 1;
  }
  char *line = malloc(MAX_MCP_LINE + 2);
  if (!line) {
    mcp_context_clear(&c);
    return 1;
  }
  while (fgets(line, MAX_MCP_LINE + 2, stdin)) {
    size_t n = strlen(line);
    bool complete = n > 0 && line[n - 1] == '\n';
    if (!complete && !feof(stdin)) {
      int ch;
      while ((ch = fgetc(stdin)) != EOF && ch != '\n') {
      }
      mcp_emit_error("", NULL, -32700, "message exceeds 1 MiB");
      continue;
    }
    while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r'))
      n--;
    if (n == 0)
      continue;
    if (n > MAX_MCP_LINE) {
      mcp_emit_error("", NULL, -32700, "message exceeds 1 MiB");
      continue;
    }
    mcp_handle(&c, line, n, zotkit_only);
  }
  free(line);
  mcp_context_clear(&c);
  return ferror(stdin) ? 1 : 0;
}

static void zotkit_cli_usage(FILE *f) {
  fprintf(f,
          "Built-in Zotkit (read-only; bundled with the Zotero XPI)\n\n"
          "Usage:\n"
          "  zotkit find [--title TEXT] [--tag TAG] [--collection NAME] "
          "[--limit N] [--json]\n"
          "  zotkit get ITEMKEY [--json]\n"
          "  zotkit collections [--limit N] [--json]\n"
          "  zotkit tags [--query TEXT] [--limit N] [--json]\n"
          "  zotkit mcp [--context PATH]\n\n"
          "Query commands emit stable JSON by default; --json is accepted for "
          "compatibility.\n"
          "All commands query the local Zotero Desktop metadata snapshot. "
          "There are no create, tag, move, attach, fetch, or delete commands.\n");
}

static bool zotkit_direct_snapshot(McpContext *c, const char *path, char *err,
                                   size_t errn) {
  if (!path || path[0] != '/') {
    snprintf(err, errn, "ZOTKIT_SNAPSHOT must be an absolute path");
    return false;
  }
  struct stat lst, st;
  char resolved[PATH_MAX];
  if (lstat(path, &lst) < 0 || S_ISLNK(lst.st_mode) || !S_ISREG(lst.st_mode) ||
      !realpath(path, resolved) || stat(resolved, &st) < 0 ||
      !S_ISREG(st.st_mode) || st.st_uid != geteuid() || st.st_size < 1 ||
      (uint64_t)st.st_size > MAX_ZOTKIT_SNAPSHOT_FILE) {
    snprintf(err, errn, "built-in Zotkit snapshot is unavailable or unsafe");
    return false;
  }
  strlcpy(c->zotkit_snapshot, resolved, sizeof(c->zotkit_snapshot));
  return true;
}

static bool cli_add_string(StrBuf *b, bool *first, const char *key,
                           const char *value) {
  if (!*first && !sb_append(b, ","))
    return false;
  *first = false;
  return sb_json_string(b, key) && sb_append(b, ":") &&
         sb_json_string(b, value);
}

static bool cli_add_limit(StrBuf *b, bool *first, const char *value,
                          long maximum) {
  char *end = NULL;
  errno = 0;
  long parsed = strtol(value, &end, 10);
  if (errno || !end || *end || parsed < 1 || parsed > maximum)
    return false;
  if (!*first && !sb_append(b, ","))
    return false;
  *first = false;
  return sb_printf(b, "\"limit\":%ld", parsed);
}

static int run_zotkit_cli(int argc, char **argv) {
  if (argc < 2 || !strcmp(argv[1], "--help") || !strcmp(argv[1], "help")) {
    zotkit_cli_usage(stdout);
    return 0;
  }
  if (!strcmp(argv[1], "--version")) {
    puts(ZC_VERSION);
    return 0;
  }
  const char *command = argv[1], *context = getenv("ZOTKIT_READER_CONTEXT");
  const char *snapshot = getenv("ZOTKIT_SNAPSHOT");
  if (!strcmp(command, "mcp")) {
    for (int i = 2; i < argc; i++) {
      if (!strcmp(argv[i], "--context") && i + 1 < argc)
        context = argv[++i];
      else {
        zotkit_cli_usage(stderr);
        return 2;
      }
    }
    if (!context) {
      fprintf(stderr, "zotkit: Reader context is unavailable\n");
      return 2;
    }
    return run_mcp(context, true);
  }

  const char *tool = NULL;
  if (!strcmp(command, "find"))
    tool = "zotkit_find_items";
  else if (!strcmp(command, "get"))
    tool = "zotkit_get_item";
  else if (!strcmp(command, "collections"))
    tool = "zotkit_list_collections";
  else if (!strcmp(command, "tags"))
    tool = "zotkit_list_tags";
  else {
    fprintf(stderr, "zotkit: unknown read-only command '%s'\n", command);
    zotkit_cli_usage(stderr);
    return 2;
  }

  StrBuf args = {0};
  bool first = true;
  sb_append(&args, "{");
  int positional = 0;
  for (int i = 2; i < argc; i++) {
    const char *arg = argv[i];
    if (!strcmp(arg, "--json"))
      continue;
    if (!strcmp(arg, "--context") && i + 1 < argc) {
      context = argv[++i];
      continue;
    }
    if (!strcmp(command, "get") && arg[0] != '-' && positional++ == 0) {
      if (!cli_add_string(&args, &first, "key", arg))
        goto oom;
      continue;
    }
    const char *key = NULL;
    long maximum = 0;
    if (!strcmp(arg, "--title"))
      key = "title";
    else if (!strcmp(arg, "--tag"))
      key = "tag";
    else if (!strcmp(arg, "--collection"))
      key = "collection";
    else if (!strcmp(arg, "--query"))
      key = "query";
    else if (!strcmp(arg, "--limit"))
      maximum = !strcmp(command, "find") ? 200 : 500;
    else {
      fprintf(stderr, "zotkit: invalid argument '%s'\n", arg);
      sb_free(&args);
      return 2;
    }
    if (++i >= argc) {
      fprintf(stderr, "zotkit: %s requires a value\n", arg);
      sb_free(&args);
      return 2;
    }
    if (maximum) {
      if (!cli_add_limit(&args, &first, argv[i], maximum)) {
        fprintf(stderr, "zotkit: invalid limit\n");
        sb_free(&args);
        return 2;
      }
    } else if (!cli_add_string(&args, &first, key, argv[i]))
      goto oom;
  }
  sb_append(&args, "}");

  McpContext c = {0};
  char err[256];
  if (context) {
    if (!mcp_context_init(&c, context, MCP_CONTEXT_SNAPSHOT, err,
                          sizeof(err))) {
      fprintf(stderr, "zotkit: %s\n", err);
      sb_free(&args);
      mcp_context_clear(&c);
      return 1;
    }
  } else if (!zotkit_direct_snapshot(&c, snapshot, err, sizeof(err))) {
    fprintf(stderr, "zotkit: %s\n", err);
    sb_free(&args);
    return 1;
  }
  JTok *tokens = calloc(MAX_JSON_TOKENS, sizeof(*tokens));
  int token_count = 0;
  const char *jerr = NULL;
  if (!tokens || !json_parse(args.data, args.len, tokens, MAX_JSON_TOKENS,
                             &token_count, &jerr)) {
    fprintf(stderr, "zotkit: could not encode command arguments\n");
    free(tokens);
    sb_free(&args);
    mcp_context_clear(&c);
    return 1;
  }
  char *payload = zotkit_tool_payload(&c, tool, args.data, tokens, token_count,
                                      0, err, sizeof(err));
  if (!payload) {
    fprintf(stderr, "zotkit: %s\n", err);
    free(tokens);
    sb_free(&args);
    mcp_context_clear(&c);
    return 1;
  }
  puts(payload);
  free(payload);
  free(tokens);
  sb_free(&args);
  mcp_context_clear(&c);
  return 0;
oom:
  fprintf(stderr, "zotkit: out of memory\n");
  sb_free(&args);
  return 1;
}

static void usage(FILE *f) {
  fprintf(
      f,
      "Usage:\n  zoterochat-helper --port PORT --token-file PATH\n  "
      "zoterochat-helper --mcp-stdio --context PATH\n  "
      "zoterochat-helper --zotkit-mcp --context PATH\n\nDaemon endpoints: GET "
      "/health and WebSocket /ws (Bearer, X-ZoteroChat-Token, or ?token=).\n");
}

static void wipe_secret(char *value) {
  if (!value)
    return;
  volatile unsigned char *p = (volatile unsigned char *)value;
  size_t n = strlen(value);
  while (n--)
    *p++ = 0;
}

static char *read_token_file(const char *path) {
  struct stat before, after;
  if (!path || path[0] != '/' || lstat(path, &before) < 0 ||
      !S_ISREG(before.st_mode) || S_ISLNK(before.st_mode) ||
      before.st_uid != geteuid() || (before.st_mode & 0077) != 0) {
    fprintf(stderr,
            "zoterochat-helper: token file must be a private regular file owned by the current user\n");
    return NULL;
  }
  int fd = open(path, O_RDONLY | O_NOFOLLOW);
  if (fd < 0 || fstat(fd, &after) < 0 || !S_ISREG(after.st_mode) ||
      after.st_dev != before.st_dev || after.st_ino != before.st_ino) {
    if (fd >= 0)
      close(fd);
    fprintf(stderr, "zoterochat-helper: could not safely open token file\n");
    return NULL;
  }
  if (unlink(path) < 0) {
    close(fd);
    fprintf(stderr, "zoterochat-helper: could not consume token file\n");
    return NULL;
  }
  char buffer[258];
  size_t used = 0;
  while (used < sizeof(buffer) - 1) {
    ssize_t n = read(fd, buffer + used, sizeof(buffer) - 1 - used);
    if (n < 0 && errno == EINTR)
      continue;
    if (n <= 0)
      break;
    used += (size_t)n;
  }
  unsigned char extra;
  ssize_t overflow = read(fd, &extra, 1);
  close(fd);
  if (overflow > 0) {
    fprintf(stderr, "zoterochat-helper: token file is too large\n");
    return NULL;
  }
  while (used && (buffer[used - 1] == '\n' || buffer[used - 1] == '\r'))
    used--;
  if (used < 16 || used > 256 || memchr(buffer, '\0', used)) {
    fprintf(stderr, "zoterochat-helper: token must contain 16..256 bytes\n");
    return NULL;
  }
  buffer[used] = 0;
  return strdup(buffer);
}

int main(int argc, char **argv) {
  const char *program = strrchr(argv[0], '/');
  program = program ? program + 1 : argv[0];
  if (!strcmp(program, "zotkit"))
    return run_zotkit_cli(argc, argv);
  int port = 27121;
  const char *token_file = NULL, *context = NULL;
  char *owned_token = NULL;
  bool mcp = false, zotkit_mcp = false;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--port") && i + 1 < argc) {
      char *e = NULL;
      long v = strtol(argv[++i], &e, 10);
      if (!e || *e || v < 1 || v > 65535) {
        usage(stderr);
        return 2;
      }
      port = (int)v;
    } else if (!strcmp(argv[i], "--token-file") && i + 1 < argc)
      token_file = argv[++i];
    else if (!strcmp(argv[i], "--mcp-stdio"))
      mcp = true;
    else if (!strcmp(argv[i], "--zotkit-mcp"))
      zotkit_mcp = true;
    else if (!strcmp(argv[i], "--context") && i + 1 < argc)
      context = argv[++i];
    else if (!strcmp(argv[i], "--version")) {
      puts(ZC_VERSION);
      return 0;
    } else if (!strcmp(argv[i], "--help")) {
      usage(stdout);
      return 0;
    } else {
      usage(stderr);
      return 2;
    }
  }
  if (mcp || zotkit_mcp) {
    if (mcp == zotkit_mcp || !context || token_file) {
      usage(stderr);
      return 2;
    }
    return run_mcp(context, zotkit_mcp);
  }
  if (token_file) {
    owned_token = read_token_file(token_file);
  }
  if (context || !owned_token || strlen(owned_token) < 16 ||
      strlen(owned_token) > 256) {
    fprintf(stderr,
            "zoterochat-helper: daemon mode requires a private --token-file containing 16..256 bytes\n");
    wipe_secret(owned_token);
    free(owned_token);
    return 2;
  }
  int result = run_daemon(port, owned_token);
  wipe_secret(owned_token);
  free(owned_token);
  return result;
}
