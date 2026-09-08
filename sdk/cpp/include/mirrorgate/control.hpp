#pragma once

#include "mirrorgate/json.hpp"
#include "mirrorgate/transport.hpp"

#include <chrono>
#include <cstdint>
#include <deque>
#include <memory>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace mirrorgate {

struct ControlLifetime;

struct Event {
  std::uint64_t sequence;
  std::string session_id;
  std::string name;
  Json data;
};

class WorkerDescriptor {
 public:
  const std::string& worker_id() const noexcept { return worker_id_; }
  const std::string& endpoint_path() const noexcept { return endpoint_path_; }
  std::uint64_t attachment_timeout_ms() const noexcept { return attachment_timeout_ms_; }
  const std::string& release_mode() const noexcept { return release_mode_; }
 private:
  friend class Session;
  friend class ManagedWorker;
  std::string worker_id_;
  std::string endpoint_path_;
  std::string attachment_token_;
  std::uint64_t attachment_timeout_ms_ = 0;
  std::string release_mode_;
  std::string owner_session_id_;
  std::weak_ptr<ControlLifetime> owner_;
};

class Authorization {
 public:
  const std::string& id() const noexcept { return id_; }
 private:
  friend class Session;
  std::string id_;
  std::string owner_session_id_;
  std::weak_ptr<ControlLifetime> owner_;
};

// Exposed for shared cross-language fixture runners. Production calls validate
// the same record immediately before writing it.
void validate_control_request(const Json& request);
void validate_control_response_fixture(const Json& response,
                                       const std::string& expected_operation);
void validate_control_operation_fixture(const Json& operation,
                                        const std::string& terminal_type);
void validate_control_event_fixture(const Json& event);

class ControlClient;

class Operation {
 public:
  Operation() = default;
  Json status();
  Json wait(std::chrono::milliseconds timeout = std::chrono::seconds(30));
  std::uint64_t id() const noexcept { return operation_id_; }

 private:
  friend class ControlClient;
  friend class ManagedWorker;
  Operation(std::shared_ptr<ControlLifetime> owner, std::string session_id,
            std::uint64_t operation_id, std::string terminal_type);
  ControlClient& client() const;
  std::weak_ptr<ControlLifetime> owner_;
  std::string session_id_;
  std::uint64_t operation_id_ = 0;
  std::string terminal_type_;
};

class Session {
 public:
  Session() = default;
  const std::string& id() const noexcept { return session_id_; }
  Operation authoring_exec(const std::string& tool_id,
                           const std::vector<std::string>& arguments,
                           const std::string& cwd);
  Operation prepare();
  Authorization authorize(std::uint64_t prepared_revision,
                          const std::string& challenge,
                          const Json& attestation);
  WorkerDescriptor acquire_worker(const Authorization& authorization);
  Operation release_worker(const WorkerDescriptor& worker,
                           const std::string& reason = "normal",
                           std::string* cleanup_mode = nullptr);
  Operation cancel(const std::string& reason = "user-cancel");
  Operation close(const Json* outcome_summary = nullptr);
  Json status();

 private:
  friend class ControlClient;
  friend class ManagedWorker;
  Session(std::shared_ptr<ControlLifetime> owner, std::string session_id);
  ControlClient& client() const;
  std::weak_ptr<ControlLifetime> owner_;
  std::string session_id_;
};

class ControlClient {
 public:
  static std::unique_ptr<ControlClient> launch(
      const std::vector<std::string>& approved_argv,
      const std::vector<std::string>& required_capabilities,
      std::chrono::milliseconds request_timeout = std::chrono::seconds(5));
  static std::unique_ptr<ControlClient> connect(
      const std::string& unix_path,
      const std::vector<std::string>& required_capabilities,
      std::chrono::milliseconds request_timeout = std::chrono::seconds(5));
  static std::unique_ptr<ControlClient> from_transport(
      std::unique_ptr<Transport> transport,
      const std::vector<std::string>& required_capabilities,
      std::chrono::milliseconds request_timeout = std::chrono::seconds(5));

  ~ControlClient();
  ControlClient(const ControlClient&) = delete;
  ControlClient& operator=(const ControlClient&) = delete;

  const Json& hello_result() const noexcept { return hello_; }
  bool owns_process() const noexcept;
  Session open_session(const Json& args);
  Json request(const std::string& operation, const Json& arguments,
               std::chrono::milliseconds timeout = std::chrono::milliseconds(0));
  std::vector<Event> take_events();
  TransportCloseResult close_with_result() noexcept;
  void close() noexcept;

 private:
  friend class Session;
  friend class Operation;
  explicit ControlClient(std::unique_ptr<Transport> transport,
                         std::chrono::milliseconds request_timeout);
  void handshake(const std::vector<std::string>& required_capabilities);
  Json receive_for(std::uint64_t request_id, const std::string& operation,
                   std::chrono::milliseconds timeout);
  void accept_event(const Json& message);
  Operation accepted(const std::string& session_id, const Json& result,
                     const std::string& terminal_type, bool release = false);

  std::unique_ptr<Transport> transport_;
  std::chrono::milliseconds request_timeout_;
  std::uint64_t next_request_id_ = 1;
  std::uint64_t next_event_sequence_ = 1;
  Json hello_;
  std::set<std::string> sessions_;
  std::deque<Event> events_;
  bool handshaken_ = false;
  bool closed_ = false;
  std::shared_ptr<ControlLifetime> lifetime_;
  std::map<std::pair<std::string, std::uint64_t>, std::string> operations_;
  std::set<std::pair<std::string, std::string>> workers_;
  std::map<std::string, std::uint64_t> output_chunks_;
  std::map<std::pair<std::string, std::string>, std::string> worker_states_;
  std::size_t queued_event_bytes_ = 0;
};

}  // namespace mirrorgate
