//! Clock-driven policy. Only the supervisor's retained Child may be restarted.
use serde::{Deserialize, Serialize};
use std::{ffi::CString, os::unix::ffi::OsStrExt, path::Path};
const GIB: u64 = 1 << 30;
const GRACE: u128 = 120_000;
const PROJECTION_OUTAGE_LIMIT: u128 = 10 * 60_000;
const NOTIFICATION_COOLDOWN: u128 = 30 * 60_000;
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeLevel {
    #[default]
    Recovery,
    Outage,
    Manual,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EscalationNotice {
    level: NoticeLevel,
    at: u128,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    pub condition: String,
    pub cause: String,
    pub action: String,
    pub since: u128,
    pub escalated: bool,
    #[serde(default)]
    pub notified_at: Option<u128>,
    #[serde(default)]
    pub notify_after: u128,
    #[serde(default)]
    pub notice_level: NoticeLevel,
    #[serde(default)]
    pub notified_level: Option<NoticeLevel>,
}
impl Condition {
    pub fn reserve_notice(&mut self, now: u128) {
        self.notified_at = Some(now);
        self.notified_level = Some(self.notice_level);
    }
    pub fn delivery_matches(&self, since: u128, level: NoticeLevel) -> bool {
        self.since == since && self.notice_level == level && self.notified_level == Some(level)
    }
    pub fn delivery_failed(&mut self, now: u128) {
        self.notified_at = None;
        self.notified_level = None;
        self.notify_after = now + 300_000;
    }
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Sweep {
    pub conditions: Vec<Condition>,
    attempts: u32,
    next_restart: u128,
    last_restart: Option<u128>,
    #[serde(skip)]
    initial_child_started_at: Option<u128>,
    #[serde(skip)]
    restart_before_decision: Option<u128>,
    ready_since: Option<u128>,
    last_notifications: std::collections::BTreeMap<String, u128>,
    last_escalation_notifications: std::collections::BTreeMap<String, EscalationNotice>,
}
impl Sweep {
    pub fn observe_all(&mut self, now: u128, observation: &Observation) -> bool {
        let disk = observation.disk;

        if let Some((free, total)) = disk {
            let level = disk_level(Some((free, total)));
            let critical = level == 2;
            let low = level > 0;
            self.update(
                "disk",
                low.then(|| {
                    (
                        format!(
                            "{} disk space: {} MiB available",
                            if critical { "critical" } else { "low" },
                            free >> 20
                        ),
                        "Free disk space; inspect Scout logs before removing user data",
                        true,
                    )
                }),
                now,
            );
        }
        if disk.is_some() {
            if let Some(condition) = self.conditions.iter_mut().find(|c| c.condition == "disk") {
                if !observation.top_consumers.is_empty() {
                    condition.cause.push_str(&format!(
                        "; Scout top consumers: {}",
                        observation.top_consumers.join(", ")
                    ));
                }
            }
        }
        for (id, service, grace) in [
            ("web", &observation.web, 90_000),
            ("relay", &observation.relay, 90_000),
        ] {
            if let Some(service) = service {
                self.finding(
                    id,
                    service.expected && !service.running,
                    &service.cause,
                    &service.action,
                    now,
                    grace,
                );
            }
        }
        if let Some(findings) = &observation.slow {
            for id in ["version-skew", "stale-files", "temp-orphans"] {
                let finding = findings.iter().find(|f| f.id == id);
                self.finding(
                    id,
                    finding.is_some(),
                    finding.map(|f| f.cause.as_str()).unwrap_or(""),
                    finding.map(|f| f.action.as_str()).unwrap_or(""),
                    now,
                    0,
                );
            }
        }
        let value = observation
            .health
            .as_deref()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
        let startup = value.as_ref().and_then(|v| v.get("startup"));
        let ready = startup
            .and_then(|s| s.get("mutationsAdmitted"))
            .and_then(|v| v.as_bool())
            == Some(true);
        if ready {
            self.update("startup-projection", None, now);
            let since = *self.ready_since.get_or_insert(now);
            // A momentarily ready child must not replenish its restart budget.
            if now.saturating_sub(since) >= 300_000 {
                self.attempts = 0;
                self.next_restart = 0;
            }
            return false;
        }
        self.ready_since = None;
        let overdue = self.projection_outage_due(now);
        let space = disk
            .map(|(free, total)| free >= 2 * GIB && total > 0)
            .unwrap_or(false);
        if startup
            .and_then(|s| s.get("phase"))
            .and_then(|v| v.as_str())
            != Some("degraded")
        {
            // Unknown health cannot replace the actionable disk-latch notice.
            // Once its restart is spent, an unready successor must still alert.
            let waiting_for_space = !space
                && self.attempts == 0
                && self.conditions.iter().any(|c| {
                    c.condition == "startup-projection" && projection_disk_failure(&c.cause)
                });
            if overdue && !waiting_for_space {
                self.escalate_projection(now, NoticeLevel::Outage,
                "Inspect Scout startup and supervisor logs; Scout has not become mutation-ready after 10 minutes");
            }
            return false;
        }
        let cause = startup
            .and_then(|s| s.get("error"))
            .and_then(|v| v.as_str())
            .unwrap_or("Startup projection is unavailable")
            .to_owned();
        let disk_failure = projection_disk_failure(&cause);
        let exhausted = self.attempts >= if disk_failure { 1 } else { 3 }
            || self.conditions.iter().any(|c| {
                c.condition == "startup-projection" && c.notice_level == NoticeLevel::Manual
            });
        let action = if exhausted {
            "Repair the startup projection cause, then restart Scout"
        } else if disk_failure && !space {
            "Free at least 2 GiB disk space; Scout will restart its owned base child"
        } else {
            "Scout will restart its owned base child after the startup grace period"
        };
        self.update(
            "startup-projection",
            Some((cause, action, exhausted || (disk_failure && !space))),
            now,
        );
        if exhausted {
            self.escalate_projection(now, NoticeLevel::Manual, action);
        }
        let since = self
            .conditions
            .iter()
            .find(|c| c.condition == "startup-projection")
            .unwrap()
            .since;
        if exhausted
            || (disk_failure && !space)
            || now.saturating_sub(since) < GRACE
            || now < self.next_restart
        {
            if !exhausted && overdue && (!disk_failure || space) {
                self.escalate_projection(now, NoticeLevel::Outage,
                    "Inspect Scout startup and supervisor logs; Scout will continue bounded recovery when possible");
            }
            return false;
        }
        // Give the successor its own readiness window. Never issue an outage
        // notice in the same pass that initiates automatic recovery.
        self.restart_before_decision = self.last_restart;
        self.last_restart = Some(now);
        self.attempts += 1;
        self.next_restart = now + (GRACE << (self.attempts - 1));
        true
    }
    pub fn base_started(&mut self, now: u128) {
        // Register only the first child in this supervisor lifetime. A restored
        // checkpoint gets a boot window, but crash respawns cannot slide it.
        self.initial_child_started_at.get_or_insert(now);
    }
    fn projection_outage_due(&self, now: u128) -> bool {
        self.conditions
            .iter()
            .find(|c| c.condition == "startup-projection")
            .is_some_and(|c| {
                let anchor = c
                    .since
                    .max(self.last_restart.unwrap_or(0))
                    .max(self.initial_child_started_at.unwrap_or(0));
                now.saturating_sub(anchor) >= PROJECTION_OUTAGE_LIMIT
            })
    }
    #[cfg(test)]
    pub fn observe(&mut self, now: u128, health: Option<&str>, disk: Option<(u64, u64)>) -> bool {
        self.observe_all(
            now,
            &Observation {
                health: health.map(str::to_owned),
                disk,
                ..Observation::default()
            },
        )
    }
    fn escalate_projection(&mut self, now: u128, level: NoticeLevel, action: &str) {
        // A lower-level notice or brief ready sample cannot cool down a new
        // escalation. Repeat notices at the same/lower level remain suppressed.
        let previous = self
            .conditions
            .iter()
            .find(|c| c.condition == "startup-projection" && c.notice_level < level)
            .and_then(|c| {
                c.notified_at
                    .map(|at| (at, c.notified_level.unwrap_or_default()))
            });
        if let Some((at, level)) = previous {
            self.remember_notice("startup-projection", at, level);
        }
        let after = self
            .last_escalation_notifications
            .get("startup-projection")
            .filter(|last| last.level >= level)
            .map_or(now, |last| {
                now.max(last.at.saturating_add(NOTIFICATION_COOLDOWN))
            });
        if let Some(c) = self
            .conditions
            .iter_mut()
            .find(|c| c.condition == "startup-projection")
        {
            if c.notice_level <= level {
                if c.notice_level < level {
                    c.notice_level = level;
                    c.notify_after = after;
                }
                c.action = action.into();
            }
            c.escalated = true;
        }
    }
    fn finding(
        &mut self,
        id: &str,
        active: bool,
        cause: &str,
        action: &str,
        now: u128,
        grace: u128,
    ) {
        if !active {
            self.clear(id);
            return;
        }
        if let Some(c) = self.conditions.iter_mut().find(|c| c.condition == id) {
            c.cause = cause.chars().take(2048).collect();
            c.action = action.chars().take(2048).collect();
        } else {
            self.conditions.push(Condition {
                condition: id.into(),
                cause: cause.chars().take(2048).collect(),
                action: action.chars().take(2048).collect(),
                since: now,
                escalated: true,
                notified_at: None,
                notice_level: NoticeLevel::Recovery,
                notified_level: None,
                notify_after: self.notification_time(id, now + grace),
            });
        }
    }
    /// A decision is not an attempt until its checkpoint can be published.
    pub fn defer_restart(&mut self, now: u128) {
        self.attempts = self.attempts.saturating_sub(1);
        self.last_restart = self.restart_before_decision.take();
        self.next_restart = now + GRACE;
    }
    pub fn due_notifications(&self, now: u128) -> Vec<String> {
        let outage_due = self.projection_outage_due(now);
        self.conditions
            .iter()
            .filter(|c| {
                (c.notice_level != NoticeLevel::Outage || outage_due)
                    && c.escalated
                    && now >= c.notify_after
                    && (c.notified_at.is_none()
                        || c.notice_level > c.notified_level.unwrap_or_default())
            })
            .map(|c| c.condition.clone())
            .collect()
    }
    fn notification_time(&self, id: &str, after: u128) -> u128 {
        self.last_notifications.get(id).map_or(after, |last| {
            after.max(last.saturating_add(NOTIFICATION_COOLDOWN))
        })
    }
    fn remember_notice(&mut self, id: &str, at: u128, level: NoticeLevel) {
        self.last_notifications.insert(id.into(), at);
        if level > NoticeLevel::Recovery {
            self.last_escalation_notifications
                .insert(id.into(), EscalationNotice { level, at });
        }
    }
    fn clear(&mut self, id: &str) {
        if let Some(index) = self.conditions.iter().position(|c| c.condition == id) {
            let c = self.conditions.remove(index);
            if let Some(at) = c.notified_at {
                self.remember_notice(id, at, c.notified_level.unwrap_or_default());
            }
        }
    }
    fn update(&mut self, id: &str, value: Option<(String, &str, bool)>, now: u128) {
        let index = self.conditions.iter().position(|c| c.condition == id);
        match (index, value) {
            (Some(i), Some((cause, action, escalated))) => {
                let c = &mut self.conditions[i];
                c.cause = cause.chars().take(2048).collect();
                c.action = action.chars().take(2048).collect();
                c.escalated = escalated;
            }
            (None, Some((cause, action, escalated))) => self.conditions.push(Condition {
                condition: id.into(),
                cause: cause.chars().take(2048).collect(),
                action: action.chars().take(2048).collect(),
                since: now,
                escalated,
                notified_at: None,
                notice_level: NoticeLevel::Recovery,
                notified_level: None,
                notify_after: self.notification_time(
                    id,
                    now + if id == "startup-projection" {
                        GRACE
                    } else {
                        60_000
                    },
                ),
            }),
            (Some(_), None) => self.clear(id),
            _ => {}
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct Observation {
    pub health: Option<String>,
    pub disk: Option<(u64, u64)>,
    pub web: Option<ServiceObservation>,
    pub relay: Option<ServiceObservation>,
    pub top_consumers: Vec<String>,
    pub slow: Option<Vec<Finding>>,
}
#[derive(Clone, Debug, Default)]
pub struct ServiceObservation {
    pub expected: bool,
    pub running: bool,
    pub cause: String,
    pub action: String,
}
#[derive(Clone, Debug)]
pub struct Finding {
    pub id: String,
    pub cause: String,
    pub action: String,
}
pub fn disk_level(disk: Option<(u64, u64)>) -> u8 {
    match disk {
        Some((free, total)) if free < GIB.max((total / 50).min(2 * GIB)) => 2,
        Some((free, total)) if free < (2 * GIB).max((total / 20).min(10 * GIB)) => 1,
        _ => 0,
    }
}
/// Constant cost: no recursive directory walks.
pub fn disk_space(path: &Path) -> Option<(u64, u64)> {
    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return None;
    }
    let s = unsafe { stats.assume_init() };
    Some((
        (s.f_bavail as u64).saturating_mul(s.f_frsize as u64),
        (s.f_blocks as u64).saturating_mul(s.f_frsize as u64),
    ))
}
fn projection_disk_failure(cause: &str) -> bool {
    let lower = cause.to_ascii_lowercase();
    [
        "sqlite_full",
        "enospc",
        "database or disk is full",
        "no space left",
    ]
    .iter()
    .any(|s| lower.contains(s))
}
#[cfg(test)]
mod tests {
    use super::*;
    const FULL: &str = r#"{"startup":{"phase":"degraded","error":"database or disk is full"}}"#;
    const OTHER: &str = r#"{"startup":{"phase":"degraded","error":"schema failed"}}"#;
    const READY: &str = r#"{"startup":{"mutationsAdmitted":true}}"#;
    const SPACE: Option<(u64, u64)> = Some((10 * GIB, 100 * GIB));
    #[test]
    fn crash_respawns_cannot_postpone_an_open_projection_outage() {
        for sweep_restart in [false, true] {
            let mut s = Sweep::default();
            s.base_started(0);
            s.observe(0, Some(OTHER), SPACE);
            let anchor = if sweep_restart {
                assert!(s.observe(120_000, Some(OTHER), SPACE));
                120_000
            } else {
                0
            };
            for now in (anchor + 30_000..=anchor + PROJECTION_OUTAGE_LIMIT).step_by(30_000) {
                // Even an accidental repeated startup registration must not
                // give each crashing child a fresh outage window.
                s.base_started(now);
                assert!(!s.observe(now, None, SPACE));
                if now < anchor + PROJECTION_OUTAGE_LIMIT {
                    assert!(s.due_notifications(now).is_empty());
                }
            }
            assert_eq!(
                s.due_notifications(anchor + PROJECTION_OUTAGE_LIMIT),
                vec!["startup-projection"],
                "30-second crash respawns must not slide the outage deadline"
            );
        }
    }
    #[test]
    fn unknown_health_keeps_the_disk_latch_notice_until_recovery_can_start() {
        let low = Some((GIB, 100 * GIB));
        let mut s = Sweep::default();
        s.observe(0, Some(FULL), low);
        for c in &mut s.conditions {
            c.reserve_notice(120_000);
        }
        let mut s: Sweep = serde_json::from_slice(&serde_json::to_vec(&s).unwrap()).unwrap();
        assert!(!s.observe(660_000, None, low));
        let c = s
            .conditions
            .iter()
            .find(|c| c.condition == "startup-projection")
            .unwrap();
        assert_eq!(c.notice_level, NoticeLevel::Recovery);
        assert!(c.action.starts_with("Free at least 2 GiB"));
        assert!(s.due_notifications(660_000).is_empty());
        assert!(s.observe(690_000, Some(FULL), SPACE));
        assert!(s.due_notifications(690_000).is_empty());
        s.observe(1_289_999, None, SPACE);
        assert!(s.due_notifications(1_289_999).is_empty());
        // Falling below the threshold again cannot mask the failed successor.
        s.observe(1_290_000, None, low);
        assert_eq!(s.due_notifications(1_290_000), vec!["startup-projection"]);

        let mut s = Sweep::default();
        s.observe(0, Some(OTHER), low);
        for c in &mut s.conditions {
            c.reserve_notice(120_000);
        }
        s.observe(660_000, None, low);
        assert_eq!(s.due_notifications(660_000), vec!["startup-projection"]);
    }
    #[test]
    fn long_disk_full_recovery_is_silent_when_the_late_restart_succeeds() {
        let mut s = Sweep::default();
        s.observe(0, Some(FULL), Some((0, 100 * GIB)));
        s.observe(120_000, Some(FULL), Some((0, 100 * GIB)));
        s.conditions
            .iter_mut()
            .find(|c| c.condition == "startup-projection")
            .unwrap()
            .reserve_notice(120_000);
        assert!(s.observe(660_000, Some(FULL), SPACE));
        assert!(
            s.due_notifications(660_000).is_empty(),
            "starting recovery must not produce an outage notice"
        );
        assert!(!s.observe(690_000, None, SPACE));
        assert!(s.due_notifications(690_000).is_empty());
        s.observe(720_000, Some(READY), SPACE);
        assert!(s.conditions.is_empty());
        assert!(s.due_notifications(720_000).is_empty());
    }
    #[test]
    fn new_child_defers_old_and_already_pending_outage_notices() {
        for pending_outage in [false, true] {
            let mut s = Sweep::default();
            s.observe(0, Some(OTHER), SPACE);
            assert!(s.observe(120_000, Some(OTHER), SPACE));
            if pending_outage {
                s.observe(720_000, None, SPACE);
                assert_eq!(s.due_notifications(720_000), vec!["startup-projection"]);
            }
            let mut s: Sweep = serde_json::from_slice(&serde_json::to_vec(&s).unwrap()).unwrap();
            s.base_started(900_000);
            s.observe(900_000, None, SPACE);
            assert!(s.due_notifications(900_000).is_empty());
            s.observe(1_499_999, None, SPACE);
            assert!(s.due_notifications(1_499_999).is_empty());
            s.observe(1_500_000, None, SPACE);
            assert_eq!(s.due_notifications(1_500_000), vec!["startup-projection"]);
        }
    }
    #[test]
    fn failed_restart_checkpoint_does_not_reset_the_outage_deadline() {
        let mut s = Sweep::default();
        s.observe(0, Some(OTHER), SPACE);
        assert!(s.observe(120_000, Some(OTHER), SPACE));
        s.defer_restart(120_000);
        s.observe(600_000, None, SPACE);
        assert_eq!(s.due_notifications(600_000), vec!["startup-projection"]);
        assert_eq!(s.last_restart, None);
    }
    #[test]
    fn projection_outage_escalates_after_ten_minutes_without_a_degraded_sample() {
        for health in [
            None,
            Some("not-json"),
            Some(r#"{"startup":{"phase":"failed"}}"#),
            Some(r#"{"startup":{"phase":"restoring"}}"#),
        ] {
            let mut s = Sweep::default();
            s.observe(0, Some(OTHER), SPACE);
            assert!(s.observe(120_000, Some(OTHER), SPACE));
            let mut s: Sweep = serde_json::from_slice(&serde_json::to_vec(&s).unwrap()).unwrap();
            assert!(!s.observe(719_999, health, SPACE));
            assert!(s.due_notifications(719_999).is_empty());
            assert!(!s.observe(720_000, health, SPACE));
            assert_eq!(s.due_notifications(720_000), vec!["startup-projection"]);
            let c = s
                .conditions
                .iter_mut()
                .find(|c| c.condition == "startup-projection")
                .unwrap();
            assert!(c.action.contains("Inspect"));
            c.reserve_notice(720_000);
            assert!(!s.observe(750_000, health, SPACE));
            assert!(s.due_notifications(750_000).is_empty());
        }
    }
    #[test]
    fn exhausted_projection_gets_a_new_notice_after_the_space_notice() {
        let mut s = Sweep::default();
        s.observe(0, Some(FULL), Some((0, 100 * GIB)));
        s.observe(120_000, Some(FULL), Some((0, 100 * GIB)));
        assert!(s
            .due_notifications(120_000)
            .contains(&"startup-projection".into()));
        s.conditions
            .iter_mut()
            .find(|c| c.condition == "startup-projection")
            .unwrap()
            .notified_at = Some(120_000);
        // Old checkpoints reserved only a timestamp, with no action level.
        let mut old = serde_json::to_value(&s).unwrap();
        for c in old["conditions"].as_array_mut().unwrap() {
            c.as_object_mut().unwrap().remove("noticeLevel");
            c.as_object_mut().unwrap().remove("notifiedLevel");
        }
        old.as_object_mut()
            .unwrap()
            .remove("lastEscalationNotifications");
        let mut s: Sweep = serde_json::from_value(old).unwrap();
        assert!(s.observe(150_000, Some(FULL), SPACE));
        assert!(!s.observe(180_000, Some(FULL), SPACE));
        let s: Sweep = serde_json::from_slice(&serde_json::to_vec(&s).unwrap()).unwrap();
        assert_eq!(s.due_notifications(180_000), vec!["startup-projection"]);
        assert!(s.conditions[0].action.contains("Repair"));
    }
    #[test]
    fn brief_readiness_does_not_cool_down_a_new_manual_action() {
        let mut s = Sweep::default();
        s.observe(0, Some(FULL), Some((0, 100 * GIB)));
        s.observe(120_000, Some(FULL), Some((0, 100 * GIB)));
        s.conditions
            .iter_mut()
            .find(|c| c.condition == "startup-projection")
            .unwrap()
            .notified_at = Some(120_000);
        assert!(s.observe(150_000, Some(FULL), SPACE));
        s.observe(160_000, Some(READY), SPACE);
        assert!(!s.observe(180_000, Some(FULL), SPACE));
        assert_eq!(s.due_notifications(180_000), vec!["startup-projection"]);
    }
    #[test]
    fn manual_notice_is_reserved_once_and_old_delivery_results_cannot_delay_it() {
        let mut s = Sweep::default();
        s.observe(0, Some(FULL), Some((0, 100 * GIB)));
        s.observe(120_000, Some(FULL), Some((0, 100 * GIB)));
        s.conditions
            .iter_mut()
            .find(|c| c.condition == "startup-projection")
            .unwrap()
            .reserve_notice(120_000);
        assert!(s.observe(150_000, Some(FULL), SPACE));
        s.observe(180_000, Some(FULL), SPACE);
        let c = s
            .conditions
            .iter_mut()
            .find(|c| c.condition == "startup-projection")
            .unwrap();
        assert!(!c.delivery_matches(0, NoticeLevel::Recovery));
        c.reserve_notice(180_000);
        assert!(c.delivery_matches(0, NoticeLevel::Manual));
        assert!(!c.delivery_matches(1, NoticeLevel::Manual));
        let mut s: Sweep = serde_json::from_slice(&serde_json::to_vec(&s).unwrap()).unwrap();
        assert!(s.due_notifications(180_001).is_empty());
        s.observe(190_000, Some(READY), SPACE);
        s.observe(200_000, Some(FULL), SPACE);
        assert!(s.due_notifications(200_000).is_empty());
        assert_eq!(
            s.due_notifications(180_000 + NOTIFICATION_COOLDOWN),
            vec!["startup-projection"]
        );
    }
    #[test]
    fn outage_notice_does_not_consume_the_later_manual_notice_or_restart_budget() {
        let mut s = Sweep::default();
        s.observe(0, Some(OTHER), SPACE);
        assert!(s.observe(120_000, Some(OTHER), SPACE));
        s.observe(720_000, None, SPACE);
        assert_eq!(s.conditions[0].notice_level, NoticeLevel::Outage);
        s.conditions[0].reserve_notice(720_000);
        assert!(s.observe(750_000, Some(OTHER), SPACE));
        assert!(s.due_notifications(750_000).is_empty());
        assert!(s.observe(990_000, Some(OTHER), SPACE));
        assert!(!s.observe(1_020_000, Some(OTHER), SPACE));
        assert_eq!(s.conditions[0].notice_level, NoticeLevel::Manual);
        assert_eq!(s.due_notifications(1_020_000), vec!["startup-projection"]);
    }
    #[test]
    fn disk_recovery_still_restarts_when_space_returns_after_ten_minutes() {
        let mut s = Sweep::default();
        s.observe(0, Some(FULL), Some((0, 100 * GIB)));
        s.observe(600_000, Some(FULL), Some((0, 100 * GIB)));
        assert!(s.observe(900_000, Some(FULL), SPACE));
    }
    #[test]
    fn self_healing_projection_never_notifies_and_exhaustion_does() {
        let mut s = Sweep::default();
        s.observe(0, Some(OTHER), SPACE);
        assert!(s.observe(120_000, Some(OTHER), SPACE));
        assert!(s.due_notifications(120_000).is_empty());
        s.observe(150_000, Some(READY), SPACE);
        assert!(s.due_notifications(150_000).is_empty());
        let mut s = Sweep::default();
        for now in [0, 120_000, 240_000, 480_000] {
            s.observe(now, Some(OTHER), SPACE);
        }
        assert!(s.due_notifications(480_000).is_empty());
        s.observe(510_000, Some(OTHER), SPACE);
        assert_eq!(s.due_notifications(510_000), vec!["startup-projection"]);
        let mut s = Sweep::default();
        s.observe(0, Some(FULL), Some((0, 1000 * GIB)));
        s.observe(120_000, Some(FULL), Some((0, 1000 * GIB)));
        assert!(s
            .due_notifications(120_000)
            .contains(&"startup-projection".into()));
    }
    #[test]
    fn large_disk_thresholds_are_capped_and_two_gib_allows_recovery() {
        for total in [228 * GIB, 1000 * GIB] {
            assert_eq!(disk_level(Some((11 * GIB, total))), 0);
            assert_eq!(disk_level(Some((3 * GIB, total))), 1);
            assert_eq!(disk_level(Some((GIB, total))), 2);
            let mut s = Sweep::default();
            s.observe(0, Some(FULL), Some((GIB, total)));
            assert!(s.observe(120_000, Some(FULL), Some((3 * GIB, total))));
        }
    }
    #[test]
    fn flapping_conditions_keep_a_persisted_notification_cooldown() {
        for id in ["disk", "web", "relay", "version-skew"] {
            let mut s = Sweep::default();
            s.finding(id, true, "cause", "action", 0, 60_000);
            assert_eq!(s.due_notifications(60_000), vec![id]);
            s.conditions[0].notified_at = Some(60_000);
            s.finding(id, false, "", "", 90_000, 60_000);
            assert!(s.conditions.is_empty());
            let bytes = serde_json::to_vec(&s).unwrap();
            let mut s: Sweep = serde_json::from_slice(&bytes).unwrap();
            s.finding(id, true, "cause", "action", 120_000, 60_000);
            assert!(s.due_notifications(180_000).is_empty());
            assert_eq!(
                s.due_notifications(60_000 + NOTIFICATION_COOLDOWN),
                vec![id]
            );
        }
    }
    #[test]
    fn epoch_clock_ages_incidents_across_sleep_and_supervisor_restart() {
        let epoch = 1_800_000_000_000;
        let mut s = Sweep::default();
        s.observe(epoch, Some(OTHER), SPACE);
        let mut s: Sweep = serde_json::from_slice(&serde_json::to_vec(&s).unwrap()).unwrap();
        assert!(s.observe(epoch + 3_600_000, Some(OTHER), SPACE));
        assert_eq!(s.conditions[0].since, epoch);
    }
    #[test]
    fn disk_recovery_waits_for_space_and_restarts_once() {
        let mut s = Sweep::default();
        assert!(!s.observe(0, Some(FULL), Some((0, 100 * GIB))));
        assert!(!s.observe(120_000, Some(FULL), None));
        assert!(s.observe(120_001, Some(FULL), SPACE));
        assert!(!s.observe(500_000, Some(FULL), SPACE));
        assert!(s.conditions[0].escalated);
        s.observe(500_001, Some(READY), SPACE);
        assert!(s.conditions.is_empty());
    }
    #[test]
    fn other_errors_have_bounded_exponential_backoff() {
        let mut s = Sweep::default();
        s.observe(0, Some(OTHER), SPACE);
        for (now, restart) in [
            (119_999, false),
            (120_000, true),
            (239_999, false),
            (240_000, true),
            (479_999, false),
            (480_000, true),
            (960_000, false),
        ] {
            assert_eq!(s.observe(now, Some(OTHER), SPACE), restart);
        }
        assert!(s.conditions[0].escalated);
        s.observe(960_001, Some(READY), SPACE);
        assert!(s.conditions.is_empty());
    }
    #[test]
    fn unreachable_or_briefly_ready_does_not_replenish_budget() {
        let mut s = Sweep::default();
        s.observe(0, Some(FULL), SPACE);
        assert!(s.observe(120_000, Some(FULL), SPACE));
        s.observe(130_000, None, SPACE);
        assert_eq!(s.conditions.len(), 1);
        s.observe(140_000, Some(READY), SPACE);
        assert!(!s.observe(500_000, Some(FULL), SPACE));
        assert!(s.conditions[0].escalated);
    }
    #[test]
    fn failed_checkpoint_does_not_spend_the_restart_budget() {
        let mut s = Sweep::default();
        s.observe(0, Some(OTHER), SPACE);
        assert!(s.observe(120_000, Some(OTHER), SPACE));
        s.defer_restart(120_000);
        assert_eq!(s.attempts, 0);
        assert!(!s.observe(239_999, Some(OTHER), SPACE));
        assert!(s.observe(240_000, Some(OTHER), SPACE));
        assert_eq!(s.attempts, 1);
    }
    #[test]
    fn disk_detects_changes_and_clears_without_runtime() {
        let mut s = Sweep::default();
        s.observe(10, None, Some((4 * GIB, 100 * GIB)));
        assert!(s.conditions[0].cause.starts_with("low"));
        s.observe(20, None, Some((GIB, 100 * GIB)));
        assert_eq!(s.conditions[0].since, 10);
        assert!(s.conditions[0].cause.starts_with("critical"));
        s.observe(30, None, SPACE);
        assert!(s.conditions.is_empty());
    }
}
