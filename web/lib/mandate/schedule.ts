// USDC has 6 decimals. Subscription config mirrors the on-chain program.
export const USDC_DECIMALS = 6;

export const SUB = {
  price: 100_000, // 0.1 USDC per period ("month")
  fundMonths: 3, // the Fund button adds this many periods
};

export const usdc = (base: number) => (base / 10 ** USDC_DECIMALS).toFixed(4);
