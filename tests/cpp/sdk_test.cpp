#include "mirrorgate/control.hpp"
#include "mirrorgate/managed_worker.hpp"

#include <fstream>
#include <atomic>
#include <chrono>
#include <cerrno>
#include <cstring>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <thread>
#include <unistd.h>

#if NLOHMANN_JSON_VERSION_MAJOR != NLOHMANN_JSON_VERSION_MAJOR_EXPECTED || \
    NLOHMANN_JSON_VERSION_MINOR != NLOHMANN_JSON_VERSION_MINOR_EXPECTED || \
    NLOHMANN_JSON_VERSION_PATCH != NLOHMANN_JSON_VERSION_PATCH_EXPECTED
#error "MirrorGate C++ SDK requires nlohmann_json exactly 3.11.3"
#endif

using mirrorgate::Json;
using mirrorgate::JsonLimits;
using mirrorgate::Manifest;
using mirrorgate::NativeValue;
using mirrorgate::SdkError;

namespace {

class ScriptedTransport final : public mirrorgate::Transport {
 public:
  explicit ScriptedTransport(std::vector<std::string> replies) : replies_(std::move(replies)) {}
  void write_frame(const std::string& payload, std::size_t) override { writes.push_back(payload); }
  std::string read_frame(std::size_t, std::chrono::milliseconds) override {
    if (at_ >= replies_.size()) throw SdkError("CONTROL_DISCONNECTED", "script exhausted");
    return replies_[at_++];
  }
  void close() noexcept override { closed = true; }
  bool owns_process() const noexcept override { return false; }
  std::vector<std::string> writes;
  bool closed = false;
 private:
  std::vector<std::string> replies_;
  std::size_t at_ = 0;
};

std::string read_file(const std::string& path) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) throw std::runtime_error("cannot read " + path);
  std::ostringstream out; out << stream.rdbuf(); return out.str();
}

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

bool rejects(const std::string& input, JsonLimits limits) {
  try { (void)mirrorgate::parse_strict_json(input, limits); return false; }
  catch (const SdkError&) { return true; }
}

std::string hex_decode(const std::string& hex) {
  std::string out;
  for (std::size_t i = 0; i < hex.size(); i += 2) {
    out.push_back(static_cast<char>(std::stoul(hex.substr(i, 2), nullptr, 16)));
  }
  return out;
}

bool parse_worker_frame(const std::string& bytes) {
  try {
    if (bytes.empty() || bytes.back() != '\n' || bytes.find('\n') != bytes.size() - 1)
      throw SdkError("FRAME", "Expected exactly one terminated frame");
    const std::string payload = bytes.substr(0, bytes.size() - 1);
    if (payload.empty() || payload.find('\r') != std::string::npos)
      throw SdkError("FRAME", "Invalid JSONL payload");
    Json value = mirrorgate::parse_strict_json(payload, {65535, 96, 8192});
    if (!value.is_object()) throw SdkError("FRAME", "Frame root must be an object");
    return true;
  } catch (const SdkError&) { return false; }
}

void test_strict_json() {
  const JsonLimits limits{65535, 96, 8192};
  require(rejects("{\"a\":1,\"a\":2}", limits), "duplicate keys accepted");
  require(rejects("{\"a\":1,\"\\u0061\":2}", limits), "escaped duplicate keys accepted");
  require(rejects(std::string("\xef\xbb\xbf{}", 5), limits), "BOM accepted");
  require(rejects("{\"x\":\"\\ud800\"}", limits), "lone surrogate accepted");
  require(rejects("{\"x\":9007199254740991.00000000000000001}", limits), "rounded unsafe number accepted");
  require(mirrorgate::parse_strict_json("{\"x\":1.0}", limits).at("x") == 1,
          "integral decimal rejected");
  require(mirrorgate::parse_strict_json("{\"x\":10e-1}", limits).at("x") == 1,
          "integral exponent rejected");
}

void test_worker_vectors(const std::string& path) {
  std::istringstream lines(read_file(path)); std::string line; std::size_t checked = 0;
  while (std::getline(lines, line)) {
    if (line.empty()) continue;
    Json vector = Json::parse(line);
    const auto kind = vector.at("kind").get<std::string>();
    bool valid = true;
    if (kind == "manifest") {
      try { (void)Manifest::parse(vector.at("value").dump()); }
      catch (const SdkError&) { valid = false; }
    } else if (kind == "value") {
      try { (void)mirrorgate::decode_portable_value(vector.at("type"), vector.at("value")); }
      catch (const SdkError&) { valid = false; }
    } else if (kind == "frame") {
      valid = parse_worker_frame(hex_decode(vector.at("hex").get<std::string>()));
    } else continue;
    require(valid == vector.at("valid").get<bool>(), kind + " vector mismatch: " + vector.at("name").get<std::string>());
    ++checked;
  }
  require(checked >= 40, "too few shared worker vectors");
}

void test_native_values(const std::string& manifest_path) {
  Manifest manifest = Manifest::parse(read_file(manifest_path));
  Json encoded = manifest.encode_inputs("Tick", {{"Stride", NativeValue::bigint("900719925474099312345")}});
  require(encoded == Json{{"Stride", Json{{"#bigint", "900719925474099312345"}}}}, "bigint encoding mismatch");
  auto decoded = manifest.decode_observations(Json{{"Count", Json{{"#bigint", "-5"}}}});
  require(decoded.at("Count").kind == mirrorgate::NativeKind::bigint && decoded.at("Count").text == "-5",
          "bigint decoding mismatch");
}

void test_control_vectors_present(const std::string& path) {
  std::istringstream lines(read_file(path)); std::string line; std::size_t checked = 0;
  while (std::getline(lines, line)) {
    if (line.empty()) continue;
    Json vector = Json::parse(line);
    require(vector.is_object() && vector.contains("name"), "invalid control vector record");
    const auto kind = vector.at("kind").get<std::string>();
    bool valid = true;
    try {
      if (kind == "request") mirrorgate::validate_control_request(vector.at("value"));
      else if (kind == "response") {
        if (!vector.contains("request")) throw SdkError("SCHEMA", "response fixture lacks request context");
        const Json& request = vector.at("request");
        mirrorgate::validate_control_response_fixture(vector.at("value"), request.at("op"));
        if (vector.at("value").at("id") != request.at("id"))
          throw SdkError("SCHEMA", "response fixture correlation mismatch");
        if (request.at("op") == "hello" && vector.at("value").at("ok") == true) {
          for (const auto& required : request.at("args").at("requiredCapabilities")) {
            bool found = false;
            for (const auto& capability : vector.at("value").at("result").at("capabilities"))
              if (capability.at("id") == required && capability.at("available") == true) found = true;
            if (!found) throw SdkError("SCHEMA", "missing required capability");
          }
        }
        if (request.at("op") == "operation.status" && vector.at("value").at("ok") == true) {
          const Json& outcome = vector.at("value").at("result");
          if (outcome.at("operationId") != request.at("args").at("operationId"))
            throw SdkError("SCHEMA", "operation status correlation mismatch");
          if (vector.contains("operation")) {
            const auto op = vector.at("operation").get<std::string>();
            const auto terminal = op == "session.prepare" ? "Prepared" :
                (op == "authoring.exec" ? "CommandResult" : "CleanupResult");
            mirrorgate::validate_control_operation_fixture(outcome, terminal);
          }
        }
      } else if (kind == "operation") {
        if (!vector.contains("operation")) throw SdkError("SCHEMA", "operation fixture lacks context");
        const auto op = vector.at("operation").get<std::string>();
        const auto terminal = op == "session.prepare" ? "Prepared" :
            (op == "authoring.exec" ? "CommandResult" : "CleanupResult");
        mirrorgate::validate_control_operation_fixture(vector.at("value"), terminal);
      } else if (kind == "event") {
        mirrorgate::validate_control_event_fixture(vector.at("value"));
        if (vector.contains("operation") && vector.at("value").at("event") == "operation.finished") {
          const auto op = vector.at("operation").get<std::string>();
          const auto terminal = op == "session.prepare" ? "Prepared" :
              (op == "authoring.exec" ? "CommandResult" : "CleanupResult");
          mirrorgate::validate_control_operation_fixture(vector.at("value").at("data"), terminal);
        }
      } else if (kind == "attachment") mirrorgate::validate_attachment_fixture(vector.at("value"), false);
      else if (kind == "attached") mirrorgate::validate_attachment_fixture(vector.at("value"), true);
      else throw SdkError("SCHEMA", "unknown fixture kind");
    } catch (const std::exception&) { valid = false; }
    require(valid == vector.at("valid").get<bool>(),
            "control vector mismatch: " + vector.at("name").get<std::string>());
    ++checked;
  }
  require(checked >= 72, "incomplete control fixture corpus");
}

Json hello_response(std::uint64_t id) {
  Json limits = {{"maxFrameBytes",1048576},{"maxJsonDepth",128},{"maxJsonNodes",16384},
    {"maxPendingOutputBytes",4194304},{"maxSessionsPerConnection",4},{"maxInflightRequestsPerConnection",16},
    {"maxCompletedOperationsPerSession",128},{"helloTimeoutMs",5000},{"requestAckTimeoutMs",5000},
    {"workerAttachmentTimeoutMs",5000},{"sessionWallMs",600000},{"gracefulStopMs",1000},{"teardownMs",5000}};
  Json result = {{"controlVersion",1},{"instanceId","11111111111111111111111111111111"},
    {"capabilities",Json::array({{{"id","control.local-stdio-v1"},{"available",true},
      {"enforcedScope","connection"},{"limits",Json::object()}}})},{"limits",limits}};
  return {{"v",1},{"kind","response"},{"id",id},{"ok",true},{"result",result}};
}

void test_control_correlation(const std::string& manifest_path) {
  const std::string sid = "22222222222222222222222222222222";
  const std::string authorization_id = "55555555555555555555555555555555";
  const std::string worker_id = "66666666666666666666666666666666";
  auto scripted = new ScriptedTransport({
    hello_response(1).dump(),
    Json({{"v",1},{"kind","response"},{"id",2},{"ok",true},{"result",{{"sessionId",sid}}}}).dump(),
    Json({{"v",1},{"kind","response"},{"id",3},{"ok",true},{"result",{{"authorizationId",authorization_id}}}}).dump(),
    Json({{"v",1},{"kind","response"},{"id",4},{"ok",true},{"result",{{"workerId",worker_id},
      {"endpoint",{{"kind","unix"},{"path","/tmp/fixture.sock"}}},{"attachmentToken",std::string(64,'7')},
      {"attachmentTimeoutMs",5000},{"releaseMode","control-v1"}}}}).dump(),
    Json({{"v",1},{"kind","event"},{"seq",1},{"sessionId",sid},{"event","worker.started"},{"data",{{"workerId",worker_id}}}}).dump(),
    Json({{"v",1},{"kind","event"},{"seq",2},{"sessionId",sid},{"event","worker.ready"},{"data",{{"workerId",worker_id}}}}).dump(),
    Json({{"v",1},{"kind","response"},{"id",5},{"ok",true},{"result",{{"phase","running"},
      {"resources",{{"authoringProcesses",0},{"buildProcesses",0},{"workers",1},{"snapshots",1}}},
      {"cleanup",{{"status","notStarted"},{"remainingResources",Json::array()}}}}}}).dump()
  });
  auto client = mirrorgate::ControlClient::from_transport(
      std::unique_ptr<mirrorgate::Transport>(scripted), {"control.local-stdio-v1"});
  mirrorgate::Session session = client->open_session({{"policyId","default"},
      {"submission",{{"kind","prebuilt"},{"input",{{"rootId","submission"},{"relativePath","counter"}}}}},
      {"runtime","node-v1"},{"manifestJson",read_file(manifest_path)}});
  require(session.id() == sid, "session correlation mismatch");
  Json attestation = {{"registrationId","fixture"},{"request","verify"},{"policy","require"},
    {"status","matched"},{"descriptorSchema","mirrors.model-interface-descriptor/v1"},
    {"semanticDigest","193d6cc187d05c18f02ad483a44f8ad0c1634b02083df241df08b9281b045d1c"},
    {"adapterId","mirrorgate/node-v1"},{"targetProfile","node-v1"},
    {"stateComputerContractVersion","mirrors.state-computer/v1"}};
  auto authorization = session.authorize(1, "44444444444444444444444444444444", attestation);
  auto descriptor = session.acquire_worker(authorization);
  require(descriptor.worker_id() == worker_id, "worker ownership mismatch");
  require(session.status().at("phase") == "running", "session status mismatch");
  auto events = client->take_events();
  require(events.size() == 2 && events[0].sequence == 1 && events[1].sequence == 2 && events[0].session_id == sid,
          "event correlation mismatch");
  require(scripted->writes.size() == 5, "unexpected request count");
  require(Json::parse(scripted->writes[0]).at("op") == "hello" &&
          Json::parse(scripted->writes[1]).at("op") == "session.open",
          "outgoing request operation mismatch");
}

void test_custom_transport_close_receipt_fails_closed() {
  auto scripted = new ScriptedTransport({hello_response(1).dump()});
  auto client = mirrorgate::ControlClient::from_transport(
      std::unique_ptr<mirrorgate::Transport>(scripted), {});
  const auto receipt = client->close_with_result();
  require(scripted->closed, "checked close did not close a custom transport");
  require(!receipt.transport_closed && !receipt.process_shutdown_confirmed() &&
              receipt.process_state == mirrorgate::ProcessCloseState::not_owned,
          "custom transport without a receipt was treated as confirmed");
  const auto repeated = client->close_with_result();
  require(!repeated.transport_closed,
          "repeated checked close changed an unknown receipt");
}

void test_handle_ownership(const std::string& manifest_path) {
  const std::string sid1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const std::string sid2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  auto scripted = new ScriptedTransport({hello_response(1).dump(),
    Json({{"v",1},{"kind","response"},{"id",2},{"ok",true},{"result",{{"sessionId",sid1}}}}).dump(),
    Json({{"v",1},{"kind","response"},{"id",3},{"ok",true},{"result",{{"sessionId",sid2}}}}).dump(),
    Json({{"v",1},{"kind","response"},{"id",4},{"ok",true},{"result",{{"authorizationId","cccccccccccccccccccccccccccccccc"}}}}).dump(),
    Json({{"v",1},{"kind","response"},{"id",5},{"ok",true},{"result",{{"workerId","eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},
      {"endpoint",{{"kind","unix"},{"path","/tmp/fixture.sock"}}},{"attachmentToken",std::string(64,'7')},
      {"attachmentTimeoutMs",5000},{"releaseMode","control-v1"}}}}).dump()});
  auto client = mirrorgate::ControlClient::from_transport(std::unique_ptr<mirrorgate::Transport>(scripted), {});
  Json open = {{"policyId","default"},{"submission",{{"kind","prebuilt"},{"input",{{"rootId","submission"},{"relativePath","counter"}}}}},
               {"runtime","node-v1"},{"manifestJson",read_file(manifest_path)}};
  auto session1 = client->open_session(open); auto session2 = client->open_session(open);
  Json attestation = {{"registrationId","fixture"},{"request","verify"},{"policy","require"},
    {"status","matched"},{"descriptorSchema","mirrors.model-interface-descriptor/v1"},
    {"semanticDigest","193d6cc187d05c18f02ad483a44f8ad0c1634b02083df241df08b9281b045d1c"},
    {"adapterId","mirrorgate/node-v1"},{"targetProfile","node-v1"},
    {"stateComputerContractVersion","mirrors.state-computer/v1"}};
  auto authorization = session1.authorize(1, "dddddddddddddddddddddddddddddddd", attestation);
  bool rejected = false;
  try { (void)session2.acquire_worker(authorization); } catch (const SdkError& error) { rejected = error.code == "HANDLE_INVALID"; }
  require(rejected && scripted->writes.size() == 4, "cross-session authorization dispatched");
  auto descriptor = session1.acquire_worker(authorization);
  rejected = false;
  try { (void)session2.release_worker(descriptor); } catch (const SdkError& error) { rejected = error.code == "HANDLE_INVALID"; }
  require(rejected && scripted->writes.size() == 5, "cross-session worker release dispatched");
  client.reset();
  rejected = false;
  try { (void)session1.status(); } catch (const SdkError& error) { rejected = error.code == "HANDLE_INVALID"; }
  require(rejected, "stale session handle did not fail safely");
}

std::string make_socket_path() {
  std::string pattern = "/tmp/mirrorgate-cpp-XXXXXX";
  std::vector<char> bytes(pattern.begin(), pattern.end()); bytes.push_back('\0');
  char* directory = ::mkdtemp(bytes.data());
  if (!directory) throw std::runtime_error("mkdtemp failed");
  return std::string(directory) + "/broker.sock";
}

int listen_socket(const std::string& path) {
  const int fd = ::socket(AF_UNIX, SOCK_STREAM, 0); if (fd < 0) throw std::runtime_error("socket failed");
  sockaddr_un address{}; address.sun_family = AF_UNIX; std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
  if (::bind(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)))
    throw std::runtime_error(std::string("bind failed: ") + std::strerror(errno));
  if (::chmod(path.c_str(), 0600) || ::listen(fd, 1))
    throw std::runtime_error(std::string("chmod/listen failed: ") + std::strerror(errno));
  return fd;
}

void remove_socket(const std::string& path) {
  ::unlink(path.c_str());
  const auto slash = path.find_last_of('/'); if (slash != std::string::npos) ::rmdir(path.substr(0, slash).c_str());
}

void write_all(int fd, const char* data, std::size_t size) {
  std::size_t at = 0;
  while (at < size) {
    const auto written = ::write(fd, data + at, size - at);
    if (written <= 0) throw std::runtime_error("socket write failed");
    at += static_cast<std::size_t>(written);
  }
}

std::string read_line_fd(int fd) {
  std::string line; char c;
  while (true) {
    const auto n = ::read(fd, &c, 1);
    if (n == 0) return line;
    if (n < 0) throw std::runtime_error("socket read failed");
    if (c == '\n') return line;
    line.push_back(c);
  }
}

void write_json_fd(int fd, const Json& value) {
  const std::string frame = value.dump() + "\n";
  write_all(fd, frame.data(), frame.size());
}

void test_attachment_buffering() {
  const std::string path = make_socket_path(); const int listener = listen_socket(path);
  std::thread server([&] {
    const int client = ::accept(listener, nullptr, nullptr);
    const std::string both = "{\"v\":1,\"kind\":\"attached\"}\n{\"v\":1,\"id\":1}\n";
    write_all(client, both.data(), both.size()); ::close(client); ::close(listener);
  });
  auto transport = mirrorgate::connect_unix(path);
  require(transport->read_frame(4096, std::chrono::seconds(1)).find("attached") != std::string::npos,
          "attachment ack missing");
  require(transport->read_frame(65535, std::chrono::seconds(1)).find("\"id\":1") != std::string::npos,
          "coalesced worker frame was dropped");
  transport->close(); server.join(); remove_socket(path);

  const std::string path2 = make_socket_path(); const int listener2 = listen_socket(path2);
  std::thread fragmented([&] {
    const int client = ::accept(listener2, nullptr, nullptr); const std::string frame = "{\"kind\":\"attached\"}\n";
    write_all(client, frame.data(), 5); std::this_thread::sleep_for(std::chrono::milliseconds(5));
    write_all(client, frame.data() + 5, frame.size() - 5); ::close(client); ::close(listener2);
  });
  auto transport2 = mirrorgate::connect_unix(path2);
  require(transport2->read_frame(4096, std::chrono::seconds(1)).find("attached") != std::string::npos,
          "fragmented attachment ack failed");
  transport2->close(); fragmented.join(); remove_socket(path2);

  const std::string path3 = make_socket_path(); const int listener3 = listen_socket(path3);
  std::thread eof([&] { const int client = ::accept(listener3, nullptr, nullptr); ::close(client); ::close(listener3); });
  auto transport3 = mirrorgate::connect_unix(path3); bool failed = false;
  try { (void)transport3->read_frame(4096, std::chrono::seconds(1)); } catch (const SdkError& error) { failed = error.code == "CONTROL_DISCONNECTED"; }
  require(failed, "EOF before attachment ack was accepted"); transport3->close(); eof.join(); remove_socket(path3);
}

struct FakeWorkerServer {
  std::string path = make_socket_path();
  int listener = listen_socket(path);
  std::atomic<int> port_requests{0};
  std::atomic<bool> ok{true};
  std::thread thread;

  void start(int mode) {
    thread = std::thread([this, mode] {
      try {
        const int fd = ::accept(listener, nullptr, nullptr);
        Json attach = Json::parse(read_line_fd(fd));
        write_json_fd(fd, {{"v",1},{"kind","attached"},{"sessionId",attach.at("sessionId")},{"workerId",attach.at("workerId")}});
        while (true) {
          const std::string line = read_line_fd(fd); if (line.empty()) break;
          Json request = Json::parse(line); ++port_requests;
          const auto op = request.at("op").get<std::string>();
          if (op == "hello") write_json_fd(fd, {{"v",1},{"id",request.at("id")},{"ok",true},
            {"result",{{"interfaceDigest",request.at("interfaceDigest")},{"runtime",request.at("runtime")}}}});
          else if (op == "invoke" && mode == 2) {
            Json cancel = Json::parse(read_line_fd(fd)); ++port_requests;
            if (cancel.at("op") != "cancel" || cancel.at("requestId") != request.at("id"))
              throw std::runtime_error("invalid worker cancellation request");
            write_json_fd(fd, {{"v",1},{"id",request.at("id")},{"ok",false},
              {"error",{{"code","CANCELLED"},{"message","cancelled"}}}});
            write_json_fd(fd, {{"v",1},{"id",cancel.at("id")},{"ok",true},{"result",nullptr}});
            break;
          } else if (op == "create" || op == "invoke" || op == "dispose")
            write_json_fd(fd, {{"v",1},{"id",request.at("id")},{"ok",true},{"result",nullptr}});
          else if (op == "observe") {
            Json count = mode == 1 ? Json(1) : Json{{"#bigint","0"}};
            write_json_fd(fd, {{"v",1},{"id",request.at("id")},{"ok",true},{"result",{{"Count",count}}}});
            if (mode == 1) break;
          } else throw std::runtime_error("unexpected fake worker request");
        }
        ::close(fd); ::close(listener);
      } catch (...) { ok = false; }
    });
  }

  ~FakeWorkerServer() {
    if (thread.joinable()) thread.join();
    remove_socket(path);
  }
};

std::unique_ptr<mirrorgate::ManagedWorker> attach_fake_worker(
    FakeWorkerServer& server, const std::string& manifest_path,
    std::unique_ptr<mirrorgate::ControlClient>& control, mirrorgate::Session& session,
    bool include_cancel) {
  const std::string sid = "22222222222222222222222222222222";
  const std::string wid = "66666666666666666666666666666666";
  std::vector<std::string> replies = {hello_response(1).dump(),
    Json({{"v",1},{"kind","response"},{"id",2},{"ok",true},{"result",{{"sessionId",sid}}}}).dump(),
    Json({{"v",1},{"kind","response"},{"id",3},{"ok",true},{"result",{{"authorizationId","55555555555555555555555555555555"}}}}).dump(),
    Json({{"v",1},{"kind","response"},{"id",4},{"ok",true},{"result",{{"workerId",wid},
      {"endpoint",{{"kind","unix"},{"path",server.path}}},{"attachmentToken",std::string(64,'7')},
      {"attachmentTimeoutMs",5000},{"releaseMode","control-v1"}}}}).dump()};
  std::uint64_t release_request_id = 5;
  if (include_cancel) {
    replies.push_back(Json({{"v",1},{"kind","response"},{"id",5},{"ok",true},{"result",{{"operationId",1}}}}).dump());
    replies.push_back(Json({{"v",1},{"kind","response"},{"id",6},{"ok",true},
      {"result",{{"operationId",1},{"status","succeeded"},{"result",{{"phase","closed"},
        {"cleanupStatus","succeeded"},{"remainingResources",Json::array()}}}}}}).dump());
  } else {
    replies.push_back(Json({{"v",1},{"kind","response"},{"id",release_request_id},{"ok",true},
      {"result",{{"operationId",2},{"cleanupMode","terminate-only"}}}}).dump());
    replies.push_back(Json({{"v",1},{"kind","response"},{"id",release_request_id+1},{"ok",true},
      {"result",{{"operationId",2},{"status","succeeded"},{"result",{{"phase","closed"},
        {"cleanupStatus","succeeded"},{"remainingResources",Json::array()}}}}}}).dump());
  }
  control = mirrorgate::ControlClient::from_transport(
      std::unique_ptr<mirrorgate::Transport>(new ScriptedTransport(std::move(replies))), {});
  const std::string manifest_json = read_file(manifest_path);
  session = control->open_session({{"policyId","default"},
    {"submission",{{"kind","prebuilt"},{"input",{{"rootId","submission"},{"relativePath","counter"}}}}},
    {"runtime","node-v1"},{"manifestJson",manifest_json}});
  Json attestation = {{"registrationId","fixture"},{"request","verify"},{"policy","require"},
    {"status","matched"},{"descriptorSchema","mirrors.model-interface-descriptor/v1"},
    {"semanticDigest","193d6cc187d05c18f02ad483a44f8ad0c1634b02083df241df08b9281b045d1c"},
    {"adapterId","mirrorgate/node-v1"},{"targetProfile","node-v1"},
    {"stateComputerContractVersion","mirrors.state-computer/v1"}};
  auto authorization = session.authorize(1, "44444444444444444444444444444444", attestation);
  return mirrorgate::ManagedWorker::attach(session, session.acquire_worker(authorization),
      Manifest::parse(manifest_json), "node-v1");
}

void test_managed_worker_negative_paths(const std::string& manifest_path) {
  {
    FakeWorkerServer server; server.start(1);
    std::unique_ptr<mirrorgate::ControlClient> control; mirrorgate::Session session;
    auto worker = attach_fake_worker(server, manifest_path, control, session, true);
    session = mirrorgate::Session{};  // ManagedWorker retains its lifetime-safe session value.
    worker->invoke("Initialize", {});
    bool rejected = false;
    try { (void)worker->observe(); } catch (const SdkError& error) { rejected = error.code == "VALUE"; }
    require(rejected, "malformed native observation was accepted");
    const int after_failure = server.port_requests.load();
    try { worker->invoke("Initialize", {}); } catch (const SdkError&) {}
    require(server.port_requests.load() == after_failure, "managed dispatch continued after malformed observation");
    worker->close("worker-failure");
    require(server.ok, "fake malformed worker server failed");
  }
  {
    FakeWorkerServer server; server.start(0);
    std::unique_ptr<mirrorgate::ControlClient> control; mirrorgate::Session session;
    auto worker = attach_fake_worker(server, manifest_path, control, session, false);
    mirrorgate::CallOptions aborted; aborted.cancelled = [] { return true; };
    bool rejected = false;
    try { worker->invoke("Initialize", {}, aborted); } catch (const SdkError& error) { rejected = error.code == "CANCELLED"; }
    require(rejected, "pre-aborted call did not cancel locally");
    worker->invoke("Initialize", {});
    require(worker->observe().at("Count").text == "0", "worker unusable after pre-dispatch cancellation");
    // hello/create plus exactly one initializer and observation: the aborted call consumed no ID or frame.
    require(server.port_requests.load() == 4, "pre-aborted call reached the worker");
    worker->close();
    require(server.ok, "fake pre-abort worker server failed");
  }
  {
    FakeWorkerServer server; server.start(2);
    std::unique_ptr<mirrorgate::ControlClient> control; mirrorgate::Session session;
    auto worker = attach_fake_worker(server, manifest_path, control, session, true);
    const auto cancel_at = std::chrono::steady_clock::now() + std::chrono::milliseconds(15);
    mirrorgate::CallOptions options;
    options.cancelled = [cancel_at] { return std::chrono::steady_clock::now() >= cancel_at; };
    bool rejected = false;
    try { worker->invoke("Initialize", {}, options); }
    catch (const SdkError& error) { rejected = error.code == "CANCELLED"; }
    require(rejected && server.port_requests.load() == 4,
            "worker cancellation did not use invoke-then-cancel with correlated responses");
    worker->close("user-cancel");
    require(server.ok, "fake cancellation worker server failed");
  }
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc != 4) throw std::runtime_error("expected worker vectors, control vectors, manifest");
    test_strict_json();
    test_worker_vectors(argv[1]);
    test_control_vectors_present(argv[2]);
    test_native_values(argv[3]);
    test_control_correlation(argv[3]);
    test_custom_transport_close_receipt_fails_closed();
    test_handle_ownership(argv[3]);
    test_attachment_buffering();
    test_managed_worker_negative_paths(argv[3]);
    std::cout << "MirrorGate C++ SDK tests passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; return 1;
  }
}
