#include "mirrorgate/control.hpp"
#include "mirrorgate/managed_worker.hpp"

#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using mirrorgate::ControlClient;
using mirrorgate::Json;
using mirrorgate::ManagedWorker;
using mirrorgate::Manifest;
using mirrorgate::NativeFields;
using mirrorgate::NativeValue;

namespace {

std::string read_file(const std::string& path) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) throw std::runtime_error("cannot read " + path);
  std::ostringstream out; out << stream.rdbuf(); return out.str();
}

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc != 8) {
      std::cerr << "usage: control_e2e stdio|unix GATE_OR_SOCKET POLICY MANIFEST RELATIVE RUNTIME EXPECTED_COUNT\n";
      return 2;
    }
    const std::string mode = argv[1], gate_or_socket = argv[2], policy = argv[3];
    const std::string manifest_json = read_file(argv[4]);
    const std::string relative = argv[5], runtime = argv[6], expected = argv[7];
    const std::vector<std::string> capabilities = {
      mode == "stdio" ? "control.local-stdio-v1" : "control.local-unix-v1",
      "submission.prebuilt-v1", "execution.compiled-verify-v1",
      "worker.managed-unix-v1",
      runtime == "node-v1" ? "worker.node-v1" : "worker.rust-v1",
      "backend.linux-bubblewrap-v1", "cleanup.bounded-attempt-v1"};
    std::unique_ptr<ControlClient> control;
    if (mode == "stdio") {
      control = ControlClient::launch({gate_or_socket, "control", "--stdio", "--policy-file", policy}, capabilities);
      require(control->owns_process(), "owned stdio control did not retain process ownership");
    } else if (mode == "unix") {
      control = ControlClient::connect(gate_or_socket, capabilities);
      require(!control->owns_process(), "attached Unix client claimed daemon ownership");
    } else throw std::runtime_error("unknown control mode");

    const std::string policy_id = runtime == "node-v1" ? "test.node" :
        (expected == "2" ? "test.rust" : "test.rust-faulty");
    auto session = control->open_session({{"policyId", policy_id},
      {"submission",{{"kind","prebuilt"},{"input",{{"rootId","submission"},{"relativePath",relative}}}}},
      {"runtime",runtime},{"manifestJson",manifest_json}});
    Json prepared = session.prepare().wait();
    require(prepared.at("preparedRevision") == 1, "unexpected prepared revision");
    Manifest manifest = Manifest::parse(manifest_json);
    Json attestation = {{"registrationId","cpp-e2e-registration"},{"request","verify"},
      {"policy","require"},{"status","matched"},
      {"descriptorSchema","mirrors.model-interface-descriptor/v1"},
      {"semanticDigest",manifest.interface_digest()},
      {"adapterId",runtime == "node-v1" ? "mirrorgate/node-v1" : "mirrorgate/rust-v1"},
      {"targetProfile",runtime},{"stateComputerContractVersion","mirrors.state-computer/v1"}};
    auto authorization = session.authorize(
        prepared.at("preparedRevision").get<std::uint64_t>(),
        prepared.at("challenge").get<std::string>(), attestation);
    auto worker = ManagedWorker::attach(session, session.acquire_worker(authorization), std::move(manifest), runtime);
    worker->invoke("Initialize", {});
    auto initial = worker->observe();
    require(initial.at("Count").text == "0", "Counter did not initialize to zero");
    worker->invoke("Tick", NativeFields{{"Stride", NativeValue::bigint("2")}});
    auto actual = worker->observe();
    require(actual.at("Count").text == expected,
            "Counter actual observation mismatch: expected " + expected + ", got " + actual.at("Count").text);
    worker->close("normal");
    Json summary = {{"status", expected == "2" ? "passed" : "mismatch"},
                    {"failureFamily", expected == "2" ? "counter-correct" : "counter-faulty"}};
    Json cleanup = session.close(&summary).wait();
    require(cleanup.at("phase") == "closed" && cleanup.at("cleanupStatus") == "succeeded",
            "session cleanup was not confirmed");
    control->close();
    std::cout << "C++ control e2e " << mode << ' ' << runtime << " Count=" << expected << " passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; return 1;
  }
}
