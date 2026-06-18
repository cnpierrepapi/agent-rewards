use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

// Placeholder. Run `anchor keys sync` after the first `anchor build`.
declare_id!("11111111111111111111111111111111");

// A trustless standing order ("the subscription that can't overcharge you").
//
// The payer funds a PDA escrow and authorises a provider to pull payment. The
// program guarantees three things the payer normally has to TRUST a merchant for:
//   1. Custody  — funds stay in the payer's PDA until pulled.
//   2. Spend cap — the provider can pull at most `max_per_period` per `period_secs`.
//   3. Exit     — the payer can cancel and reclaim the remainder at any time.
// A LowBalance event is emitted when the escrow drops below a threshold.
#[program]
pub mod standing_order {
    use super::*;

    pub fn open_mandate(
        ctx: Context<OpenMandate>,
        max_per_period: u64,
        period_secs: i64,
        low_balance_threshold: u64,
    ) -> Result<()> {
        require!(max_per_period > 0, MandateError::InvalidAmount);
        require!(period_secs > 0, MandateError::InvalidPeriod);
        let m = &mut ctx.accounts.mandate;
        m.owner = ctx.accounts.owner.key();
        m.provider = ctx.accounts.provider.key();
        m.mint = ctx.accounts.mint.key();
        m.max_per_period = max_per_period;
        m.period_secs = period_secs;
        m.low_balance_threshold = low_balance_threshold;
        m.spent_this_period = 0;
        m.period_start = Clock::get()?.unix_timestamp;
        m.total_pulled = 0;
        m.active = true;
        m.bump = ctx.bumps.mandate;
        Ok(())
    }

    /// Payer tops up the escrow. Funds once, the standing order runs from it.
    pub fn fund(ctx: Context<Fund>, amount: u64) -> Result<()> {
        require!(amount > 0, MandateError::InvalidAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_token_account.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }

    /// Provider pulls a payment. Enforced on-chain: mandate active, per-period cap
    /// not exceeded, pull <= escrow balance. Emits Charged, and LowBalance when the
    /// remaining balance falls below the threshold.
    pub fn pull(ctx: Context<Pull>, amount: u64) -> Result<()> {
        require!(amount > 0, MandateError::InvalidAmount);
        require!(ctx.accounts.mandate.active, MandateError::MandateInactive);

        let now = Clock::get()?.unix_timestamp;
        // Roll the rate-limit window if the period elapsed.
        let (period_start, spent_base) = {
            let m = &ctx.accounts.mandate;
            if now.saturating_sub(m.period_start) >= m.period_secs {
                (now, 0u64)
            } else {
                (m.period_start, m.spent_this_period)
            }
        };
        let new_spent = spent_base.checked_add(amount).ok_or(MandateError::MathOverflow)?;
        require!(
            new_spent <= ctx.accounts.mandate.max_per_period,
            MandateError::RateLimitExceeded
        );

        let balance = ctx.accounts.escrow.amount;
        require!(balance >= amount, MandateError::InsufficientFunds);

        // Pay the provider, signed by the mandate PDA.
        let owner = ctx.accounts.mandate.owner;
        let provider = ctx.accounts.mandate.provider;
        let bump = ctx.accounts.mandate.bump;
        let seeds: &[&[u8]] = &[b"mandate", owner.as_ref(), provider.as_ref(), &[bump]];
        let signer = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow.to_account_info(),
                    to: ctx.accounts.provider_token_account.to_account_info(),
                    authority: ctx.accounts.mandate.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        let remaining = balance - amount;
        let mandate_key = ctx.accounts.mandate.key();
        let threshold = ctx.accounts.mandate.low_balance_threshold;
        {
            let m = &mut ctx.accounts.mandate;
            m.period_start = period_start;
            m.spent_this_period = new_spent;
            m.total_pulled = m
                .total_pulled
                .checked_add(amount)
                .ok_or(MandateError::MathOverflow)?;
        }

        emit!(Charged { mandate: mandate_key, provider, amount, remaining });
        if remaining < threshold {
            emit!(LowBalance { mandate: mandate_key, remaining, threshold });
        }
        Ok(())
    }

    /// Payer cancels at any time: deactivate and refund the full remainder.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let amount = ctx.accounts.escrow.amount;
        if amount > 0 {
            let owner = ctx.accounts.mandate.owner;
            let provider = ctx.accounts.mandate.provider;
            let bump = ctx.accounts.mandate.bump;
            let seeds: &[&[u8]] = &[b"mandate", owner.as_ref(), provider.as_ref(), &[bump]];
            let signer = &[seeds];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow.to_account_info(),
                        to: ctx.accounts.owner_token_account.to_account_info(),
                        authority: ctx.accounts.mandate.to_account_info(),
                    },
                    signer,
                ),
                amount,
            )?;
        }
        let mandate_key = ctx.accounts.mandate.key();
        ctx.accounts.mandate.active = false;
        emit!(MandateCancelled { mandate: mandate_key, refunded: amount });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct OpenMandate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// CHECK: stored as the only key allowed to pull; not read or written.
    pub provider: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = owner,
        space = 8 + Mandate::INIT_SPACE,
        seeds = [b"mandate", owner.key().as_ref(), provider.key().as_ref()],
        bump
    )]
    pub mandate: Account<'info, Mandate>,

    #[account(
        init,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = mandate
    )]
    pub escrow: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Fund<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [b"mandate", mandate.owner.as_ref(), mandate.provider.as_ref()],
        bump = mandate.bump,
        has_one = owner
    )]
    pub mandate: Account<'info, Mandate>,

    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mandate.mint,
        associated_token::authority = mandate
    )]
    pub escrow: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Pull<'info> {
    // The merchant. has_one ties this signer to the mandate's authorised provider.
    pub provider: Signer<'info>,

    #[account(
        mut,
        seeds = [b"mandate", mandate.owner.as_ref(), mandate.provider.as_ref()],
        bump = mandate.bump,
        has_one = provider
    )]
    pub mandate: Account<'info, Mandate>,

    #[account(
        mut,
        associated_token::mint = mandate.mint,
        associated_token::authority = mandate
    )]
    pub escrow: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mandate.mint,
        associated_token::authority = provider
    )]
    pub provider_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"mandate", mandate.owner.as_ref(), mandate.provider.as_ref()],
        bump = mandate.bump,
        has_one = owner
    )]
    pub mandate: Account<'info, Mandate>,

    #[account(
        mut,
        associated_token::mint = mandate.mint,
        associated_token::authority = mandate
    )]
    pub escrow: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Mandate {
    pub owner: Pubkey,
    pub provider: Pubkey,
    pub mint: Pubkey,
    pub max_per_period: u64,
    pub period_secs: i64,
    pub spent_this_period: u64,
    pub period_start: i64,
    pub low_balance_threshold: u64,
    pub total_pulled: u64,
    pub active: bool,
    pub bump: u8,
}

#[event]
pub struct Charged {
    pub mandate: Pubkey,
    pub provider: Pubkey,
    pub amount: u64,
    pub remaining: u64,
}

#[event]
pub struct LowBalance {
    pub mandate: Pubkey,
    pub remaining: u64,
    pub threshold: u64,
}

#[event]
pub struct MandateCancelled {
    pub mandate: Pubkey,
    pub refunded: u64,
}

#[error_code]
pub enum MandateError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Period must be greater than zero")]
    InvalidPeriod,
    #[msg("Mandate is not active")]
    MandateInactive,
    #[msg("Pull exceeds the per-period spend cap")]
    RateLimitExceeded,
    #[msg("Escrow has insufficient funds")]
    InsufficientFunds,
    #[msg("Math overflow")]
    MathOverflow,
}
