use std::sync::{Mutex, MutexGuard};
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| {
        eprintln!("Recovered poisoned application state lock");
        mutex.clear_poison();
        error.into_inner()
    })
}
