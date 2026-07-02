// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LateoAttestation} from "../src/LateoAttestation.sol";

contract LateoAttestationTest is Test {
    LateoAttestation att;
    address attestor = address(0xA11CE);
    address stranger = address(0xBAD);

    function setUp() public {
        att = new LateoAttestation(attestor);
    }

    function test_appendByAttestor_storesAndEmits() public {
        bytes32 root = keccak256("epoch-1");
        vm.expectEmit(true, false, false, true);
        emit LateoAttestation.EpochAttested(1, root, block.timestamp);
        vm.prank(attestor);
        att.appendEpoch(1, root);
        assertEq(att.rootOf(1), root);
        assertEq(att.latestEpoch(), 1);
    }

    // BITES: a non-attestor can never append (access control).
    function test_appendByStranger_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(LateoAttestation.NotAttestor.selector);
        att.appendEpoch(1, keccak256("x"));
    }

    // BITES: epoch must be strictly increasing (append-only, no overwrite, no replay).
    function test_nonMonotonicEpoch_reverts() public {
        vm.startPrank(attestor);
        att.appendEpoch(1, keccak256("a"));
        vm.expectRevert(abi.encodeWithSelector(LateoAttestation.EpochNotMonotonic.selector, 1, 1));
        att.appendEpoch(1, keccak256("b")); // same epoch
        vm.expectRevert(abi.encodeWithSelector(LateoAttestation.EpochNotMonotonic.selector, 0, 1));
        att.appendEpoch(0, keccak256("c")); // lower epoch
        att.appendEpoch(2, keccak256("d")); // strictly higher is allowed
        vm.stopPrank();
        assertEq(att.latestEpoch(), 2);
        assertEq(att.rootOf(1), keccak256("a")); // epoch 1 untouched
    }

    function test_emptyRoot_reverts() public {
        vm.prank(attestor);
        vm.expectRevert(LateoAttestation.EmptyRoot.selector);
        att.appendEpoch(1, bytes32(0));
    }

    // BITES: the contract is non-custodial — it cannot receive funds (no payable/receive/fallback).
    function test_noFunds_cannotReceiveEth() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(att).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(att).balance, 0);
    }

    function test_zeroAttestor_reverts() public {
        vm.expectRevert(LateoAttestation.ZeroAttestor.selector);
        new LateoAttestation(address(0));
    }
}
