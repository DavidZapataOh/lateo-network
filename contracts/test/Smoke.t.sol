// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Smoke} from "../src/Smoke.sol";

/// Minimal test without forge-std (scaffolding only proves `forge test` runs green).
contract SmokeTest {
    function test_ping() public {
        Smoke s = new Smoke();
        require(s.ping() == 1, "ping failed");
    }
}
