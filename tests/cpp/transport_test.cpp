#include "mirrorgate/json.hpp"
#include "mirrorgate/transport.hpp"

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <future>
#include <iostream>
#include <signal.h>
#include <stdexcept>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <thread>
#include <unistd.h>

using mirrorgate::SdkError;
using namespace std::chrono_literals;

namespace {
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

struct ThreadJoiner {
  std::thread& thread;
  int listener_fd;
  ~ThreadJoiner() {
    if (thread.joinable()) {
      (void)::shutdown(listener_fd, SHUT_RDWR);
      thread.join();
    }
  }
};

struct Listener {
  std::string directory;
  std::string path;
  int fd = -1;
  Listener() {
    char pattern[] = "/tmp/mg-cpp-transport-XXXXXX";
    char* made = ::mkdtemp(pattern);
    if (!made) throw std::runtime_error("mkdtemp failed");
    directory = made;
    path = directory + "/transport.sock";
    fd = ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) throw std::runtime_error("socket failed");
    struct sockaddr_un address {};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
    if (::bind(fd, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) < 0)
      throw std::runtime_error(std::string("bind failed: ") + std::strerror(errno));
    if (::chmod(path.c_str(), 0600) < 0)
      throw std::runtime_error(std::string("chmod failed: ") + std::strerror(errno));
    if (::listen(fd, 1) < 0)
      throw std::runtime_error(std::string("listen failed: ") + std::strerror(errno));
  }
  ~Listener() {
    if (fd >= 0) ::close(fd);
    if (!path.empty()) ::unlink(path.c_str());
    if (!directory.empty()) ::rmdir(directory.c_str());
  }
};

void send_all(int fd, const std::string& bytes) {
  std::size_t at = 0;
  while (at < bytes.size()) {
    const ssize_t count = ::send(fd, bytes.data() + at, bytes.size() - at, MSG_NOSIGNAL);
    if (count > 0) at += static_cast<std::size_t>(count);
    else if (count < 0 && errno == EINTR) continue;
    else return;
  }
}

void with_server(const std::string& bytes, const std::function<void(const std::string&)>& client,
                 std::chrono::milliseconds hold = 0ms) {
  Listener listener;
  std::thread server([&] {
    const int connection = ::accept4(listener.fd, nullptr, nullptr, SOCK_CLOEXEC);
    if (connection >= 0) {
      send_all(connection, bytes);
      if (hold.count()) std::this_thread::sleep_for(hold);
      ::close(connection);
    }
  });
  ThreadJoiner server_joiner {server, listener.fd};
  client(listener.path);
  server.join();
}

void expect_code(const std::string& code, const std::function<void()>& body) {
  try { body(); }
  catch (const SdkError& error) { require(error.code == code, "unexpected SDK error code"); return; }
  throw std::runtime_error("expected SDK error");
}

void test_buffered_frames_and_limits() {
  with_server("first\nsecond\n", [](const std::string& path) {
    auto transport = mirrorgate::connect_unix(path, 1s, 1s);
    require(transport->read_frame(5, 1s) == "first", "first coalesced frame mismatch");
    require(transport->read_frame(6, 1s) == "second", "buffered tail was lost");
    transport->close();
    const auto receipt = transport->close_result();
    require(receipt.transport_closed && !receipt.process_owned &&
                receipt.process_state == mirrorgate::ProcessCloseState::not_owned,
            "attached transport close receipt was not confirmed separately");
  });
  with_server(std::string(17, 'x') + "\n", [](const std::string& path) {
    auto transport = mirrorgate::connect_unix(path, 1s, 1s);
    expect_code("LIMIT", [&] { (void)transport->read_frame(16, 1s); });
  });
  with_server("partial", [](const std::string& path) {
    auto transport = mirrorgate::connect_unix(path, 1s, 1s);
    expect_code("CONTROL_MALFORMED", [&] { (void)transport->read_frame(16, 1s); });
  });
}

void test_write_deadline_and_sigpipe() {
  Listener stalled;
  std::thread server([&] {
    const int connection = ::accept4(stalled.fd, nullptr, nullptr, SOCK_CLOEXEC);
    std::this_thread::sleep_for(300ms);
    if (connection >= 0) ::close(connection);
  });
  ThreadJoiner server_joiner {server, stalled.fd};
  auto transport = mirrorgate::connect_unix(stalled.path, 1s, 50ms);
  expect_code("DEADLINE_EXCEEDED", [&] { transport->write_frame(std::string(1024 * 1024, 'x'), 1024 * 1024); });
  transport->close();
  server.join();

  Listener closed_listener;
  std::promise<void> peer_closed;
  auto peer_closed_future = peer_closed.get_future();
  std::thread closed_server([&] {
    try {
      const int connection = ::accept4(closed_listener.fd, nullptr, nullptr, SOCK_CLOEXEC);
      if (connection < 0) throw std::runtime_error("closed-peer accept failed");
      (void)::shutdown(connection, SHUT_RDWR);
      ::close(connection);
      peer_closed.set_value();
    } catch (...) {
      peer_closed.set_exception(std::current_exception());
    }
  });
  ThreadJoiner closed_server_joiner {closed_server, closed_listener.fd};
  auto closed = mirrorgate::connect_unix(closed_listener.path, 1s, 100ms);
  peer_closed_future.get();
  expect_code("CONTROL_DISCONNECTED", [&] { closed->write_frame("{}", 16); });
  closed->close();
  closed_server.join();
}

void test_large_write_completes_across_partial_syscalls() {
  Listener listener;
  std::string received;
  std::thread server([&] {
    const int connection = ::accept4(listener.fd, nullptr, nullptr, SOCK_CLOEXEC);
    char bytes[4096];
    while (connection >= 0) {
      const ssize_t count = ::read(connection, bytes, sizeof(bytes));
      if (count > 0) {
        received.append(bytes, static_cast<std::size_t>(count));
        if (!received.empty() && received.back() == '\n') break;
      } else if (count < 0 && errno == EINTR) continue;
      else break;
    }
    if (connection >= 0) ::close(connection);
  });
  ThreadJoiner server_joiner {server, listener.fd};
  auto transport = mirrorgate::connect_unix(listener.path, 1s, 2s);
  const std::string payload(1024 * 1024, 'z');
  transport->write_frame(payload, payload.size());
  transport->close();
  server.join();
  require(received.size() == payload.size() + 1 && received.back() == '\n' &&
          received.compare(0, payload.size(), payload) == 0,
          "large frame was truncated or interleaved across partial writes");
}

void test_server_join_is_bounded_before_connect() {
  const auto started = std::chrono::steady_clock::now();
  bool preserved = false;
  try {
    with_server("", [](const std::string&) {
      throw std::runtime_error("forced client failure before connect");
    });
  } catch (const std::runtime_error& error) {
    preserved = std::string(error.what()) == "forced client failure before connect";
  }
  require(preserved, "pre-connect client failure was not preserved");
  require(std::chrono::steady_clock::now() - started < 1s,
          "pre-connect server join was not bounded");
}

void test_owned_close_is_bounded_and_waits_for_eof_cleanup() {
  auto graceful = mirrorgate::launch_stdio(
      {"/bin/sh", "-c", "cat >/dev/null; head -c 131072 /dev/zero >&2; sleep 0.15"},
      262144, 1s, 1s);
  require(graceful->owns_process(), "owned stdio did not report process ownership");
  const auto started = std::chrono::steady_clock::now();
  graceful->close();
  const auto elapsed = std::chrono::steady_clock::now() - started;
  require(elapsed >= 100ms && elapsed < 1s, "owned close did not allow bounded EOF cleanup");
  const auto graceful_receipt = graceful->close_result();
  require(graceful_receipt.transport_closed && graceful_receipt.process_owned &&
              graceful_receipt.process_state == mirrorgate::ProcessCloseState::exited &&
              graceful_receipt.exit_code == 0 &&
              graceful_receipt.process_shutdown_confirmed(),
          "normal owned child exit lacked a checked reap receipt");

  auto forced = mirrorgate::launch_stdio(
      {"/bin/sh", "-c", "trap '' TERM; while :; do :; done"}, 65536, 1s, 50ms);
  const auto forced_at = std::chrono::steady_clock::now();
  forced->close();
  require(std::chrono::steady_clock::now() - forced_at < 1s, "forced owned close exceeded bound");
  const auto forced_receipt = forced->close_result();
  require(forced_receipt.transport_closed && forced_receipt.process_owned &&
              forced_receipt.process_state == mirrorgate::ProcessCloseState::signaled &&
              forced_receipt.signal == SIGKILL && forced_receipt.terminate_requested &&
              forced_receipt.kill_requested && forced_receipt.process_shutdown_confirmed(),
          "forced owned child exit lacked a checked SIGKILL reap receipt");
}
}  // namespace

int main() {
  try {
    test_buffered_frames_and_limits();
    test_write_deadline_and_sigpipe();
    test_large_write_completes_across_partial_syscalls();
    test_server_join_is_bounded_before_connect();
    test_owned_close_is_bounded_and_waits_for_eof_cleanup();
    std::cout << "C++ transport tests passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
