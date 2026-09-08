#include "mirrorgate/control.hpp"
#include "mirrorgate/managed_worker.hpp"

#include <algorithm>
#include <chrono>
#include <regex>
#include <set>
#include <sys/un.h>
#include <thread>
#include <utility>

namespace mirrorgate {

struct ControlLifetime {
  explicit ControlLifetime(ControlClient* value) : client(value) {}
  ControlClient* client;
};

namespace {

constexpr JsonLimits kControlLimits{1048576, 128, 16384};

class ServerError final : public SdkError {
 public:
  using SdkError::SdkError;
};

bool one_of(const std::string& value, std::initializer_list<const char*> choices) {
  for (const char* choice : choices) if (value == choice) return true;
  return false;
}

bool valid_digest(const std::string& value) {
  static const std::regex pattern("^[0-9a-f]{64}$");
  return std::regex_match(value, pattern);
}

bool valid_id(const std::string& value) {
  static const std::regex pattern("^[A-Za-z][A-Za-z0-9_.-]{0,127}$");
  return std::regex_match(value, pattern);
}

void opaque_handle(const std::string& value, const char* label) {
  static const std::regex pattern("^[0-9a-f]{32}$");
  if (!std::regex_match(value, pattern))
    throw SdkError("CONTROL_MALFORMED", std::string("Invalid ") + label);
}

void result_fields(const Json& value, std::initializer_list<const char*> fields,
                   std::initializer_list<const char*> optional = {}) {
  std::vector<std::string> required;
  std::vector<std::string> extras;
  for (const char* field : fields) required.emplace_back(field);
  for (const char* field : optional) extras.emplace_back(field);
  require_exact_fields(value, required, extras);
}

ServerError decode_control_error(const Json& error) {
  require_exact_fields(error, {"code", "stage", "message"}, {"operationId"});
  const auto code = require_string(error, "code", 64);
  const auto stage = require_string(error, "stage", 32);
  const auto message = require_string(error, "message", 1024);
  if (!one_of(code, {"VERSION_UNSUPPORTED", "CAPABILITY_UNAVAILABLE", "ARGUMENT_INVALID",
      "POLICY_DENIED", "HANDLE_INVALID", "STATE_INVALID", "LIMIT_EXCEEDED",
      "PREPARATION_FAILED", "BUILD_FAILED", "NEGOTIATION_ATTESTATION_INVALID",
      "BACKEND_ADMISSION_FAILED", "ATTACHMENT_FAILED", "WORKER_PROTOCOL_FAILED",
      "WORKER_EXITED", "CANCELLED", "DEADLINE_EXCEEDED", "CLEANUP_FAILED",
      "OPERATION_UNKNOWN"}) ||
      !one_of(stage, {"bootstrap", "policy", "authoring", "prepare", "build",
                      "authorize", "attach", "worker", "cleanup"}))
    throw SdkError("CONTROL_MALFORMED", "Unknown control error family or stage");
  const std::uint64_t operation_id = error.contains("operationId")
      ? require_safe_id(error, "operationId") : 0;
  return ServerError(code, stage, message, operation_id);
}

void require_version_one(const Json& value) {
  if (!value.contains("v") || !value.at("v").is_number_integer() ||
      value.at("v").get<std::int64_t>() != 1)
    throw SdkError("CONTROL_MALFORMED", "Invalid control protocol version");
}

bool canonical_base64(const std::string& value) {
  if (value.size() % 4 != 0) return false;
  std::size_t padding = 0;
  if (!value.empty() && value.back() == '=') ++padding;
  if (value.size() > 1 && value[value.size() - 2] == '=') ++padding;
  for (std::size_t i = 0; i < value.size() - padding; ++i) {
    const char c = value[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
          (c >= '0' && c <= '9') || c == '+' || c == '/')) return false;
  }
  for (std::size_t i = value.size() - padding; i < value.size(); ++i)
    if (value[i] != '=') return false;
  if (padding > 2) return false;
  auto digit = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return 26 + c - 'a';
    if (c >= '0' && c <= '9') return 52 + c - '0';
    return c == '+' ? 62 : 63;
  };
  if (padding == 1 && (digit(value[value.size() - 2]) & 0x03) != 0) return false;
  if (padding == 2 && (digit(value[value.size() - 3]) & 0x0f) != 0) return false;
  const std::size_t decoded = value.size() / 4 * 3 - padding;
  return decoded <= 16384;
}

void validate_operation_status(const Json& value) {
  if (!value.is_object()) throw SdkError("CONTROL_MALFORMED", "Invalid operation status");
  const auto status = require_string(value, "status", 16);
  if (status == "pending") result_fields(value, {"operationId", "status"});
  else if (status == "succeeded") result_fields(value, {"operationId", "status", "result"});
  else if (status == "failed") {
    result_fields(value, {"operationId", "status", "error"});
    (void)decode_control_error(value.at("error"));
    if (value.at("error").contains("operationId") &&
        require_safe_id(value.at("error"), "operationId") != require_safe_id(value, "operationId"))
      throw SdkError("CONTROL_MALFORMED", "Nested operation error correlation mismatch");
  } else throw SdkError("CONTROL_MALFORMED", "Unknown operation status");
  (void)require_safe_id(value, "operationId");
}

std::uint64_t nonnegative_count(const Json& value, const char* field) {
  if (!value.contains(field) ||
      !(value.at(field).is_number_integer() || value.at(field).is_number_unsigned()))
    throw SdkError("CONTROL_MALFORMED", std::string("Invalid count: ") + field);
  const auto count = value.at(field).get<std::int64_t>();
  if (count < 0 || count > 9007199254740991LL)
    throw SdkError("CONTROL_MALFORMED", std::string("Invalid count: ") + field);
  return static_cast<std::uint64_t>(count);
}

void validate_cleanup(const Json& cleanup) {
  result_fields(cleanup, {"status", "remainingResources"});
  const auto status = require_string(cleanup, "status", 16);
  if (!one_of(status, {"notStarted", "pending", "succeeded", "failed"}) ||
      !cleanup.at("remainingResources").is_array())
    throw SdkError("CONTROL_MALFORMED", "Invalid cleanup status");
  std::set<std::string> seen;
  if (cleanup.at("remainingResources").size() > 64)
    throw SdkError("CONTROL_MALFORMED", "Too many remaining resources");
  for (const auto& item : cleanup.at("remainingResources"))
    if (!item.is_string() || !valid_id(item.get<std::string>()) ||
        !seen.insert(item.get<std::string>()).second)
      throw SdkError("CONTROL_MALFORMED", "Invalid remaining resource");
}

void validate_terminal_cleanup(const Json& result) {
  result_fields(result, {"phase", "cleanupStatus", "remainingResources"});
  Json cleanup = {{"status", result.at("cleanupStatus")},
                  {"remainingResources", result.at("remainingResources")}};
  validate_cleanup(cleanup);
  const auto phase = require_string(result, "phase", 16);
  const auto status = require_string(result, "cleanupStatus", 16);
  const bool resources_empty = result.at("remainingResources").empty();
  if ((phase == "closed" && (status != "succeeded" || !resources_empty)) ||
      (phase == "cleanupFailed" && status != "failed") ||
      (phase != "closed" && phase != "cleanupFailed"))
    throw SdkError("CONTROL_MALFORMED", "Incoherent terminal cleanup result");
}

void exact_args(const Json& args, std::initializer_list<const char*> required,
                std::initializer_list<const char*> optional = {}) {
  std::vector<std::string> r, o;
  for (const char* item : required) r.emplace_back(item);
  for (const char* item : optional) o.emplace_back(item);
  require_exact_fields(args, r, o, "ARGUMENT_INVALID");
}

void control_name(const Json& object, const char* field) {
  const auto value = require_string(object, field, 128, "ARGUMENT_INVALID");
  static const std::regex pattern("^[A-Za-z][A-Za-z0-9_.-]{0,127}$");
  if (!std::regex_match(value, pattern)) throw SdkError("ARGUMENT_INVALID", std::string("Invalid ") + field);
}

void handle_arg(const Json& object, const char* field) {
  opaque_handle(require_string(object, field, 32, "ARGUMENT_INVALID"), field);
}

void reason_arg(const Json& object) {
  const auto reason = require_string(object, "reason", 32, "ARGUMENT_INVALID");
  if (!one_of(reason, {"normal", "user-cancel", "deadline", "client-failure", "worker-failure"}))
    throw SdkError("ARGUMENT_INVALID", "Invalid cleanup reason");
}

void canonical_relative_path(const std::string& value, const char* label) {
  if (value.empty() || value.front() == '/' || value.find('\0') != std::string::npos ||
      value.back() == '/' || value.find("//") != std::string::npos)
    throw SdkError("ARGUMENT_INVALID", std::string("Invalid ") + label);
  std::size_t start = 0;
  while (start < value.size()) {
    const auto end = value.find('/', start);
    const auto part = value.substr(start, end == std::string::npos ? value.size() - start : end - start);
    if ((part == "." && value != ".") || part == "..")
      throw SdkError("ARGUMENT_INVALID", std::string("Invalid ") + label);
    if (end == std::string::npos) break;
    start = end + 1;
  }
}

void canonical_unix_endpoint(const std::string& value) {
  if (value.empty() || value.front() != '/' || value.size() > 107 ||
      value.find('\0') != std::string::npos || value.back() == '/' ||
      value.find("//") != std::string::npos)
    throw SdkError("CONTROL_MALFORMED", "Invalid worker Unix endpoint");
  std::size_t start = 1;
  while (start < value.size()) {
    const auto end = value.find('/', start);
    const auto part = value.substr(start, end == std::string::npos ? value.size() - start : end - start);
    if (part == "." || part == "..") throw SdkError("CONTROL_MALFORMED", "Unsafe worker Unix endpoint");
    if (end == std::string::npos) break;
    start = end + 1;
  }
}

}  // namespace

void validate_control_request(const Json& request) {
  require_exact_fields(request, {"v", "kind", "id", "op", "args"}, {}, "CONTROL_MALFORMED");
  require_version_one(request);
  if (!request.at("kind").is_string() || request.at("kind") != "request")
    throw SdkError("CONTROL_MALFORMED", "Invalid control request envelope");
  (void)require_safe_id(request, "id", "CONTROL_MALFORMED");
  const auto op = require_string(request, "op", 32, "CONTROL_MALFORMED");
  const Json& args = request.at("args");
  if (op == "hello") {
    exact_args(args, {"controlVersions", "requiredCapabilities"});
    if (!args.at("controlVersions").is_array() || args.at("controlVersions").empty() || args.at("controlVersions").size() > 8 ||
        !args.at("requiredCapabilities").is_array() || args.at("requiredCapabilities").size() > 64)
      throw SdkError("ARGUMENT_INVALID", "Invalid hello collections");
    std::set<std::int64_t> versions; for (const auto& item : args.at("controlVersions")) {
      if (!item.is_number_integer() || item.get<std::int64_t>() < 1 || !versions.insert(item.get<std::int64_t>()).second)
        throw SdkError("ARGUMENT_INVALID", "Invalid control version");
    }
    std::set<std::string> caps; for (const auto& item : args.at("requiredCapabilities")) {
      if (!item.is_string()) throw SdkError("ARGUMENT_INVALID", "Invalid capability");
      Json holder = {{"value", item}}; control_name(holder, "value");
      if (!caps.insert(item.get<std::string>()).second) throw SdkError("ARGUMENT_INVALID", "Duplicate capability");
    }
    return;
  }
  if (op == "session.open") {
    exact_args(args, {"policyId", "submission", "runtime", "manifestJson"}, {"limits", "modelRevisionId"});
    control_name(args, "policyId"); control_name(args, "runtime");
    const auto manifest_json = require_string(args, "manifestJson", 262144, "ARGUMENT_INVALID");
    (void)Manifest::parse(manifest_json);
    const Json& submission = args.at("submission");
    if (!submission.is_object() || !submission.contains("kind")) throw SdkError("ARGUMENT_INVALID", "Invalid submission");
    const auto kind = require_string(submission, "kind", 16, "ARGUMENT_INVALID");
    if (kind == "prebuilt") exact_args(submission, {"kind", "input"});
    else if (kind == "source") exact_args(submission, {"kind", "input", "buildPlanId", "authoring"});
    else throw SdkError("ARGUMENT_INVALID", "Invalid submission kind");
    const Json& input = submission.at("input"); exact_args(input, {"rootId", "relativePath"}); control_name(input, "rootId");
    canonical_relative_path(require_string(input, "relativePath", 1024, "ARGUMENT_INVALID"), "input path");
    if (kind == "source") { control_name(submission, "buildPlanId"); if (!submission.at("authoring").is_boolean()) throw SdkError("ARGUMENT_INVALID", "Invalid authoring flag"); }
    if (args.contains("limits")) {
      const Json& limits = args.at("limits");
      if (!limits.is_object()) throw SdkError("ARGUMENT_INVALID", "Invalid tightened limits");
      static const std::set<std::string> allowed = {"sessionWallMs", "executionWallMs", "commandCpuSeconds",
        "addressSpaceBytes", "uidProcesses", "openFiles", "fileBytes", "stdoutBytes", "stderrBytes",
        "snapshotFiles", "snapshotBytes", "tmpBytes", "scratchBytes"};
      for (const auto& item : limits.items()) {
        if (!allowed.count(item.key())) throw SdkError("ARGUMENT_INVALID", "Unknown tightened limit");
        Json holder = {{"value", item.value()}}; (void)require_safe_id(holder, "value", "ARGUMENT_INVALID");
      }
    }
    if (args.contains("modelRevisionId")) {
      const auto revision = require_string(args, "modelRevisionId", 128, "ARGUMENT_INVALID");
      if (revision.empty() || std::any_of(revision.begin(), revision.end(), [](unsigned char c) { return c < 0x21 || c > 0x7e; }))
        throw SdkError("ARGUMENT_INVALID", "Invalid model revision ID");
    }
    return;
  }
  if (op == "authoring.exec") {
    exact_args(args, {"sessionId", "toolId", "arguments", "cwd"}); handle_arg(args, "sessionId"); control_name(args, "toolId");
    if (!args.at("arguments").is_array() || args.at("arguments").size() > 256) throw SdkError("ARGUMENT_INVALID", "Invalid arguments");
    for (const auto& item : args.at("arguments")) if (!item.is_string() || item.get_ref<const std::string&>().find('\0') != std::string::npos) throw SdkError("ARGUMENT_INVALID", "Invalid tool argument");
    canonical_relative_path(require_string(args, "cwd", 1024, "ARGUMENT_INVALID"), "authoring cwd"); return;
  }
  if (op == "session.prepare" || op == "session.status") { exact_args(args, {"sessionId"}); handle_arg(args, "sessionId"); return; }
  if (op == "session.authorize") {
    exact_args(args, {"sessionId", "preparedRevision", "challenge", "attestation"}); handle_arg(args, "sessionId"); handle_arg(args, "challenge");
    if (require_safe_id(args, "preparedRevision", "ARGUMENT_INVALID") != 1) throw SdkError("ARGUMENT_INVALID", "Unsupported prepared revision");
    const Json& att = args.at("attestation"); exact_args(att, {"registrationId", "request", "policy", "status", "descriptorSchema", "semanticDigest", "adapterId", "targetProfile", "stateComputerContractVersion"});
    if (require_string(att, "registrationId", 128, "ARGUMENT_INVALID").empty())
      throw SdkError("ARGUMENT_INVALID", "Empty registration identity");
    if (att.value("request", "") != "verify" || att.value("policy", "") != "require" || att.value("status", "") != "matched" ||
        att.value("descriptorSchema", "") != "mirrors.model-interface-descriptor/v1" || !valid_digest(att.value("semanticDigest", "")))
      throw SdkError("ARGUMENT_INVALID", "Invalid required-match attestation");
    for (const char* field : {"adapterId", "targetProfile", "stateComputerContractVersion"}) {
      const auto value = require_string(att, field, 128, "ARGUMENT_INVALID"); if (value.empty()) throw SdkError("ARGUMENT_INVALID", "Empty attestation identity");
    }
    return;
  }
  if (op == "worker.acquire") { exact_args(args, {"sessionId", "authorizationId"}); handle_arg(args, "sessionId"); handle_arg(args, "authorizationId"); return; }
  if (op == "worker.release") { exact_args(args, {"sessionId", "workerId", "reason"}); handle_arg(args, "sessionId"); handle_arg(args, "workerId"); reason_arg(args); return; }
  if (op == "session.cancel") { exact_args(args, {"sessionId", "reason"}); handle_arg(args, "sessionId"); reason_arg(args); return; }
  if (op == "session.close") {
    exact_args(args, {"sessionId"}, {"outcomeSummary"}); handle_arg(args, "sessionId");
    if (args.contains("outcomeSummary")) {
      const Json& outcome = args.at("outcomeSummary"); exact_args(outcome, {"status"}, {"failureFamily"});
      const auto status = require_string(outcome, "status", 16, "ARGUMENT_INVALID");
      if (!one_of(status, {"passed", "mismatch", "failed", "cancelled", "timedOut"})) throw SdkError("ARGUMENT_INVALID", "Invalid outcome status");
      if (outcome.contains("failureFamily")) control_name(outcome, "failureFamily");
    }
    return;
  }
  if (op == "operation.status") { exact_args(args, {"sessionId", "operationId"}); handle_arg(args, "sessionId"); (void)require_safe_id(args, "operationId", "ARGUMENT_INVALID"); return; }
  throw SdkError("CONTROL_MALFORMED", "Unknown control operation");
}

Operation::Operation(std::shared_ptr<ControlLifetime> owner, std::string session_id,
                     std::uint64_t operation_id, std::string terminal_type)
    : owner_(owner), session_id_(std::move(session_id)), operation_id_(operation_id),
      terminal_type_(std::move(terminal_type)) {}

ControlClient& Operation::client() const {
  auto owner = owner_.lock();
  if (!owner || !owner->client) throw SdkError("HANDLE_INVALID", "Control operation owner is closed");
  return *owner->client;
}

Json Operation::status() {
  Json args = {{"sessionId", session_id_}, {"operationId", operation_id_}};
  Json result = client().request("operation.status", args);
  if (require_safe_id(result, "operationId") != operation_id_)
    throw SdkError("CONTROL_MALFORMED", "Operation status correlation mismatch");
  validate_control_operation_fixture(result, terminal_type_);
  return result;
}

Json Operation::wait(std::chrono::milliseconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (true) {
    Json outcome = status();
    const auto state = outcome.at("status").get<std::string>();
    if (state == "succeeded") return outcome.at("result");
    if (state == "failed") throw decode_control_error(outcome.at("error"));
    if (std::chrono::steady_clock::now() >= deadline)
      throw SdkError("DEADLINE_EXCEEDED", "Operation wait deadline exceeded");
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
}

Session::Session(std::shared_ptr<ControlLifetime> owner, std::string session_id)
    : owner_(owner), session_id_(std::move(session_id)) {}

ControlClient& Session::client() const {
  auto owner = owner_.lock();
  if (!owner || !owner->client) throw SdkError("HANDLE_INVALID", "Control session owner is closed");
  return *owner->client;
}

Operation Session::authoring_exec(const std::string& tool_id,
                                  const std::vector<std::string>& arguments,
                                  const std::string& cwd) {
  return client().accepted(session_id_, client().request("authoring.exec",
      {{"sessionId", session_id_}, {"toolId", tool_id},
       {"arguments", arguments}, {"cwd", cwd}}), "CommandResult");
}

Operation Session::prepare() {
  return client().accepted(session_id_, client().request("session.prepare",
      {{"sessionId", session_id_}}), "Prepared");
}

Authorization Session::authorize(std::uint64_t prepared_revision,
                                 const std::string& challenge,
                                 const Json& attestation) {
  Json result = client().request("session.authorize",
      {{"sessionId", session_id_}, {"preparedRevision", prepared_revision},
       {"challenge", challenge}, {"attestation", attestation}});
  Authorization authorization;
  authorization.id_ = require_string(result, "authorizationId", 32);
  authorization.owner_session_id_ = session_id_;
  authorization.owner_ = owner_;
  return authorization;
}

WorkerDescriptor Session::acquire_worker(const Authorization& authorization) {
  auto expected_owner = owner_.lock(); auto actual_owner = authorization.owner_.lock();
  if (!expected_owner || expected_owner != actual_owner || authorization.owner_session_id_ != session_id_)
    throw SdkError("HANDLE_INVALID", "Authorization is not owned by this session");
  Json result = client().request("worker.acquire",
      {{"sessionId", session_id_}, {"authorizationId", authorization.id_}});
  WorkerDescriptor descriptor;
  descriptor.worker_id_ = require_string(result, "workerId", 32);
  opaque_handle(descriptor.worker_id_, "worker ID");
  const Json& endpoint = result.at("endpoint");
  result_fields(endpoint, {"kind", "path"});
  if (require_string(endpoint, "kind", 16) != "unix")
    throw SdkError("CONTROL_MALFORMED", "Unsupported worker endpoint kind");
  descriptor.endpoint_path_ = require_string(endpoint, "path", sizeof(sockaddr_un{}.sun_path) - 1);
  descriptor.attachment_token_ = require_string(result, "attachmentToken", 128);
  descriptor.attachment_timeout_ms_ = require_safe_id(result, "attachmentTimeoutMs");
  descriptor.release_mode_ = require_string(result, "releaseMode", 32);
  if (descriptor.release_mode_ != "control-v1")
    throw SdkError("CONTROL_MALFORMED", "Worker is not Gate-release managed");
  descriptor.owner_session_id_ = session_id_;
  descriptor.owner_ = owner_;
  client().workers_.insert(std::make_pair(session_id_, descriptor.worker_id_));
  client().worker_states_[std::make_pair(session_id_, descriptor.worker_id_)] = "reserved";
  return descriptor;
}

Operation Session::release_worker(const WorkerDescriptor& worker,
                                  const std::string& reason,
                                  std::string* cleanup_mode) {
  auto expected_owner = owner_.lock(); auto actual_owner = worker.owner_.lock();
  if (!expected_owner || expected_owner != actual_owner || worker.owner_session_id_ != session_id_)
    throw SdkError("HANDLE_INVALID", "Worker is not owned by this session");
  Json result = client().request("worker.release",
      {{"sessionId", session_id_}, {"workerId", worker.worker_id_}, {"reason", reason}});
  if (cleanup_mode) *cleanup_mode = require_string(result, "cleanupMode", 32);
  return client().accepted(session_id_, result, "CleanupResult", true);
}

Operation Session::cancel(const std::string& reason) {
  return client().accepted(session_id_, client().request("session.cancel",
      {{"sessionId", session_id_}, {"reason", reason}}), "CleanupResult");
}

Operation Session::close(const Json* outcome_summary) {
  Json args = {{"sessionId", session_id_}};
  if (outcome_summary) args["outcomeSummary"] = *outcome_summary;
  return client().accepted(session_id_, client().request("session.close", args), "CleanupResult");
}

Json Session::status() {
  return client().request("session.status", {{"sessionId", session_id_}});
}

ControlClient::ControlClient(std::unique_ptr<Transport> transport,
                             std::chrono::milliseconds request_timeout)
    : transport_(std::move(transport)), request_timeout_(request_timeout),
      lifetime_(std::make_shared<ControlLifetime>(this)) {
  if (!transport_ || request_timeout_.count() < 1)
    throw SdkError("ARGUMENT_INVALID", "Invalid control transport or deadline");
}

std::unique_ptr<ControlClient> ControlClient::launch(
    const std::vector<std::string>& approved_argv,
    const std::vector<std::string>& required_capabilities,
    std::chrono::milliseconds request_timeout) {
  return from_transport(launch_stdio(approved_argv), required_capabilities, request_timeout);
}

std::unique_ptr<ControlClient> ControlClient::connect(
    const std::string& unix_path,
    const std::vector<std::string>& required_capabilities,
    std::chrono::milliseconds request_timeout) {
  return from_transport(connect_unix(unix_path), required_capabilities, request_timeout);
}

std::unique_ptr<ControlClient> ControlClient::from_transport(
    std::unique_ptr<Transport> transport,
    const std::vector<std::string>& required_capabilities,
    std::chrono::milliseconds request_timeout) {
  std::unique_ptr<ControlClient> client(new ControlClient(std::move(transport), request_timeout));
  try { client->handshake(required_capabilities); }
  catch (...) { client->close(); throw; }
  return client;
}

ControlClient::~ControlClient() { close(); }

bool ControlClient::owns_process() const noexcept {
  return transport_ && transport_->owns_process();
}

void ControlClient::handshake(const std::vector<std::string>& required_capabilities) {
  if (required_capabilities.size() > 64)
    throw SdkError("ARGUMENT_INVALID", "Required capabilities exceed the bounded set");
  std::set<std::string> unique(required_capabilities.begin(), required_capabilities.end());
  if (unique.size() != required_capabilities.size())
    throw SdkError("ARGUMENT_INVALID", "Duplicate required capability");
  hello_ = request("hello", {{"controlVersions", Json::array({1})},
                              {"requiredCapabilities", required_capabilities}});
  for (const auto& required : required_capabilities) {
    bool available = false;
    for (const auto& capability : hello_.at("capabilities"))
      if (capability.at("id") == required && capability.at("available") == true) {
        available = true; break;
      }
    if (!available) throw SdkError("CAPABILITY_UNAVAILABLE", "Required capability was not reported available: " + required);
  }
  handshaken_ = true;
}

Session ControlClient::open_session(const Json& args) {
  if (!handshaken_) throw SdkError("STATE_INVALID", "Control handshake is incomplete");
  Json result = request("session.open", args);
  const std::string session_id = require_string(result, "sessionId", 32);
  opaque_handle(session_id, "session ID");
  if (!sessions_.insert(session_id).second)
    throw SdkError("CONTROL_MALFORMED", "Duplicate session handle");
  return Session(lifetime_, session_id);
}

Json ControlClient::request(const std::string& operation, const Json& arguments,
                            std::chrono::milliseconds timeout) {
  if (closed_) throw SdkError("CONTROL_DISCONNECTED", "Control connection is closed");
  if (next_request_id_ > 9007199254740991ULL)
    throw SdkError("LIMIT", "Control request ID space exhausted");
  if (!arguments.is_object()) throw SdkError("ARGUMENT_INVALID", "Control arguments must be an object");
  const std::uint64_t request_id = next_request_id_++;
  Json request_value = {{"v", 1}, {"kind", "request"}, {"id", request_id},
                        {"op", operation}, {"args", arguments}};
  validate_control_request(request_value);
  const std::string encoded = encode_strict_json(request_value, kControlLimits);
  try { transport_->write_frame(encoded, kControlLimits.bytes); }
  catch (...) { close(); throw; }
  return receive_for(request_id, operation, timeout.count() > 0 ? timeout : request_timeout_);
}

Json ControlClient::receive_for(std::uint64_t request_id, const std::string& operation,
                                std::chrono::milliseconds timeout) {
  try {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (true) {
      const auto now = std::chrono::steady_clock::now();
      if (now >= deadline) throw SdkError("DEADLINE_EXCEEDED", "Control response deadline exceeded");
      Json message = parse_strict_json(transport_->read_frame(
          kControlLimits.bytes, std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now)),
          kControlLimits);
      if (!message.is_object()) throw SdkError("CONTROL_MALFORMED", "Control frame is not an object");
      const std::string kind = require_string(message, "kind", 16);
      if (kind == "event") { accept_event(message); continue; }
      if (kind != "response") throw SdkError("CONTROL_MALFORMED", "Unexpected control envelope kind");
      require_version_one(message);
      if (require_safe_id(message, "id") != request_id)
        throw SdkError("CONTROL_MALFORMED", "Unsolicited or incorrectly correlated response");
      if (!message.contains("ok") || !message.at("ok").is_boolean())
        throw SdkError("CONTROL_MALFORMED", "Invalid response status");
      if (message.at("ok").get<bool>()) {
        require_exact_fields(message, {"v", "kind", "id", "ok", "result"});
        validate_control_response_fixture(message, operation);
        return message.at("result");
      }
      require_exact_fields(message, {"v", "kind", "id", "ok", "error"});
      throw decode_control_error(message.at("error"));
    }
  } catch (const ServerError&) {
    throw;
  } catch (const SdkError&) {
    close();
    throw;
  } catch (const std::exception& error) {
    close();
    throw SdkError("CONTROL_MALFORMED", error.what());
  }
}

void ControlClient::accept_event(const Json& message) {
  validate_control_event_fixture(message);
  require_exact_fields(message, {"v", "kind", "seq", "sessionId", "event", "data"});
  require_version_one(message);
  if (require_safe_id(message, "seq") != next_event_sequence_++)
    throw SdkError("CONTROL_MALFORMED", "Control event sequence gap");
  const std::string session_id = require_string(message, "sessionId", 32);
  opaque_handle(session_id, "event session ID");
  if (!sessions_.count(session_id))
    throw SdkError("CONTROL_MALFORMED", "Event belongs to an unknown session");
  const std::string name = require_string(message, "event", 32);
  if (!one_of(name, {"operation.finished", "authoring.output", "build.output",
                     "worker.started", "worker.ready", "worker.exited",
                     "worker.closing", "session.closed"}))
    throw SdkError("CONTROL_MALFORMED", "Unknown control event");
  if (!message.at("data").is_object())
    throw SdkError("CONTROL_MALFORMED", "Invalid control event data");
  const Json& data = message.at("data");
  if (name == "operation.finished") {
    validate_operation_status(data);
    const auto operation_id = require_safe_id(data, "operationId");
    const auto operation = operations_.find(std::make_pair(session_id, operation_id));
    if (operation == operations_.end())
      throw SdkError("CONTROL_MALFORMED", "Finished event names an unaccepted operation");
    const auto status = data.at("status").get<std::string>();
    if (status == "pending") throw SdkError("CONTROL_MALFORMED", "Finished event is not terminal");
    if (status == "succeeded")
      validate_control_operation_fixture(data, operation->second);
  } else if (name == "authoring.output" || name == "build.output") {
    result_fields(data, {"operationId", "stream", "chunk", "bytesBase64"});
    const auto operation_id = require_safe_id(data, "operationId");
    const auto operation = operations_.find(std::make_pair(session_id, operation_id));
    if (operation == operations_.end() ||
        (name == "authoring.output" && operation->second != "CommandResult") ||
        (name == "build.output" && operation->second != "Prepared"))
      throw SdkError("CONTROL_MALFORMED", "Output event operation correlation mismatch");
    const auto stream = require_string(data, "stream", 8);
    if (!one_of(stream, {"stdout", "stderr"})) throw SdkError("CONTROL_MALFORMED", "Invalid output stream");
    const auto chunk = require_safe_id(data, "chunk");
    const auto key = session_id + ":" + std::to_string(operation_id) + ":" + stream;
    std::uint64_t& expected = output_chunks_[key];
    if (expected == 0) expected = 1;
    if (chunk != expected++) throw SdkError("CONTROL_MALFORMED", "Output chunk sequence gap");
    if (!canonical_base64(require_string(data, "bytesBase64", 21848)))
      throw SdkError("CONTROL_MALFORMED", "Invalid output base64");
  } else if (name == "worker.started" || name == "worker.ready") {
    result_fields(data, {"workerId"});
    const auto worker_id = require_string(data, "workerId", 32); opaque_handle(worker_id, "worker ID");
    const auto key = std::make_pair(session_id, worker_id);
    if (!workers_.count(key)) throw SdkError("CONTROL_MALFORMED", "Worker event names an unowned worker");
    auto& state = worker_states_[key];
    if ((name == "worker.started" && state != "reserved") ||
        (name == "worker.ready" && state != "started"))
      throw SdkError("CONTROL_MALFORMED", "Impossible worker event order");
    state = name == "worker.started" ? "started" : "ready";
  } else if (name == "worker.closing") {
    result_fields(data, {"workerId", "reason"});
    const auto worker_id = require_string(data, "workerId", 32);
    const auto key = std::make_pair(session_id, worker_id);
    if (!workers_.count(key)) throw SdkError("CONTROL_MALFORMED", "Closing event names an unowned worker");
    reason_arg(data); worker_states_[key] = "closing";
  } else if (name == "worker.exited") {
    result_fields(data, {"workerId", "reason"}, {"exitCode"});
    const auto worker_id = require_string(data, "workerId", 32);
    const auto key = std::make_pair(session_id, worker_id);
    if (!workers_.count(key)) throw SdkError("CONTROL_MALFORMED", "Exit event names an unowned worker");
    (void)require_string(data, "reason", 128);
    if (data.contains("exitCode") && !data.at("exitCode").is_number_integer())
      throw SdkError("CONTROL_MALFORMED", "Invalid worker exit code");
    worker_states_[key] = "exited";
  } else if (name == "session.closed") {
    result_fields(data, {"phase", "cleanupStatus", "remainingResources"});
    const auto phase = require_string(data, "phase", 16);
    const auto status = require_string(data, "cleanupStatus", 16);
    if (!one_of(phase, {"closed", "cleanupFailed"}) ||
        !one_of(status, {"succeeded", "failed"}) || !data.at("remainingResources").is_array())
      throw SdkError("CONTROL_MALFORMED", "Invalid session closed event");
  }
  const std::size_t encoded_size = message.dump().size() + 1;
  if (encoded_size > 4194304 - queued_event_bytes_)
    throw SdkError("LIMIT", "Control event queue limit exceeded");
  queued_event_bytes_ += encoded_size;
  events_.push_back(Event{next_event_sequence_ - 1, session_id, name, data});
}

void validate_control_operation_fixture(const Json& operation,
                                        const std::string& terminal_type) {
  validate_operation_status(operation);
  if (operation.at("status") != "succeeded") return;
  const Json& result = operation.at("result");
  if (terminal_type == "CommandResult") {
    result_fields(result, {"exitCode", "stdoutBytes", "stderrBytes"});
    if (!result.at("exitCode").is_number_integer())
      throw SdkError("CONTROL_MALFORMED", "Invalid command exit code");
    (void)nonnegative_count(result, "stdoutBytes");
    (void)nonnegative_count(result, "stderrBytes");
    return;
  }
  if (terminal_type == "Prepared") {
    result_fields(result, {"preparedRevision", "artifactId", "artifactHash",
        "manifestHash", "runtime", "policyId", "challenge"}, {"sourceHash"});
    if (require_safe_id(result, "preparedRevision") != 1)
      throw SdkError("CONTROL_MALFORMED", "Unsupported prepared revision");
    for (const char* field : {"artifactId", "challenge"})
      opaque_handle(require_string(result, field, 32), field);
    static const std::regex digest("^[0-9a-f]{64}$");
    for (const char* field : {"artifactHash", "manifestHash"})
      if (!std::regex_match(require_string(result, field, 64), digest))
        throw SdkError("CONTROL_MALFORMED", "Invalid prepared hash");
    if (result.contains("sourceHash") &&
        !std::regex_match(require_string(result, "sourceHash", 64), digest))
      throw SdkError("CONTROL_MALFORMED", "Invalid source hash");
    control_name(result, "runtime"); control_name(result, "policyId");
    return;
  }
  if (terminal_type == "CleanupResult") {
    validate_terminal_cleanup(result);
    return;
  }
  throw SdkError("CONTROL_MALFORMED", "Unknown terminal result contract");
}

void validate_control_result(const std::string& operation, const Json& result) {
  if (operation == "hello") {
    result_fields(result, {"controlVersion", "instanceId", "capabilities", "limits"});
    if (result.value("controlVersion", 0) != 1 || !result.at("capabilities").is_array() ||
        !result.at("limits").is_object()) throw SdkError("CONTROL_MALFORMED", "Invalid hello result");
    opaque_handle(require_string(result, "instanceId", 32), "instance ID");
    std::set<std::string> capability_ids;
    for (const auto& capability : result.at("capabilities")) {
      result_fields(capability, {"id", "available", "enforcedScope", "limits"}, {"reason"});
      const auto cap_id = require_string(capability, "id", 128);
      if (!valid_id(cap_id) || !capability_ids.insert(cap_id).second ||
          !capability.at("available").is_boolean() ||
          !capability.at("limits").is_object())
        throw SdkError("CONTROL_MALFORMED", "Invalid capability report");
      const auto scope = require_string(capability, "enforcedScope", 16);
      if (!one_of(scope, {"connection", "session", "command", "process", "host-uid", "host", "none"}))
        throw SdkError("CONTROL_MALFORMED", "Invalid capability scope");
      const bool available = capability.at("available").get<bool>();
      if ((!available && (!capability.contains("reason") || scope != "none")) ||
          (available && (capability.contains("reason") || scope == "none")))
        throw SdkError("CONTROL_MALFORMED", "Incoherent capability availability");
      if (capability.contains("reason") && !valid_id(require_string(capability, "reason", 128)))
        throw SdkError("CONTROL_MALFORMED", "Invalid capability reason");
      for (const auto& limit : capability.at("limits").items()) {
        if (!valid_id(limit.key())) throw SdkError("CONTROL_MALFORMED", "Invalid capability limit name");
        Json holder = {{"value", limit.value()}}; (void)require_safe_id(holder, "value");
      }
    }
    const Json& limits = result.at("limits");
    result_fields(limits, {"maxFrameBytes", "maxJsonDepth", "maxJsonNodes",
        "maxPendingOutputBytes", "maxSessionsPerConnection", "maxInflightRequestsPerConnection",
        "maxCompletedOperationsPerSession", "helloTimeoutMs", "requestAckTimeoutMs",
        "workerAttachmentTimeoutMs", "sessionWallMs", "gracefulStopMs", "teardownMs"});
    for (const char* field : {"maxFrameBytes", "maxJsonDepth", "maxJsonNodes",
        "maxPendingOutputBytes", "maxSessionsPerConnection", "maxInflightRequestsPerConnection",
        "maxCompletedOperationsPerSession", "helloTimeoutMs", "requestAckTimeoutMs",
        "workerAttachmentTimeoutMs", "sessionWallMs", "gracefulStopMs", "teardownMs"})
      (void)require_safe_id(limits, field);
  } else if (operation == "session.open") {
    result_fields(result, {"sessionId"});
    opaque_handle(require_string(result, "sessionId", 32), "session ID");
  } else if (operation == "authoring.exec" || operation == "session.prepare" ||
             operation == "session.cancel" || operation == "session.close") {
    result_fields(result, {"operationId"}); (void)require_safe_id(result, "operationId");
  } else if (operation == "session.authorize") {
    result_fields(result, {"authorizationId"});
    opaque_handle(require_string(result, "authorizationId", 32), "authorization ID");
  } else if (operation == "worker.acquire") {
    result_fields(result, {"workerId", "endpoint", "attachmentToken",
                           "attachmentTimeoutMs", "releaseMode"});
    opaque_handle(require_string(result, "workerId", 32), "worker ID");
    const Json& endpoint = result.at("endpoint");
    result_fields(endpoint, {"kind", "path"});
    if (require_string(endpoint, "kind", 16) != "unix")
      throw SdkError("CONTROL_MALFORMED", "Invalid endpoint kind");
    canonical_unix_endpoint(require_string(endpoint, "path", 107));
    static const std::regex token("^[0-9a-f]{64}$");
    if (!std::regex_match(require_string(result, "attachmentToken", 64), token))
      throw SdkError("CONTROL_MALFORMED", "Invalid attachment token");
    (void)require_safe_id(result, "attachmentTimeoutMs");
    if (require_string(result, "releaseMode", 32) != "control-v1")
      throw SdkError("CONTROL_MALFORMED", "Invalid release mode");
  } else if (operation == "worker.release") {
    result_fields(result, {"operationId", "cleanupMode"});
    (void)require_safe_id(result, "operationId");
    const auto mode = require_string(result, "cleanupMode", 32);
    if (!one_of(mode, {"dispose-then-terminate", "terminate-only"}))
      throw SdkError("CONTROL_MALFORMED", "Unknown Gate cleanup mode");
  } else if (operation == "operation.status") validate_operation_status(result);
  else if (operation == "session.status") {
    result_fields(result, {"phase", "resources", "cleanup"});
    if (!result.at("resources").is_object() || !result.at("cleanup").is_object())
      throw SdkError("CONTROL_MALFORMED", "Invalid session status");
    const auto phase = require_string(result, "phase", 16);
    if (!one_of(phase, {"open", "authoring", "preparing", "prepared", "authorized",
        "reserved", "starting", "running", "closing", "closed", "cleanupFailed"}))
      throw SdkError("CONTROL_MALFORMED", "Invalid session phase");
    const Json& resources = result.at("resources");
    result_fields(resources, {"authoringProcesses", "buildProcesses", "workers", "snapshots"});
    for (const char* field : {"authoringProcesses", "buildProcesses", "workers", "snapshots"})
      (void)nonnegative_count(resources, field);
    validate_cleanup(result.at("cleanup"));
  } else throw SdkError("CONTROL_MALFORMED", "Response for unknown requested operation");
}

void validate_control_response_fixture(const Json& response,
                                       const std::string& expected_operation) {
  if (!response.is_object()) throw SdkError("CONTROL_MALFORMED", "Response is not an object");
  require_version_one(response);
  if (require_string(response, "kind", 16) != "response")
    throw SdkError("CONTROL_MALFORMED", "Invalid response kind");
  (void)require_safe_id(response, "id");
  if (!response.contains("ok") || !response.at("ok").is_boolean())
    throw SdkError("CONTROL_MALFORMED", "Invalid response status");
  if (response.at("ok").get<bool>()) {
    require_exact_fields(response, {"v", "kind", "id", "ok", "result"});
    validate_control_result(expected_operation, response.at("result"));
  } else {
    require_exact_fields(response, {"v", "kind", "id", "ok", "error"});
    (void)decode_control_error(response.at("error"));
  }
}

void validate_control_event_fixture(const Json& message) {
  require_exact_fields(message, {"v", "kind", "seq", "sessionId", "event", "data"});
  require_version_one(message);
  if (require_string(message, "kind", 16) != "event")
    throw SdkError("CONTROL_MALFORMED", "Invalid event kind");
  (void)require_safe_id(message, "seq");
  opaque_handle(require_string(message, "sessionId", 32), "event session ID");
  const auto name = require_string(message, "event", 32);
  const Json& data = message.at("data");
  if (name == "operation.finished") {
    validate_operation_status(data);
    if (data.at("status") == "pending")
      throw SdkError("CONTROL_MALFORMED", "Finished event cannot be pending");
  }
  else if (name == "authoring.output" || name == "build.output") {
    result_fields(data, {"operationId", "stream", "chunk", "bytesBase64"});
    (void)require_safe_id(data, "operationId"); (void)require_safe_id(data, "chunk");
    const auto stream = require_string(data, "stream", 8);
    if (!one_of(stream, {"stdout", "stderr"}) ||
        !canonical_base64(require_string(data, "bytesBase64", 21848)))
      throw SdkError("CONTROL_MALFORMED", "Invalid output event");
  } else if (name == "worker.started" || name == "worker.ready") {
    result_fields(data, {"workerId"}); opaque_handle(require_string(data, "workerId", 32), "worker ID");
  } else if (name == "worker.closing") {
    result_fields(data, {"workerId", "reason"}); opaque_handle(require_string(data, "workerId", 32), "worker ID");
    const auto reason = require_string(data, "reason", 32);
    if (!one_of(reason, {"normal", "user-cancel", "deadline", "client-failure", "worker-failure"}))
      throw SdkError("CONTROL_MALFORMED", "Invalid worker closing reason");
  } else if (name == "worker.exited") {
    result_fields(data, {"workerId", "reason"}, {"exitCode"}); opaque_handle(require_string(data, "workerId", 32), "worker ID");
    const auto reason = require_string(data, "reason", 32);
    if (!one_of(reason, {"normal", "user-cancel", "deadline", "client-failure", "worker-failure"}))
      throw SdkError("CONTROL_MALFORMED", "Invalid worker exit reason");
    if (data.contains("exitCode") && !data.at("exitCode").is_number_integer())
      throw SdkError("CONTROL_MALFORMED", "Invalid worker exit code");
  } else if (name == "session.closed") {
    validate_terminal_cleanup(data);
  } else throw SdkError("CONTROL_MALFORMED", "Unknown control event");
}

Operation ControlClient::accepted(const std::string& session_id, const Json& result,
                                  const std::string& terminal_type, bool release) {
  if (!sessions_.count(session_id)) throw SdkError("HANDLE_INVALID", "Session is not owned by this connection");
  if (release) {
    const auto mode = require_string(result, "cleanupMode", 32);
    (void)mode;
  }
  const auto operation_id = require_safe_id(result, "operationId");
  const auto key = std::make_pair(session_id, operation_id);
  auto inserted = operations_.emplace(key, terminal_type);
  if (!inserted.second && inserted.first->second != terminal_type)
    throw SdkError("CONTROL_MALFORMED", "Operation ID reused with another result contract");
  return Operation(lifetime_, session_id, operation_id, terminal_type);
}

std::vector<Event> ControlClient::take_events() {
  std::vector<Event> result(events_.begin(), events_.end());
  events_.clear(); queued_event_bytes_ = 0; return result;
}

TransportCloseResult ControlClient::close_with_result() noexcept {
  if (!closed_) {
    closed_ = true;
    if (lifetime_) lifetime_->client = nullptr;
    if (transport_) transport_->close();
  }
  return transport_ ? transport_->close_result() : TransportCloseResult{};
}

void ControlClient::close() noexcept {
  (void)close_with_result();
}

}  // namespace mirrorgate
