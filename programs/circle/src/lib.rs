use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

// Placeholder. Run `anchor keys sync` after the first `anchor build`.
declare_id!("11111111111111111111111111111111");

// A trustless savings circle (esusu / ajo). Everyone funds a shared vault. Your points
// grow with how MUCH and how OFTEN you contribute. When the vault crosses a minimum, the
// front-of-queue member withdraws a slice sized by their share of total points — more than
// they put in, but only a fraction of the pool, so the vault is never drained. Solvent by
// construction: a withdrawal is always <= your proportional share <= the vault.
//
// Behavioral tuning (see README): a 7-period streak cap at +10%/period (max 1.7x) rewards
// consistency; a 50% per-payout cap keeps the pool visibly solvent.
const ALPHA_BPS: u64 = 1000; // +10% points per consecutive streak step
const STREAK_MAX: u32 = 7; // streak multiplier caps at 1.7x
const STREAK_MIN_CLAIM: u32 = 1; // must contribute >= 2 periods in a row before claiming
const BETA_BPS: u128 = 5000; // a single payout is capped at 50% of the vault
const SENTINEL: u64 = u64::MAX; // "never contributed"

#[program]
pub mod circle {
    use super::*;

    pub fn open_circle(ctx: Context<OpenCircle>, v_min: u64, period_secs: i64) -> Result<()> {
        require!(v_min > 0, CircleError::InvalidParam);
        require!(period_secs > 0, CircleError::InvalidParam);
        let c = &mut ctx.accounts.circle;
        c.authority = ctx.accounts.authority.key();
        c.mint = ctx.accounts.mint.key();
        c.v_min = v_min;
        c.period_secs = period_secs;
        c.start_ts = Clock::get()?.unix_timestamp;
        c.p_total = 0;
        c.round = 0;
        c.bump = ctx.bumps.circle;
        Ok(())
    }

    pub fn join(ctx: Context<Join>) -> Result<()> {
        let m = &mut ctx.accounts.member;
        m.circle = ctx.accounts.circle.key();
        m.owner = ctx.accounts.owner.key();
        m.points = 0;
        m.streak = 0;
        m.last_period = SENTINEL;
        m.contributed = 0;
        m.bump = ctx.bumps.member;
        Ok(())
    }

    /// Fund the vault. Points grow with amount, multiplied by your consecutive-period streak.
    pub fn contribute(ctx: Context<Contribute>, amount: u64) -> Result<()> {
        require!(amount > 0, CircleError::InvalidParam);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.contributor_token_account.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                    authority: ctx.accounts.contributor.to_account_info(),
                },
            ),
            amount,
        )?;

        let now = Clock::get()?.unix_timestamp;
        let cur = ((now - ctx.accounts.circle.start_ts) / ctx.accounts.circle.period_secs) as u64;

        let m = &mut ctx.accounts.member;
        if m.last_period == SENTINEL {
            m.streak = 0; // first contribution: base multiplier
        } else {
            let gap = cur.saturating_sub(m.last_period);
            if gap == 1 {
                m.streak = m.streak.saturating_add(1); // consecutive period
            } else if gap >= 2 {
                m.streak = 0; // missed a period -> streak breaks
            } // gap == 0: same period, streak unchanged
        }
        m.last_period = cur;

        let s = m.streak.min(STREAK_MAX) as u64;
        let mult_bps = 10_000 + ALPHA_BPS * s; // 1.0x .. 1.7x
        let gained = (amount as u128) * (mult_bps as u128) / 10_000;

        m.points = m.points.checked_add(gained).ok_or(CircleError::MathOverflow)?;
        m.contributed = m.contributed.checked_add(amount).ok_or(CircleError::MathOverflow)?;
        let c = &mut ctx.accounts.circle;
        c.p_total = c.p_total.checked_add(gained).ok_or(CircleError::MathOverflow)?;
        Ok(())
    }

    /// Front-of-queue withdrawal. Pays your share of the vault, capped at BETA_BPS of it.
    /// Requires the vault to be above v_min and the member to have been consistent.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        require!(ctx.accounts.member.points > 0, CircleError::NoPoints);
        require!(ctx.accounts.member.streak >= STREAK_MIN_CLAIM, CircleError::NotConsistent);

        let v = ctx.accounts.escrow.amount;
        require!(v >= ctx.accounts.circle.v_min, CircleError::BelowMinimum);

        let p_total = ctx.accounts.circle.p_total;
        require!(p_total > 0, CircleError::NoPoints);
        let points = ctx.accounts.member.points;

        // share of the pool, capped at BETA_BPS
        let share = points * (v as u128) / p_total;
        let cap = BETA_BPS * (v as u128) / 10_000;
        let w = share.min(cap) as u64;
        require!(w > 0, CircleError::NoPoints);

        let authority = ctx.accounts.circle.authority;
        let bump = ctx.accounts.circle.bump;
        let seeds: &[&[u8]] = &[b"circle", authority.as_ref(), &[bump]];
        let signer = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow.to_account_info(),
                    to: ctx.accounts.claimer_token_account.to_account_info(),
                    authority: ctx.accounts.circle.to_account_info(),
                },
                signer,
            ),
            w,
        )?;

        let key = ctx.accounts.circle.key();
        let contributed = ctx.accounts.member.contributed;
        {
            let c = &mut ctx.accounts.circle;
            c.p_total = c.p_total.saturating_sub(points);
            c.round = c.round.saturating_add(1);
        }
        {
            let m = &mut ctx.accounts.member;
            m.points = 0;
            m.streak = 0;
            m.last_period = SENTINEL;
            m.contributed = 0;
        }

        emit!(Payout {
            circle: key,
            member: ctx.accounts.claimer.key(),
            contributed,
            paid_out: w,
            remaining: v - w,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct OpenCircle<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        space = 8 + Circle::INIT_SPACE,
        seeds = [b"circle", authority.key().as_ref()],
        bump
    )]
    pub circle: Account<'info, Circle>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = circle
    )]
    pub escrow: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Join<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub circle: Account<'info, Circle>,
    #[account(
        init,
        payer = owner,
        space = 8 + Member::INIT_SPACE,
        seeds = [b"member", circle.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub member: Account<'info, Member>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Contribute<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    #[account(mut, seeds = [b"circle", circle.authority.as_ref()], bump = circle.bump)]
    pub circle: Account<'info, Circle>,
    #[account(
        mut,
        seeds = [b"member", circle.key().as_ref(), contributor.key().as_ref()],
        bump = member.bump,
        has_one = owner
    )]
    pub member: Account<'info, Member>,
    /// CHECK: bound to member via has_one = owner
    #[account(address = member.owner)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut)]
    pub contributor_token_account: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = circle.mint, associated_token::authority = circle)]
    pub escrow: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,
    #[account(mut, seeds = [b"circle", circle.authority.as_ref()], bump = circle.bump)]
    pub circle: Account<'info, Circle>,
    #[account(
        mut,
        seeds = [b"member", circle.key().as_ref(), claimer.key().as_ref()],
        bump = member.bump,
        has_one = owner
    )]
    pub member: Account<'info, Member>,
    /// CHECK: bound to member via has_one = owner
    #[account(address = member.owner)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = circle.mint, associated_token::authority = circle)]
    pub escrow: Account<'info, TokenAccount>,
    #[account(mut)]
    pub claimer_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Circle {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub v_min: u64,
    pub period_secs: i64,
    pub start_ts: i64,
    pub p_total: u128,
    pub round: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Member {
    pub circle: Pubkey,
    pub owner: Pubkey,
    pub points: u128,
    pub streak: u32,
    pub last_period: u64,
    pub contributed: u64,
    pub bump: u8,
}

#[event]
pub struct Payout {
    pub circle: Pubkey,
    pub member: Pubkey,
    pub contributed: u64,
    pub paid_out: u64,
    pub remaining: u64,
}

#[error_code]
pub enum CircleError {
    #[msg("Invalid parameter")]
    InvalidParam,
    #[msg("Member has no points")]
    NoPoints,
    #[msg("Not consistent enough to claim yet")]
    NotConsistent,
    #[msg("Vault is below the minimum payout threshold")]
    BelowMinimum,
    #[msg("Math overflow")]
    MathOverflow,
}
