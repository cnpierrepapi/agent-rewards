import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Circle } from "../target/types/circle";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("circle (savings circle)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Circle as Program<Circle>;
  const connection = provider.connection;
  const alice = provider.wallet as anchor.Wallet; // authority + member A
  const bob = Keypair.generate(); // member B

  const V_MIN = 200_000;
  const PERIOD = 1;

  let mint: PublicKey;
  let circle: PublicKey;
  let escrow: PublicKey;
  let aliceAta: PublicKey;
  let bobAta: PublicKey;
  let memberA: PublicKey;
  let memberB: PublicKey;

  const bal = async (a: PublicKey) => (await getAccount(connection, a)).amount;

  before(async () => {
    const s = await connection.requestAirdrop(bob.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(s, "confirmed");
    mint = await createMint(connection, alice.payer, alice.publicKey, null, 6);
    aliceAta = (await getOrCreateAssociatedTokenAccount(connection, alice.payer, mint, alice.publicKey)).address;
    bobAta = (await getOrCreateAssociatedTokenAccount(connection, alice.payer, mint, bob.publicKey)).address;
    await mintTo(connection, alice.payer, mint, aliceAta, alice.publicKey, 5_000_000);
    await mintTo(connection, alice.payer, mint, bobAta, alice.publicKey, 5_000_000);

    [circle] = PublicKey.findProgramAddressSync(
      [Buffer.from("circle"), alice.publicKey.toBuffer()],
      program.programId
    );
    escrow = getAssociatedTokenAddressSync(mint, circle, true);
    [memberA] = PublicKey.findProgramAddressSync(
      [Buffer.from("member"), circle.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );
    [memberB] = PublicKey.findProgramAddressSync(
      [Buffer.from("member"), circle.toBuffer(), bob.publicKey.toBuffer()],
      program.programId
    );
  });

  it("opens the circle and both members join", async () => {
    await program.methods.openCircle(new BN(V_MIN), new BN(PERIOD)).accounts({ authority: alice.publicKey, mint }).rpc();
    await program.methods.join().accounts({ owner: alice.publicKey, circle }).rpc();
    await program.methods.join().accounts({ owner: bob.publicKey, circle }).signers([bob]).rpc();
  });

  it("rewards consistency: Alice's streak lifts her points above her dollars", async () => {
    // Alice contributes three consecutive periods (streak builds to 2)
    for (let k = 0; k < 3; k++) {
      await program.methods.contribute(new BN(100_000)).accounts({ contributor: alice.publicKey, circle, owner: alice.publicKey, contributorTokenAccount: aliceAta }).rpc();
      if (k < 2) await sleep(1100);
    }
    // Bob makes one large one-off contribution (no streak) -> deepens the pool
    await program.methods.contribute(new BN(2_000_000)).accounts({ contributor: bob.publicKey, circle, owner: bob.publicKey, contributorTokenAccount: bobAta }).signers([bob]).rpc();

    const a = await program.account.member.fetch(memberA);
    const b = await program.account.member.fetch(memberB);
    assert.isTrue(a.points.toNumber() > 300_000, "streak should lift Alice's points above her 300k dollars");
    assert.equal(b.points.toNumber(), 2_000_000, "Bob (one-off) gets points == dollars");
  });

  it("lets a big one-off contributor claim too (size qualifies), throttled by the 10% cap", async () => {
    const before = await bal(bobAta);
    const vault = Number(await bal(escrow));
    await program.methods.claim().accounts({ claimer: bob.publicKey, circle, owner: bob.publicKey, claimerTokenAccount: bobAta }).signers([bob]).rpc();
    const paid = Number(await bal(bobAta)) - Number(before);
    assert.isTrue(paid > 0, "a one-off can claim its share (no consistency gate)");
    assert.isTrue(paid <= Math.ceil(vault * 0.1) + 1, "streak-0 one-off capped at 10% of the vault");
    const b = await program.account.member.fetch(memberB);
    assert.isTrue(b.points.toNumber() > 0, "residual points carry forward, not forfeited");
  });

  it("pays Alice her points-share, more than she put in, vault keeps the rest", async () => {
    const before = await bal(aliceAta);
    const vault = Number(await bal(escrow));
    await program.methods.claim().accounts({ claimer: alice.publicKey, circle, owner: alice.publicKey, claimerTokenAccount: aliceAta }).rpc();
    const paid = Number(await bal(aliceAta)) - Number(before);
    assert.isTrue(paid > 300_000, "Alice should withdraw more than her 300k contribution");
    assert.isTrue(Number(await bal(escrow)) > 0, "vault retains a balance for the others");
    assert.isTrue(paid <= Math.ceil(vault / 3) + 1, "payout capped at <= 33.3% of the vault");
    const a = await program.account.member.fetch(memberA);
    assert.equal(a.points.toNumber(), 0, "points reset after payout");
  });
});
