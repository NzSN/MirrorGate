#pragma once

#include "mirrorgate/control.hpp"

#include <chrono>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace mirrorgate {

enum class NativeKind {
  null_value, boolean, bigint, string, sequence, set, tuple, record, map, variant
};

struct NativeValue {
  NativeKind kind = NativeKind::null_value;
  bool boolean = false;
  std::string text;
  std::vector<NativeValue> elements;
  std::vector<std::pair<std::string, NativeValue>> fields;

  static NativeValue null();
  static NativeValue boolean_value(bool value);
  static NativeValue bigint(std::string decimal);
  static NativeValue string(std::string value);
  static NativeValue sequence(std::vector<NativeValue> values);
  static NativeValue set(std::vector<NativeValue> values);
  static NativeValue tuple(std::vector<NativeValue> values);
  static NativeValue record(std::vector<std::pair<std::string, NativeValue>> values);
  static NativeValue map(std::vector<std::pair<std::string, NativeValue>> values);
  static NativeValue variant(std::string tag, NativeValue payload);
};

using NativeFields = std::map<std::string, NativeValue>;

NativeValue decode_portable_value(const Json& type, const Json& wire);
Json encode_portable_value(const Json& type, const NativeValue& value);
void validate_attachment_fixture(const Json& value, bool acknowledgement);

class Manifest {
 public:
  static Manifest parse(const std::string& exact_json);
  const std::string& exact_json() const noexcept { return exact_json_; }
  const std::string& interface_digest() const noexcept { return interface_digest_; }
  Json encode_inputs(const std::string& operation, const NativeFields& values) const;
  NativeFields decode_observations(const Json& values) const;
  bool is_initializer(const std::string& operation) const;
  bool has_operation(const std::string& operation) const;

 private:
  Json document_;
  std::string exact_json_;
  std::string interface_digest_;
};

struct CallOptions {
  std::chrono::milliseconds timeout{10000};
  std::function<bool()> cancelled;
};

class ManagedWorker {
 public:
  static std::unique_ptr<ManagedWorker> attach(
      Session& session, WorkerDescriptor descriptor, Manifest manifest,
      std::string runtime);
  ~ManagedWorker();
  ManagedWorker(const ManagedWorker&) = delete;
  ManagedWorker& operator=(const ManagedWorker&) = delete;

  void invoke(const std::string& operation, const NativeFields& inputs,
              const CallOptions& options = {});
  NativeFields observe(const CallOptions& options = {});
  void close(const std::string& reason = "normal");

 private:
  enum class State { await_hello, await_create, need_initializer, need_observe,
                     ready_action, poisoned, closed };
  ManagedWorker(Session& session, WorkerDescriptor descriptor, Manifest manifest,
                std::string runtime, std::unique_ptr<Transport> transport);
  void attachment_handshake();
  Json call(const std::string& operation, Json fields, const CallOptions& options);
  Json receive_response(std::uint64_t id, const std::string& operation,
                        const CallOptions& options);
  void validate_worker_response(const Json& response, std::uint64_t id);
  void cancel_pending(std::uint64_t id, const std::string& reason);
  void start_gate_cleanup(const std::string& reason);
  void remember_primary(const SdkError& error);

  Session session_;
  WorkerDescriptor descriptor_;
  Manifest manifest_;
  std::string runtime_;
  std::unique_ptr<Transport> transport_;
  State state_ = State::await_hello;
  std::uint64_t next_id_ = 1;
  bool released_ = false;
  std::unique_ptr<SdkError> primary_error_;
  std::unique_ptr<Operation> session_cleanup_;
};

}  // namespace mirrorgate
