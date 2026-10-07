pragma circom 2.1.0;

// Private 2-in/2-out transaction over a multi-asset note pool.
// Lineage: Tornado Nova circuits (tornadocash/tornado-nova, ISC; THIRD_PARTY_NOTICES.md),
// extended with an asset id bound into every note commitment, hidden in private transfers.
//
//   pubkey     = Poseidon(sk)
//   commitment = Poseidon(asset, amount, pubkey, blinding)
//   signature  = Poseidon(sk, commitment, leafIndex)
//   nullifier  = Poseidon(commitment, leafIndex, signature)
//
// Binding the nullifier to the leaf index means two notes with identical
// contents at different positions have different nullifiers (no "Faerie Gold").

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/switcher.circom";

template Keypair() {
    signal input privateKey;
    signal output publicKey;

    component hasher = Poseidon(1);
    hasher.inputs[0] <== privateKey;
    publicKey <== hasher.out;
}

template Signature() {
    signal input privateKey;
    signal input commitment;
    signal input leafIndex;
    signal output out;

    component hasher = Poseidon(3);
    hasher.inputs[0] <== privateKey;
    hasher.inputs[1] <== commitment;
    hasher.inputs[2] <== leafIndex;
    out <== hasher.out;
}

// Recomputes the root from a leaf, its index (as a number) and the sibling path.
template MerkleProof(levels) {
    signal input leaf;
    signal input leafIndex;
    signal input pathElements[levels];
    signal output root;

    component indexBits = Num2Bits(levels);
    indexBits.in <== leafIndex;

    component switcher[levels];
    component hasher[levels];
    for (var i = 0; i < levels; i++) {
        switcher[i] = Switcher();
        switcher[i].L <== i == 0 ? leaf : hasher[i - 1].out;
        switcher[i].R <== pathElements[i];
        switcher[i].sel <== indexBits.out[i];

        hasher[i] = Poseidon(2);
        hasher[i].inputs[0] <== switcher[i].outL;
        hasher[i].inputs[1] <== switcher[i].outR;
    }
    root <== hasher[levels - 1].out;
}

template Transaction(levels, nIns, nOuts) {
    // Public statement.
    signal input root;               // note-tree root R[h_anchor], derived by the indexer
    signal input publicAmount;       // > 0 mint/shield, < 0 (p - x) unshield, 0 private transfer
    signal input publicAsset;        // asset id when publicAmount != 0, else 0
    signal input extDataHash;        // binds the rest of the envelope (ciphertexts, anchor, ...)
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    // Private witness. One asset per transaction; zero-amount notes are dummies.
    signal input asset;
    signal input inAmount[nIns];
    signal input inPrivateKey[nIns];
    signal input inBlinding[nIns];
    signal input inLeafIndex[nIns];
    signal input inPathElements[nIns][levels];
    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];

    component inKeypair[nIns];
    component inCommitment[nIns];
    component inSignature[nIns];
    component inNullifier[nIns];
    component inTree[nIns];
    component inCheckRoot[nIns];
    component inAmountRange[nIns];
    var sumIns = 0;

    for (var i = 0; i < nIns; i++) {
        inKeypair[i] = Keypair();
        inKeypair[i].privateKey <== inPrivateKey[i];

        inCommitment[i] = Poseidon(4);
        inCommitment[i].inputs[0] <== asset;
        inCommitment[i].inputs[1] <== inAmount[i];
        inCommitment[i].inputs[2] <== inKeypair[i].publicKey;
        inCommitment[i].inputs[3] <== inBlinding[i];

        inSignature[i] = Signature();
        inSignature[i].privateKey <== inPrivateKey[i];
        inSignature[i].commitment <== inCommitment[i].out;
        inSignature[i].leafIndex <== inLeafIndex[i];

        inNullifier[i] = Poseidon(3);
        inNullifier[i].inputs[0] <== inCommitment[i].out;
        inNullifier[i].inputs[1] <== inLeafIndex[i];
        inNullifier[i].inputs[2] <== inSignature[i].out;
        inNullifier[i].out === inputNullifier[i];

        inTree[i] = MerkleProof(levels);
        inTree[i].leaf <== inCommitment[i].out;
        inTree[i].leafIndex <== inLeafIndex[i];
        for (var j = 0; j < levels; j++) {
            inTree[i].pathElements[j] <== inPathElements[i][j];
        }

        // Membership is only enforced for notes that carry value.
        inCheckRoot[i] = ForceEqualIfEnabled();
        inCheckRoot[i].in[0] <== root;
        inCheckRoot[i].in[1] <== inTree[i].root;
        inCheckRoot[i].enabled <== inAmount[i];

        inAmountRange[i] = Num2Bits(64);
        inAmountRange[i].in <== inAmount[i];
        sumIns += inAmount[i];
    }

    component outCommitment[nOuts];
    component outAmountRange[nOuts];
    var sumOuts = 0;

    for (var i = 0; i < nOuts; i++) {
        outCommitment[i] = Poseidon(4);
        outCommitment[i].inputs[0] <== asset;
        outCommitment[i].inputs[1] <== outAmount[i];
        outCommitment[i].inputs[2] <== outPubkey[i];
        outCommitment[i].inputs[3] <== outBlinding[i];
        outCommitment[i].out === outputCommitment[i];

        outAmountRange[i] = Num2Bits(64);
        outAmountRange[i].in <== outAmount[i];
        sumOuts += outAmount[i];
    }

    // The same note cannot be spent twice inside one transaction.
    component sameNullifiers[nIns * (nIns - 1) / 2];
    var k = 0;
    for (var i = 0; i < nIns - 1; i++) {
        for (var j = i + 1; j < nIns; j++) {
            sameNullifiers[k] = IsEqual();
            sameNullifiers[k].in[0] <== inputNullifier[i];
            sameNullifiers[k].in[1] <== inputNullifier[j];
            sameNullifiers[k].out === 0;
            k++;
        }
    }

    // Value conservation. Amounts are < 2^64 and the indexer encodes
    // publicAmount from a signed 64-bit integer, so the field cannot wrap.
    sumIns + publicAmount === sumOuts;

    // Value entering or leaving the pool must be of the publicly named asset.
    publicAmount * (asset - publicAsset) === 0;

    // Keep extDataHash in the constraint system so it cannot be optimised away.
    signal extDataSquare <== extDataHash * extDataHash;
}
