// KZP contribution circle — NATIVE Solana program (no Anchor) for a tiny binary that
// deploys cheaply (~1 SOL). Same cascade as the Anchor version: each deposit sends 50%
// DOWN to earlier members (reward-per-share index) and 50% UP to the next depositor; the
// first down-half seeds a locked floor.
//
// In Solana Playground: create a NATIVE project, paste this into src/lib.rs, Build, Deploy.
// Deps (spl_token, borsh) are auto-detected from the `use` lines.
//
// Account orders (the client passes these, in order):
//   OpenCircle: [authority(s,w), circle_pda(w), mint, system_program]
//   Join:       [owner(s,w), circle, member_pda(w), system_program]
//   Deposit{amount}: [depositor(s,w), circle(w), member(w), depositor_token(w), escrow(w), token_program]
//   Withdraw:   [owner(s,w), circle(w), member(w), escrow(w), owner_token(w), token_program]
// The `escrow` is an SPL token account owned by the circle PDA (the client creates it as the
// circle PDA's associated token account before the first deposit).

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

const ACC_SCALE: u128 = 1_000_000_000_000;
const CIRCLE_LEN: usize = 1 + 32 + 32 + 16 + 16 + 8 + 8 + 1; // 114
const MEMBER_LEN: usize = 1 + 32 + 32 + 8 + 16 + 8 + 1; // 98

#[derive(BorshSerialize, BorshDeserialize)]
enum Ix {
    OpenCircle,
    Join,
    Deposit { amount: u64 },
    Withdraw,
}

#[derive(BorshSerialize, BorshDeserialize, Default)]
struct Circle {
    init: bool,
    authority: Pubkey,
    mint: Pubkey,
    pool_total: u128,
    acc_per_deposit: u128,
    floor: u64,
    up_reserve: u64,
    bump: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Default)]
struct Member {
    init: bool,
    circle: Pubkey,
    owner: Pubkey,
    deposited: u64,
    reward_checkpoint: u128,
    balance: u64,
    bump: u8,
}

entrypoint!(process);
fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match Ix::try_from_slice(data)? {
        Ix::OpenCircle => open_circle(program_id, accounts),
        Ix::Join => join(program_id, accounts),
        Ix::Deposit { amount } => deposit(program_id, accounts, amount),
        Ix::Withdraw => withdraw(program_id, accounts),
    }
}

fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    pda: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    program_id: &Pubkey,
    seeds: &[&[u8]],
    space: usize,
) -> ProgramResult {
    let rent = Rent::get()?.minimum_balance(space);
    invoke_signed(
        &system_instruction::create_account(payer.key, pda.key, rent, space as u64, program_id),
        &[payer.clone(), pda.clone(), system.clone()],
        &[seeds],
    )
}

fn open_circle(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let i = &mut accounts.iter();
    let authority = next_account_info(i)?;
    let circle_ai = next_account_info(i)?;
    let mint = next_account_info(i)?;
    let system = next_account_info(i)?;

    let (pda, bump) = Pubkey::find_program_address(&[b"circle", authority.key.as_ref()], program_id);
    if pda != *circle_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    create_pda(authority, circle_ai, system, program_id, &[b"circle", authority.key.as_ref(), &[bump]], CIRCLE_LEN)?;

    let c = Circle {
        init: true,
        authority: *authority.key,
        mint: *mint.key,
        pool_total: 0,
        acc_per_deposit: 0,
        floor: 0,
        up_reserve: 0,
        bump,
    };
    c.serialize(&mut &mut circle_ai.data.borrow_mut()[..])?;
    msg!("circle opened");
    Ok(())
}

fn join(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let i = &mut accounts.iter();
    let owner = next_account_info(i)?;
    let circle_ai = next_account_info(i)?;
    let member_ai = next_account_info(i)?;
    let system = next_account_info(i)?;

    let c = Circle::try_from_slice(&circle_ai.data.borrow())?;
    let (pda, bump) =
        Pubkey::find_program_address(&[b"member", circle_ai.key.as_ref(), owner.key.as_ref()], program_id);
    if pda != *member_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    create_pda(owner, member_ai, system, program_id, &[b"member", circle_ai.key.as_ref(), owner.key.as_ref(), &[bump]], MEMBER_LEN)?;

    let m = Member {
        init: true,
        circle: *circle_ai.key,
        owner: *owner.key,
        deposited: 0,
        reward_checkpoint: c.acc_per_deposit,
        balance: 0,
        bump,
    };
    m.serialize(&mut &mut member_ai.data.borrow_mut()[..])?;
    Ok(())
}

fn token_transfer<'a>(
    token_program: &AccountInfo<'a>,
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    signer: Option<&[&[u8]]>,
) -> ProgramResult {
    let ix = spl_token::instruction::transfer(token_program.key, from.key, to.key, authority.key, &[], amount)?;
    let infos = [from.clone(), to.clone(), authority.clone(), token_program.clone()];
    match signer {
        Some(seeds) => invoke_signed(&ix, &infos, &[seeds]),
        None => invoke(&ix, &infos),
    }
}

fn deposit(_program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    if amount == 0 {
        return Err(ProgramError::InvalidArgument);
    }
    let i = &mut accounts.iter();
    let depositor = next_account_info(i)?;
    let circle_ai = next_account_info(i)?;
    let member_ai = next_account_info(i)?;
    let depositor_token = next_account_info(i)?;
    let escrow = next_account_info(i)?;
    let token_program = next_account_info(i)?;

    let mut c = Circle::try_from_slice(&circle_ai.data.borrow())?;
    let mut m = Member::try_from_slice(&member_ai.data.borrow())?;

    // 1. settle the depositor's accrued down-flows, then the UP gift
    let pending = (m.deposited as u128) * (c.acc_per_deposit - m.reward_checkpoint) / ACC_SCALE;
    m.balance = m.balance.saturating_add(pending as u64).saturating_add(c.up_reserve);
    c.up_reserve = 0;

    // pull the deposit into escrow
    token_transfer(token_program, depositor_token, escrow, depositor, amount, None)?;

    let down = amount / 2;
    let up = amount - down;
    let other_total = c.pool_total - m.deposited as u128; // exclude the depositor's own prior stake
    if other_total > 0 {
        c.acc_per_deposit += (down as u128) * ACC_SCALE / other_total;
    } else {
        c.floor = c.floor.saturating_add(down);
    }
    c.up_reserve = up;
    c.pool_total += amount as u128;

    m.deposited = m.deposited.saturating_add(amount);
    m.reward_checkpoint = c.acc_per_deposit; // this deposit earns only FUTURE down-flows

    c.serialize(&mut &mut circle_ai.data.borrow_mut()[..])?;
    m.serialize(&mut &mut member_ai.data.borrow_mut()[..])?;
    Ok(())
}

fn withdraw(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let i = &mut accounts.iter();
    let owner = next_account_info(i)?;
    let circle_ai = next_account_info(i)?;
    let member_ai = next_account_info(i)?;
    let escrow = next_account_info(i)?;
    let owner_token = next_account_info(i)?;
    let token_program = next_account_info(i)?;

    let c = Circle::try_from_slice(&circle_ai.data.borrow())?;
    let mut m = Member::try_from_slice(&member_ai.data.borrow())?;
    if m.owner != *owner.key {
        return Err(ProgramError::IllegalOwner);
    }

    let pending = (m.deposited as u128) * (c.acc_per_deposit - m.reward_checkpoint) / ACC_SCALE;
    m.balance = m.balance.saturating_add(pending as u64);
    m.reward_checkpoint = c.acc_per_deposit;

    let payout = m.balance;
    if payout == 0 {
        return Err(ProgramError::InsufficientFunds);
    }
    // sanity: escrow must hold it
    let esc = spl_token::state::Account::unpack(&escrow.data.borrow())?;
    if esc.amount < payout {
        return Err(ProgramError::InsufficientFunds);
    }

    token_transfer(
        token_program,
        escrow,
        owner_token,
        circle_ai,
        payout,
        Some(&[b"circle", c.authority.as_ref(), &[c.bump]]),
    )?;
    m.balance = 0;
    m.serialize(&mut &mut member_ai.data.borrow_mut()[..])?;

    // silence unused in some builds
    let _ = program_id;
    Ok(())
}
