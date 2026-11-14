//! AgentNFT registry (NEP-171/177/178/181). Each token id is the account id of a keyless agent wallet
//! this contract created as its sub-account. The token holder controls the wallet only through the
//! owner actions here, which check ownership in the same receipt that holds it.
//!
//! Storage: only the minter can mint, and `mint_agent` requires a deposit covering the wallet's
//! funding, its credits registration and this contract's per-token storage (token, metadata,
//! enumeration entries, rotation counter and approval counter, with room for one later owner). The
//! wallet code is set by the owner and paid from this contract's balance. NEP-178 approvals are paid
//! by the holder's deposit on `nft_approve` and refunded when they are revoked or cleared by a
//! transfer.

use std::collections::HashMap;

use hustle_common::{ext_ft, promise_succeeded, Rulebook, GAS_FOR_STORAGE_DEPOSIT};
use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
use near_contract_standards::non_fungible_token::core::{
    NonFungibleTokenCore, NonFungibleTokenResolver,
};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{
    refund_approved_account_ids, NonFungibleToken, Token, TokenId,
};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{LazyOption, LookupMap};
use near_sdk::{
    assert_one_yocto, borsh, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas,
    NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

/// Bytes of wallet state the registry funds on top of the wallet code. Matches the bound the wallet
/// contract proves in its own tests (`MAX_WALLET_STATE_BYTES`) plus the account record.
pub const WALLET_STATE_BYTES: u64 = 24_000 + 200;

/// Extra NEAR left in each wallet for the 1 yocto it attaches to every `ft_transfer` (enough for
/// about 10^22 transfers) and for storage price changes.
pub const WALLET_NEAR_BUFFER: NearToken = NearToken::from_millinear(10);

/// NEP-145 registration cost on the credits token (and on USDC): 0.00125 NEAR. The token refunds
/// any excess to this contract.
pub const CREDITS_STORAGE_DEPOSIT: NearToken =
    NearToken::from_yoctonear(1_250_000_000_000_000_000_000);

/// Bytes this contract stores per token: owner entry, metadata (capped below), the owner's
/// enumeration set entry (counted twice: the minting owner and one later holder), the rotation
/// counter, and `APPROVAL_OVERHEAD_BYTES`. Charged to the minter.
pub const TOKEN_STORAGE_BYTES: u64 = 2_048 + MAX_TOKEN_METADATA_BYTES + APPROVAL_OVERHEAD_BYTES;

/// What NEP-178 stores per token beyond each approved account (which `nft_approve`'s deposit pays):
/// the token's approval counter, kept forever, and the key of its approvals entry. The standard
/// implementation doesn't charge for these, so the mint does.
pub const APPROVAL_OVERHEAD_BYTES: u64 = 256;

/// Largest token metadata (borsh bytes) a mint may carry: a name, a short description and a media
/// link, not a document.
pub const MAX_TOKEN_METADATA_BYTES: u64 = 1_024;

/// Same floor as the wallet's `MIN_DAY_MS`, checked here too so a bad config fails at deploy time
/// rather than on the first mint.
pub const MIN_WALLET_DAY_MS: u64 = 60_000;

/// Longest agent name.
pub const MAX_NAME_LEN: usize = 64;

/// Largest wallet wasm accepted by `set_wallet_code`. Every agent pays storage for its own copy, so a
/// bloated build is refused rather than silently making every mint expensive.
pub const MAX_WALLET_CODE_BYTES: usize = 512 * 1024;

/// Global contract code is charged 10x normal storage, burnt (NEP-591).
pub const GLOBAL_CONTRACT_STORAGE_MULTIPLIER: u128 = 10;
/// Raw storage key of the flag "the wallet code is published as a global contract". Kept outside
/// the Borsh state struct so a registry deployed before it can be upgraded without a migration.
const WALLET_GLOBAL_KEY: &[u8] = b"wallet_global";
const GAS_FOR_GLOBAL_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_FOR_WALLET_INIT: Gas = Gas::from_tgas(20);
const GAS_FOR_MINT_CALLBACK: Gas = Gas::from_tgas(40);
const GAS_FOR_ROTATE: Gas = Gas::from_tgas(15);
const GAS_FOR_OWNER_ACTION: Gas = Gas::from_tgas(15);
/// Approve and withdraw start a token transfer and its callback inside the wallet.
const GAS_FOR_OWNER_PAYMENT: Gas = Gas::from_tgas(60);

const ITEM_SPEC: &str = "sharded-item-1.0.0";

/// Where each token's live card and attributes are served (NEP-177 `base_uri`), set by the owner.
/// Kept under its own storage key, outside the root state, so setting it needs no state migration.
const BASE_URI_KEY: &[u8] = b"base_uri";
/// Longest base URI accepted.
const MAX_BASE_URI_LEN: usize = 200;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    OwnerById,
    TokenMetadata,
    Enumeration,
    WalletCode,
    RotationSeq,
    TransfersInFlight,
    Approvals,
}

#[ext_contract(ext_wallet)]
pub trait AgentWallet {
    fn approve(&mut self, request_id: u64, rotation_seq: u64);
    fn deny(&mut self, request_id: u64, rotation_seq: u64);
    fn set_rulebook(&mut self, rulebook: Rulebook, rotation_seq: u64);
    fn set_frozen(&mut self, frozen: bool, rotation_seq: u64);
    fn withdraw(&mut self, amount: U128, receiver_id: AccountId, rotation_seq: u64);
    fn rotate_owner(&mut self, new_owner_id: AccountId, rotation_seq: u64);
}

#[near(serializers = [json])]
pub struct ItemInfo {
    pub spec: String,
    pub collection_id: AccountId,
    pub token_id: TokenId,
    pub owner_id: AccountId,
    pub rotation_seq: u64,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner_id: AccountId,
    pub minter_id: AccountId,
    pub operator_id: AccountId,
    pub credits_id: AccountId,
    pub jobs_id: AccountId,
    pub treasury_id: AccountId,
    pub wallet_day_ms: u64,
    pub next_agent: u64,
    /// Hex sha256 of the stored wallet code, if set.
    pub wallet_code_hash: Option<String>,
    /// Deposit `mint_agent` currently requires, in yoctoNEAR.
    pub mint_deposit: Option<NearToken>,
    /// New wallets use the code published as a global contract (by its hash) instead of each
    /// storing a copy, so a mint pays only for the wallet's state.
    pub wallet_code_global: bool,
}

#[near(event_json(standard = "hustle"))]
pub enum RegistryEvent<'a> {
    #[event_version("1.0.0")]
    WalletCodeSet { code_hash: String, code_len: u64 },
    #[event_version("1.0.0")]
    WalletCodePublished { code_hash: String },
    #[event_version("1.0.0")]
    MintFailed {
        token_id: &'a str,
        owner_id: &'a AccountId,
    },
    #[event_version("1.0.0")]
    CreditsRegistrationFailed { token_id: &'a str },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    owner_id: AccountId,
    minter_id: AccountId,
    operator_id: AccountId,
    credits_id: AccountId,
    jobs_id: AccountId,
    treasury_id: AccountId,
    /// Passed to every new wallet: the length of its spending day.
    wallet_day_ms: u64,
    tokens: NonFungibleToken,
    /// Kept out of the root state so ordinary calls do not load the wasm.
    wallet_code: LazyOption<Vec<u8>>,
    wallet_code_hash: Option<Vec<u8>>,
    next_agent: u64,
    rotation_seq: LookupMap<TokenId, u64>,
    /// Tokens with an `nft_transfer_call` whose `nft_resolve_transfer` has not run yet, with a count
    /// for nested calls. While set, the receiver holds the token only provisionally (it can hand it
    /// back), so owner actions are refused. Entries are removed on resolve, so this never grows.
    transfers_in_flight: LookupMap<TokenId, u32>,
}

#[near]
impl Registry {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner_id: AccountId,
        minter_id: AccountId,
        operator_id: AccountId,
        credits_id: AccountId,
        jobs_id: AccountId,
        treasury_id: AccountId,
        wallet_day_ms: u64,
    ) -> Self {
        require!(wallet_day_ms >= MIN_WALLET_DAY_MS, "invalid_day_ms");
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::OwnerById,
                owner_id.clone(),
                Some(StorageKey::TokenMetadata),
                Some(StorageKey::Enumeration),
                Some(StorageKey::Approvals),
            ),
            owner_id,
            minter_id,
            operator_id,
            credits_id,
            jobs_id,
            treasury_id,
            wallet_day_ms,
            wallet_code: LazyOption::new(StorageKey::WalletCode, None),
            wallet_code_hash: None,
            next_agent: 0,
            rotation_seq: LookupMap::new(StorageKey::RotationSeq),
            transfers_in_flight: LookupMap::new(StorageKey::TransfersInFlight),
        }
    }

    /// Owner only. Points every token's `media` and `reference` at `<base_uri>/<token_id>.svg` and
    /// `.json`, a card and attributes drawn from the agent's live state, so a wallet or marketplace
    /// shows the agent as it is now. `None` turns it off. The few bytes it stores come from this
    /// contract's balance.
    pub fn set_base_uri(&mut self, base_uri: Option<String>) {
        require!(env::predecessor_account_id() == self.owner_id, "not_owner");
        match base_uri {
            Some(uri) => {
                let uri = uri.trim_end_matches('/');
                require!(
                    uri.starts_with("https://") || uri.starts_with("http://"),
                    "invalid_base_uri"
                );
                require!(uri.len() <= MAX_BASE_URI_LEN, "invalid_base_uri");
                env::storage_write(BASE_URI_KEY, uri.as_bytes());
            }
            None => {
                env::storage_remove(BASE_URI_KEY);
            }
        }
    }

    pub fn get_base_uri(&self) -> Option<String> {
        base_uri()
    }

    /// Owner only, no deposit. The call input is the raw agent-wallet wasm (not JSON).
    pub fn set_wallet_code(&mut self) {
        require!(env::predecessor_account_id() == self.owner_id, "not_owner");
        let code = env::input().unwrap_or_default();
        require!(
            !code.is_empty() && code.len() <= MAX_WALLET_CODE_BYTES,
            "invalid_code"
        );
        let hash = env::sha256(&code);
        RegistryEvent::WalletCodeSet {
            code_hash: hex(&hash),
            code_len: code.len() as u64,
        }
        .emit();
        self.wallet_code_hash = Some(hash);
        self.wallet_code.set(Some(code));
        // New code is not published yet: wallets get their own copy until it is.
        env::storage_remove(WALLET_GLOBAL_KEY);
    }

    /// Owner only, once per wallet code. Publishes the stored wallet code as a global contract by
    /// hash (the call input is the same raw wasm, checked against the stored hash), so new wallets
    /// use it instead of storing a copy each. The deposit must cover 10x the code's storage, which
    /// the protocol burns; any excess goes back to the owner. Existing wallets keep their own copy.
    #[payable]
    pub fn publish_wallet_code(&mut self) -> Promise {
        require!(env::predecessor_account_id() == self.owner_id, "not_owner");
        require!(!wallet_code_global(), "already_published");
        let code = env::input().unwrap_or_default();
        let hash = env::sha256(&code);
        require!(
            self.wallet_code_hash.as_deref() == Some(hash.as_slice()),
            "not_the_wallet_code"
        );
        let cost = global_code_cost(code.len() as u64);
        let deposit = env::attached_deposit();
        require!(deposit >= cost, "insufficient_deposit");
        Promise::new(env::current_account_id())
            .deploy_global_contract(code)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_GLOBAL_CALLBACK)
                    .on_wallet_code_published(deposit, cost),
            )
    }

    /// Sets the flag once the code is published; if publishing failed nothing was burnt, so the
    /// whole deposit goes back.
    #[private]
    pub fn on_wallet_code_published(&mut self, deposit: NearToken, cost: NearToken) -> bool {
        if !promise_succeeded(0) {
            refund(&self.owner_id, deposit);
            return false;
        }
        env::storage_write(WALLET_GLOBAL_KEY, &[1]);
        RegistryEvent::WalletCodePublished {
            code_hash: self
                .wallet_code_hash
                .as_deref()
                .map(hex)
                .unwrap_or_default(),
        }
        .emit();
        refund(&self.owner_id, deposit.saturating_sub(cost));
        true
    }

    /// Minter only, with a deposit of at least `get_config().mint_deposit`. Creates the keyless
    /// wallet account `agent-<n>.<registry>` and registers it on the credits token; the NFT is minted
    /// in `on_agent_created` only if the account batch succeeded. Resolves to the token id, or null
    /// if creation failed (the deposit is then refunded).
    #[payable]
    pub fn mint_agent(
        &mut self,
        owner_id: AccountId,
        name: String,
        metadata: Option<TokenMetadata>,
        rulebook: Option<Rulebook>,
    ) -> Promise {
        require!(
            env::predecessor_account_id() == self.minter_id,
            "not_minter"
        );
        require!(
            !name.is_empty() && name.len() <= MAX_NAME_LEN,
            "invalid_name"
        );
        if let Some(rulebook) = &rulebook {
            rulebook.assert_valid();
        }
        let metadata = TokenMetadata {
            title: Some(name),
            ..metadata.unwrap_or_else(empty_metadata)
        };
        let metadata_len = borsh::to_vec(&metadata).map_or(u64::MAX, |b| b.len() as u64);
        require!(
            metadata_len <= MAX_TOKEN_METADATA_BYTES,
            "metadata_too_large"
        );
        let global = wallet_code_global();
        // With the code published globally the wallet stores none of it, so it is funded for its
        // state alone; otherwise it gets its own copy and pays that copy's storage.
        let code = if global {
            None
        } else {
            Some(
                self.wallet_code
                    .get()
                    .clone()
                    .unwrap_or_else(|| env::panic_str("no_wallet_code")),
            )
        };
        let stored_len = code.as_ref().map_or(0, |c| c.len() as u64);
        let wallet_funding = wallet_funding(stored_len);
        let required = mint_deposit(stored_len);
        let deposit = env::attached_deposit();
        require!(deposit >= required, "insufficient_deposit");

        let token_id = format!("agent-{}.{}", self.next_agent, env::current_account_id());
        self.next_agent += 1;
        let wallet_id: AccountId = token_id
            .parse()
            .unwrap_or_else(|_| env::panic_str("invalid_token_id"));
        let init_args = json!({
            "owner_id": owner_id,
            "operator_id": self.operator_id,
            "credits_id": self.credits_id,
            "jobs_id": self.jobs_id,
            "treasury_id": self.treasury_id,
            "rulebook": rulebook,
            "day_ms": self.wallet_day_ms,
        });

        // No AddKey: the account is controlled only by the wallet code.
        let account = Promise::new(wallet_id.clone())
            .create_account()
            .transfer(wallet_funding);
        let account = match code {
            Some(code) => account.deploy_contract(code),
            None => {
                let hash: [u8; 32] = self
                    .wallet_code_hash
                    .as_deref()
                    .and_then(|h| h.try_into().ok())
                    .unwrap_or_else(|| env::panic_str("no_wallet_code"));
                account.use_global_contract(hash)
            }
        };
        let create = account.function_call(
            "new".to_string(),
            init_args.to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_FOR_WALLET_INIT,
        );
        // A different receiver, so it cannot join the batch above; it runs alongside it.
        let register = ext_ft::ext(self.credits_id.clone())
            .with_attached_deposit(CREDITS_STORAGE_DEPOSIT)
            .with_static_gas(GAS_FOR_STORAGE_DEPOSIT)
            .storage_deposit(Some(wallet_id), Some(true));
        create.and(register).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_MINT_CALLBACK)
                .on_agent_created(
                    token_id,
                    owner_id,
                    metadata,
                    env::predecessor_account_id(),
                    deposit,
                    required,
                ),
        )
    }

    /// Mints the NFT if the wallet account was created. On failure the account does not exist (the
    /// batch is atomic), the agent number is not reused, and the deposit goes back to the minter.
    #[private]
    pub fn on_agent_created(
        &mut self,
        token_id: TokenId,
        owner_id: AccountId,
        metadata: TokenMetadata,
        minter_id: AccountId,
        deposit: NearToken,
        required: NearToken,
    ) -> Option<TokenId> {
        let created = promise_succeeded(0);
        let registered = promise_succeeded(1);
        if !created {
            RegistryEvent::MintFailed {
                token_id: &token_id,
                owner_id: &owner_id,
            }
            .emit();
            let spent = if registered {
                CREDITS_STORAGE_DEPOSIT
            } else {
                NearToken::from_yoctonear(0)
            };
            refund(&minter_id, deposit.saturating_sub(spent));
            return None;
        }
        if !registered {
            // Anyone can still register the wallet with `credits.storage_deposit`.
            RegistryEvent::CreditsRegistrationFailed {
                token_id: &token_id,
            }
            .emit();
        }
        self.tokens.internal_mint_with_refund(
            token_id.clone(),
            owner_id.clone(),
            Some(metadata),
            None,
        );
        self.rotation_seq.insert(token_id.clone(), 0);
        NftMint {
            owner_id: &owner_id,
            token_ids: &[&token_id],
            memo: None,
        }
        .emit();
        refund(&minter_id, deposit.saturating_sub(required));
        Some(token_id)
    }

    // Owner actions: exactly 1 yoctoNEAR, caller must hold the token now.

    #[payable]
    pub fn set_rulebook(&mut self, token_id: TokenId, rulebook: Rulebook) -> Promise {
        let (wallet, seq) = self.assert_holder(&token_id);
        rulebook.assert_valid();
        ext_wallet::ext(wallet)
            .with_static_gas(GAS_FOR_OWNER_ACTION)
            .set_rulebook(rulebook, seq)
    }

    #[payable]
    pub fn approve_spend(&mut self, token_id: TokenId, request_id: u64) -> Promise {
        let (wallet, seq) = self.assert_holder(&token_id);
        ext_wallet::ext(wallet)
            .with_static_gas(GAS_FOR_OWNER_PAYMENT)
            .approve(request_id, seq)
    }

    #[payable]
    pub fn deny_spend(&mut self, token_id: TokenId, request_id: u64) -> Promise {
        let (wallet, seq) = self.assert_holder(&token_id);
        ext_wallet::ext(wallet)
            .with_static_gas(GAS_FOR_OWNER_ACTION)
            .deny(request_id, seq)
    }

    /// Always pays the caller, who is the current holder. Refused with `listed` while the token has
    /// any NEP-178 approval: a buyer pays for the wallet as listed, so the seller must unlist first
    /// (`nft_revoke` or `nft_revoke_all`), which voids the listing and fails any buy still in flight,
    /// refunding it in full.
    #[payable]
    pub fn withdraw(&mut self, token_id: TokenId, amount: U128) -> Promise {
        let (wallet, seq) = self.assert_holder(&token_id);
        require!(!self.is_listed(&token_id), "listed");
        ext_wallet::ext(wallet)
            .with_static_gas(GAS_FOR_OWNER_PAYMENT)
            .withdraw(amount, env::predecessor_account_id(), seq)
    }

    #[payable]
    pub fn set_frozen(&mut self, token_id: TokenId, frozen: bool) -> Promise {
        let (wallet, seq) = self.assert_holder(&token_id);
        ext_wallet::ext(wallet)
            .with_static_gas(GAS_FOR_OWNER_ACTION)
            .set_frozen(frozen, seq)
    }

    /// Anyone, no deposit. Resends the current owner and rotation sequence to the wallet, in case the
    /// `rotate_owner` sent after a transfer failed (for example, out of gas). The wallet ignores
    /// sequences it has already applied.
    pub fn sync_owner(&mut self, token_id: TokenId) -> Promise {
        let owner = self.owner_of(&token_id);
        let seq = self.seq_of(&token_id);
        ext_wallet::ext(wallet_account(&token_id))
            .with_static_gas(GAS_FOR_ROTATE)
            .rotate_owner(owner, seq)
    }

    pub fn nft_item_info(&self, token_id: TokenId) -> Option<ItemInfo> {
        let owner_id = self.tokens.owner_by_id.get(&token_id)?;
        Some(ItemInfo {
            spec: ITEM_SPEC.to_string(),
            collection_id: env::current_account_id(),
            rotation_seq: self.seq_of(&token_id),
            token_id,
            owner_id,
        })
    }

    /// True while an `nft_transfer_call` for the token is unresolved; owner actions then fail with
    /// `transfer_in_flight`.
    pub fn is_transfer_in_flight(&self, token_id: TokenId) -> bool {
        self.transfers_in_flight.contains_key(&token_id)
    }

    pub fn get_config(&self) -> Config {
        let global = wallet_code_global();
        let code_len = self
            .wallet_code
            .get()
            .as_ref()
            .map(|c| if global { 0 } else { c.len() as u64 });
        Config {
            owner_id: self.owner_id.clone(),
            minter_id: self.minter_id.clone(),
            operator_id: self.operator_id.clone(),
            credits_id: self.credits_id.clone(),
            jobs_id: self.jobs_id.clone(),
            treasury_id: self.treasury_id.clone(),
            wallet_day_ms: self.wallet_day_ms,
            next_agent: self.next_agent,
            wallet_code_hash: self.wallet_code_hash.as_deref().map(hex),
            mint_deposit: code_len.map(mint_deposit),
            wallet_code_global: global,
        }
    }
}

#[near]
impl NonFungibleTokenCore for Registry {
    /// NEP-171, exactly 1 yoctoNEAR, by the holder or an account it approved (with a matching
    /// `approval_id` if one is given). Moves the token, clears its approvals (refunding their
    /// storage to the old holder) and tells the wallet its new owner.
    #[payable]
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        let sender_id = env::predecessor_account_id();
        // While an `nft_transfer_call` is unresolved the token may still go back, with the old
        // holder's approvals restored; an approval must not move it in between.
        if self.tokens.owner_by_id.get(&token_id).as_ref() != Some(&sender_id) {
            require!(
                !self.transfers_in_flight.contains_key(&token_id),
                "transfer_in_flight"
            );
        }
        let (previous_owner_id, approvals) =
            self.tokens
                .internal_transfer(&sender_id, &receiver_id, &token_id, approval_id, memo);
        refund_approvals(previous_owner_id, approvals);
        self.rotate(&token_id, receiver_id);
    }

    /// NEP-171, exactly 1 yoctoNEAR. The wallet is rotated in `nft_resolve_transfer`, once the
    /// receiver has kept the token.
    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        let count = self
            .transfers_in_flight
            .get(&token_id)
            .copied()
            .unwrap_or(0);
        self.transfers_in_flight.insert(token_id.clone(), count + 1);
        self.tokens
            .nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id).map(with_live_media)
    }
}

#[near]
impl NonFungibleTokenResolver for Registry {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        match self.transfers_in_flight.get(&token_id).copied() {
            Some(count) if count > 1 => {
                self.transfers_in_flight.insert(token_id.clone(), count - 1);
            }
            _ => {
                self.transfers_in_flight.remove(&token_id);
            }
        }
        let kept = self.tokens.nft_resolve_transfer(
            previous_owner_id.clone(),
            receiver_id.clone(),
            token_id.clone(),
            approved_account_ids.clone(),
        );
        // Kept: the old holder's approvals stay cleared, so their storage goes back to them. (The
        // standard only refunds them for a burned token, which this registry never has.)
        if kept {
            refund_approvals(previous_owner_id, approved_account_ids);
        }
        // If the receiver already passed the token on, that `nft_transfer` rotated the wallet.
        if kept && self.tokens.owner_by_id.get(&token_id).as_ref() == Some(&receiver_id) {
            self.rotate(&token_id, receiver_id);
        }
        kept
    }
}

/// NEP-178. Approvals are cleared by every transfer; the market lists an agent through one.
#[near]
impl NonFungibleTokenApproval for Registry {
    /// The holder only, with a deposit covering the approval's storage (excess refunded). With a
    /// `msg`, calls `account_id.nft_on_approve` and resolves to its result.
    #[payable]
    fn nft_approve(
        &mut self,
        token_id: TokenId,
        account_id: AccountId,
        msg: Option<String>,
    ) -> Option<Promise> {
        // A provisional holder could otherwise approve an account in the transfer-call window.
        require!(
            !self.transfers_in_flight.contains_key(&token_id),
            "transfer_in_flight"
        );
        self.tokens.nft_approve(token_id, account_id, msg)
    }

    /// The holder only, exactly 1 yoctoNEAR; refunds the approval's storage.
    #[payable]
    fn nft_revoke(&mut self, token_id: TokenId, account_id: AccountId) {
        self.tokens.nft_revoke(token_id, account_id);
    }

    /// The holder only, exactly 1 yoctoNEAR; refunds every approval's storage.
    #[payable]
    fn nft_revoke_all(&mut self, token_id: TokenId) {
        self.tokens.nft_revoke_all(token_id);
    }

    fn nft_is_approved(
        &self,
        token_id: TokenId,
        approved_account_id: AccountId,
        approval_id: Option<u64>,
    ) -> bool {
        self.tokens
            .nft_is_approved(token_id, approved_account_id, approval_id)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Registry {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        let tokens = self.tokens.nft_tokens(from_index, limit);
        tokens.into_iter().map(with_live_media).collect()
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens
            .nft_tokens_for_owner(account_id, from_index, limit)
            .into_iter()
            .map(with_live_media)
            .collect()
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Registry {
    fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Hustle Agents".to_string(),
            symbol: "AGENT".to_string(),
            icon: None,
            base_uri: base_uri(),
            reference: None,
            reference_hash: None,
        }
    }
}

impl Registry {
    /// Checks 1 yoctoNEAR and that the caller holds the token, and returns the wallet and the
    /// rotation sequence the wallet must be at for the action to apply.
    fn assert_holder(&self, token_id: &TokenId) -> (AccountId, u64) {
        assert_one_yocto();
        require!(
            !self.transfers_in_flight.contains_key(token_id),
            "transfer_in_flight"
        );
        let owner = self.owner_of(token_id);
        require!(env::predecessor_account_id() == owner, "not_owner");
        (wallet_account(token_id), self.seq_of(token_id))
    }

    /// Listed means approved for any account, not only the market: any approved account could move
    /// the token. A returned `nft_transfer_call` can restore an empty entry, which is not listed.
    fn is_listed(&self, token_id: &TokenId) -> bool {
        self.tokens
            .approvals_by_id
            .as_ref()
            .and_then(|approvals| approvals.get(token_id))
            .is_some_and(|approved| !approved.is_empty())
    }

    fn owner_of(&self, token_id: &TokenId) -> AccountId {
        self.tokens
            .owner_by_id
            .get(token_id)
            .unwrap_or_else(|| env::panic_str("not_found"))
    }

    fn seq_of(&self, token_id: &TokenId) -> u64 {
        self.rotation_seq.get(token_id).copied().unwrap_or(0)
    }

    /// Bumps the token's rotation sequence and tells the wallet. The counter entry was paid at mint,
    /// so this never grows storage.
    fn rotate(&mut self, token_id: &TokenId, new_owner_id: AccountId) {
        let seq = self.seq_of(token_id) + 1;
        self.rotation_seq.insert(token_id.clone(), seq);
        ext_wallet::ext(wallet_account(token_id))
            .with_static_gas(GAS_FOR_ROTATE)
            .rotate_owner(new_owner_id, seq)
            .detach();
    }
}

fn wallet_account(token_id: &TokenId) -> AccountId {
    token_id
        .parse()
        .unwrap_or_else(|_| env::panic_str("invalid_token_id"))
}

/// NEAR sent into a new wallet: its code and bounded state at the current storage price, plus a
/// small buffer.
fn wallet_funding(code_len: u64) -> NearToken {
    env::storage_byte_cost()
        .saturating_mul(u128::from(code_len + WALLET_STATE_BYTES))
        .saturating_add(WALLET_NEAR_BUFFER)
}

fn wallet_code_global() -> bool {
    env::storage_read(WALLET_GLOBAL_KEY).is_some()
}

/// What publishing `code_len` bytes as a global contract burns.
fn global_code_cost(code_len: u64) -> NearToken {
    env::storage_byte_cost()
        .saturating_mul(u128::from(code_len) * GLOBAL_CONTRACT_STORAGE_MULTIPLIER)
}

fn mint_deposit(code_len: u64) -> NearToken {
    wallet_funding(code_len)
        .saturating_add(CREDITS_STORAGE_DEPOSIT)
        .saturating_add(env::storage_byte_cost().saturating_mul(u128::from(TOKEN_STORAGE_BYTES)))
}

/// Returns the storage deposit of approvals a transfer cleared to the holder who paid it.
fn refund_approvals(previous_owner_id: AccountId, approvals: Option<HashMap<AccountId, u64>>) {
    if let Some(approvals) = approvals.filter(|a| !a.is_empty()) {
        refund_approved_account_ids(previous_owner_id, &approvals).detach();
    }
}

fn refund(account_id: &AccountId, amount: NearToken) {
    if !amount.is_zero() {
        Promise::new(account_id.clone()).transfer(amount).detach();
    }
}

fn base_uri() -> Option<String> {
    env::storage_read(BASE_URI_KEY).and_then(|b| String::from_utf8(b).ok())
}

/// A token as views return it: with a base URI set, its `media` and `reference` point at the live
/// card and attributes, as absolute URLs so no wallet has to resolve them against `base_uri`. They
/// change as the agent does, so they carry no hash. The stored metadata is never changed.
fn with_live_media(mut token: Token) -> Token {
    if let (Some(base), Some(metadata)) = (base_uri(), token.metadata.as_mut()) {
        metadata.media = Some(format!("{base}/{}.svg", token.token_id));
        metadata.media_hash = None;
        metadata.reference = Some(format!("{base}/{}.json", token.token_id));
        metadata.reference_hash = None;
    }
    token
}

fn empty_metadata() -> TokenMetadata {
    TokenMetadata {
        title: None,
        description: None,
        media: None,
        media_hash: None,
        copies: None,
        issued_at: None,
        expires_at: None,
        starts_at: None,
        updated_at: None,
        extra: None,
        reference: None,
        reference_hash: None,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
