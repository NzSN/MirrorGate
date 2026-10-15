#include "orchestration.hpp"

#include <chrono>
#include <exception>
#include <optional>
#include <utility>

namespace mirrorgate::mirrorcpp_integration {
namespace {

mirrorcpp::Error gate_error(const FailureSnapshot& error) {
  // A worker-chosen code never occupies the trusted control namespace.
  const std::string code = error.origin == FailureOrigin::worker_application
      ? "mirrorgate.worker_application" : "mirrorgate." + error.code;
  return mirrorcpp::Error(mirrorcpp::ErrorKind::model_interface, error.message, code);
}

void capture(std::shared_ptr<const FailureSnapshot>& target,
             const FailureSnapshot& snapshot) {
  if (!target) target = std::make_shared<const FailureSnapshot>(snapshot);
}

void capture_worker(ManagedWorker& worker, SandboxEvidence& evidence,
                    bool before_cleanup) {
  if (before_cleanup) {
    if (auto failure = worker.failure_snapshot()) capture(evidence.primary_failure, *failure);
  }
  if (auto failure = worker.cleanup_failure_snapshot()) capture(evidence.cleanup_failure, *failure);
}

void cleanup_failure(SandboxEvidence& evidence, const std::string& code,
                     const std::string& message) {
  capture(evidence.cleanup_failure, snapshot_failure(SdkError(code, message), "cleanup"));
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

mirrorcpp::Result<void> detail::restore_gate_failure(
    mirrorcpp::Result<void> primary, SandboxEvidence& evidence) {
  if (primary) {
    if (evidence.cleanup_failure) return std::unexpected(gate_error(*evidence.cleanup_failure));
    return primary;
  }
  if (primary.error().kind != mirrorcpp::ErrorKind::model_interface) return primary;
  const auto& code = primary.error().code;
  if (code == "adapter_dispose_failed" && evidence.cleanup_failure)
    return std::unexpected(gate_error(*evidence.cleanup_failure));
  if ((code == "adapter_factory_failed" || code == "adapter_failure" ||
       code == "observation_shape_mismatch") && evidence.primary_failure)
    return std::unexpected(gate_error(*evidence.primary_failure));
  return primary;
}

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
    cleanup_failure(evidence, "cleanup_failed", evidence.cleanup_error);
    return std::unexpected(local_error(
        "Gate cleanup was not confirmed: " + evidence.cleanup_error,
        "mirrorgate.cleanup_failed"));
  }

  evidence.cleanup_confirmed = false;
  const std::string failure = "control shutdown was not confirmed (state=" +
      evidence.control_process_state + ")";
  if (!evidence.cleanup_error.empty()) evidence.cleanup_error += "; ";
  evidence.cleanup_error += failure;
  cleanup_failure(evidence, "control_shutdown_unconfirmed", failure);
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
    capture(observed.primary_failure, snapshot_failure(error, "manifest"));
    return std::unexpected(gate_error(*observed.primary_failure));
  }

  std::string operation = "bootstrap";
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

    operation = "open_session";
    session.emplace(control->open_session({
        {"policyId", plan.policy_id}, {"submission", plan.submission},
        {"runtime", plan.runtime}, {"manifestJson", plan.manifest_json}}));
    operation = "prepare";
    const Json prepared = session->prepare().wait();
    mirrorcpp::CompiledAdapterRegistry registry({
        mirrorcpp::CompiledAdapterRegistration{
            mirrorcpp::CompiledAdapterKey{
                *digest, plan.adapter_id, plan.target_profile,
                plan.state_computer_contract_version},
            [&](const mirrorcpp::ApalacheConfig& effective)
                -> mirrorcpp::Result<mirrorcpp::LocalBinding> {
              ++observed.binding_factory_calls;
              std::string factory_operation = "authorize";
              std::shared_ptr<ManagedWorker> worker;
              bool in_binding_factory = false;
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
                factory_operation = "acquire";
                auto descriptor = session->acquire_worker(authorization);
                factory_operation = "attach";
                worker = std::shared_ptr<ManagedWorker>(ManagedWorker::attach(
                    *session, std::move(descriptor),
                    Manifest::parse(plan.manifest_json), plan.runtime));
                ++observed.worker_acquisitions;
                in_binding_factory = true;
                auto binding = bind_worker(worker, effective);
                in_binding_factory = false;
                if (!binding) {
                  capture_worker(*worker, observed, true);
                  try { worker->close("client-failure"); }
                  catch (const SdkError& error) {
                    capture(observed.cleanup_failure, snapshot_failure(error, "dispose"));
                  }
                  capture_worker(*worker, observed, false);
                  return binding;
                }
                auto dispose = std::move(binding->dispose);
                binding->dispose = [worker = std::move(worker),
                                    dispose = std::move(dispose), &observed]() mutable {
                  // This is the last seam before generated disposal can close
                  // the worker. Capture body failure before any cleanup runs.
                  capture_worker(*worker, observed, true);
                  mirrorcpp::Result<void> primary_cleanup;
                  try { if (dispose) primary_cleanup = dispose(); }
                  catch (const std::exception& error) {
                    cleanup_failure(observed, "adapter_dispose_failed", error.what());
                    primary_cleanup = std::unexpected(local_error(
                        error.what(), "adapter_dispose_failed"));
                  } catch (...) {
                    cleanup_failure(observed, "adapter_dispose_failed", "native binding disposal threw");
                    primary_cleanup = std::unexpected(local_error(
                        "native binding disposal threw", "adapter_dispose_failed"));
                  }
                  try {
                    worker->close(primary_cleanup ? "normal" : "client-failure");
                  } catch (const SdkError& error) {
                    capture(observed.cleanup_failure, snapshot_failure(error, "dispose"));
                  }
                  capture_worker(*worker, observed, false);
                  if (!primary_cleanup && !observed.cleanup_failure)
                    cleanup_failure(observed, "adapter_dispose_failed", primary_cleanup.error().message);
                  worker.reset();
                  if (primary_cleanup && observed.cleanup_failure)
                    return mirrorcpp::Result<void>(std::unexpected(gate_error(*observed.cleanup_failure)));
                  return primary_cleanup;
                };
                return binding;
              } catch (const SdkError& error) {
                if (worker) capture_worker(*worker, observed, true);
                if (!in_binding_factory)
                  capture(observed.primary_failure, snapshot_failure(error, factory_operation));
                if (worker) {
                  try { worker->close("client-failure"); }
                  catch (const SdkError& cleanup) {
                    capture(observed.cleanup_failure, snapshot_failure(cleanup, "dispose"));
                  }
                  capture_worker(*worker, observed, false);
                }
                if (observed.primary_failure)
                  return std::unexpected(gate_error(*observed.primary_failure));
                return std::unexpected(local_error(error.what(), "mirrorgate.binding_failed"));
              } catch (const std::exception& error) {
                if (worker) {
                  capture_worker(*worker, observed, true);
                  try { worker->close("client-failure"); }
                  catch (const SdkError& cleanup) {
                    capture(observed.cleanup_failure, snapshot_failure(cleanup, "dispose"));
                  }
                  capture_worker(*worker, observed, false);
                }
                return std::unexpected(local_error(
                    std::string("native worker binding failed: ") + error.what(),
                    "mirrorgate.binding_failed"));
              }
            }}});
    const mirrorcpp::CompiledAdapterSelection selection{
        metadata, plan.adapter_id, plan.target_profile,
        plan.state_computer_contract_version, &registry,
        mirrorcpp::NegotiationPolicy::require, std::nullopt};
    operation = "replay";
    primary = plan.replay_mode == ModelReplayMode::generate
        ? mirrorcpp::run_client_negotiated(
              mirrors, config, plan.trace_generation, selection)
        : mirrorcpp::run_client_with_traces_negotiated(
              mirrors, config, trace_paths, selection);
    primary = detail::restore_gate_failure(std::move(primary), observed);
  } catch (const SdkError& error) {
    capture(observed.primary_failure, snapshot_failure(error, operation));
    primary = std::unexpected(gate_error(*observed.primary_failure));
  } catch (const std::exception& error) {
    primary = std::unexpected(local_error(
        std::string("native orchestration failed: ") + error.what(),
        "mirrorgate.orchestration_failed"));
  }

  if (session) {
    Json summary = {{"status", primary ? "passed" :
        (primary.error().kind == mirrorcpp::ErrorKind::step_mismatch
             ? "mismatch" : "failed")}};
    if (!primary) {
      const auto recorded = observed.primary_failure
          ? observed.primary_failure : observed.cleanup_failure;
      summary["failureFamily"] = primary.error().kind == mirrorcpp::ErrorKind::model_interface && recorded
          ? failure_family_name(recorded->family)
          : mirrorcpp::error_kind_name(primary.error().kind);
    }
    try {
      const Json cleanup = session->close(&summary).wait();
      observed.cleanup_confirmed = cleanup.at("phase") == "closed" &&
          cleanup.at("cleanupStatus") == "succeeded" &&
          cleanup.at("remainingResources").empty();
      if (!observed.cleanup_confirmed) {
        observed.cleanup_error = "Gate did not confirm closed/succeeded: " +
            cleanup.dump();
        cleanup_failure(observed, "cleanup_failed", observed.cleanup_error);
      }
    } catch (const SdkError& error) {
      observed.cleanup_error = error.what();
      capture(observed.cleanup_failure, snapshot_failure(error, "cleanup"));
    } catch (const std::exception& error) {
      observed.cleanup_error = error.what();
      cleanup_failure(observed, "cleanup_failed", observed.cleanup_error);
    }
  }
  // A successful body with failed cleanup must be a public failure. A failed
  // body is retained, including an ordinary Mirrors mismatch or negotiation.
  if (primary && observed.cleanup_failure)
    primary = std::unexpected(gate_error(*observed.cleanup_failure));
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
