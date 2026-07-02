// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LateoAttestation
/// @notice Thin, non-custodial attestation ledger (ADR-0015). Publishes a per-epoch
/// commitment (a merkle root of the public off-chain ledger state) so ANYONE can verify
/// LATEO's accounting/invariants against the chain WITHOUT trusting the backend.
/// @dev Append-only, single writer, NO funds, NO value logic, NO upgradeability. Merkle
/// building/verification is done off-chain (rebuild the root from the published leaves and
/// compare it to `rootOf`). The contract intentionally holds no state beyond the roots.
contract LateoAttestation {
    /// @notice The only address allowed to append commitments (the platform attestor).
    address public immutable attestor;

    /// @notice The highest epoch attested so far (0 = none yet).
    uint256 public latestEpoch;

    mapping(uint256 => bytes32) private _roots;

    event EpochAttested(uint256 indexed epoch, bytes32 root, uint256 timestamp);

    error NotAttestor();
    error EpochNotMonotonic(uint256 provided, uint256 latest);
    error EmptyRoot();
    error ZeroAttestor();

    constructor(address attestor_) {
        if (attestor_ == address(0)) revert ZeroAttestor();
        attestor = attestor_;
    }

    modifier onlyAttestor() {
        if (msg.sender != attestor) revert NotAttestor();
        _;
    }

    /// @notice Append the commitment for a new epoch. Attestor-only; epoch must be strictly
    /// increasing; root must be non-zero. Append-only: existing roots are never overwritten.
    function appendEpoch(uint256 epoch, bytes32 root) external onlyAttestor {
        if (epoch <= latestEpoch) revert EpochNotMonotonic(epoch, latestEpoch);
        if (root == bytes32(0)) revert EmptyRoot();
        _roots[epoch] = root;
        latestEpoch = epoch;
        emit EpochAttested(epoch, root, block.timestamp);
    }

    /// @notice The attested merkle root for `epoch` (bytes32(0) if none).
    function rootOf(uint256 epoch) external view returns (bytes32) {
        return _roots[epoch];
    }
}
