// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Smoke contract just to exercise the Foundry toolchain in the scaffolding (1.0).
/// The real attestation contract (non-custodial, third-party-verifiable) is slice 1.2 / ADR-0015.
contract Smoke {
    function ping() external pure returns (uint256) {
        return 1;
    }
}
