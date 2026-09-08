#include "orchestration.hpp"

#include <chrono>
#include <exception>
#include <optional>
#include <utility>

namespace mirrorgate::mirrorcpp_integration {
namespace {

mirrorcpp::Error gate_error(const SdkError& error) {
  return mirrorcpp::Error(mirrorcpp::ErrorKind::model_interface, error.what(),
                          "mirrorgate." + error.code);
}

mirrorcpp::Error local_error(std::string message, std::string code) {
  return mirrorcpp::Error(mirrorcpp::ErrorKind::model_interface,
                          std::move(message), std::move(code));
}

std::vector<std::string> capabilities(const SandboxPlan& plan) {
  return {
      plan.gate.mode == ControlMode::owned_stdio
          ? "control.local-stdio-v1" : "control.local-unix-v1",
      "submission.prebuilt-v1", "execution.compiled-verify-v1",
      "worker.managed-unix-v1",
      plan.runtime == "node-v1" ? "worker.node-v1" : "worker.rust-v1",
      "backend.linux-bubblewrap-v1", "cleanup.bounded-attempt-v1"};
}

}  // namespace

mirrorcpp::Result<void> detail::apply_control_close_receipt(
    mirrorcpp::Result<void> primary,
    const TransportCloseResult& receipt,
    bool expected_owned,
    SandboxEvidence& evidence) {
  evidence.control_process_state = process_close_state_name(receipt.process_state);
  const bool ownership_matches = expected_owned
      ? receipt.process_owned
      : !receipt.process_owned &&
            receipt.process_state == ProcessCloseState::not_owned;
  evidence.control_shutdown_confirmed = receipt.transport_closed &&
      ownership_matches && receipt.process_shutdown_confirmed();
  if (evidence.control_shutdown_confirmed) {
    if (evidence.cleanup_confirmed || !primary) return primary;
    return std::unexpected(local_error(
        "Gate cleanup was not confirmed: " + evidence.cleanup_error,
        "mirrorgate.cleanup_failed"));
  }

  evidence.cleanup_confirmed = false;
  const std::string failure = "control shutdown was not confirmed (state=" +
      evidence.control_process_state + ")";
  if (!evidence.cleanup_error.empty()) evidence.cleanup_error += "; ";
  evidence.cleanup_error += failure;
  if (!primary) return primary;
  return std::unexpected(local_error(
      failure, "mirrorgate.control_shutdown_unconfirmed"));
}

mirrorcpp::Result<void> run_with_traces_sandboxed(
    mirrorcpp::Transport& mirrors,
    const mirrorcpp::ApalacheConfig& config,
    const std::vector<std::string>& trace_paths,
    const mirrorcpp::GeneratedModelInterface& metadata,
    const SandboxPlan& plan,
    WorkerBindingFactory bind_worker,
    SandboxEvidence* evidence) {
  SandboxEvidence local_evidence;
  SandboxEvidence& observed = evidence == nullptr ? local_evidence : *evidence;
  observed = {};
  std::unique_ptr<ControlClient> control;
  std::optional<Session> session;
  mirrorcpp::Result<void> primary;

  const auto digest = mirrorcpp::semantic_digest_from_hex(metadata.semantic_digest);
  if (!digest) return std::unexpected(digest.error());
  try {
    const Manifest parsed_manifest = Manifest::parse(plan.manifest_json);
    if (parsed_manifest.interface_digest() != metadata.semantic_digest) {
      return std::unexpected(local_error(
          "public manifest and generated model semantic digests differ",
          "mirrorgate.manifest_digest_mismatch"));
    }
  } catch (const SdkError& error) {
    return std::unexpected(gate_error(error));
  }

  try {
    if (plan.runtime != "node-v1" && plan.runtime != "rust-v1") {
      return std::unexpected(local_error("unsupported Gate worker runtime",
                                         "mirrorgate.configuration"));
    }
    if (!bind_worker) {
      return std::unexpected(local_error("missing native worker binding factory",
                                         "mirrorgate.configuration"));
    }
    const auto required = capabilities(plan);
    if (plan.gate.mode == ControlMode::owned_stdio) {
      control = ControlClient::launch(
          {plan.gate.executable_or_socket, "control", "--stdio",
           "--policy-file", plan.gate.policy_file}, required);
    } else {
      control = ControlClient::connect(plan.gate.executable_or_socket, required);
    }
    observed.owned_process = control->owns_process();
    if (observed.owned_process !=
        (plan.gate.mode == ControlMode::owned_stdio)) {
      throw SdkError("OWNERSHIP", "control endpoint ownership mismatch");
    }

    session.emplace(control->open_session({
        {"policyId", plan.policy_id}, {"submission", plan.submission},
        {"runtime", plan.runtime}, {"manifestJson", plan.manifest_json}}));
    const Json prepared = session->prepare().wait();
    mirrorcpp::CompiledAdapterRegistry registry({
        mirrorcpp::CompiledAdapterRegistration{
            mirrorcpp::CompiledAdapterKey{
                *digest, plan.adapter_id, plan.target_profile,
                plan.state_computer_contract_version},
            [&](const mirrorcpp::ApalacheConfig& effective)
                -> mirrorcpp::Result<mirrorcpp::LocalBinding> {
              ++observed.binding_factory_calls;
              try {
                const Json attestation = {
                    {"registrationId", "mirrorcpp-" + session->id()},
                    {"request", "verify"}, {"policy", "require"},
                    {"status", "matched"},
                    {"descriptorSchema", plan.descriptor_schema},
                    {"semanticDigest", metadata.semantic_digest},
                    {"adapterId", plan.adapter_id},
                    {"targetProfile", plan.target_profile},
                    {"stateComputerContractVersion",
                     plan.state_computer_contract_version}};
                auto authorization = session->authorize(
                    prepared.at("preparedRevision").get<std::uint64_t>(),
                    prepared.at("challenge").get<std::string>(), attestation);
                auto descriptor = session->acquire_worker(authorization);
                auto worker = std::shared_ptr<ManagedWorker>(ManagedWorker::attach(
                    *session, std::move(descriptor),
                    Manifest::parse(plan.manifest_json), plan.runtime));
                ++observed.worker_acquisitions;
                auto binding = bind_worker(worker, effective);
                if (!binding) {
                  try { worker->close("client-failure"); } catch (...) {}
                  return binding;
                }
                auto dispose = std::move(binding->dispose);
                binding->dispose = [worker = std::move(worker),
                                    dispose = std::move(dispose)]() mutable {
                  mirrorcpp::Result<void> primary_cleanup;
                  if (dispose) primary_cleanup = dispose();
                  try {
                    worker->close(primary_cleanup ? "normal" : "client-failure");
                  } catch (const SdkError& error) {
                    if (primary_cleanup) return mirrorcpp::Result<void>(
                        std::unexpected(gate_error(error)));
                  }
                  worker.reset();
                  return primary_cleanup;
                };
                return binding;
              } catch (const SdkError& error) {
                return std::unexpected(gate_error(error));
              } catch (const std::exception& error) {
                return std::unexpected(local_error(
                    std::string("native worker binding failed: ") + error.what(),
                    "mirrorgate.binding_failed"));
              }
            }}});
    const mirrorcpp::CompiledAdapterSelection selection{
        metadata, plan.adapter_id, plan.target_profile,
        plan.state_computer_contract_version, &registry,
        mirrorcpp::NegotiationPolicy::require, std::nullopt};
    primary = plan.replay_mode == ModelReplayMode::generate
        ? mirrorcpp::run_client_negotiated(
              mirrors, config, plan.trace_generation, selection)
        : mirrorcpp::run_client_with_traces_negotiated(
              mirrors, config, trace_paths, selection);
  } catch (const SdkError& error) {
    primary = std::unexpected(gate_error(error));
  } catch (const std::exception& error) {
    primary = std::unexpected(local_error(
        std::string("native orchestration failed: ") + error.what(),
        "mirrorgate.orchestration_failed"));
  }

  if (session) {
    Json summary = {{"status", primary ? "passed" :
        (primary.error().kind == mirrorcpp::ErrorKind::step_mismatch
             ? "mismatch" : "failed")}};
    if (!primary) summary["failureFamily"] =
        mirrorcpp::error_kind_name(primary.error().kind);
    try {
      const Json cleanup = session->close(&summary).wait();
      observed.cleanup_confirmed = cleanup.at("phase") == "closed" &&
          cleanup.at("cleanupStatus") == "succeeded" &&
          cleanup.at("remainingResources").empty();
      if (!observed.cleanup_confirmed) {
        observed.cleanup_error = "Gate did not confirm closed/succeeded: " +
            cleanup.dump();
      }
    } catch (const std::exception& error) {
      observed.cleanup_error = error.what();
    }
  }
  if (control) {
    for (const auto& event : control->take_events()) {
      if (event.name == "worker.started") ++observed.worker_started_events;
    }
    const TransportCloseResult receipt = control->close_with_result();
    return detail::apply_control_close_receipt(
        std::move(primary), receipt,
        plan.gate.mode == ControlMode::owned_stdio, observed);
  }
  if (!observed.cleanup_confirmed && primary) {
    return std::unexpected(local_error(
        "Gate cleanup was not confirmed: " + observed.cleanup_error,
        "mirrorgate.cleanup_failed"));
  }
  return primary;
}

}  // namespace mirrorgate::mirrorcpp_integration
