#pragma once

#include <mirrorgate/managed_worker.hpp>
#include <mirrorcpp/client.hpp>

#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace mirrorgate::mirrorcpp_integration {

enum class ControlMode { owned_stdio, attached_unix };
enum class ModelReplayMode { traces, generate };

struct GateEndpoint {
  ControlMode mode = ControlMode::owned_stdio;
  std::string executable_or_socket;
  std::string policy_file;
};

struct SandboxPlan {
  GateEndpoint gate;
  std::string policy_id;
  Json submission;
  std::string runtime;
  std::string manifest_json;
  std::string adapter_id;
  std::string target_profile = std::string(mirrorcpp::mirrorcpp_target_profile);
  std::string state_computer_contract_version =
      std::string(mirrorcpp::state_computer_contract_version);
  std::string descriptor_schema =
      std::string(mirrorcpp::model_interface_descriptor_schema);
  ModelReplayMode replay_mode = ModelReplayMode::traces;
  mirrorcpp::TraceGenerationConfig trace_generation;
};

struct SandboxEvidence {
  bool owned_process = false;
  std::size_t binding_factory_calls = 0;
  std::size_t worker_acquisitions = 0;
  std::size_t worker_started_events = 0;
  bool cleanup_confirmed = false;
  bool control_shutdown_confirmed = false;
  std::string control_process_state = "unconfirmed";
  std::string cleanup_error;
};

namespace detail {
mirrorcpp::Result<void> apply_control_close_receipt(
    mirrorcpp::Result<void> primary,
    const TransportCloseResult& receipt,
    bool expected_owned,
    SandboxEvidence& evidence);
}

using WorkerBindingFactory = std::function<mirrorcpp::Result<mirrorcpp::LocalBinding>(
    std::shared_ptr<ManagedWorker>, const mirrorcpp::ApalacheConfig&)>;

// Trusted native orchestration facade. Gate preparation precedes model
// negotiation, while authorization and worker acquisition occur only inside
// MirrorCPP's post-match adapter factory.
mirrorcpp::Result<void> run_with_traces_sandboxed(
    mirrorcpp::Transport& mirrors,
    const mirrorcpp::ApalacheConfig& config,
    const std::vector<std::string>& trace_paths,
    const mirrorcpp::GeneratedModelInterface& metadata,
    const SandboxPlan& plan,
    WorkerBindingFactory bind_worker,
    SandboxEvidence* evidence = nullptr);

}  // namespace mirrorgate::mirrorcpp_integration
