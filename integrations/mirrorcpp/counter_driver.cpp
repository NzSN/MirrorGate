#include "orchestration.hpp"

#include "CounterMirror.generated.hpp"

#include <fstream>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <memory>
#include <optional>
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
  explicit GateCounterPort(std::shared_ptr<mirrorgate::ManagedWorker> worker,
                           std::string scenario)
      : worker_(std::move(worker)), scenario_(std::move(scenario)) {}

  void initialize() override {
    if (scenario_ == "error-adapter") throw std::runtime_error("same human text");
    worker_->invoke("Initialize", {}, options());
  }

  void tick(const generated::TickInput& input) override {
    worker_->invoke("Tick", {{"Stride", mirrorgate::NativeValue::bigint(
        input.stride.convert_to<std::string>())}}, options());
  }

  generated::CounterObservation observe() override {
    const auto fields = worker_->observe(options());
    return {mirrorcpp::Value::Int(fields.at("Count").text)};
  }

  void close() { worker_->close("normal"); }

 private:
  std::shared_ptr<mirrorgate::ManagedWorker> worker_;
  std::string scenario_;
  mirrorgate::CallOptions options() const {
    mirrorgate::CallOptions result;
    if (scenario_.find("timeout") != std::string::npos)
      result.timeout = std::chrono::milliseconds(150);
    if (scenario_.find("cancel") != std::string::npos) {
      const auto at = std::chrono::steady_clock::now() + std::chrono::milliseconds(30);
      result.cancelled = [at] { return std::chrono::steady_clock::now() >= at; };
    }
    return result;
  }
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
    const bool error_case = expected_outcome.starts_with("error-");
    const bool broker_protocol_fault = expected_outcome == "error-invoke-protocol" ||
        expected_outcome == "error-observe-protocol";
    require(mode == "owned" || mode == "attached", "invalid control mode");
    require(expected_outcome == "correct" || expected_outcome == "faulty" ||
                expected_outcome == "wrong-digest" ||
                expected_outcome == "generate-correct" ||
                expected_outcome == "generate-faulty" || error_case,
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
    if (expected_outcome == "error-build") {
      plan.submission["kind"] = "source";
      plan.submission["buildPlanId"] = "copy";
      plan.submission["authoring"] = false;
    }
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

    // An independent attached connection keeps a live, authorized worker while
    // the facade runs. Its continued operation proves session-scoped cleanup.
    std::unique_ptr<mirrorgate::ControlClient> sibling_control;
    std::optional<mirrorgate::Session> sibling_session;
    std::unique_ptr<mirrorgate::ManagedWorker> sibling_worker;
    if (mode == "attached" && std::getenv("MIRRORGATE_CPP_SECOND_SESSION")) {
      sibling_control = mirrorgate::ControlClient::connect(argv[2], {});
      sibling_session.emplace(sibling_control->open_session({
          {"policyId", plan.policy_id}, {"runtime", plan.runtime},
          {"manifestJson", plan.manifest_json},
          {"submission", {{"kind", "prebuilt"},
              {"input", {{"rootId", "submission"}, {"relativePath", "observer"}}}}}}));
      const auto prepared = sibling_session->prepare().wait();
      auto authorization = sibling_session->authorize(
          prepared.at("preparedRevision").get<std::uint64_t>(),
          prepared.at("challenge").get<std::string>(), {
              {"registrationId", "sibling-owner"}, {"request", "verify"},
              {"policy", "require"}, {"status", "matched"},
              {"descriptorSchema", plan.descriptor_schema},
              {"semanticDigest", semantic_digest}, {"adapterId", plan.adapter_id},
              {"targetProfile", plan.target_profile},
              {"stateComputerContractVersion", plan.state_computer_contract_version}});
      sibling_worker = mirrorgate::ManagedWorker::attach(*sibling_session,
          sibling_session->acquire_worker(authorization),
          mirrorgate::Manifest::parse(plan.manifest_json), plan.runtime);
      sibling_worker->invoke("Initialize", {});
      require(sibling_worker->observe().at("Count").text == "0", "sibling worker initialization failed");
    }
    if (const char* denied_mount = std::getenv("MIRRORGATE_CPP_DENIED_MOUNT")) {
      require(mode == "attached" && expected_outcome == "error-admission" &&
          std::filesystem::remove(denied_mount),
          "admission fixture did not remove its empty approved mount after policy load");
    }

    auto result = integration::run_with_traces_sandboxed(
        *mirrors, config, {argv[10]}, metadata, plan,
        [&expected_outcome](std::shared_ptr<mirrorgate::ManagedWorker> worker,
           const mirrorcpp::ApalacheConfig& effective)
            -> mirrorcpp::Result<mirrorcpp::LocalBinding> {
          auto port = std::make_shared<GateCounterPort>(std::move(worker), expected_outcome);
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

    if (expected_outcome == "error-cleanup") {
      require(!result && !evidence.primary_failure && evidence.cleanup_failure,
              "intentional cleanup failure lost its cleanup-only outcome");
      const auto& failure = *evidence.cleanup_failure;
      require(failure.origin == mirrorgate::FailureOrigin::worker_application &&
          failure.family == mirrorgate::FailureFamily::worker_application &&
          failure.code == "APPLICATION" && failure.stage.empty() &&
          failure.operation_id == 0 && failure.operation == "dispose" &&
          result.error().code == "mirrorgate.worker_application",
          "intentional cleanup failure lost its original trusted-boundary evidence");
    } else require(evidence.cleanup_confirmed, "Gate cleanup was not confirmed: " +
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
    } else if (expected_outcome == "error-build") {
      require(evidence.binding_factory_calls == 0 && evidence.worker_acquisitions == 0 &&
          evidence.worker_started_events == 0, "build failure reached worker acquisition");
    } else if (expected_outcome == "error-admission") {
      require(evidence.binding_factory_calls == 1 && evidence.worker_acquisitions == 0 &&
          evidence.worker_started_events == 0, "denied admission fell through to worker launch");
    } else {
      require(evidence.binding_factory_calls == 1,
              "negotiated binding factory was not called exactly once");
      require(evidence.worker_acquisitions == 1,
              "Gate worker was not acquired exactly once");
      require(evidence.worker_started_events == 1,
              "Gate did not emit exactly one physical worker.started event");
    }
    if (error_case) {
      require(!result, "injected Gate failure was reported as success");
      if (expected_outcome == "error-adapter") {
        require(result.error().code == "adapter_failure" && !evidence.primary_failure,
                "arbitrary adapter exception acquired Gate classification");
      } else {
        const auto failure = expected_outcome == "error-cleanup"
            ? evidence.cleanup_failure : evidence.primary_failure;
        require(static_cast<bool>(failure), "injected failure lost structured evidence");
        const std::string expected_family = expected_outcome == "error-build" ? "build"
            : expected_outcome == "error-admission" ? "admission"
            : broker_protocol_fault ? "worker_transport"
            : expected_outcome.find("protocol") != std::string::npos
            ? "worker_protocol" : expected_outcome.find("transport") != std::string::npos
            ? "worker_transport" : expected_outcome.find("timeout") != std::string::npos
            ? "timeout" : expected_outcome.find("cancel") != std::string::npos
            ? "cancellation" : "worker_application";
        require(mirrorgate::failure_family_name(failure->family) == expected_family,
                "failure family changed: " + std::string(mirrorgate::failure_family_name(failure->family)));
        if (expected_outcome.find("spoof") != std::string::npos) {
          require(result.error().code == "mirrorgate.worker_application" &&
              failure->code == (expected_outcome == "error-spoof-admission"
                  ? "BACKEND_ADMISSION_FAILED" : "DEADLINE_EXCEEDED"),
                  "peer-authored control/deadline code spoofed trusted origin");
        }
        if (expected_outcome == "error-build" || expected_outcome == "error-admission") {
          require(failure->origin == mirrorgate::FailureOrigin::control_reply &&
              failure->code == (expected_outcome == "error-build" ? "BUILD_FAILED" : "BACKEND_ADMISSION_FAILED") &&
              failure->stage == (expected_outcome == "error-build" ? "build" : "authorize"),
              "control failure lost exact code or stage");
        } else if (broker_protocol_fault) {
          require(failure->origin == mirrorgate::FailureOrigin::sdk &&
              failure->code == "CONTROL_DISCONNECTED" && failure->stage.empty() &&
              failure->operation_id == 0 &&
              failure->operation == (expected_outcome == "error-invoke-protocol" ? "invoke" : "observe") &&
              result.error().code == "mirrorgate.CONTROL_DISCONNECTED",
              "broker-filtered invalid response lost its observed SDK disconnect classification");
        } else require(failure->stage.empty() && failure->operation_id == 0,
            "local context overwrote exact worker stage or operation ID");
      }
    } else if (sut_outcome == "correct") {
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

    if (sibling_worker) {
      sibling_worker->invoke("Tick", {{"Stride", mirrorgate::NativeValue::bigint("2")}});
      require(sibling_worker->observe().at("Count").text == "2",
              "facade cleanup damaged another attached session");
      sibling_worker->close();
      require(sibling_session->close().wait().at("phase") == "closed",
              "sibling session cleanup was not confirmed");
      require(sibling_control->close_with_result().process_state == mirrorgate::ProcessCloseState::not_owned,
              "sibling attached control acquired daemon ownership");
    }

    mirrorgate::Json record = {
        {"schema", "mirrors.shared-orchestration-evidence/v1"},
        {"facade", "mirrorcpp"}, {"controlMode", mode},
        {"workerRuntime", argv[7]}, {"backend", "linux-bubblewrap-v1"},
        {"sut", expected_outcome},
        {"resultStatus", result ? "passed" :
            (sut_outcome == "wrong-digest" ? "negotiation-rejected" : error_case ? "failed" : "mismatch")},
        {"replay", generated_replay ? "generate" : "traces"},
        {"cleanup", evidence.cleanup_confirmed ? "succeeded" : "failed"},
        {"cleanupConfirmed", evidence.cleanup_confirmed},
        {"controlShutdown", "confirmed"},
        {"controlProcessState", evidence.control_process_state},
        {"bindingFactoryCalls", evidence.binding_factory_calls},
        {"workerAcquisitions", evidence.worker_acquisitions},
        {"workerStartedEvents", evidence.worker_started_events},
        {"nodeEvaluator", false}, {"mirrorEcmaDependency", false}};
    if (broker_protocol_fault) record["faultInjection"] = {
        {"kind", "uncorrelated_worker_response_id"},
        {"operation", expected_outcome == "error-invoke-protocol" ? "invoke" : "observe"}};
    const auto encode_failure = [](const std::shared_ptr<const mirrorgate::FailureSnapshot>& failure) -> mirrorgate::Json {
      if (!failure) return nullptr;
      return {{"origin", mirrorgate::failure_origin_name(failure->origin)},
          {"family", mirrorgate::failure_family_name(failure->family)},
          {"code", failure->code}, {"stage", failure->stage},
          {"operationId", failure->operation_id}, {"operation", failure->operation},
          {"message", failure->message}};
    };
    record["primaryFailure"] = encode_failure(evidence.primary_failure);
    record["cleanupFailure"] = encode_failure(evidence.cleanup_failure);
    record["secondSessionSurvived"] = static_cast<bool>(sibling_worker);
    if (!result) record["publicErrorCode"] = result.error().code.value_or("");
    std::cout << record.dump() << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
