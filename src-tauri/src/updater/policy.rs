use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Policy {
    pub interval_minutes: u64,
    pub auto_install: bool,
}
impl Policy {
    pub fn new(interval_minutes: u64, auto_install: bool) -> Option<Self> {
        (1..=1440).contains(&interval_minutes).then_some(Self {
            interval_minutes,
            auto_install,
        })
    }
    pub fn delay(self, failures: u32) -> Duration {
        let base = self.interval_minutes * 60;
        Duration::from_secs((base * (1u64 << failures.min(6))).min(base.max(3600)))
    }
}
#[cfg(test)]
mod tests {
    use super::Policy;
    #[test]
    fn retry_delays_are_bounded_and_preserve_long_user_intervals() {
        let policy = Policy::new(5, true).unwrap();
        assert!(policy.auto_install);
        assert_eq!(policy.delay(0).as_secs(), 300);
        assert_eq!(policy.delay(1).as_secs(), 600);
        assert_eq!(policy.delay(9).as_secs(), 3600);
        assert_eq!(Policy::new(1440, false).unwrap().delay(9).as_secs(), 86400);
        assert!(Policy::new(0, true).is_none());
        assert!(Policy::new(1441, true).is_none());
    }
}
