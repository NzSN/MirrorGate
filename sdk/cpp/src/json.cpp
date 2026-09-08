#include "mirrorgate/json.hpp"

#include <algorithm>
#include <cerrno>
#include <climits>
#include <cstdlib>
#include <limits>
#include <set>
#include <sstream>
#include <utility>

static_assert(NLOHMANN_JSON_VERSION_MAJOR == 3 &&
              NLOHMANN_JSON_VERSION_MINOR == 11 &&
              NLOHMANN_JSON_VERSION_PATCH == 3,
              "MirrorGate C++ SDK requires nlohmann_json exactly 3.11.3");

namespace mirrorgate {
namespace {

[[noreturn]] void bad(const char* code, const std::string& message) {
  throw SdkError(code, message);
}

bool is_cont(unsigned char c) { return (c & 0xc0U) == 0x80U; }

void validate_utf8(const std::string& input) {
  for (std::size_t i = 0; i < input.size();) {
    const unsigned char c = static_cast<unsigned char>(input[i]);
    if (c < 0x80U) { ++i; continue; }
    std::uint32_t cp = 0;
    std::size_t n = 0;
    if (c >= 0xc2U && c <= 0xdfU) { cp = c & 0x1fU; n = 2; }
    else if (c >= 0xe0U && c <= 0xefU) { cp = c & 0x0fU; n = 3; }
    else if (c >= 0xf0U && c <= 0xf4U) { cp = c & 0x07U; n = 4; }
    else bad("FRAME", "Invalid UTF-8");
    if (i + n > input.size()) bad("FRAME", "Invalid UTF-8");
    for (std::size_t j = 1; j < n; ++j) {
      const unsigned char d = static_cast<unsigned char>(input[i + j]);
      if (!is_cont(d)) bad("FRAME", "Invalid UTF-8");
      cp = (cp << 6U) | (d & 0x3fU);
    }
    if ((n == 3 && cp < 0x800U) || (n == 4 && cp < 0x10000U) ||
        cp > 0x10ffffU || (cp >= 0xd800U && cp <= 0xdfffU))
      bad("FRAME", "Invalid Unicode scalar");
    i += n;
  }
}

class Scanner {
 public:
  Scanner(const std::string& input, JsonLimits limits)
      : input_(input), limits_(limits) {}

  void run() {
    whitespace(); value(0); whitespace();
    if (pos_ != input_.size()) bad("FRAME", "Trailing JSON content");
  }

 private:
  void whitespace() {
    while (pos_ < input_.size() &&
           (input_[pos_] == ' ' || input_[pos_] == '\t' ||
            input_[pos_] == '\r' || input_[pos_] == '\n')) ++pos_;
  }

  void node(std::size_t depth) {
    if (depth > limits_.depth || ++nodes_ > limits_.nodes)
      bad("LIMIT", "JSON structural limit exceeded");
  }

  static unsigned hex(char c) {
    if (c >= '0' && c <= '9') return static_cast<unsigned>(c - '0');
    if (c >= 'a' && c <= 'f') return static_cast<unsigned>(10 + c - 'a');
    if (c >= 'A' && c <= 'F') return static_cast<unsigned>(10 + c - 'A');
    bad("FRAME", "Malformed Unicode escape");
  }

  std::uint32_t unicode_escape() {
    if (pos_ + 4 > input_.size()) bad("FRAME", "Malformed Unicode escape");
    std::uint32_t cp = 0;
    for (int i = 0; i < 4; ++i) cp = (cp << 4U) | hex(input_[pos_++]);
    return cp;
  }

  static void append_utf8(std::string& out, std::uint32_t cp) {
    if (cp <= 0x7fU) out.push_back(static_cast<char>(cp));
    else if (cp <= 0x7ffU) {
      out.push_back(static_cast<char>(0xc0U | (cp >> 6U)));
      out.push_back(static_cast<char>(0x80U | (cp & 0x3fU)));
    } else if (cp <= 0xffffU) {
      out.push_back(static_cast<char>(0xe0U | (cp >> 12U)));
      out.push_back(static_cast<char>(0x80U | ((cp >> 6U) & 0x3fU)));
      out.push_back(static_cast<char>(0x80U | (cp & 0x3fU)));
    } else {
      out.push_back(static_cast<char>(0xf0U | (cp >> 18U)));
      out.push_back(static_cast<char>(0x80U | ((cp >> 12U) & 0x3fU)));
      out.push_back(static_cast<char>(0x80U | ((cp >> 6U) & 0x3fU)));
      out.push_back(static_cast<char>(0x80U | (cp & 0x3fU)));
    }
  }

  std::string string() {
    if (pos_ >= input_.size() || input_[pos_++] != '"')
      bad("FRAME", "Expected JSON string");
    std::string decoded;
    while (pos_ < input_.size()) {
      const unsigned char c = static_cast<unsigned char>(input_[pos_++]);
      if (c == '"') return decoded;
      if (c < 0x20U) bad("FRAME", "Control character in JSON string");
      if (c != '\\') { decoded.push_back(static_cast<char>(c)); continue; }
      if (pos_ >= input_.size()) bad("FRAME", "Unterminated JSON escape");
      const char e = input_[pos_++];
      switch (e) {
        case '"': decoded.push_back('"'); break;
        case '\\': decoded.push_back('\\'); break;
        case '/': decoded.push_back('/'); break;
        case 'b': decoded.push_back('\b'); break;
        case 'f': decoded.push_back('\f'); break;
        case 'n': decoded.push_back('\n'); break;
        case 'r': decoded.push_back('\r'); break;
        case 't': decoded.push_back('\t'); break;
        case 'u': {
          std::uint32_t cp = unicode_escape();
          if (cp >= 0xd800U && cp <= 0xdbffU) {
            if (pos_ + 2 > input_.size() || input_[pos_] != '\\' ||
                input_[pos_ + 1] != 'u') bad("FRAME", "Lone Unicode surrogate");
            pos_ += 2;
            const std::uint32_t low = unicode_escape();
            if (low < 0xdc00U || low > 0xdfffU)
              bad("FRAME", "Lone Unicode surrogate");
            cp = 0x10000U + ((cp - 0xd800U) << 10U) + (low - 0xdc00U);
          } else if (cp >= 0xdc00U && cp <= 0xdfffU) {
            bad("FRAME", "Lone Unicode surrogate");
          }
          append_utf8(decoded, cp);
          break;
        }
        default: bad("FRAME", "Invalid JSON escape");
      }
    }
    bad("FRAME", "Unterminated JSON string");
  }

  void number() {
    const std::size_t begin = pos_;
    if (input_[pos_] == '-') ++pos_;
    if (pos_ >= input_.size()) bad("FRAME", "Malformed JSON number");
    const std::size_t integer_start = pos_;
    if (input_[pos_] == '0') ++pos_;
    else {
      if (input_[pos_] < '1' || input_[pos_] > '9')
        bad("FRAME", "Malformed JSON number");
      while (pos_ < input_.size() && input_[pos_] >= '0' && input_[pos_] <= '9') ++pos_;
    }
    const std::size_t integer_end = pos_;
    std::size_t fractional = 0;
    std::size_t fraction_start = pos_;
    if (pos_ < input_.size() && input_[pos_] == '.') {
      ++pos_; const std::size_t start = pos_; fraction_start = start;
      while (pos_ < input_.size() && input_[pos_] >= '0' && input_[pos_] <= '9') ++pos_;
      if (start == pos_) bad("FRAME", "Malformed JSON number");
      fractional = pos_ - start;
    }
    long long exponent = 0; bool exponent_negative = false; bool exponent_overflow = false;
    if (pos_ < input_.size() && (input_[pos_] == 'e' || input_[pos_] == 'E')) {
      ++pos_;
      if (pos_ < input_.size() && (input_[pos_] == '+' || input_[pos_] == '-'))
        exponent_negative = input_[pos_++] == '-';
      const std::size_t start = pos_;
      while (pos_ < input_.size() && input_[pos_] >= '0' && input_[pos_] <= '9') {
        if (exponent <= 1000000) exponent = exponent * 10 + (input_[pos_] - '0');
        else exponent_overflow = true;
        ++pos_;
      }
      if (start == pos_) bad("FRAME", "Malformed JSON number");
      if (exponent_negative) exponent = -exponent;
    }
    (void)begin;
    std::string digits = input_.substr(integer_start, integer_end - integer_start);
    if (fractional) digits += input_.substr(fraction_start, fractional);
    const std::size_t first = digits.find_first_not_of('0');
    if (first == std::string::npos) return;
    if (exponent_overflow || exponent > 1000000 || exponent < -1000000)
      bad("FRAME", "Unsafe JSON number");
    digits.erase(0, first);
    const long long scale = exponent - static_cast<long long>(fractional);
    if (scale < 0) {
      const unsigned long long remove = static_cast<unsigned long long>(-scale);
      if (remove >= digits.size()) bad("FRAME", "Fractional JSON number");
      for (std::size_t i = digits.size() - static_cast<std::size_t>(remove);
           i < digits.size(); ++i)
        if (digits[i] != '0') bad("FRAME", "Fractional JSON number");
      digits.resize(digits.size() - static_cast<std::size_t>(remove));
    } else {
      if (scale > 16 || digits.size() + static_cast<std::size_t>(scale) > 16)
        bad("FRAME", "Unsafe JSON number");
      digits.append(static_cast<std::size_t>(scale), '0');
    }
    if (digits.size() > 16) bad("FRAME", "Unsafe JSON number");
    unsigned long long magnitude = 0;
    for (char c : digits) magnitude = magnitude * 10U + static_cast<unsigned>(c - '0');
    if (magnitude > 9007199254740991ULL) bad("FRAME", "Unsafe JSON number");
  }

  void literal(const char* text) {
    const std::size_t n = std::char_traits<char>::length(text);
    if (input_.compare(pos_, n, text) != 0) bad("FRAME", "Malformed JSON value");
    pos_ += n;
  }

  void value(std::size_t depth) {
    node(depth); whitespace();
    if (pos_ >= input_.size()) bad("FRAME", "Missing JSON value");
    const char c = input_[pos_];
    if (c == '"') { string(); return; }
    if (c == '{') {
      ++pos_; whitespace(); std::set<std::string> keys;
      if (pos_ < input_.size() && input_[pos_] == '}') { ++pos_; return; }
      while (true) {
        whitespace(); const std::string key = string();
        if (!keys.insert(key).second) bad("FRAME", "Duplicate JSON object key");
        whitespace();
        if (pos_ >= input_.size() || input_[pos_++] != ':') bad("FRAME", "Expected colon");
        value(depth + 1); whitespace();
        if (pos_ >= input_.size()) bad("FRAME", "Unterminated JSON object");
        const char sep = input_[pos_++];
        if (sep == '}') return;
        if (sep != ',') bad("FRAME", "Expected object separator");
      }
    }
    if (c == '[') {
      ++pos_; whitespace();
      if (pos_ < input_.size() && input_[pos_] == ']') { ++pos_; return; }
      while (true) {
        value(depth + 1); whitespace();
        if (pos_ >= input_.size()) bad("FRAME", "Unterminated JSON array");
        const char sep = input_[pos_++];
        if (sep == ']') return;
        if (sep != ',') bad("FRAME", "Expected array separator");
      }
    }
    if (c == 't') { literal("true"); return; }
    if (c == 'f') { literal("false"); return; }
    if (c == 'n') { literal("null"); return; }
    if (c == '-' || (c >= '0' && c <= '9')) { number(); return; }
    bad("FRAME", "Malformed JSON value");
  }

  const std::string& input_;
  JsonLimits limits_;
  std::size_t pos_ = 0;
  std::size_t nodes_ = 0;
};

void normalize_integral_numbers(Json& value) {
  if (value.is_number_float()) {
    const double number = value.get<double>();
    value = static_cast<std::int64_t>(number);
    return;
  }
  if (value.is_array()) for (auto& item : value) normalize_integral_numbers(item);
  else if (value.is_object()) for (auto& item : value.items()) normalize_integral_numbers(item.value());
}

}  // namespace

SdkError::SdkError(std::string code_value, std::string message)
    : std::runtime_error(std::move(message)), code(std::move(code_value)),
      stage(), operation_id(0) {}

SdkError::SdkError(std::string code_value, std::string stage_value,
                   std::string message, std::uint64_t operation)
    : std::runtime_error(std::move(message)), code(std::move(code_value)),
      stage(std::move(stage_value)), operation_id(operation) {}

Json parse_strict_json(const std::string& input, JsonLimits limits) {
  if (input.size() > limits.bytes) bad("LIMIT", "JSON byte limit exceeded");
  if (input.size() >= 3 && static_cast<unsigned char>(input[0]) == 0xefU &&
      static_cast<unsigned char>(input[1]) == 0xbbU &&
      static_cast<unsigned char>(input[2]) == 0xbfU)
    bad("FRAME", "JSON BOM is forbidden");
  validate_utf8(input);
  Scanner(input, limits).run();
  try {
    Json result = Json::parse(input);
    normalize_integral_numbers(result);
    return result;
  }
  catch (const std::exception&) { bad("FRAME", "Malformed JSON"); }
}

std::string encode_strict_json(const Json& value, JsonLimits limits) {
  std::string encoded;
  try { encoded = value.dump(-1, ' ', false, Json::error_handler_t::strict); }
  catch (const std::exception&) { bad("FRAME", "Unable to encode JSON"); }
  (void)parse_strict_json(encoded, limits);
  return encoded;
}

void require_exact_fields(const Json& value,
                          const std::vector<std::string>& required,
                          const std::vector<std::string>& optional,
                          const char* code) {
  if (!value.is_object()) bad(code, "Expected JSON object");
  for (const auto& key : required)
    if (!value.contains(key)) bad(code, "Missing field: " + key);
  for (auto it = value.begin(); it != value.end(); ++it) {
    if (std::find(required.begin(), required.end(), it.key()) == required.end() &&
        std::find(optional.begin(), optional.end(), it.key()) == optional.end())
      bad(code, "Unexpected field: " + it.key());
  }
}

std::uint64_t require_safe_id(const Json& value, const char* field, const char* code) {
  if (!value.contains(field) ||
      !(value[field].is_number_unsigned() || value[field].is_number_integer()))
    bad(code, std::string("Invalid safe ID: ") + field);
  const auto id = value[field].get<std::int64_t>();
  if (id < 1 || id > 9007199254740991LL)
    bad(code, std::string("Invalid safe ID: ") + field);
  return static_cast<std::uint64_t>(id);
}

std::string require_string(const Json& value, const char* field,
                           std::size_t max_bytes, const char* code) {
  if (!value.contains(field) || !value[field].is_string())
    bad(code, std::string("Invalid string field: ") + field);
  const auto result = value[field].get<std::string>();
  if (result.size() > max_bytes)
    bad(code, std::string("String field exceeds limit: ") + field);
  return result;
}

}  // namespace mirrorgate
