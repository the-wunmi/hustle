//! An agent NFT's image and attributes follow the agent: with a base URI set by the owner, every
//! token view points `media` and `reference` at the live card, for tokens minted before and after.

use hustle_integration_tests::*;
use serde_json::{json, Value};

#[tokio::test]
async fn tokens_point_at_the_live_card_once_the_owner_sets_a_base_uri() -> anyhow::Result<()> {
    let w = World::new().await?;
    let before = w.mint_agent(&w.alice).await?;

    // Off by default: the stored metadata, with no image.
    let token = w.view(w.registry.id(), "nft_token", json!({ "token_id": before })).await?;
    assert_eq!(token["metadata"]["media"], Value::Null);

    // Only the owner may set it, and only to a web address.
    let r = w
        .alice
        .call(w.registry.id(), "set_base_uri")
        .args_json(json!({ "base_uri": "https://evil.example/nft" }))
        .transact()
        .await?;
    assert_failed_with(&r, "not_owner");
    let r = w
        .hustle
        .call(w.registry.id(), "set_base_uri")
        .args_json(json!({ "base_uri": "ipfs://nope" }))
        .transact()
        .await?;
    assert_failed_with(&r, "invalid_base_uri");

    let r = w
        .hustle
        .call(w.registry.id(), "set_base_uri")
        .args_json(json!({ "base_uri": "https://hustle.example/nft/" }))
        .transact()
        .await?;
    assert!(r.is_success(), "{r:?}");
    let after = w.mint_agent(&w.bob).await?;

    for id in [&before, &after] {
        let token = w.view(w.registry.id(), "nft_token", json!({ "token_id": id })).await?;
        assert_eq!(token["metadata"]["media"], format!("https://hustle.example/nft/{id}.svg"));
        assert_eq!(token["metadata"]["reference"], format!("https://hustle.example/nft/{id}.json"));
        assert_eq!(token["metadata"]["media_hash"], Value::Null);
    }
    let all = w.view(w.registry.id(), "nft_tokens", json!({})).await?;
    assert!(all.as_array().unwrap().iter().all(|t| t["metadata"]["media"].is_string()));
    let bobs = w
        .view(w.registry.id(), "nft_tokens_for_owner", json!({ "account_id": w.bob.id() }))
        .await?;
    assert_eq!(bobs[0]["metadata"]["media"], format!("https://hustle.example/nft/{after}.svg"));
    let meta = w.view(w.registry.id(), "nft_metadata", json!({})).await?;
    assert_eq!(meta["base_uri"], "https://hustle.example/nft");

    // Turned off again, the views return the stored metadata.
    let r = w
        .hustle
        .call(w.registry.id(), "set_base_uri")
        .args_json(json!({ "base_uri": null }))
        .transact()
        .await?;
    assert!(r.is_success(), "{r:?}");
    let token = w.view(w.registry.id(), "nft_token", json!({ "token_id": before })).await?;
    assert_eq!(token["metadata"]["media"], Value::Null);
    Ok(())
}
