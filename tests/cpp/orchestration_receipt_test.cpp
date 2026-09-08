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

}  // namespace

int main() {
  try {
    test_confirmed_owned_and_attached_receipts();
    test_unconfirmed_owned_process_fails_a_pass();
    test_unconfirmed_close_preserves_primary_mismatch();
    std::cout << "MirrorCPP orchestration close receipt tests passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
