#include "mirrorgate/transport.hpp"
#include "mirrorgate/json.hpp"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <climits>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <mutex>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <utility>
#include <vector>

namespace mirrorgate {
namespace {
using Clock = std::chrono::steady_clock;

std::string system_error(const char* action) {
  return std::string(action) + ": " + std::strerror(errno);
}
void close_fd(int& fd) noexcept {
  if (fd >= 0) {
    const int owned = fd;
    fd = -1;
    (void)::close(owned);  // Retrying close after EINTR can target a reused fd.
  }
}
void set_nonblocking_cloexec(int fd) {
  const int dflags = ::fcntl(fd, F_GETFD), sflags = ::fcntl(fd, F_GETFL);
  if (dflags < 0 || sflags < 0 || ::fcntl(fd, F_SETFD, dflags | FD_CLOEXEC) < 0 ||
      ::fcntl(fd, F_SETFL, sflags | O_NONBLOCK) < 0)
    throw SdkError("CONTROL_TRANSPORT", system_error("fcntl"));
}
int poll_ms(Clock::time_point deadline) {
  if (Clock::now() >= deadline) return 0;
  auto value = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
  return static_cast<int>(std::min<std::int64_t>(INT_MAX, std::max<std::int64_t>(1, value)));
}
short wait_fd(int fd, short events, Clock::time_point deadline, const char* action) {
  while (Clock::now() < deadline) {
    struct pollfd item {fd, events, 0};
    const int rc = ::poll(&item, 1, poll_ms(deadline));
    if (rc > 0) return item.revents;
    if (rc == 0) break;
    if (errno != EINTR) throw SdkError("CONTROL_TRANSPORT", system_error(action));
  }
  throw SdkError("DEADLINE_EXCEEDED", std::string(action) + " deadline exceeded");
}

class BlockSigpipe {
 public:
  BlockSigpipe() {
    ::sigemptyset(&set_); ::sigaddset(&set_, SIGPIPE);
    sigset_t pending {};
    already_pending_ = (::sigpending(&pending) == 0 && ::sigismember(&pending, SIGPIPE));
    active_ = (::pthread_sigmask(SIG_BLOCK, &set_, &old_) == 0);
  }
  ~BlockSigpipe() {
    if (!active_) return;
    if (!already_pending_) {
      sigset_t pending {};
      if (::sigpending(&pending) == 0 && ::sigismember(&pending, SIGPIPE)) {
        struct timespec zero {0, 0};
        while (::sigtimedwait(&set_, nullptr, &zero) < 0 && errno == EINTR) {}
      }
    }
    (void)::pthread_sigmask(SIG_SETMASK, &old_, nullptr);
  }
 private:
  sigset_t set_ {}, old_ {};
  bool active_ = false, already_pending_ = false;
};
ssize_t write_safe(int fd, const void* data, std::size_t size, bool socket_fd) {
#ifdef MSG_NOSIGNAL
  if (socket_fd) return ::send(fd, data, size, MSG_NOSIGNAL);
#endif
  ssize_t result;
  int saved_errno;
  {
    BlockSigpipe blocked;
    result = ::write(fd, data, size);
    saved_errno = errno;
  }
  errno = saved_errno;
  return result;
}

class FdTransport final : public Transport {
 public:
  FdTransport(int read_fd, int write_fd, pid_t child, int stderr_fd,
              std::size_t stderr_limit, std::chrono::milliseconds io_timeout,
              std::chrono::milliseconds close_timeout, bool socket_fd)
      : read_fd_(read_fd), write_fd_(write_fd), child_(child), owns_process_(child > 0),
        stderr_fd_(stderr_fd), stderr_limit_(stderr_limit), io_timeout_(io_timeout),
        close_timeout_(close_timeout), socket_fd_(socket_fd) {
    close_result_.process_owned = owns_process_;
    close_result_.process_state = owns_process_
        ? ProcessCloseState::unconfirmed : ProcessCloseState::not_owned;
    if (io_timeout_ <= std::chrono::milliseconds::zero() || close_timeout_ <= std::chrono::milliseconds::zero())
      throw SdkError("ARGUMENT_INVALID", "Transport deadlines must be positive");
    set_nonblocking_cloexec(read_fd_);
    if (write_fd_ != read_fd_) set_nonblocking_cloexec(write_fd_);
    if (stderr_fd_ >= 0) {
      set_nonblocking_cloexec(stderr_fd_);
      stderr_thread_ = std::thread([this] { drain_stderr(); });
    }
  }
  ~FdTransport() override { close(); }

  void write_frame(const std::string& payload, std::size_t max_bytes) override {
    if (closed_) throw SdkError("CONTROL_DISCONNECTED", "Transport is closed");
    if (payload.empty() || payload.size() > max_bytes) throw SdkError("LIMIT", "Frame byte limit exceeded");
    if (payload.find('\n') != std::string::npos || payload.find('\r') != std::string::npos)
      throw SdkError("CONTROL_MALFORMED", "Frame payload contains a raw line terminator");
    std::string bytes = payload; bytes.push_back('\n');
    const auto deadline = Clock::now() + io_timeout_;
    for (std::size_t at = 0; at < bytes.size();) {
      if (closed_) throw SdkError("CONTROL_DISCONNECTED", "Transport closed during write");
      const short events = wait_fd(write_fd_, POLLOUT, deadline, "Transport write");
      if (events & (POLLERR | POLLHUP | POLLNVAL)) throw SdkError("CONTROL_DISCONNECTED", "Transport closed during write");
      const ssize_t count = write_safe(write_fd_, bytes.data() + at, bytes.size() - at, socket_fd_);
      if (count > 0) at += static_cast<std::size_t>(count);
      else if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
      else throw SdkError("CONTROL_DISCONNECTED", system_error("write"));
    }
  }

  std::string read_frame(std::size_t max_bytes, std::chrono::milliseconds timeout) override {
    if (closed_) throw SdkError("CONTROL_DISCONNECTED", "Transport is closed");
    if (timeout <= std::chrono::milliseconds::zero()) throw SdkError("DEADLINE_EXCEEDED", "Transport read deadline exceeded");
    const auto deadline = Clock::now() + timeout;
    while (true) {
      const auto newline = buffer_.find('\n');
      if (newline != std::string::npos) {
        if (newline > max_bytes) throw SdkError("LIMIT", "Frame byte limit exceeded");
        std::string line = buffer_.substr(0, newline); buffer_.erase(0, newline + 1);
        if (line.empty()) throw SdkError("CONTROL_MALFORMED", "Empty JSONL frame");
        if (line.find('\r') != std::string::npos) throw SdkError("CONTROL_MALFORMED", "Raw CR in JSONL frame");
        return line;
      }
      if (buffer_.size() > max_bytes) throw SdkError("LIMIT", "Frame byte limit exceeded");
      if (closed_) throw SdkError("CONTROL_DISCONNECTED", "Transport closed during read");
      const short events = wait_fd(read_fd_, POLLIN | POLLHUP, deadline, "Transport read");
      if (events & (POLLERR | POLLNVAL)) throw SdkError("CONTROL_DISCONNECTED", "Transport failed during read");
      char chunk[8192];
      const ssize_t count = ::read(read_fd_, chunk, sizeof(chunk));
      if (count > 0) buffer_.append(chunk, static_cast<std::size_t>(count));
      else if (count == 0) throw SdkError(buffer_.empty() ? "CONTROL_DISCONNECTED" : "CONTROL_MALFORMED",
                                          buffer_.empty() ? "Transport reached EOF" : "Unterminated JSONL frame");
      else if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) continue;
      else throw SdkError("CONTROL_DISCONNECTED", system_error("read"));
    }
  }

  void close() noexcept override {
    std::lock_guard<std::mutex> lock(close_mutex_);
    if (closed_.exchange(true)) return;
    const bool shared_fd = read_fd_ == write_fd_;
    if (shared_fd) {
      (void)::shutdown(write_fd_, SHUT_RDWR);
      close_fd(write_fd_);
      read_fd_ = -1;
    } else {
      close_fd(write_fd_);  // EOF first lets an owned Gate perform bounded cleanup.
    }
    if (child_ > 0) {
      int status = 0;
      bool status_valid = false;
      bool exited = wait_child_until(
          Clock::now() + close_timeout_, status, status_valid);
      if (!exited) {
        close_result_.terminate_requested = true;
        (void)::kill(child_, SIGTERM);
        exited = wait_child_until(
            Clock::now() + std::chrono::milliseconds(250), status,
            status_valid);
      }
      if (!exited) {
        close_result_.kill_requested = true;
        (void)::kill(child_, SIGKILL);
        exited = wait_child_until(
            Clock::now() + std::chrono::milliseconds(250), status,
            status_valid);
      }
      if (!exited) {
        const pid_t unreaped = child_;
        try {
          std::thread([unreaped] {
            while (::waitpid(unreaped, nullptr, 0) < 0 && errno == EINTR) {}
          }).detach();
        } catch (...) {
          // Teardown is noexcept and bounded; the OS adopts it when this exits.
        }
      }
      if (!exited) {
        close_result_.process_state = ProcessCloseState::unconfirmed;
      } else if (!status_valid) {
        close_result_.process_state = ProcessCloseState::reaped_unknown;
      } else if (WIFEXITED(status)) {
        close_result_.process_state = ProcessCloseState::exited;
        close_result_.exit_code = WEXITSTATUS(status);
      } else if (WIFSIGNALED(status)) {
        close_result_.process_state = ProcessCloseState::signaled;
        close_result_.signal = WTERMSIG(status);
      } else {
        close_result_.process_state = ProcessCloseState::reaped_unknown;
      }
      child_ = -1;
    }
    close_fd(read_fd_);
    stderr_stop_ = true;
    if (stderr_fd_ >= 0) (void)::close(stderr_fd_);
    if (stderr_thread_.joinable()) stderr_thread_.join();
    stderr_fd_ = -1;
    close_result_.transport_closed = true;
  }
  bool owns_process() const noexcept override { return owns_process_; }
  TransportCloseResult close_result() const noexcept override {
    std::lock_guard<std::mutex> lock(close_mutex_);
    return close_result_;
  }

 private:
  bool wait_child_until(Clock::time_point deadline, int& status,
                        bool& status_valid) noexcept {
    while (Clock::now() < deadline) {
      const pid_t result = ::waitpid(child_, &status, WNOHANG);
      if (result == child_) { status_valid = true; return true; }
      if (result < 0 && errno == ECHILD) { status_valid = false; return true; }
      if (result < 0 && errno != EINTR) return false;
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return false;
  }
  void drain_stderr() noexcept {
    char chunk[4096]; std::size_t total = 0;
    while (!stderr_stop_) {
      struct pollfd item {stderr_fd_, POLLIN | POLLHUP, 0};
      const int rc = ::poll(&item, 1, 50);
      if (rc < 0 && errno == EINTR) continue;
      if (rc <= 0) continue;
      const ssize_t count = ::read(stderr_fd_, chunk, sizeof(chunk));
      if (count > 0) {
        total += static_cast<std::size_t>(count);
        if (total > stderr_limit_ && child_ > 0) { (void)::kill(child_, SIGTERM); return; }
      } else if (count == 0) return;
      else if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) return;
    }
  }
  int read_fd_, write_fd_;
  pid_t child_;
  const bool owns_process_;
  int stderr_fd_;
  std::size_t stderr_limit_;
  std::chrono::milliseconds io_timeout_, close_timeout_;
  bool socket_fd_;
  std::atomic<bool> closed_{false};
  std::atomic<bool> stderr_stop_{false};
  std::string buffer_;
  std::thread stderr_thread_;
  mutable std::mutex close_mutex_;
  TransportCloseResult close_result_;
};

void verify_socket_path(const std::string& path) {
  if (path.empty() || path[0] != '/' || path.size() >= sizeof(sockaddr_un::sun_path))
    throw SdkError("ARGUMENT_INVALID", "Unix endpoint must be a bounded absolute filesystem path");
  std::string current = "/";
  std::size_t start = 1;
  while (start < path.size()) {
    const std::size_t slash = path.find('/', start);
    const bool last = slash == std::string::npos;
    const std::string part = path.substr(start, last ? path.size() - start : slash - start);
    if (part.empty() || part == "." || part == "..") throw SdkError("ARGUMENT_INVALID", "Unsafe Unix endpoint path");
    if (current.size() > 1) current.push_back('/');
    current += part;
    struct stat info {};
    if (::lstat(current.c_str(), &info) < 0) throw SdkError("CONTROL_TRANSPORT", system_error("lstat"));
    if (S_ISLNK(info.st_mode)) throw SdkError("POLICY_DENIED", "Unix endpoint path contains a symlink");
    if (last) {
      if (!S_ISSOCK(info.st_mode) || info.st_uid != ::geteuid() || (info.st_mode & 0777) != 0600)
        throw SdkError("POLICY_DENIED", "Unix endpoint socket ownership or mode is invalid");
    } else if (slash == path.find_last_of('/')) {
      if (!S_ISDIR(info.st_mode) || info.st_uid != ::geteuid() || (info.st_mode & 0777) != 0700)
        throw SdkError("POLICY_DENIED", "Unix endpoint directory ownership or mode is invalid");
    }
    if (last) break;
    start = slash + 1;
  }
}
}  // namespace

const char* process_close_state_name(ProcessCloseState state) noexcept {
  switch (state) {
    case ProcessCloseState::not_owned: return "not-owned";
    case ProcessCloseState::exited: return "exited";
    case ProcessCloseState::signaled: return "signaled";
    case ProcessCloseState::reaped_unknown: return "reaped-unknown";
    case ProcessCloseState::unconfirmed: return "unconfirmed";
  }
  return "unconfirmed";
}

std::unique_ptr<Transport> launch_stdio(const std::vector<std::string>& argv,
                                        std::size_t stderr_limit,
                                        std::chrono::milliseconds io_timeout,
                                        std::chrono::milliseconds close_timeout) {
  if (argv.empty() || argv[0].empty()) throw SdkError("ARGUMENT_INVALID", "Approved control command is required");
  int input[2] {-1,-1}, output[2] {-1,-1}, errors[2] {-1,-1};
  auto close_all = [&] { for (int* pair : {input,output,errors}) { close_fd(pair[0]); close_fd(pair[1]); } };
  if (::pipe2(input,O_CLOEXEC) < 0 || ::pipe2(output,O_CLOEXEC) < 0 || ::pipe2(errors,O_CLOEXEC) < 0) {
    const auto message=system_error("pipe"); close_all(); throw SdkError("CONTROL_TRANSPORT",message);
  }
  const pid_t pid=::fork();
  if (pid < 0) { const auto message=system_error("fork"); close_all(); throw SdkError("CONTROL_TRANSPORT",message); }
  if (pid == 0) {
    if (::dup2(input[0],STDIN_FILENO)<0 || ::dup2(output[1],STDOUT_FILENO)<0 || ::dup2(errors[1],STDERR_FILENO)<0) _exit(126);
    close_all();
    std::vector<char*> args; for (const auto& item:argv) args.push_back(const_cast<char*>(item.c_str())); args.push_back(nullptr);
    ::execvp(args[0],args.data()); _exit(127);
  }
  close_fd(input[0]); close_fd(output[1]); close_fd(errors[1]);
  try {
    return std::unique_ptr<Transport>(new FdTransport(output[0],input[1],pid,errors[0],stderr_limit,io_timeout,close_timeout,false));
  } catch (...) {
    close_all(); (void)::kill(pid,SIGKILL); while (::waitpid(pid,nullptr,0)<0 && errno==EINTR) {} throw;
  }
}

std::unique_ptr<Transport> connect_unix(const std::string& path,
                                        std::chrono::milliseconds connect_timeout,
                                        std::chrono::milliseconds io_timeout) {
  verify_socket_path(path);
  if (connect_timeout <= std::chrono::milliseconds::zero()) throw SdkError("ARGUMENT_INVALID","Connect deadline must be positive");
  int fd=::socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK,0);
  if (fd<0) throw SdkError("CONTROL_TRANSPORT",system_error("socket"));
  struct sockaddr_un address {}; address.sun_family=AF_UNIX; std::memcpy(address.sun_path,path.c_str(),path.size()+1);
  const socklen_t length=static_cast<socklen_t>(offsetof(sockaddr_un,sun_path)+path.size()+1);
  if (::connect(fd,reinterpret_cast<const struct sockaddr*>(&address),length)<0) {
    if (errno!=EINPROGRESS) { const auto message=system_error("connect"); close_fd(fd); throw SdkError("CONTROL_TRANSPORT",message); }
    try { (void)wait_fd(fd,POLLOUT,Clock::now()+connect_timeout,"Unix connect"); }
    catch (...) { close_fd(fd); throw; }
    int error=0; socklen_t size=sizeof(error);
    if (::getsockopt(fd,SOL_SOCKET,SO_ERROR,&error,&size)<0 || error!=0) {
      if (error) errno = error;
      const auto message = system_error("connect");
      close_fd(fd);
      throw SdkError("CONTROL_TRANSPORT", message);
    }
  }
  try { return std::unique_ptr<Transport>(new FdTransport(fd,fd,-1,-1,0,io_timeout,std::chrono::seconds(5),true)); }
  catch (...) { close_fd(fd); throw; }
}
}  // namespace mirrorgate
