#include "orchestration.hpp"

#include "CounterMirror.generated.hpp"

#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>

namespace generated = mirrors_generated::counter;
namespace integration = mirrorgate::mirrorcpp_integration;

namespace {

std::string read_file(const std::string& path) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) throw std::runtime_error("cannot read " + path);
  std::ostringstream out;
  out << stream.rdbuf();
  return out.str();
}

class GateCounterPort final : public generated::CounterPort {
 public:
  explicit GateCounterPort(std::shared_ptr<mirrorgate::ManagedWorker> worker)
      : worker_(std::move(worker)) {}

  void initialize() override { worker_->invoke("Initialize", {}); }

  void tick(const generated::TickInput& input) override {
    worker_->invoke("Tick", {{"Stride", mirrorgate::NativeValue::bigint(
        input.stride.convert_to<std::string>())}});
  }

  generated::CounterObservation observe() override {
    const auto fields = worker_->observe();
    return {mirrorcpp::Value::Int(fields.at("Count").text)};
  }

  void close() { worker_->close("normal"); }

 private:
  std::shared_ptr<mirrorgate::ManagedWorker> worker_;
};

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc != 12) {
      std::cerr << "usage: mirrorcpp_counter_driver owned|attached GATE_OR_SOCKET "
                   "POLICY POLICY_ID MANIFEST SUBMISSION RUNTIME MIRROR SPEC TRACE "
                   "correct|faulty|wrong-digest|generate-correct|generate-faulty\n";
      return 2;
    }
    const std::string mode = argv[1];
    const std::string expected_outcome = argv[11];
    require(mode == "owned" || mode == "attached", "invalid control mode");
    require(expected_outcome == "correct" || expected_outcome == "faulty" ||
                expected_outcome == "wrong-digest" ||
                expected_outcome == "generate-correct" ||
                expected_outcome == "generate-faulty",
            "invalid expected outcome");
    const bool generated_replay = expected_outcome.starts_with("generate-");
    const std::string sut_outcome = generated_replay
        ? expected_outcome.substr(std::string("generate-").size())
        : expected_outcome;

    mirrorcpp::ApalacheConfig config;
    config.spec_path = argv[9];
    config.invariant = "TraceComplete";
    config.const_init = "CInit";
    config.length_bound = 6;
    config.param_vars = "parameters";

    auto mirrors = mirrorcpp::spawn_mirror(argv[8]);
    require(static_cast<bool>(mirrors), "failed to spawn Mirrors");
    std::string manifest_json = read_file(argv[5]);
    std::string semantic_digest(generated::CounterSemanticDigest);
    if (sut_outcome == "wrong-digest") {
      semantic_digest.assign(64, 'b');
      auto manifest = mirrorgate::Json::parse(manifest_json);
      manifest["interfaceDigest"] = semantic_digest;
      manifest_json = manifest.dump();
    }
    integration::SandboxPlan plan;
    plan.gate = {
        mode == "owned" ? integration::ControlMode::owned_stdio
                          : integration::ControlMode::attached_unix,
        argv[2], argv[3]};
    plan.policy_id = argv[4];
    plan.submission = {{"kind", "prebuilt"},
                       {"input", {{"rootId", "submission"},
                                  {"relativePath", argv[6]}}}};
    plan.runtime = argv[7];
    plan.manifest_json = manifest_json;
    plan.adapter_id = std::string("mirrorgate/") + argv[7];
    if (generated_replay) {
      plan.replay_mode = integration::ModelReplayMode::generate;
      plan.trace_generation.num_traces = 1;
      plan.trace_generation.view = "View";
    }
    integration::SandboxEvidence evidence;
    const mirrorcpp::GeneratedModelInterface metadata{
        semantic_digest,
        generated::CounterModelInterface.contract_json};

    auto result = integration::run_with_traces_sandboxed(
        *mirrors, config, {argv[10]}, metadata, plan,
        [](std::shared_ptr<mirrorgate::ManagedWorker> worker,
           const mirrorcpp::ApalacheConfig& effective)
            -> mirrorcpp::Result<mirrorcpp::LocalBinding> {
          auto port = std::make_shared<GateCounterPort>(std::move(worker));
          auto generated_binding = generated::bind_counter(*port, effective);
          mirrorcpp::LocalBinding local;
          const auto digest = mirrorcpp::semantic_digest_from_hex(
              generated::CounterSemanticDigest);
          if (!digest) return std::unexpected(digest.error());
          local.semantic_digest = *digest;
          local.computer = std::move(generated_binding.computer);
          local.assert_compatible_config = [](const mirrorcpp::ApalacheConfig& candidate) {
            if (candidate.param_vars != "parameters") {
              return mirrorcpp::Result<void>(std::unexpected(mirrorcpp::Error(
                  mirrorcpp::ErrorKind::model_interface,
                  "Counter requires paramVars=parameters",
                  "configuration_mismatch")));
            }
            return mirrorcpp::Result<void>{};
          };
          local.dispose = [port = std::move(port)]() mutable {
            try {
              port->close();
              port.reset();
              return mirrorcpp::Result<void>{};
            } catch (const mirrorgate::SdkError& error) {
              return mirrorcpp::Result<void>(std::unexpected(mirrorcpp::Error(
                  mirrorcpp::ErrorKind::model_interface, error.what(),
                  "mirrorgate." + error.code)));
            }
          };
          return local;
        }, &evidence);

    require(evidence.cleanup_confirmed, "Gate cleanup was not confirmed: " +
            evidence.cleanup_error + (result ? std::string() :
            " primary=" + result.error().message));
    require(evidence.control_shutdown_confirmed,
            "Gate control shutdown was not confirmed: " +
                evidence.control_process_state);
    if (sut_outcome == "wrong-digest") {
      require(!result && result.error().kind == mirrorcpp::ErrorKind::registration &&
                  result.error().code == "interface_digest_mismatch",
              "wrong model digest was not rejected by Mirrors negotiation: " +
              (result ? std::string("unexpected success") :
               std::string(mirrorcpp::error_kind_name(result.error().kind)) + "/" +
                   result.error().code.value_or("no-code") + ": " +
                   result.error().message));
      require(evidence.binding_factory_calls == 0 &&
                  evidence.worker_acquisitions == 0 &&
                  evidence.worker_started_events == 0,
              "failed negotiation reached native binding or worker launch");
    } else {
      require(evidence.binding_factory_calls == 1,
              "negotiated binding factory was not called exactly once");
      require(evidence.worker_acquisitions == 1,
              "Gate worker was not acquired exactly once");
      require(evidence.worker_started_events == 1,
              "Gate did not emit exactly one physical worker.started event");
    }
    if (sut_outcome == "correct") {
      require(static_cast<bool>(result), "correct SUT failed model replay: " +
          (result ? std::string() : result.error().message));
    } else if (sut_outcome == "faulty") {
      require(!result && result.error().kind == mirrorcpp::ErrorKind::step_mismatch,
              "faulty SUT did not produce a real Mirrors step mismatch");
      require(result.error().expected && result.error().actual,
              "step mismatch lacked expected/actual states");
      const auto expected = result.error().expected->at("count").as_int();
      const auto actual = result.error().actual->at("count").as_int();
      require(expected && actual && *expected - *actual == 1,
              "faulty Counter mismatch did not lag the real expected count by one");
    }

    mirrorgate::Json record = {
        {"schema", "mirrors.shared-orchestration-evidence/v1"},
        {"facade", "mirrorcpp"}, {"controlMode", mode},
        {"workerRuntime", argv[7]}, {"backend", "linux-bubblewrap-v1"},
        {"sut", expected_outcome},
        {"resultStatus", result ? "passed" :
            (sut_outcome == "wrong-digest" ? "negotiation-rejected" : "mismatch")},
        {"replay", generated_replay ? "generate" : "traces"},
        {"cleanup", "succeeded"},
        {"controlShutdown", "confirmed"},
        {"controlProcessState", evidence.control_process_state},
        {"bindingFactoryCalls", evidence.binding_factory_calls},
        {"workerAcquisitions", evidence.worker_acquisitions},
        {"workerStartedEvents", evidence.worker_started_events},
        {"nodeEvaluator", false}, {"mirrorEcmaDependency", false}};
    std::cout << record.dump() << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
