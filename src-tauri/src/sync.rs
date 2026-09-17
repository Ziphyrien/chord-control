//! Small, explicit coordination primitives shared by process owners.
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // State transitions install complete values while holding the lock. Poison is reported,
    // never silently cleared; callers can still cancel resources after an unrelated panic.
    mutex.lock().unwrap_or_else(|error| {
        eprintln!("Recovering application lock after panic");
        error.into_inner()
    })
}

#[derive(Clone, Default)]
pub(crate) struct Cancellation(Arc<(Mutex<bool>, Condvar)>);
impl Cancellation {
    pub fn cancel(&self) {
        let (state, wake) = &*self.0;
        *lock(state) = true;
        wake.notify_all();
    }
    pub fn is_cancelled(&self) -> bool {
        *lock(&self.0 .0)
    }
    /// Returns false when cancelled, including cancellation before this wait starts.
    pub fn wait(&self, duration: Duration) -> bool {
        let (state, wake) = &*self.0;
        let result = wake
            .wait_timeout_while(lock(state), duration, |cancelled| !*cancelled)
            .unwrap_or_else(|error| error.into_inner());
        !*result.0
    }
}

/// Five consecutive failures are terminal even when each launch/acknowledgement is slow.
/// Only an observed healthy minute replenishes the peer budget.
#[derive(Default)]
pub(crate) struct RestartBudget {
    attempts: u32,
    healthy_since: Option<Instant>,
}
impl RestartBudget {
    pub fn next(&mut self) -> Option<Duration> {
        self.healthy_since = None;
        if self.attempts >= 5 {
            return None;
        }
        let delay = Duration::from_secs(1 << self.attempts);
        self.attempts += 1;
        Some(delay)
    }
    pub fn healthy(&mut self) {
        let since = self.healthy_since.get_or_insert_with(Instant::now);
        if since.elapsed() >= Duration::from_secs(60) {
            self.attempts = 0;
        }
    }
}
