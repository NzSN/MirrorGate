#pragma once

#include <chrono>
#include <cstddef>
#include <memory>
#include <string>
#include <vector>

namespace mirrorgate {

enum class ProcessCloseState {
  not_owned,
  exited,
  signaled,
  reaped_unknown,
  unconfirmed,
};

struct TransportCloseResult {
  bool transport_closed = false;
  bool process_owned = false;
  ProcessCloseState process_state = ProcessCloseState::unconfirmed;
  int exit_code = -1;
  int signal = -1;
  bool terminate_requested = false;
  bool kill_requested = false;

  bool process_shutdown_confirmed() const noexcept {
    return transport_closed && (!process_owned ||
        process_state == ProcessCloseState::exited ||
        process_state == ProcessCloseState::signaled ||
        process_state == ProcessCloseState::reaped_unknown);
  }
};

const char* process_close_state_name(ProcessCloseState state) noexcept;

class Transport {
 public:
  virtual ~Transport() = default;
  virtual void write_frame(const std::string& payload, std::size_t max_bytes) = 0;
  virtual std::string read_frame(std::size_t max_bytes,
                                 std::chrono::milliseconds timeout) = 0;
  virtual void close() noexcept = 0;
  virtual bool owns_process() const noexcept = 0;
  // Custom transports fail closed for an owned-process receipt unless they
  // override this after a bounded close. Attached transports need no process
  // receipt and retain their distinct connection-only ownership.
  virtual TransportCloseResult close_result() const noexcept {
    TransportCloseResult result;
    result.process_owned = owns_process();
    result.process_state = result.process_owned
        ? ProcessCloseState::unconfirmed : ProcessCloseState::not_owned;
    return result;
  }
};

std::unique_ptr<Transport> launch_stdio(
    const std::vector<std::string>& argv,
    std::size_t stderr_limit = 65536,
    std::chrono::milliseconds io_timeout = std::chrono::seconds(5),
    std::chrono::milliseconds close_timeout = std::chrono::seconds(5));
std::unique_ptr<Transport> connect_unix(
    const std::string& path,
    std::chrono::milliseconds connect_timeout = std::chrono::seconds(5),
    std::chrono::milliseconds io_timeout = std::chrono::seconds(5));

}  // namespace mirrorgate
