pragma circom 2.1.0;

// Production entry point. All templates live in lib.circom so audit harnesses
// (circuits/audit/) can instantiate the exact same code.
include "lib.circom";

component main {public [root, publicAmount, publicAsset, extDataHash, inputNullifier, outputCommitment]} = Transaction(32, 2, 2);
