use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

// Placeholder. Run `anchor keys sync` after the first `anchor build`.
declare_id!("11111111111111111111111111111111");

// A recurring subscription you actually control: "the one you forgot to cancel,
// except you get your unused months back."
//
// The payer funds a PDA escrow with one or more periods up front. The provider may
// `charge` the fixed `price` at most ONCE per `period_secs` (the program enforces the
// cadence and the amount). If the escrow cannot cover a period, the charge fails and
// service lapses. The payer can `cancel` at any time and is refunded every period that
// was funded but not yet charged.
#[program]
pub mod standing_order {
    use super::*;

    pub fn open_subscription(
        ctx: Context<OpenSubscription>,
        price: u64,
        period_secs: i64,
    ) -> Result<()> {
        require!(price > 0, SubError::InvalidAmount);
        require!(period_secs > 0, SubError::InvalidPeriod);
        let s = &mut ctx.accounts.subscription;
        s.owner = ctx.accounts.owner.key();
        s.provider = ctx.accounts.provider.key();
        s.mint = ctx.accounts.mint.key();
        s.price = price;
        s.period_secs = period_secs;
        s.next_charge_ts = Clock::get()?.unix_timestamp; // first charge is due immediately
        s.periods_charged = 0;
        s.active = true;
        s.bump = ctx.bumps.subscription;
        Ok(())
    }

    /// Payer funds the escrow. Deposit any number of periods ahead.
    pub fn fund(ctx: Context<Fund>, amount: u64) -> Result<()> {
        require!(amount > 0, SubError::InvalidAmount);
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

    /// Provider collects one period's fee. Enforced on-chain: active, the period is due
    /// (at most one charge per `period_secs`), and the escrow covers `price`. Emits Charged,
    /// and RenewalAtRisk when the remaining balance cannot cover the next period.
    pub fn charge(ctx: Context<Charge>) -> Result<()> {
        require!(ctx.accounts.subscription.active, SubError::Inactive);

        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= ctx.accounts.subscription.next_charge_ts,
            SubError::RenewalNotDue
        );

        let price = ctx.accounts.subscription.price;
        let balance = ctx.accounts.escrow.amount;
        require!(balance >= price, SubError::InsufficientFunds);

        // Pay the provider, signed by the subscription PDA.
        let owner = ctx.accounts.subscription.owner;
        let provider = ctx.accounts.subscription.provider;
        let bump = ctx.accounts.subscription.bump;
        let seeds: &[&[u8]] = &[b"sub", owner.as_ref(), provider.as_ref(), &[bump]];
        let signer = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow.to_account_info(),
                    to: ctx.accounts.provider_token_account.to_account_info(),
                    authority: ctx.accounts.subscription.to_account_info(),
                },
                signer,
            ),
            price,
        )?;

        let remaining = balance - price;
        let key = ctx.accounts.subscription.key();
        let period_index;
        {
            let s = &mut ctx.accounts.subscription;
            s.next_charge_ts = s
                .next_charge_ts
                .checked_add(s.period_secs)
                .ok_or(SubError::MathOverflow)?;
            s.periods_charged = s.periods_charged.checked_add(1).ok_or(SubError::MathOverflow)?;
            period_index = s.periods_charged;
        }

        emit!(Charged { subscription: key, period: period_index, amount: price, remaining });
        if remaining < price {
            emit!(RenewalAtRisk { subscription: key, remaining, price });
        }
        Ok(())
    }

    /// Payer cancels at any time: deactivate and refund every funded-but-uncharged period.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let amount = ctx.accounts.escrow.amount;
        let price = ctx.accounts.subscription.price;
        if amount > 0 {
            let owner = ctx.accounts.subscription.owner;
            let provider = ctx.accounts.subscription.provider;
            let bump = ctx.accounts.subscription.bump;
            let seeds: &[&[u8]] = &[b"sub", owner.as_ref(), provider.as_ref(), &[bump]];
            let signer = &[seeds];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow.to_account_info(),
                        to: ctx.accounts.owner_token_account.to_account_info(),
                        authority: ctx.accounts.subscription.to_account_info(),
                    },
                    signer,
                ),
                amount,
            )?;
        }
        let key = ctx.accounts.subscription.key();
        ctx.accounts.subscription.active = false;
        let months_refunded = amount / price;
        emit!(SubscriptionCancelled { subscription: key, refunded: amount, months_refunded });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct OpenSubscription<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// CHECK: stored as the only key allowed to charge; not read or written.
    pub provider: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = owner,
        space = 8 + Subscription::INIT_SPACE,
        seeds = [b"sub", owner.key().as_ref(), provider.key().as_ref()],
        bump
    )]
    pub subscription: Account<'info, Subscription>,

    #[account(
        init,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = subscription
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
        seeds = [b"sub", subscription.owner.as_ref(), subscription.provider.as_ref()],
        bump = subscription.bump,
        has_one = owner
    )]
    pub subscription: Account<'info, Subscription>,

    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = subscription.mint,
        associated_token::authority = subscription
    )]
    pub escrow: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Charge<'info> {
    pub provider: Signer<'info>,

    #[account(
        mut,
        seeds = [b"sub", subscription.owner.as_ref(), subscription.provider.as_ref()],
        bump = subscription.bump,
        has_one = provider
    )]
    pub subscription: Account<'info, Subscription>,

    #[account(
        mut,
        associated_token::mint = subscription.mint,
        associated_token::authority = subscription
    )]
    pub escrow: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = subscription.mint,
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
        seeds = [b"sub", subscription.owner.as_ref(), subscription.provider.as_ref()],
        bump = subscription.bump,
        has_one = owner
    )]
    pub subscription: Account<'info, Subscription>,

    #[account(
        mut,
        associated_token::mint = subscription.mint,
        associated_token::authority = subscription
    )]
    pub escrow: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Subscription {
    pub owner: Pubkey,
    pub provider: Pubkey,
    pub mint: Pubkey,
    pub price: u64,
    pub period_secs: i64,
    pub next_charge_ts: i64,
    pub periods_charged: u64,
    pub active: bool,
    pub bump: u8,
}

#[event]
pub struct Charged {
    pub subscription: Pubkey,
    pub period: u64,
    pub amount: u64,
    pub remaining: u64,
}

#[event]
pub struct RenewalAtRisk {
    pub subscription: Pubkey,
    pub remaining: u64,
    pub price: u64,
}

#[event]
pub struct SubscriptionCancelled {
    pub subscription: Pubkey,
    pub refunded: u64,
    pub months_refunded: u64,
}

#[error_code]
pub enum SubError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Period must be greater than zero")]
    InvalidPeriod,
    #[msg("Subscription is not active")]
    Inactive,
    #[msg("This period's charge is not due yet")]
    RenewalNotDue,
    #[msg("Escrow cannot cover this period")]
    InsufficientFunds,
    #[msg("Math overflow")]
    MathOverflow,
}
