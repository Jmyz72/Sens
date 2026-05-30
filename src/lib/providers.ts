// Frontend mirror of the Rust account-template seed (src-tauri/src/db/seed.rs).
// Providers are BRANDING ONLY — `group` organises the picker and `defaultSubtype`
// is a suggested starting subtype; neither determines an account's type/group.
// KEEP IN SYNC with seed.rs, which is authoritative for the packaged app.

export type ProviderGroup = {
  group: string;
  defaultSubtype: string;
  providers: [key: string, name: string][];
};

export const PROVIDER_GROUPS: ProviderGroup[] = [
  { group: "Banks", defaultSubtype: "savings", providers: [
    ["maybank", "Maybank"], ["cimb", "CIMB"], ["public-bank", "Public Bank"],
    ["rhb", "RHB"], ["hong-leong-bank", "Hong Leong Bank"], ["ambank", "AmBank"],
    ["bank-islam", "Bank Islam"], ["bank-rakyat", "Bank Rakyat"],
    ["bank-muamalat", "Bank Muamalat"], ["affin-bank", "Affin Bank"],
    ["alliance-bank", "Alliance Bank"], ["bsn", "BSN"], ["agrobank", "Agrobank"],
    ["mbsb-bank", "MBSB Bank"], ["al-rajhi-bank", "Al Rajhi Bank"],
    ["ocbc", "OCBC"], ["uob", "UOB"], ["hsbc", "HSBC"],
    ["standard-chartered", "Standard Chartered"],
  ] },
  { group: "Digital banks", defaultSubtype: "savings", providers: [
    ["gxbank", "GXBank"], ["boost-bank", "Boost Bank"], ["aeon-bank", "AEON Bank"],
    ["kaf-digital-bank", "KAF Digital Bank"], ["ryt-bank", "Ryt Bank"],
  ] },
  { group: "E-wallets", defaultSubtype: "ewallet", providers: [
    ["tng-ewallet", "Touch 'n Go eWallet"], ["grabpay", "GrabPay"], ["boost", "Boost"],
    ["shopeepay", "ShopeePay"], ["mae", "MAE"], ["setel", "Setel"],
    ["bigpay", "BigPay"], ["lazada-wallet", "Lazada Wallet"],
  ] },
  { group: "Buy now, pay later", defaultSubtype: "bnpl", providers: [
    ["atome", "Atome"], ["shopee-paylater", "Shopee PayLater"],
    ["grab-paylater", "Grab PayLater"], ["boost-payflex", "Boost PayFlex"],
    ["riipay", "Riipay"],
  ] },
  { group: "Investment", defaultSubtype: "investment", providers: [
    ["asnb", "ASNB"], ["stashaway", "StashAway"], ["versa", "Versa"],
    ["wahed", "Wahed"], ["rakuten-trade", "Rakuten Trade"], ["moomoo", "Moomoo"],
    ["kdi", "KDI"],
  ] },
  { group: "Global fintech", defaultSubtype: "ewallet", providers: [
    ["paypal", "PayPal"], ["wise", "Wise"], ["revolut", "Revolut"],
    ["n26", "N26"], ["payoneer", "Payoneer"],
  ] },
  { group: "Crypto", defaultSubtype: "crypto", providers: [
    ["luno", "Luno"],
  ] },
];

export const PROVIDER_KEYS: string[] =
  PROVIDER_GROUPS.flatMap((g) => g.providers.map(([key]) => key));
