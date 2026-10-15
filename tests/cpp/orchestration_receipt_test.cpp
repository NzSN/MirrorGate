#include "orchestration.hpp"

#include <iostream>
#include <stdexcept>
#include <string>

namespace integration = mirrorgate::mirrorcpp_integration;

namespace {

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void test_confirmed_owned_and_attached_receipts() {
  mirrorgate::TransportCloseResult owned;
  owned.transport_closed = true;
  owned.process_owned = true;
  owned.process_state = mirrorgate::ProcessCloseState::exited;
  owned.exit_code = 0;
  integration::SandboxEvidence owned_evidence;
  owned_evidence.cleanup_confirmed = true;
  auto owned_result = integration::detail::apply_control_close_receipt(
      {}, owned, true, owned_evidence);
  require(owned_result && owned_evidence.control_shutdown_confirmed &&
              owned_evidence.cleanup_confirmed &&
              owned_evidence.control_process_state == "exited",
          "confirmed owned process receipt failed");

  mirrorgate::TransportCloseResult attached;
  attached.transport_closed = true;
  attached.process_state = mirrorgate::ProcessCloseState::not_owned;
  integration::SandboxEvidence attached_evidence;
  attached_evidence.cleanup_confirmed = true;
  auto attached_result = integration::detail::apply_control_close_receipt(
      {}, attached, false, attached_evidence);
  require(attached_result && attached_evidence.control_shutdown_confirmed,
          "confirmed attached close was rejected");
}

void test_unconfirmed_owned_process_fails_a_pass() {
  mirrorgate::TransportCloseResult receipt;
  receipt.transport_closed = true;
  receipt.process_owned = true;
  receipt.process_state = mirrorgate::ProcessCloseState::unconfirmed;
  integration::SandboxEvidence evidence;
  evidence.cleanup_confirmed = true;
  auto result = integration::detail::apply_control_close_receipt(
      {}, receipt, true, evidence);
  require(!result && result.error().kind == mirrorcpp::ErrorKind::model_interface &&
              result.error().code == "mirrorgate.control_shutdown_unconfirmed" &&
              !evidence.control_shutdown_confirmed &&
              !evidence.cleanup_confirmed,
          "unconfirmed owned process shutdown was reported as a pass");
}

void test_unconfirmed_close_preserves_primary_mismatch() {
  mirrorgate::TransportCloseResult receipt;
  receipt.transport_closed = true;
  receipt.process_owned = true;
  receipt.process_state = mirrorgate::ProcessCloseState::unconfirmed;
  mirrorcpp::Result<void> primary = std::unexpected(mirrorcpp::Error(
      mirrorcpp::ErrorKind::step_mismatch, "real model mismatch"));
  integration::SandboxEvidence evidence;
  evidence.cleanup_confirmed = true;
  auto result = integration::detail::apply_control_close_receipt(
      std::move(primary), receipt, true, evidence);
  require(!result && result.error().kind == mirrorcpp::ErrorKind::step_mismatch &&
              result.error().message == "real model mismatch" &&
              !evidence.cleanup_confirmed,
          "control shutdown failure replaced the primary model mismatch");
}

void test_failure_authority_and_primary_precedence() {
  using mirrorgate::FailureFamily;
  using mirrorgate::FailureOrigin;
  const auto error_result = [](const std::string& code) -> mirrorcpp::Result<void> {
    return std::unexpected(mirrorcpp::Error(mirrorcpp::ErrorKind::model_interface,
        "same human text", code));
  };
  for (const auto& [family_code, family] : std::vector<std::pair<const char*, FailureFamily>>{
      {"VERSION_UNSUPPORTED", FailureFamily::control_compatibility},
      {"BACKEND_ADMISSION_FAILED", FailureFamily::admission},
      {"BUILD_FAILED", FailureFamily::build},
      {"NEGOTIATION_ATTESTATION_INVALID", FailureFamily::negotiation},
      {"DEADLINE_EXCEEDED", FailureFamily::timeout},
      {"CANCELLED", FailureFamily::cancellation},
      {"WORKER_PROTOCOL_FAILED", FailureFamily::worker_protocol}}) {
    integration::SandboxEvidence evidence;
    auto snapshot = mirrorgate::snapshot_failure(mirrorgate::SdkError(
        family_code, "worker", "same human text", 42, FailureOrigin::control_reply), "acquire");
    evidence.primary_failure = std::make_shared<const mirrorgate::FailureSnapshot>(snapshot);
    evidence.cleanup_failure = std::make_shared<const mirrorgate::FailureSnapshot>(
        mirrorgate::snapshot_failure(mirrorgate::SdkError("CLEANUP_FAILED", "cleanup",
            "secondary cleanup", 43, FailureOrigin::control_reply), "cleanup"));
    auto result = integration::detail::restore_gate_failure(error_result("adapter_factory_failed"), evidence);
    require(!result && result.error().code == std::string("mirrorgate.") + family_code &&
        evidence.primary_failure->stage == "worker" && evidence.primary_failure->operation_id == 42 &&
        evidence.primary_failure->family == family &&
        evidence.cleanup_failure->operation_id == 43,
        "normalized factory failure lost trusted code/stage or secondary cleanup");
    auto ordinary = integration::detail::restore_gate_failure(
        std::unexpected(mirrorcpp::Error(mirrorcpp::ErrorKind::registration,
            "negotiation rejected", "interface_digest_mismatch")), evidence);
    require(!ordinary && ordinary.error().kind == mirrorcpp::ErrorKind::registration,
            "Gate snapshot replaced ordinary Mirrors negotiation");
    auto mismatch = integration::detail::restore_gate_failure(
        std::unexpected(mirrorcpp::make_step_mismatch("mismatch",
            mirrorcpp::State{}, mirrorcpp::State{})), evidence);
    require(!mismatch && mismatch.error().kind == mirrorcpp::ErrorKind::step_mismatch &&
        mismatch.error().expected && mismatch.error().actual,
        "Gate snapshot replaced or erased ordinary Mirrors mismatch data");
  }
  for (const std::string code : {"BACKEND_ADMISSION_FAILED", "DEADLINE_EXCEEDED"}) {
    integration::SandboxEvidence evidence;
    evidence.primary_failure = std::make_shared<const mirrorgate::FailureSnapshot>(
        mirrorgate::snapshot_failure(mirrorgate::SdkError(code, "", "same human text", 0,
            FailureOrigin::worker_application), "observe"));
    auto result = integration::detail::restore_gate_failure(error_result("observation_shape_mismatch"), evidence);
    require(!result && result.error().code == "mirrorgate.worker_application" &&
        evidence.primary_failure->code == code &&
        evidence.primary_failure->family == FailureFamily::worker_application,
        "worker-chosen code spoofed a trusted Gate failure");
  }
  integration::SandboxEvidence no_gate_failure;
  auto arbitrary = integration::detail::restore_gate_failure(error_result("adapter_failure"), no_gate_failure);
  require(!arbitrary && arbitrary.error().code == "adapter_failure",
          "equal adapter message was reclassified without a trusted SDK snapshot");
  integration::SandboxEvidence cleanup_only;
  cleanup_only.cleanup_failure = std::make_shared<const mirrorgate::FailureSnapshot>(
      mirrorgate::snapshot_failure(mirrorgate::SdkError("CLEANUP_FAILED", "cleanup",
          "secondary cleanup", 44, FailureOrigin::control_reply), "cleanup"));
  auto cleanup_result = integration::detail::restore_gate_failure({}, cleanup_only);
  require(!cleanup_result && cleanup_result.error().code == "mirrorgate.CLEANUP_FAILED",
          "cleanup-only failure left a successful public result");
  const auto unicode = mirrorgate::snapshot_failure(mirrorgate::SdkError("SCHEMA",
      std::string(1023, 'x') + "\xe2\x82\xac"), "observe");
  require(unicode.message.size() == 1023,
          "bounded diagnostics split a UTF-8 scalar");
}

}  // namespace

int main() {
  try {
    test_confirmed_owned_and_attached_receipts();
    test_unconfirmed_owned_process_fails_a_pass();
    test_unconfirmed_close_preserves_primary_mismatch();
    test_failure_authority_and_primary_precedence();
    std::cout << "MirrorCPP orchestration close receipt tests passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
