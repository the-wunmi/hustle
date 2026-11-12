//! Shared sandbox harness: one `World` per test, with the contracts deployed at the account
//! layout `<name>.hustle.test.near`, so each test reads as its scenario.

use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

use anyhow::{anyhow, ensure, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Worker};
use serde_json::{json, Value};

/// One dollar in micro-USD.
pub const DOLLAR: u128 = 1_000_000;

/// The platform fee used by the tests: 5%.
pub const FEE_BPS: u16 = 500;

/// The market fee used by the tests: 2.5%, what the game passes.
pub const MARKET_FEE_BPS: u16 = 250;

/// A real UTC day; the day-reset test builds its own world with a short day.
pub const REAL_DAY_MS: u64 = 86_400_000;

pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const MAX_GAS: Gas = Gas::from_tgas(300);

static BUILD: OnceLock<()> = OnceLock::new();

fn contracts_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("contracts dir")
        .to_path_buf()
}

/// Builds every contract once per test binary with the project's build script, so the tests always
/// run the current source as the same wasm the TypeScript side deploys.
pub fn wasm(name: &str) -> Vec<u8> {
    BUILD.get_or_init(|| {
        let script = contracts_dir().join("../scripts/build-contracts.sh");
        let status = Command::new("bash")
            .arg(script)
            .status()
            .expect("run build-contracts.sh");
        assert!(status.success(), "build-contracts.sh failed");
    });
    std::fs::read(contracts_dir().join("out").join(format!("{name}.wasm")))
        .unwrap_or_else(|e| panic!("read {name}.wasm: {e}"))
}

pub fn rulebook() -> Value {
    json!({
        "daily_cap": (10 * DOLLAR).to_string(),
        "max_per_job": (5 * DOLLAR).to_string(),
        "max_per_call": (2 * DOLLAR).to_string(),
        "allowed_vendors": [],
        "any_vendor": false,
        "may_hire": true,
        "helper_budget": DOLLAR.to_string(),
    })
}

pub struct World {
    pub worker: Worker<Sandbox>,
    /// Root of the layout and owner of every contract.
    pub hustle: Account,
    pub credits: Account,
    pub registry: Account,
    pub jobs: Account,
    pub rep: Account,
    pub market: Account,
    pub minter: Account,
    pub operator: Account,
    pub treasury: Account,
    /// A tool seller on the allowlist.
    pub vendor: Account,
    /// A tool seller nobody approved (the scam).
    pub scammer: Account,
    pub alice: Account,
    pub bob: Account,
    /// A job poster.
    pub client: Account,
    pub stranger: Account,
}

impl World {
    pub async fn new() -> Result<Self> {
        Self::with_day_ms(REAL_DAY_MS).await
    }

    pub async fn with_day_ms(day_ms: u64) -> Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;
        let hustle = sub(&root, "hustle", 5_000).await?;
        let credits = sub(&hustle, "credits", 50).await?;
        let registry = sub(&hustle, "agents", 50).await?;
        let jobs = sub(&hustle, "jobs", 50).await?;
        let rep = sub(&hustle, "rep", 50).await?;
        let market = sub(&hustle, "market", 50).await?;
        let minter = sub(&hustle, "signup", 200).await?;
        let operator = sub(&hustle, "orchestrator", 50).await?;
        let treasury = sub(&hustle, "treasury", 10).await?;
        let vendors = sub(&hustle, "vendors", 30).await?;
        let vendor = sub(&vendors, "search", 10).await?;
        let scammer = sub(&vendors, "scam", 10).await?;
        let alice = sub(&root, "alice", 50).await?;
        let bob = sub(&root, "bob", 50).await?;
        let client = sub(&root, "client", 50).await?;
        let stranger = sub(&root, "stranger", 50).await?;

        ok(credits
            .deploy(&wasm("credits"))
            .await?
            .into_result()?
            .call("new")
            .args_json(json!({ "owner_id": hustle.id() }))
            .transact()
            .await?)?;
        ok(registry
            .deploy(&wasm("registry"))
            .await?
            .into_result()?
            .call("new")
            .args_json(json!({
                "owner_id": hustle.id(),
                "minter_id": minter.id(),
                "operator_id": operator.id(),
                "credits_id": credits.id(),
                "jobs_id": jobs.id(),
                "treasury_id": treasury.id(),
                "wallet_day_ms": day_ms,
            }))
            .transact()
            .await?)?;
        ok(jobs
            .deploy(&wasm("job-board"))
            .await?
            .into_result()?
            .call("new")
            .args_json(json!({
                "owner_id": hustle.id(),
                "operator_id": operator.id(),
                "credits_id": credits.id(),
                "registry_id": registry.id(),
                "rep_id": rep.id(),
                "treasury_id": treasury.id(),
                "fee_bps": FEE_BPS,
            }))
            .transact()
            .await?)?;
        ok(rep
            .deploy(&wasm("reputation"))
            .await?
            .into_result()?
            .call("new")
            .args_json(json!({
                "owner_id": hustle.id(),
                "jobs_id": jobs.id(),
                "operator_id": operator.id(),
                "registry_id": registry.id(),
            }))
            .transact()
            .await?)?;
        ok(market
            .deploy(&wasm("market"))
            .await?
            .into_result()?
            .call("new")
            .args_json(json!({
                "owner_id": hustle.id(),
                "registry_id": registry.id(),
                "credits_id": credits.id(),
                "treasury_id": treasury.id(),
                "fee_bps": MARKET_FEE_BPS,
            }))
            .transact()
            .await?)?;
        ok(hustle
            .call(registry.id(), "set_wallet_code")
            .args(wasm("agent-wallet"))
            .gas(MAX_GAS)
            .transact()
            .await?)?;

        let world = Self {
            worker,
            hustle,
            credits,
            registry,
            jobs,
            rep,
            market,
            minter,
            operator,
            treasury,
            vendor,
            scammer,
            alice,
            bob,
            client,
            stranger,
        };
        for account in [
            &world.jobs,
            &world.market,
            &world.treasury,
            &world.vendor,
            &world.scammer,
            &world.alice,
            &world.bob,
            &world.client,
        ] {
            world.register(account.id()).await?;
        }
        Ok(world)
    }

    /// NEP-145 registration on credits, paid by the root account.
    pub async fn register(&self, account_id: &AccountId) -> Result<()> {
        ok(self
            .hustle
            .call(self.credits.id(), "storage_deposit")
            .args_json(json!({ "account_id": account_id, "registration_only": true }))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await?)
    }

    pub async fn mint_credits(&self, account_id: &AccountId, amount: u128) -> Result<()> {
        ok(self
            .hustle
            .call(self.credits.id(), "mint")
            .args_json(json!({ "account_id": account_id, "amount": amount.to_string() }))
            .transact()
            .await?)
    }

    pub async fn balance(&self, account_id: &AccountId) -> Result<u128> {
        let value: String = self
            .worker
            .view(self.credits.id(), "ft_balance_of")
            .args_json(json!({ "account_id": account_id }))
            .await?
            .json()?;
        Ok(value.parse()?)
    }

    pub async fn mint_deposit(&self) -> Result<NearToken> {
        let config = self
            .view(self.registry.id(), "get_config", json!({}))
            .await?;
        let yocto: u128 = config["mint_deposit"]
            .as_str()
            .ok_or_else(|| anyhow!("no mint_deposit"))?
            .parse()?;
        Ok(NearToken::from_yoctonear(yocto))
    }

    /// Mints an agent for `owner` with the test rulebook and returns its wallet account id.
    pub async fn mint_agent(&self, owner: &Account) -> Result<AccountId> {
        self.mint_agent_with(owner, Some(rulebook())).await
    }

    pub async fn mint_agent_with(
        &self,
        owner: &Account,
        rulebook: Option<Value>,
    ) -> Result<AccountId> {
        let result = self
            .minter
            .call(self.registry.id(), "mint_agent")
            .args_json(json!({
                "owner_id": owner.id(),
                "name": "Scout",
                "metadata": null,
                "rulebook": rulebook,
            }))
            .deposit(self.mint_deposit().await?)
            .gas(MAX_GAS)
            .transact()
            .await?;
        let token: Option<String> = result.clone().into_result()?.json()?;
        Ok(token
            .ok_or_else(|| anyhow!("mint returned null"))?
            .parse()?)
    }

    pub async fn view(&self, contract: &AccountId, method: &str, args: Value) -> Result<Value> {
        Ok(self
            .worker
            .view(contract, method)
            .args_json(args)
            .await?
            .json()?)
    }

    pub async fn wallet(&self, wallet: &AccountId) -> Result<Value> {
        self.view(wallet, "get_wallet", json!({})).await
    }

    /// Operator spend; returns the whole execution so tests can read the outcome and the events.
    pub async fn spend_as(
        &self,
        caller: &Account,
        wallet: &AccountId,
        request: Value,
    ) -> Result<ExecutionFinalResult> {
        Ok(caller
            .call(wallet, "spend")
            .args_json(json!({ "request": request }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    pub async fn spend(&self, wallet: &AccountId, request: Value) -> Result<ExecutionFinalResult> {
        self.spend_as(&self.operator, wallet, request).await
    }

    /// An owner action routed through the registry with the given deposit.
    pub async fn owner_action(
        &self,
        caller: &Account,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.registry.id(), method)
            .args_json(args)
            .deposit(deposit)
            .gas(Gas::from_tgas(150))
            .transact()
            .await?)
    }

    pub async fn set_rulebook(
        &self,
        owner: &Account,
        wallet: &AccountId,
        rulebook: Value,
    ) -> Result<()> {
        ok(self
            .owner_action(
                owner,
                "set_rulebook",
                json!({ "token_id": wallet, "rulebook": rulebook }),
                ONE_YOCTO,
            )
            .await?)
    }

    pub async fn transfer_nft(
        &self,
        from: &Account,
        wallet: &AccountId,
        to: &Account,
    ) -> Result<()> {
        ok(from
            .call(self.registry.id(), "nft_transfer")
            .args_json(json!({ "receiver_id": to.id(), "token_id": wallet }))
            .deposit(ONE_YOCTO)
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    /// Lists an agent: `nft_approve(market, {price})` with a deposit for the approval's storage.
    pub async fn list(
        &self,
        seller: &Account,
        wallet: &AccountId,
        price: u128,
    ) -> Result<ExecutionFinalResult> {
        Ok(seller
            .call(self.registry.id(), "nft_approve")
            .args_json(json!({
                "token_id": wallet,
                "account_id": self.market.id(),
                "msg": json!({ "price": price.to_string() }).to_string(),
            }))
            .deposit(NearToken::from_millinear(10))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    /// Buys an agent: `ft_transfer_call(market, amount, {token_id, expected_price})`. The result's
    /// value is the amount the market kept: the price after a sale, 0 after a refund.
    pub async fn buy(
        &self,
        buyer: &Account,
        wallet: &AccountId,
        amount: u128,
        expected_price: u128,
    ) -> Result<ExecutionFinalResult> {
        Ok(buyer
            .call(self.credits.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": self.market.id(),
                "amount": amount.to_string(),
                "msg": json!({
                    "token_id": wallet,
                    "expected_price": expected_price.to_string(),
                })
                .to_string(),
            }))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await?)
    }

    /// Alice's agent with 5 credits in its wallet, listed at `price`; Bob gets 50 credits to buy it.
    pub async fn listed_agent(&self, price: u128) -> Result<AccountId> {
        let wallet = self.mint_agent(&self.alice).await?;
        self.mint_credits(&wallet, 5 * DOLLAR).await?;
        self.mint_credits(self.bob.id(), 50 * DOLLAR).await?;
        ok(self.list(&self.alice, &wallet, price).await?)?;
        Ok(wallet)
    }

    pub async fn listing(&self, wallet: &AccountId) -> Result<Value> {
        self.view(
            self.market.id(),
            "get_listing",
            json!({ "token_id": wallet }),
        )
        .await
    }

    pub async fn owner_of(&self, wallet: &AccountId) -> Result<Value> {
        Ok(self
            .view(
                self.registry.id(),
                "nft_token",
                json!({ "token_id": wallet }),
            )
            .await?["owner_id"]
            .clone())
    }

    /// Posts a job by `ft_transfer_call` from `client` and returns the execution.
    pub async fn post_job(
        &self,
        client: &Account,
        job_key: &str,
        budget: u128,
        auto_award: bool,
        review_window_ms: u64,
    ) -> Result<ExecutionFinalResult> {
        let msg = json!({ "post": {
            "job_key": job_key,
            "spec_hash": "sha256:spec",
            "auto_award": auto_award,
            "review_window_ms": review_window_ms,
        }});
        self.post_job_msg(client, budget, msg).await
    }

    /// Posts with an arbitrary `ft_transfer_call` message.
    pub async fn post_job_msg(
        &self,
        client: &Account,
        budget: u128,
        msg: Value,
    ) -> Result<ExecutionFinalResult> {
        Ok(client
            .call(self.credits.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": self.jobs.id(),
                "amount": budget.to_string(),
                "msg": msg.to_string(),
            }))
            .deposit(ONE_YOCTO)
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    pub async fn job_by_key(&self, job_key: &str) -> Result<Value> {
        self.view(
            self.jobs.id(),
            "get_job_by_key",
            json!({ "job_key": job_key }),
        )
        .await
    }

    pub async fn job(&self, job_id: u64) -> Result<Value> {
        self.view(self.jobs.id(), "get_job", json!({ "job_id": job_id }))
            .await
    }

    pub async fn jobs_call(
        &self,
        caller: &Account,
        method: &str,
        args: Value,
    ) -> Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.jobs.id(), method)
            .args_json(args)
            .gas(Gas::from_tgas(150))
            .transact()
            .await?)
    }

    /// Posts, awards and delivers a job; returns its id.
    pub async fn delivered_job(
        &self,
        job_key: &str,
        agent: &AccountId,
        budget: u128,
        price: u128,
        review_window_ms: u64,
    ) -> Result<u64> {
        ok(self
            .post_job(&self.client, job_key, budget, false, review_window_ms)
            .await?)?;
        let job_id = self.job_by_key(job_key).await?["job_id"]
            .as_u64()
            .ok_or_else(|| anyhow!("job not stored"))?;
        ok(self
            .jobs_call(
                &self.client,
                "award",
                json!({ "job_id": job_id, "agent_id": agent, "price": price.to_string() }),
            )
            .await?)?;
        ok(self
            .jobs_call(
                &self.operator,
                "deliver",
                json!({ "job_id": job_id, "agent_id": agent, "work_hash": "sha256:work" }),
            )
            .await?)?;
        Ok(job_id)
    }
}

async fn sub(parent: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(parent
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

/// Fails with the receipt errors if the transaction or any of its receipts failed.
pub fn ok(result: ExecutionFinalResult) -> Result<()> {
    ensure!(
        result.is_success() && result.receipt_failures().is_empty(),
        "transaction failed: {:?}",
        result.receipt_failures()
    );
    Ok(())
}

/// True if the transaction failed with `code` in its error message.
pub fn failed_with(result: &ExecutionFinalResult, code: &str) -> bool {
    !result.is_success() && format!("{:?}", result.clone().into_result()).contains(code)
}

pub fn assert_failed_with(result: &ExecutionFinalResult, code: &str) {
    assert!(
        failed_with(result, code),
        "expected failure `{code}`, got {:?}",
        result.clone().into_result().map(|_| "success")
    );
}

/// The NEP-297 events logged anywhere in the transaction.
pub fn events(result: &ExecutionFinalResult) -> Vec<Value> {
    result
        .logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .filter_map(|json| serde_json::from_str(json).ok())
        .collect()
}

pub fn has_event(result: &ExecutionFinalResult, name: &str) -> bool {
    events(result).iter().any(|e| e["event"] == name)
}

pub fn spend_request(key: &str, kind: &str, receiver: &AccountId, amount: u128) -> Value {
    json!({
        "key": key,
        "kind": kind,
        "receiver_id": receiver,
        "amount": amount.to_string(),
        "job_id": null,
        "memo": "",
        "receipt": null,
    })
}

pub fn with_job(mut request: Value, job_id: &str) -> Value {
    request["job_id"] = json!(job_id);
    request
}

/// The `SpendOutcome` a spend resolved to.
pub fn outcome(result: &ExecutionFinalResult) -> Value {
    result.clone().json().expect("spend returns an outcome")
}

/// The first event called `name` anywhere in the transaction, as its `data`.
pub fn event<'a>(events: &'a [Value], name: &str) -> Option<&'a Value> {
    events
        .iter()
        .find(|e| e["event"] == name)
        .map(|e| &e["data"])
}

/// The amount a buy's `ft_transfer_call` kept: the price after a sale, 0 after a refund.
pub fn kept(r: &ExecutionFinalResult) -> u128 {
    let value: String = r
        .clone()
        .json()
        .expect("ft_transfer_call returns the amount used");
    value.parse().expect("amount")
}

/// Why the market refunded a buy.
pub fn refund_reason(r: &ExecutionFinalResult) -> Value {
    event(&events(r), "buy_refunded").expect("buy_refunded")["reason"].clone()
}

/// The market's cut of a sale at `price`, rounded down.
pub fn market_fee(price: u128) -> u128 {
    price * u128::from(MARKET_FEE_BPS) / 10_000
}
