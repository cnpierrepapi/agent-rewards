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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("standing_order (recurring subscription)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.StandingOrder as Program<StandingOrder>;
  const connection = provider.connection;
  const payer = provider.wallet as anchor.Wallet; // the customer / owner

  const merchant = Keypair.generate(); // authorised provider
  const intruder = Keypair.generate();

  const PRICE = 100_000; // 0.1 USDC / period
  const PERIOD_SECS = 1; // short so the window elapses during the test

  let mint: PublicKey;
  let ownerAta: PublicKey;
  let sub: PublicKey;
  let escrow: PublicKey;
  let merchantAta: PublicKey;

  const balOf = async (a: PublicKey) => (await getAccount(connection, a)).amount;

  before(async () => {
    const s = await connection.requestAirdrop(merchant.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(s, "confirmed");

    mint = await createMint(connection, payer.payer, payer.publicKey, null, 6);
    ownerAta = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, mint, payer.publicKey)
    ).address;
    await mintTo(connection, payer.payer, mint, ownerAta, payer.publicKey, 10_000_000);

    [sub] = PublicKey.findProgramAddressSync(
      [Buffer.from("sub"), payer.publicKey.toBuffer(), merchant.publicKey.toBuffer()],
      program.programId
    );
    escrow = getAssociatedTokenAddressSync(mint, sub, true);
    merchantAta = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, mint, merchant.publicKey)
    ).address;
  });

  const charge = (signer = merchant) =>
    program.methods
      .charge()
      .accounts({ provider: signer.publicKey, subscription: sub, providerTokenAccount: merchantAta })
      .signers([signer])
      .rpc();

  it("opens a subscription and funds 3 periods", async () => {
    await program.methods
      .openSubscription(new BN(PRICE), new BN(PERIOD_SECS))
      .accounts({ owner: payer.publicKey, provider: merchant.publicKey, mint })
      .rpc();
    await program.methods
      .fund(new BN(3 * PRICE))
      .accounts({ owner: payer.publicKey, ownerTokenAccount: ownerAta })
      .rpc();
    assert.equal((await balOf(escrow)).toString(), (3 * PRICE).toString());
  });

  it("charges the first period", async () => {
    await charge();
    assert.equal((await balOf(merchantAta)).toString(), PRICE.toString());
    assert.equal((await balOf(escrow)).toString(), (2 * PRICE).toString());
    const s = await program.account.subscription.fetch(sub);
    assert.equal(s.periodsCharged.toString(), "1");
  });

  it("rejects a second charge in the same period", async () => {
    try {
      await charge();
      assert.fail("should not be due yet");
    } catch (e: any) {
      assert.include(JSON.stringify(e), "RenewalNotDue");
    }
  });

  it("charges later periods once the window elapses, then lapses when empty", async () => {
    await sleep(1100);
    await charge(); // period 2
    await sleep(1100);
    await charge(); // period 3 -> escrow now 0
    assert.equal((await balOf(escrow)).toString(), "0");

    await sleep(1100);
    try {
      await charge(); // due, but nothing to pull -> service lapses
      assert.fail("should fail on empty escrow");
    } catch (e: any) {
      assert.include(JSON.stringify(e), "InsufficientFunds");
    }
  });

  it("rejects an unauthorised provider", async () => {
    try {
      await charge(intruder);
      assert.fail("intruder should not be able to charge");
    } catch (e: any) {
      assert.ok(e);
    }
  });

  it("cancels and refunds the unused months", async () => {
    // top the subscription back up with 2 months, then quit
    await program.methods
      .fund(new BN(2 * PRICE))
      .accounts({ owner: payer.publicKey, ownerTokenAccount: ownerAta })
      .rpc();

    const ownerBefore = await balOf(ownerAta);
    await program.methods
      .cancel()
      .accounts({ owner: payer.publicKey, ownerTokenAccount: ownerAta })
      .rpc();

    assert.equal((await balOf(escrow)).toString(), "0");
    assert.equal((await balOf(ownerAta)).toString(), (ownerBefore + BigInt(2 * PRICE)).toString());
    const s = await program.account.subscription.fetch(sub);
    assert.isFalse(s.active);
  });

  it("blocks charges after cancellation", async () => {
    await sleep(1100);
    try {
      await charge();
      assert.fail("charge after cancel should fail");
    } catch (e: any) {
      assert.include(JSON.stringify(e), "Inactive");
    }
  });
});
