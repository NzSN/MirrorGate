#pragma once

#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace mirrorgate {

using Json = nlohmann::json;

struct JsonLimits {
  std::size_t bytes;
  std::size_t depth;
  std::size_t nodes;
};

// Assigned at the SDK boundary, never inferred from peer-authored error text.
enum class FailureOrigin { sdk, control_reply, worker_application };
enum class FailureFamily {
  control_compatibility, control_transport, control_protocol, admission, build,
  negotiation, worker_transport, worker_protocol, worker_application, timeout,
  cancellation, cleanup, configuration
};

const char* failure_origin_name(FailureOrigin origin) noexcept;
const char* failure_family_name(FailureFamily family) noexcept;

class SdkError : public std::runtime_error {
 public:
  SdkError(std::string code, std::string message);
  SdkError(std::string code, std::string stage, std::string message,
           std::uint64_t operation_id = 0,
           FailureOrigin origin = FailureOrigin::sdk);

  const std::string code;
  const std::string stage;
  const std::uint64_t operation_id;
  const FailureOrigin origin;
};

// An immutable owned diagnostic copy. `operation` is trusted local context;
// `stage` remains exactly as received, including an empty SDK stage.
struct FailureSnapshot {
  const FailureOrigin origin;
  const FailureFamily family;
  const std::string code;
  const std::string stage;
  const std::uint64_t operation_id;
  const std::string operation;
  const std::string message;
};

FailureSnapshot snapshot_failure(const SdkError& error,
                                 const std::string& operation);

Json parse_strict_json(const std::string& input, JsonLimits limits);
std::string encode_strict_json(const Json& value, JsonLimits limits);
void require_exact_fields(const Json& value,
                          const std::vector<std::string>& required,
                          const std::vector<std::string>& optional = {},
                          const char* code = "CONTROL_MALFORMED");
std::uint64_t require_safe_id(const Json& value, const char* field,
                              const char* code = "CONTROL_MALFORMED");
std::string require_string(const Json& value, const char* field,
                           std::size_t max_bytes,
                           const char* code = "CONTROL_MALFORMED");

}  // namespace mirrorgate
