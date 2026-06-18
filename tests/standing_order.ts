import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { StandingOrder } from "../target/types/standing_order";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";

describe("standing_order", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.StandingOrder as Program<StandingOrder>;
  const connection = provider.connection;
  const payer = provider.wallet as anchor.Wallet; // the "owner" / customer

  const merchant = Keypair.generate(); // the authorised provider
  const intruder = Keypair.generate(); // a different keypair that must be rejected

  // 0.5 USDC per period, a long period so it does not reset mid-test.
  const MAX_PER_PERIOD = 500_000;
  const PERIOD_SECS = 100_000;
  const LOW_THRESHOLD = 600_000; // triggers LowBalance while > 0.4 USDC remains

  let mint: PublicKey;
  let ownerAta: PublicKey;
  let mandate: PublicKey;
  let escrow: PublicKey;
  let merchantAta: PublicKey;

  const balOf = async (a: PublicKey) => (await getAccount(connection, a)).amount;

  before(async () => {
    const sig = await connection.requestAirdrop(merchant.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");

    mint = await createMint(connection, payer.payer, payer.publicKey, null, 6);
    ownerAta = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, mint, payer.publicKey)
    ).address;
    await mintTo(connection, payer.payer, mint, ownerAta, payer.publicKey, 10_000_000); // 10 USDC

    [mandate] = PublicKey.findProgramAddressSync(
      [Buffer.from("mandate"), payer.publicKey.toBuffer(), merchant.publicKey.toBuffer()],
      program.programId
    );
    escrow = getAssociatedTokenAddressSync(mint, mandate, true);
    merchantAta = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, mint, merchant.publicKey)
    ).address;
  });

  it("opens a mandate and funds it once", async () => {
    await program.methods
      .openMandate(new BN(MAX_PER_PERIOD), new BN(PERIOD_SECS), new BN(LOW_THRESHOLD))
      .accounts({ owner: payer.publicKey, provider: merchant.publicKey, mint })
      .rpc();

    await program.methods
      .fund(new BN(1_000_000)) // 1 USDC
      .accounts({ owner: payer.publicKey, ownerTokenAccount: ownerAta })
      .rpc();

    assert.equal((await balOf(escrow)).toString(), "1000000");
    const m = await program.account.mandate.fetch(mandate);
    assert.ok(m.active);
    assert.ok(m.provider.equals(merchant.publicKey));
  });

  const pull = (amount: number, signer = merchant) =>
    program.methods
      .pull(new BN(amount))
      .accounts({ provider: signer.publicKey, mandate, providerTokenAccount: merchantAta })
      .signers([signer])
      .rpc();

  it("lets the provider pull within the cap", async () => {
    await pull(200_000); // 0.2 USDC
    assert.equal((await balOf(merchantAta)).toString(), "200000");
    assert.equal((await balOf(escrow)).toString(), "800000");
  });

  it("rejects a pull that would exceed the per-period cap", async () => {
    try {
      await pull(400_000); // 0.2 + 0.4 = 0.6 > 0.5 cap
      assert.fail("should have hit the rate cap");
    } catch (e: any) {
      assert.include(JSON.stringify(e), "RateLimitExceeded");
    }
  });

  it("allows a further pull up to the cap, then blocks once exhausted", async () => {
    await pull(300_000); // total 0.5 == cap
    assert.equal((await balOf(merchantAta)).toString(), "500000");
    try {
      await pull(1); // cap fully spent this period
      assert.fail("should be blocked at the cap");
    } catch (e: any) {
      assert.include(JSON.stringify(e), "RateLimitExceeded");
    }
  });

  it("rejects an unauthorised puller", async () => {
    const [m2] = PublicKey.findProgramAddressSync(
      [Buffer.from("mandate"), payer.publicKey.toBuffer(), intruder.publicKey.toBuffer()],
      program.programId
    );
    // intruder is not this mandate's provider -> the has_one / seeds check fails
    try {
      await program.methods
        .pull(new BN(1))
        .accounts({ provider: intruder.publicKey, mandate, providerTokenAccount: merchantAta })
        .signers([intruder])
        .rpc();
      assert.fail("intruder should not be able to pull");
      void m2;
    } catch (e: any) {
      assert.ok(e, "expected rejection for unauthorised provider");
    }
  });

  it("cancels: refunds the remainder and blocks further pulls", async () => {
    const ownerBefore = await balOf(ownerAta);
    const escrowBefore = await balOf(escrow); // 0.5 USDC left
    await program.methods
      .cancel()
      .accounts({ owner: payer.publicKey, mandate, ownerTokenAccount: ownerAta })
      .rpc();

    assert.equal((await balOf(escrow)).toString(), "0");
    assert.equal((await balOf(ownerAta)).toString(), (ownerBefore + escrowBefore).toString());

    const m = await program.account.mandate.fetch(mandate);
    assert.isFalse(m.active);

    try {
      await pull(1);
      assert.fail("pull after cancel should fail");
    } catch (e: any) {
      assert.include(JSON.stringify(e), "MandateInactive");
    }
  });
});
