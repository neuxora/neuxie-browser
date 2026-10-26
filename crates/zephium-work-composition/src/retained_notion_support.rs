//! Shared release-excluded admission for exact authenticated Notion witnesses.

use crate::native_work_clock::{authority_window, NativeWorkClock};
use std::{sync::Arc, time::Duration};
use zephium_agent_controller::{
    AgentBrowserModel, AgentWorkContextSpec, AgentWorkRunInput, AgentWorkRunSettings,
    AgentWorkTask, TerraControllerIds,
};
use zephium_agent_provider_transport::{
    load_probe_openai_credential, AgentProviderTransportConfig,
};
use zephium_agent_runtime::AgentRuntimeConfig;
use zephium_agentic::*;

const TOTAL: Duration = Duration::from_secs(150);
pub(super) const ORIGIN: &str = "https://app.notion.com";
const TARGET_ENVIRONMENT: &str = "ZEPHIUM_NOTION_QUALIFICATION_URL";

pub(super) struct RequestParts {
    pub identity: ContextIdentity,
    pub origin: SemanticOrigin,
    pub account: AgentAccountScope,
    input: AgentWorkRunInput,
    credential: AgentProviderCredential,
    profile: zephium_app::AgentWorkProfileBinding,
}

impl RequestParts {
    pub fn finish(self, task: Box<dyn AgentWorkTask>) -> crate::TrustedWorkRequest {
        crate::TrustedWorkRequest::new(
            self.input,
            zephium_app::AgentWorkApplicationConfig::new(
                AgentRuntimeConfig::STANDARD,
                AgentProviderTransportConfig::STANDARD,
            ),
            self.credential,
            task,
        )
        .with_browser_profile(self.profile)
        .with_public_qualification_retention()
    }
}

pub(super) fn load_parts(
    started: std::time::Instant,
    profile: zephium_app::AgentWorkProfileBinding,
    objective: &str,
    allowed_effects: &[SemanticEffectClass],
    operations: u32,
    max_model_calls: u8,
) -> Result<RequestParts, &'static str> {
    let deadline = started.checked_add(TOTAL).ok_or("deadline")?;
    if std::time::Instant::now() >= deadline {
        return Err("deadline");
    }
    let target = load_target()?;
    let origin = SemanticOrigin::parse(ORIGIN).map_err(|_| "origin")?;
    let account = AgentAccountScope::Authenticated(AgentAccountId::generate());
    let identity = ContextIdentity::new(
        ContextId::generate(),
        ContextRunId::generate(),
        profile.profile(),
        ContextKind::Owned,
    );
    let input = input(
        identity,
        profile.storage_class(),
        deadline,
        target,
        origin.clone(),
        account,
        objective,
        allowed_effects,
        operations,
        max_model_calls,
    )?;
    let credential = load_probe_openai_credential().map_err(|_| "credential")?;
    if std::time::Instant::now() >= deadline {
        return Err("deadline");
    }
    Ok(RequestParts {
        identity,
        origin,
        account,
        input,
        credential,
        profile,
    })
}

fn load_target() -> Result<ContextNavigationTarget, &'static str> {
    let raw = std::env::var(TARGET_ENVIRONMENT).map_err(|_| "target_missing")?;
    parse_target(&raw)
}

pub(super) fn parse_target(raw: &str) -> Result<ContextNavigationTarget, &'static str> {
    if raw.trim() != raw || raw.is_empty() || raw.len() > MAX_AGENT_BROWSER_NAVIGATION_URL_BYTES {
        return Err("target_invalid");
    }
    let target = ContextNavigationTarget::parse(raw).map_err(|_| "target_invalid")?;
    let url = target.as_url();
    if url.scheme() != "https"
        || url.host_str() != Some("app.notion.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() == "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || SemanticOrigin::parse(url.as_str()).as_ref() != SemanticOrigin::parse(ORIGIN).as_ref()
    {
        return Err("target_outside_scope");
    }
    Ok(target)
}

#[allow(clippy::too_many_arguments)]
fn input(
    identity: ContextIdentity,
    storage: ContextProfileStorageClass,
    deadline: std::time::Instant,
    target: ContextNavigationTarget,
    origin: SemanticOrigin,
    account: AgentAccountScope,
    objective: &str,
    allowed_effects: &[SemanticEffectClass],
    operations: u32,
    max_model_calls: u8,
) -> Result<AgentWorkRunInput, &'static str> {
    let effects = AgentEffectScope::try_new(allowed_effects).map_err(|_| "effects")?;
    // Reservation ceiling, not expected charge. Exact provider usage shares
    // this original bounded policy reservation across the whole Work run.
    let budget = AgentRunBudget::try_new(operations, 100_000, 100_000, 1).map_err(|_| "budget")?;
    let node = AgentPlanNodeId::generate();
    let authority = AgentPlanNodeAuthority::try_new(
        vec![identity.profile()],
        vec![account],
        vec![origin.clone()],
        SemanticSensitivity::Public,
        effects,
    )
    .map_err(|_| "authority")?;
    let (issued, expires) = authority_window(deadline)?;
    let manifest = AgentRunManifest::try_new(
        AgentRunManifestId::generate(),
        identity.owner(),
        AgentRunScope::try_new(
            vec![identity.profile()],
            vec![account],
            vec![origin],
            SemanticSensitivity::Public,
            effects,
            Vec::new(),
        )
        .map_err(|_| "scope")?,
        budget,
        issued,
        expires,
        vec![AgentPlanNodeScope::new(node, authority, budget, expires)],
    )
    .map_err(|_| "manifest")?;
    let ids = TerraControllerIds::try_new(
        AgentSupervisorId::new(1).ok_or("id")?,
        AgentSupervisorAttemptId::new(1).ok_or("id")?,
        AgentSupervisorCancellationId::new(1).ok_or("id")?,
        AgentModelCallId::new(1).ok_or("id")?,
        [1, 2, 3, 4].map(|id| AgentAuditEventId::new(id).expect("fixed nonzero ID")),
        AgentAuditDeliveryId::new(1).ok_or("id")?,
    )
    .map_err(|_| "ids")?;
    let settings = AgentWorkRunSettings::new(
        AgentBrowserModel::Luna,
        ids,
        Arc::new(NativeWorkClock),
        deadline,
    )
    .with_max_model_calls(max_model_calls)
    .map_err(|_| "settings")?;
    AgentWorkRunInput::try_new(
        manifest,
        AgentPlanLeaseBinding::new(AgentPlanLeaseId::generate(), node),
        AgentWorkContextSpec::try_new_with_document_policy(
            identity,
            storage,
            target,
            WorkBrowserDocumentPolicy::Exact,
        )
        .map_err(|_| "context")?,
        objective.into(),
        settings,
    )
    .map_err(|_| "input")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_target_accepts_only_an_exact_notion_page() {
        let accepted = parse_target(
            "https://app.notion.com/p/Neuxie-Agent-Qualification-0123456789abcdef0123456789abcdef",
        )
        .unwrap();
        let url = accepted.as_url();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("app.notion.com"));
        assert_ne!(url.path(), "/");
        for refused in [
            "http://www.notion.com/page",
            "https://notion.com/page",
            "https://www.notion.so/page",
            "https://www.notion.com/page",
            "https://app.notion.com/",
            "https://app.notion.com/page?copy=true",
            "https://app.notion.com/page#fragment",
            "https://user@app.notion.com/page",
        ] {
            assert!(
                parse_target(refused).is_err(),
                "unexpected target: {refused}"
            );
        }
    }
}
