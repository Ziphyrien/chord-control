//! Hidden claims combine; releasing one plugin must not undo another plugin's request.
#[derive(Clone, Default)]
pub(crate) struct Visibility {
    pub tray_hidden: bool,
    pub taskbar_hidden: bool,
}
impl Visibility {
    pub fn combined<'a>(claims: impl Iterator<Item = &'a Self>) -> (bool, bool) {
        claims.fold((true, true), |(tray, taskbar), claim| {
            (tray && !claim.tray_hidden, taskbar && !claim.taskbar_hidden)
        })
    }
}
#[cfg(test)]
mod tests {
    use super::Visibility;
    #[test]
    fn independent_claims_release_without_restoring_other_owners() {
        let tray = Visibility {
            tray_hidden: true,
            taskbar_hidden: false,
        };
        let taskbar = Visibility {
            tray_hidden: false,
            taskbar_hidden: true,
        };
        assert_eq!(
            Visibility::combined([&tray, &taskbar].into_iter()),
            (false, false)
        );
        assert_eq!(Visibility::combined([&taskbar].into_iter()), (true, false));
        assert_eq!(Visibility::combined([].into_iter()), (true, true));
    }
}
