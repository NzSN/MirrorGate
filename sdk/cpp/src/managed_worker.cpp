#include "mirrorgate/managed_worker.hpp"

#include <algorithm>
#include <chrono>
#include <regex>
#include <set>
#include <utility>

namespace mirrorgate {
namespace {

constexpr JsonLimits kWorkerLimits{65535, 96, 8192};
constexpr JsonLimits kManifestLimits{262144, 96, 8192};
constexpr JsonLimits kAttachmentLimits{4096, 128, 16384};
constexpr std::size_t kSemanticDepth = 32;

[[noreturn]] void value_bad(const std::string& message, const char* code = "VALUE") {
  throw SdkError(code, message);
}

bool valid_id(const std::string& value) {
  static const std::regex pattern("^[A-Za-z][A-Za-z0-9_.-]{0,127}$");
  return std::regex_match(value, pattern);
}

bool valid_digest(const std::string& value) {
  static const std::regex pattern("^[0-9a-f]{64}$");
  return std::regex_match(value, pattern);
}

bool valid_bigint(const std::string& value) {
  static const std::regex pattern("^(0|-?[1-9][0-9]*)$");
  return std::regex_match(value, pattern);
}

void check_type(const Json& type, std::size_t depth) {
  if (depth > kSemanticDepth) value_bad("Type depth limit exceeded", "LIMIT");
  if (!type.is_object() || !type.contains("kind") || !type.at("kind").is_string())
    value_bad("Invalid portable type", "SCHEMA");
  const auto kind = type.at("kind").get<std::string>();
  if (kind == "int" || kind == "bool" || kind == "str" || kind == "null") {
    require_exact_fields(type, {"kind"}, {}, "SCHEMA"); return;
  }
  if (kind == "seq" || kind == "set") {
    require_exact_fields(type, {"kind", "element"}, {}, "SCHEMA");
    check_type(type.at("element"), depth + 1); return;
  }
  if (kind == "tuple") {
    require_exact_fields(type, {"kind", "elements"}, {}, "SCHEMA");
    if (!type.at("elements").is_array()) value_bad("Invalid tuple type", "SCHEMA");
    for (const auto& child : type.at("elements")) check_type(child, depth + 1);
    return;
  }
  if (kind == "record") {
    require_exact_fields(type, {"kind", "fields"}, {}, "SCHEMA");
    if (!type.at("fields").is_array()) value_bad("Invalid record type", "SCHEMA");
    std::set<std::string> seen;
    for (const auto& field : type.at("fields")) {
      require_exact_fields(field, {"wireName", "type"}, {}, "SCHEMA");
      const auto name = require_string(field, "wireName", 128, "SCHEMA");
      if (name.empty() || !seen.insert(name).second) value_bad("Invalid record field", "SCHEMA");
      check_type(field.at("type"), depth + 1);
    }
    return;
  }
  if (kind == "map") {
    require_exact_fields(type, {"kind", "key", "value"}, {}, "SCHEMA");
    require_exact_fields(type.at("key"), {"kind"}, {}, "SCHEMA");
    if (type.at("key").at("kind") != "str") value_bad("Only string map keys are portable", "SCHEMA");
    check_type(type.at("value"), depth + 1); return;
  }
  if (kind == "variant") {
    require_exact_fields(type, {"kind", "cases"}, {}, "SCHEMA");
    if (!type.at("cases").is_array() || type.at("cases").empty())
      value_bad("Invalid variant type", "SCHEMA");
    std::set<std::string> seen;
    for (const auto& item : type.at("cases")) {
      require_exact_fields(item, {"tag", "payload"}, {}, "SCHEMA");
      const auto tag = require_string(item, "tag", 128, "SCHEMA");
      if (tag.empty() || !seen.insert(tag).second) value_bad("Invalid variant tag", "SCHEMA");
      check_type(item.at("payload"), depth + 1);
    }
    return;
  }
  value_bad("Unsupported portable type", "SCHEMA");
}

const Json& find_case(const Json& type, const std::string& tag) {
  for (const auto& item : type.at("cases")) if (item.at("tag") == tag) return item;
  value_bad("Unknown variant tag");
}

Json encode_value(const Json& type, const NativeValue& native, std::size_t depth);
NativeValue decode_value(const Json& type, const Json& wire, std::size_t depth);

std::string canonical(const Json& type, const Json& wire) {
  const auto kind = type.at("kind").get<std::string>();
  if (kind == "seq") {
    Json items = Json::array();
    for (const auto& item : wire) items.push_back(canonical(type.at("element"), item));
    return items.dump();
  }
  if (kind == "set") {
    std::vector<std::string> items;
    for (const auto& item : wire.at("#set")) items.push_back(canonical(type.at("element"), item));
    std::sort(items.begin(), items.end()); return Json(items).dump();
  }
  if (kind == "tuple") {
    Json items = Json::array();
    for (std::size_t i = 0; i < type.at("elements").size(); ++i)
      items.push_back(canonical(type.at("elements").at(i), wire.at("#tup").at(i)));
    return items.dump();
  }
  if (kind == "record") {
    std::vector<std::pair<std::string, std::string>> fields;
    for (const auto& field : type.at("fields")) {
      const auto name = field.at("wireName").get<std::string>();
      fields.emplace_back(name, canonical(field.at("type"), wire.at(name)));
    }
    std::sort(fields.begin(), fields.end()); return Json(fields).dump();
  }
  if (kind == "map") {
    std::vector<std::pair<std::string, std::string>> fields;
    for (const auto& item : wire.at("#map"))
      fields.emplace_back(item.at(0).get<std::string>(), canonical(type.at("value"), item.at(1)));
    std::sort(fields.begin(), fields.end()); return Json(fields).dump();
  }
  if (kind == "variant") {
    const auto tag = wire.at("tag").get<std::string>();
    return Json::array({tag, canonical(find_case(type, tag).at("payload"), wire.at("value"))}).dump();
  }
  return wire.dump();
}

Json encode_value(const Json& type, const NativeValue& native, std::size_t depth) {
  if (depth > kSemanticDepth) value_bad("Value depth limit exceeded", "LIMIT");
  const auto kind = type.at("kind").get<std::string>();
  if (kind == "int") {
    if (native.kind != NativeKind::bigint || !valid_bigint(native.text)) value_bad("Expected canonical native bigint");
    return Json{{"#bigint", native.text}};
  }
  if (kind == "bool") {
    if (native.kind != NativeKind::boolean) value_bad("Expected native boolean");
    return native.boolean;
  }
  if (kind == "str") {
    if (native.kind != NativeKind::string) value_bad("Expected native string");
    return native.text;
  }
  if (kind == "null") {
    if (native.kind != NativeKind::null_value) value_bad("Expected native null");
    return nullptr;
  }
  if (kind == "seq" || kind == "set") {
    const NativeKind expected = kind == "seq" ? NativeKind::sequence : NativeKind::set;
    if (native.kind != expected) value_bad("Native collection kind mismatch");
    Json items = Json::array(); std::set<std::string> seen;
    for (const auto& item : native.elements) {
      Json encoded = encode_value(type.at("element"), item, depth + 1);
      if (kind == "set" && !seen.insert(canonical(type.at("element"), encoded)).second)
        value_bad("Duplicate set element");
      items.push_back(std::move(encoded));
    }
    return kind == "seq" ? items : Json{{"#set", items}};
  }
  if (kind == "tuple") {
    if (native.kind != NativeKind::tuple || native.elements.size() != type.at("elements").size())
      value_bad("Tuple arity mismatch");
    Json items = Json::array();
    for (std::size_t i = 0; i < native.elements.size(); ++i)
      items.push_back(encode_value(type.at("elements").at(i), native.elements[i], depth + 1));
    return Json{{"#tup", items}};
  }
  if (kind == "record" || kind == "map") {
    const NativeKind expected = kind == "record" ? NativeKind::record : NativeKind::map;
    if (native.kind != expected) value_bad("Native keyed collection kind mismatch");
    std::map<std::string, const NativeValue*> input;
    for (const auto& field : native.fields)
      if (!input.emplace(field.first, &field.second).second) value_bad("Duplicate native key");
    if (kind == "record") {
      if (input.size() != type.at("fields").size()) value_bad("Record fields mismatch");
      Json result = Json::object();
      for (const auto& field : type.at("fields")) {
        const auto name = field.at("wireName").get<std::string>();
        auto it = input.find(name); if (it == input.end()) value_bad("Record fields mismatch");
        result[name] = encode_value(field.at("type"), *it->second, depth + 1);
      }
      return result;
    }
    Json entries = Json::array();
    for (const auto& field : native.fields)
      entries.push_back(Json::array({field.first, encode_value(type.at("value"), field.second, depth + 1)}));
    return Json{{"#map", entries}};
  }
  if (kind == "variant") {
    if (native.kind != NativeKind::variant || native.elements.size() != 1) value_bad("Expected native variant");
    return Json{{"tag", native.text}, {"value", encode_value(find_case(type, native.text).at("payload"), native.elements[0], depth + 1)}};
  }
  value_bad("Unsupported native type");
}

NativeValue decode_value(const Json& type, const Json& wire, std::size_t depth) {
  if (depth > kSemanticDepth) value_bad("Value depth limit exceeded", "LIMIT");
  const auto kind = type.at("kind").get<std::string>();
  if (kind == "int") {
    require_exact_fields(wire, {"#bigint"}, {}, "VALUE");
    const auto value = require_string(wire, "#bigint", kWorkerLimits.bytes, "VALUE");
    if (!valid_bigint(value)) value_bad("Invalid integer encoding");
    return NativeValue::bigint(value);
  }
  if (kind == "bool") { if (!wire.is_boolean()) value_bad("Expected boolean"); return NativeValue::boolean_value(wire.get<bool>()); }
  if (kind == "str") { if (!wire.is_string()) value_bad("Expected string"); return NativeValue::string(wire.get<std::string>()); }
  if (kind == "null") { if (!wire.is_null()) value_bad("Expected null"); return NativeValue::null(); }
  if (kind == "seq") {
    if (!wire.is_array()) value_bad("Expected sequence");
    std::vector<NativeValue> values;
    for (const auto& item : wire) values.push_back(decode_value(type.at("element"), item, depth + 1));
    return NativeValue::sequence(std::move(values));
  }
  if (kind == "set") {
    require_exact_fields(wire, {"#set"}, {}, "VALUE");
    if (!wire.at("#set").is_array()) value_bad("Expected set");
    std::vector<NativeValue> values; std::set<std::string> seen;
    for (const auto& item : wire.at("#set")) {
      if (!seen.insert(canonical(type.at("element"), item)).second) value_bad("Duplicate set element");
      values.push_back(decode_value(type.at("element"), item, depth + 1));
    }
    return NativeValue::set(std::move(values));
  }
  if (kind == "tuple") {
    require_exact_fields(wire, {"#tup"}, {}, "VALUE");
    if (!wire.at("#tup").is_array() || wire.at("#tup").size() != type.at("elements").size()) value_bad("Tuple arity mismatch");
    std::vector<NativeValue> values;
    for (std::size_t i = 0; i < type.at("elements").size(); ++i)
      values.push_back(decode_value(type.at("elements").at(i), wire.at("#tup").at(i), depth + 1));
    return NativeValue::tuple(std::move(values));
  }
  if (kind == "record") {
    std::vector<std::string> names; for (const auto& field : type.at("fields")) names.push_back(field.at("wireName"));
    require_exact_fields(wire, names, {}, "VALUE"); std::vector<std::pair<std::string, NativeValue>> fields;
    for (const auto& field : type.at("fields")) { const auto name = field.at("wireName").get<std::string>(); fields.emplace_back(name, decode_value(field.at("type"), wire.at(name), depth + 1)); }
    return NativeValue::record(std::move(fields));
  }
  if (kind == "map") {
    require_exact_fields(wire, {"#map"}, {}, "VALUE");
    if (!wire.at("#map").is_array()) value_bad("Expected map");
    std::set<std::string> seen; std::vector<std::pair<std::string, NativeValue>> fields;
    for (const auto& item : wire.at("#map")) {
      if (!item.is_array() || item.size() != 2 || !item.at(0).is_string()) value_bad("Invalid map entry");
      const auto key = item.at(0).get<std::string>(); if (!seen.insert(key).second) value_bad("Duplicate map key");
      fields.emplace_back(key, decode_value(type.at("value"), item.at(1), depth + 1));
    }
    return NativeValue::map(std::move(fields));
  }
  if (kind == "variant") {
    require_exact_fields(wire, {"tag", "value"}, {}, "VALUE");
    if (!wire.at("tag").is_string()) value_bad("Invalid variant tag");
    const auto tag = wire.at("tag").get<std::string>();
    return NativeValue::variant(tag, decode_value(find_case(type, tag).at("payload"), wire.at("value"), depth + 1));
  }
  value_bad("Unsupported wire type");
}

const Json* find_operation(const Json& manifest, const std::string& id) {
  for (const char* collection : {"initializers", "actions"})
    for (const auto& operation : manifest.at(collection)) if (operation.at("id") == id) return &operation;
  return nullptr;
}

void validate_field_declarations(const Json& fields, std::set<std::string>& seen) {
  if (!fields.is_array()) value_bad("Invalid field declarations", "SCHEMA");
  for (const auto& field : fields) {
    require_exact_fields(field, {"id", "type"}, {}, "SCHEMA");
    const auto id = require_string(field, "id", 128, "SCHEMA");
    if (!valid_id(id) || !seen.insert(id).second) value_bad("Invalid or duplicate field ID", "SCHEMA");
    check_type(field.at("type"), 0);
  }
}

}  // namespace

NativeValue NativeValue::null() { return {}; }
NativeValue NativeValue::boolean_value(bool value) { NativeValue r; r.kind = NativeKind::boolean; r.boolean = value; return r; }
NativeValue NativeValue::bigint(std::string value) { NativeValue r; r.kind = NativeKind::bigint; r.text = std::move(value); return r; }
NativeValue NativeValue::string(std::string value) { NativeValue r; r.kind = NativeKind::string; r.text = std::move(value); return r; }
NativeValue NativeValue::sequence(std::vector<NativeValue> values) { NativeValue r; r.kind = NativeKind::sequence; r.elements = std::move(values); return r; }
NativeValue NativeValue::set(std::vector<NativeValue> values) { NativeValue r; r.kind = NativeKind::set; r.elements = std::move(values); return r; }
NativeValue NativeValue::tuple(std::vector<NativeValue> values) { NativeValue r; r.kind = NativeKind::tuple; r.elements = std::move(values); return r; }
NativeValue NativeValue::record(std::vector<std::pair<std::string, NativeValue>> values) { NativeValue r; r.kind = NativeKind::record; r.fields = std::move(values); return r; }
NativeValue NativeValue::map(std::vector<std::pair<std::string, NativeValue>> values) { NativeValue r; r.kind = NativeKind::map; r.fields = std::move(values); return r; }
NativeValue NativeValue::variant(std::string tag, NativeValue payload) { NativeValue r; r.kind = NativeKind::variant; r.text = std::move(tag); r.elements.push_back(std::move(payload)); return r; }

NativeValue decode_portable_value(const Json& type, const Json& wire) {
  check_type(type, 0);
  return decode_value(type, wire, 0);
}

Json encode_portable_value(const Json& type, const NativeValue& value) {
  check_type(type, 0);
  return encode_value(type, value, 0);
}

void validate_attachment_fixture(const Json& value, bool acknowledgement) {
  if (acknowledgement)
    require_exact_fields(value, {"v", "kind", "sessionId", "workerId"}, {}, "ATTACHMENT_FAILED");
  else
    require_exact_fields(value, {"v", "kind", "sessionId", "workerId", "attachmentToken"}, {}, "ATTACHMENT_FAILED");
  if (!value.at("v").is_number_integer() || value.at("v") != 1 ||
      !value.at("kind").is_string() || value.at("kind") != (acknowledgement ? "attached" : "attach"))
    throw SdkError("ATTACHMENT_FAILED", "Invalid attachment envelope");
  static const std::regex handle("^[0-9a-f]{32}$");
  for (const char* field : {"sessionId", "workerId"})
    if (!std::regex_match(require_string(value, field, 32, "ATTACHMENT_FAILED"), handle))
      throw SdkError("ATTACHMENT_FAILED", "Invalid attachment handle");
  if (!acknowledgement) {
    static const std::regex token("^[0-9a-f]{64}$");
    if (!std::regex_match(require_string(value, "attachmentToken", 64, "ATTACHMENT_FAILED"), token))
      throw SdkError("ATTACHMENT_FAILED", "Invalid attachment token");
  }
}

Manifest Manifest::parse(const std::string& exact_json) {
  Manifest result; result.document_ = parse_strict_json(exact_json, kManifestLimits);
  require_exact_fields(result.document_, {"schema", "interfaceDigest", "initializers", "actions", "observations"}, {}, "SCHEMA");
  if (result.document_.at("schema") != "mirrorgate.port/v1") value_bad("Invalid manifest schema", "SCHEMA");
  result.interface_digest_ = require_string(result.document_, "interfaceDigest", 64, "SCHEMA");
  if (!valid_digest(result.interface_digest_)) value_bad("Invalid interface digest", "SCHEMA");
  if (!result.document_.at("initializers").is_array() || result.document_.at("initializers").empty() ||
      !result.document_.at("actions").is_array() || !result.document_.at("observations").is_array() ||
      result.document_.at("observations").empty()) value_bad("Invalid manifest collections", "SCHEMA");
  std::set<std::string> operations;
  for (const char* collection : {"initializers", "actions"}) for (const auto& operation : result.document_.at(collection)) {
    require_exact_fields(operation, {"id", "inputs"}, {}, "SCHEMA"); const auto id = require_string(operation, "id", 128, "SCHEMA");
    if (!valid_id(id) || !operations.insert(id).second) value_bad("Invalid or duplicate operation ID", "SCHEMA");
    std::set<std::string> inputs; validate_field_declarations(operation.at("inputs"), inputs);
  }
  std::set<std::string> observations; validate_field_declarations(result.document_.at("observations"), observations);
  result.exact_json_ = exact_json; return result;
}

Json Manifest::encode_inputs(const std::string& operation, const NativeFields& values) const {
  const Json* declaration = find_operation(document_, operation);
  if (!declaration) value_bad("Unknown public operation");
  if (values.size() != declaration->at("inputs").size()) value_bad("Input fields mismatch");
  Json result = Json::object();
  for (const auto& field : declaration->at("inputs")) {
    const auto id = field.at("id").get<std::string>(); auto it = values.find(id);
    if (it == values.end()) value_bad("Input fields mismatch");
    result[id] = encode_value(field.at("type"), it->second, 0);
  }
  return result;
}

NativeFields Manifest::decode_observations(const Json& values) const {
  std::vector<std::string> names; for (const auto& field : document_.at("observations")) names.push_back(field.at("id"));
  require_exact_fields(values, names, {}, "VALUE"); NativeFields result;
  for (const auto& field : document_.at("observations")) { const auto id = field.at("id").get<std::string>(); result.emplace(id, decode_value(field.at("type"), values.at(id), 0)); }
  return result;
}

bool Manifest::is_initializer(const std::string& operation) const { for (const auto& item : document_.at("initializers")) if (item.at("id") == operation) return true; return false; }
bool Manifest::has_operation(const std::string& operation) const { return find_operation(document_, operation) != nullptr; }

ManagedWorker::ManagedWorker(Session& session, WorkerDescriptor descriptor, Manifest manifest,
                             std::string runtime, std::unique_ptr<Transport> transport)
    : session_(session), descriptor_(std::move(descriptor)), manifest_(std::move(manifest)),
      runtime_(std::move(runtime)), transport_(std::move(transport)) {}

std::unique_ptr<ManagedWorker> ManagedWorker::attach(Session& session,
    WorkerDescriptor descriptor, Manifest manifest, std::string runtime) {
  auto session_owner = session.owner_.lock();
  auto descriptor_owner = descriptor.owner_.lock();
  if (!session_owner || session_owner != descriptor_owner ||
      descriptor.owner_session_id_ != session.id())
    throw SdkError("HANDLE_INVALID", "Worker descriptor is not owned by this session");
  std::unique_ptr<Transport> transport;
  try { transport = connect_unix(descriptor.endpoint_path_); }
  catch (const SdkError&) {
    try { session.release_worker(descriptor, "client-failure").wait(); } catch (...) {}
    throw;
  }
  std::unique_ptr<ManagedWorker> worker(new ManagedWorker(session, std::move(descriptor), std::move(manifest), std::move(runtime), std::move(transport)));
  try {
    worker->attachment_handshake();
    CallOptions startup; startup.timeout = std::chrono::milliseconds(worker->descriptor_.attachment_timeout_ms_);
    Json hello = worker->call("hello", {{"interfaceDigest", worker->manifest_.interface_digest()}, {"runtime", worker->runtime_}}, startup);
    require_exact_fields(hello, {"interfaceDigest", "runtime"}, {}, "SCHEMA");
    if (hello.at("interfaceDigest") != worker->manifest_.interface_digest() || hello.at("runtime") != worker->runtime_)
      throw SdkError("HANDSHAKE", "Worker identity mismatch");
    worker->state_ = State::await_create;
    Json created = worker->call("create", Json::object(), startup);
    if (!created.is_null()) throw SdkError("SCHEMA", "Create result must be null");
    worker->state_ = State::need_initializer;
    return worker;
  } catch (const SdkError& error) {
    worker->remember_primary(error);
    try { worker->close("client-failure"); } catch (...) {}
    throw;
  } catch (const std::exception& error) {
    SdkError wrapped("WORKER_PROTOCOL_FAILED", error.what());
    worker->remember_primary(wrapped);
    try { worker->close("client-failure"); } catch (...) {}
    throw wrapped;
  }
}

ManagedWorker::~ManagedWorker() { try { close(primary_error_ ? "client-failure" : "normal"); } catch (...) {} }

void ManagedWorker::attachment_handshake() {
  Json request = {{"v", 1}, {"kind", "attach"}, {"sessionId", session_.id()},
                  {"workerId", descriptor_.worker_id_}, {"attachmentToken", descriptor_.attachment_token_}};
  validate_attachment_fixture(request, false);
  transport_->write_frame(encode_strict_json(request, kAttachmentLimits), kAttachmentLimits.bytes);
  Json reply = parse_strict_json(transport_->read_frame(kAttachmentLimits.bytes,
      std::chrono::milliseconds(descriptor_.attachment_timeout_ms_)), kAttachmentLimits);
  validate_attachment_fixture(reply, true);
  if (reply.value("v", 0) != 1 || reply.value("kind", "") != "attached" ||
      reply.value("sessionId", "") != session_.id() || reply.value("workerId", "") != descriptor_.worker_id_)
    throw SdkError("ATTACHMENT_FAILED", "Invalid broker attachment acknowledgement");
}

Json ManagedWorker::call(const std::string& operation, Json fields, const CallOptions& options) {
  if (state_ == State::poisoned || state_ == State::closed) throw SdkError("LIFECYCLE", "Worker is unavailable");
  if (options.timeout.count() < 1) throw SdkError("SCHEMA", "Invalid worker deadline");
  if (options.cancelled && options.cancelled())
    throw SdkError("CANCELLED", "Worker operation cancelled before dispatch");
  if (next_id_ > 9007199254740991ULL) throw SdkError("LIMIT", "Worker request ID exhausted");
  const std::uint64_t id = next_id_++;
  Json request = {{"v", 1}, {"id", id}, {"op", operation}};
  for (auto it = fields.begin(); it != fields.end(); ++it) request[it.key()] = it.value();
  const std::string encoded = encode_strict_json(request, kWorkerLimits);
  try {
    transport_->write_frame(encoded, kWorkerLimits.bytes);
    return receive_response(id, operation, options);
  } catch (const SdkError& error) {
    state_ = State::poisoned; remember_primary(error);
    if (error.code != "CANCELLED" && error.code != "DEADLINE_EXCEEDED")
      start_gate_cleanup("client-failure");
    throw;
  } catch (const std::exception& error) {
    SdkError wrapped("WORKER_PROTOCOL_FAILED", error.what());
    state_ = State::poisoned; remember_primary(wrapped);
    start_gate_cleanup("client-failure");
    throw wrapped;
  }
}

Json ManagedWorker::receive_response(std::uint64_t id, const std::string& operation,
                                     const CallOptions& options) {
  const auto deadline = std::chrono::steady_clock::now() + options.timeout;
  while (true) {
    if (options.cancelled && options.cancelled()) { cancel_pending(id, "user-cancel"); throw SdkError("CANCELLED", "Worker operation cancelled"); }
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) { cancel_pending(id, "deadline"); throw SdkError("DEADLINE_EXCEEDED", "Worker operation deadline exceeded"); }
    try {
      Json response = parse_strict_json(transport_->read_frame(kWorkerLimits.bytes,
          std::min(std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now), std::chrono::milliseconds(10))), kWorkerLimits);
      validate_worker_response(response, id);
      if (!response.at("ok").get<bool>()) {
        const Json& error = response.at("error");
        throw SdkError(error.at("code").get<std::string>(), error.at("message").get<std::string>());
      }
      Json result = response.at("result");
      if (operation != "hello" && operation != "observe" && !result.is_null())
        throw SdkError("SCHEMA", "Worker result must be null");
      return result;
    } catch (const SdkError& error) {
      if (error.code == "DEADLINE_EXCEEDED") continue;
      throw;
    }
  }
}

void ManagedWorker::validate_worker_response(const Json& response, std::uint64_t id) {
  if (!response.is_object() || !response.contains("v") || !response.at("v").is_number_integer() ||
      response.at("v") != 1 || require_safe_id(response, "id", "SCHEMA") != id ||
      !response.contains("ok") || !response.at("ok").is_boolean()) throw SdkError("SCHEMA", "Invalid or uncorrelated worker response");
  if (response.at("ok").get<bool>()) require_exact_fields(response, {"v", "id", "ok", "result"}, {}, "SCHEMA");
  else {
    require_exact_fields(response, {"v", "id", "ok", "error"}, {}, "SCHEMA");
    require_exact_fields(response.at("error"), {"code", "message"}, {}, "SCHEMA");
    const auto code = require_string(response.at("error"), "code", 64, "SCHEMA");
    static const std::regex error_code("^[A-Z][A-Z0-9_]{0,63}$");
    if (!std::regex_match(code, error_code)) throw SdkError("SCHEMA", "Invalid worker error code");
    (void)require_string(response.at("error"), "message", 1024, "SCHEMA");
  }
}

void ManagedWorker::cancel_pending(std::uint64_t id, const std::string& reason) {
  start_gate_cleanup(reason);
  if (next_id_ > 9007199254740991ULL) return;
  const std::uint64_t cancel_id = next_id_++;
  try {
    transport_->write_frame(encode_strict_json({{"v", 1}, {"id", cancel_id}, {"op", "cancel"}, {"requestId", id}}, kWorkerLimits), kWorkerLimits.bytes);
    Json original = parse_strict_json(transport_->read_frame(kWorkerLimits.bytes, std::chrono::milliseconds(250)), kWorkerLimits);
    validate_worker_response(original, id);
    if (original.at("ok").get<bool>() || original.at("error").at("code") != "CANCELLED") throw SdkError("SCHEMA", "Invalid cancelled operation outcome");
    Json acknowledgement = parse_strict_json(transport_->read_frame(kWorkerLimits.bytes, std::chrono::milliseconds(250)), kWorkerLimits);
    validate_worker_response(acknowledgement, cancel_id);
    if (!acknowledgement.at("ok").get<bool>() || !acknowledgement.at("result").is_null()) throw SdkError("SCHEMA", "Invalid cancel acknowledgement");
  } catch (...) { /* Gate cancellation already owns forced termination. */ }
}

void ManagedWorker::start_gate_cleanup(const std::string& reason) {
  if (session_cleanup_) return;
  try {
    Operation operation = session_.cancel(reason);
    session_cleanup_.reset(new Operation(std::move(operation)));
  } catch (...) {
    // Preserve the primary worker/transport failure. Control EOF still owns
    // cleanup of this connection's session when no acknowledgement is possible.
  }
}

void ManagedWorker::invoke(const std::string& operation, const NativeFields& inputs,
                           const CallOptions& options) {
  if ((state_ != State::need_initializer && state_ != State::ready_action) ||
      (state_ == State::need_initializer && !manifest_.is_initializer(operation)))
    throw SdkError("LIFECYCLE", "Worker invocation is not valid in this state");
  Json result = call("invoke", {{"action", operation}, {"inputs", manifest_.encode_inputs(operation, inputs)}}, options);
  if (!result.is_null()) throw SdkError("SCHEMA", "Invoke result must be null");
  state_ = State::need_observe;
}

NativeFields ManagedWorker::observe(const CallOptions& options) {
  if (state_ != State::need_observe) throw SdkError("LIFECYCLE", "Observation requires a completed invocation");
  Json result = call("observe", Json::object(), options);
  NativeFields observations;
  try { observations = manifest_.decode_observations(result); }
  catch (const SdkError& error) {
    state_ = State::poisoned; remember_primary(error);
    start_gate_cleanup("worker-failure");
    throw;
  }
  state_ = State::ready_action; return observations;
}

void ManagedWorker::remember_primary(const SdkError& error) {
  if (!primary_error_) primary_error_.reset(new SdkError(error.code, error.stage, error.what(), error.operation_id));
}

void ManagedWorker::close(const std::string& reason) {
  if (released_) return;
  released_ = true;
  std::string cleanup_mode;
  const bool had_primary = static_cast<bool>(primary_error_);
  std::unique_ptr<SdkError> cleanup_error;
  if (session_cleanup_) {
    state_ = State::closed;
    if (transport_) transport_->close();
    try { session_cleanup_->wait(); }
    catch (const SdkError&) { if (!had_primary) throw; }
    return;
  }
  try {
    Operation release = session_.release_worker(descriptor_, reason, &cleanup_mode);
    // Gate arms closing and owns the forced-stop timer. The native request-ID
    // owner may send exactly one cooperative dispose only when Gate says it is safe.
    if (cleanup_mode == "dispose-then-terminate" && transport_) {
      try {
        const State prior = state_;
        if (prior != State::closed) {
          Json result = call("dispose", Json::object(), CallOptions{});
          if (!result.is_null()) throw SdkError("SCHEMA", "Dispose result must be null");
        }
      } catch (const SdkError& error) {
        cleanup_error.reset(new SdkError(error.code, error.stage, error.what(), error.operation_id));
        remember_primary(error);
      }
    }
    state_ = State::closed;
    if (transport_) transport_->close();
    release.wait();
    if (cleanup_error && !had_primary) throw *cleanup_error;
  } catch (const SdkError&) {
    state_ = State::closed;
    if (transport_) transport_->close();
    if (!had_primary) throw;
  }
}

}  // namespace mirrorgate
