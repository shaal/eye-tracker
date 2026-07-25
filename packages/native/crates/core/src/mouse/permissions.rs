//! OS permission checks (ADR-0011).

/// Whether this process may synthesize input events that reach other
/// applications.
///
/// On macOS this is the Accessibility authorization. It matters that we check
/// it rather than infer it from a failure: without permission, `CGEventPost`
/// **silently succeeds and does nothing**. A user would see a frozen cursor and
/// no error anywhere.
///
/// `prompt = true` asks the OS to show the "open System Settings" dialog. Only
/// pass true in response to a user action.
pub fn has_input_permission(prompt: bool) -> bool {
    imp::is_trusted(prompt)
}

#[cfg(target_os = "macos")]
mod imp {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::{CFString, CFStringRef};

    unsafe extern "C" {
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    pub fn is_trusted(prompt: bool) -> bool {
        unsafe {
            let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
            let value = CFBoolean::from(prompt);
            let options =
                CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);
            AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef())
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    /// Windows and X11 do not gate synthesized input behind a per-app grant.
    pub fn is_trusted(_prompt: bool) -> bool {
        true
    }
}
