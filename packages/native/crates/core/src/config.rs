//! Runtime-tunable configuration.
//!
//! Every constant in ADR-0007 and ADR-0008 lives here and is patchable at
//! runtime, so tuning never requires a Rust rebuild (ADR-0004).

/// How eyelid gestures map to clicks (ADR-0013).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClickMode {
    /// Both eyes closing together. One blink = left click, two = double click.
    Blink,
    /// One eye at a time. Left wink = left click, left double wink = double
    /// click, right wink = right click.
    ///
    /// Structurally far more robust than `Blink`, because a natural blink
    /// closes *both* eyes and is therefore rejected outright.
    Wink,
}

impl ClickMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ClickMode::Blink => "blink",
            ClickMode::Wink => "wink",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "blink" => Some(ClickMode::Blink),
            "wink" => Some(ClickMode::Wink),
            _ => None,
        }
    }
}

/// Cursor smoothing (ADR-0007).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FilterConfig {
    /// One Euro minimum cutoff, Hz. Lower = smoother at rest.
    pub min_cutoff: f64,
    /// One Euro speed coefficient. Higher = less lag when moving.
    pub beta: f64,
    /// Cutoff for the internal speed estimate, Hz.
    pub d_cutoff: f64,
    /// Jump distance that bypasses the filter entirely, in px at a nominal
    /// 1080p diagonal; scaled to the actual display diagonal at runtime.
    pub saccade_px: f64,
    /// Floor on the fixation clamp radius, px.
    pub clamp_radius: f64,
    /// Dwell before the clamp engages, ms.
    pub clamp_ms: f64,
    /// Hard timeout on the clamp. Without this, a stuck clamp reads to the user
    /// as a crashed application (risk R10).
    pub clamp_max_hold_ms: f64,
    /// Median pre-filter width (1, 3 or 5). A median removes the isolated
    /// landmark spikes that an exponential filter merely smears out over the
    /// following frames. Costs (n-1)/2 frames of latency.
    pub median_window: u32,
    /// Scale the clamp radius to measured gaze spread, so it engages for a
    /// noisy signal instead of never triggering.
    pub adaptive_clamp: bool,
    /// Clamp radius as a multiple of the measured spread (MAD).
    pub clamp_noise_scale: f64,
    /// Ceiling on the adaptive radius, so a bad tracking patch cannot freeze
    /// the cursor over a huge area.
    pub clamp_radius_max: f64,
}

impl Default for FilterConfig {
    fn default() -> Self {
        Self {
            min_cutoff: 0.6,
            beta: 0.007,
            d_cutoff: 1.0,
            saccade_px: 120.0,
            // Raised from the original 14 px: measured webcam gaze noise is
            // routinely larger than that, so the clamp never engaged and the
            // cursor never came to rest.
            clamp_radius: 22.0,
            clamp_ms: 110.0,
            clamp_max_hold_ms: 4000.0,
            median_window: 3,
            adaptive_clamp: true,
            clamp_noise_scale: 2.5,
            clamp_radius_max: 70.0,
        }
    }
}

/// Blink / wink detection and click synthesis (ADR-0008, ADR-0013).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BlinkConfig {
    pub mode: ClickMode,

    /// Closure score above which an eye counts as shut.
    pub close_thresh: f64,
    /// Closure score below which it counts as open. Deliberately lower than
    /// `close_thresh` — the gap is hysteresis.
    pub open_thresh: f64,

    // --- both-eye blink (ClickMode::Blink) ---
    /// Minimum closure to count as deliberate. **The primary defense against
    /// involuntary blinks firing clicks** (risk R1).
    pub min_close_ms: f64,
    /// Above this, the closure is a rest, not a click.
    pub max_close_ms: f64,

    // --- single-eye wink (ClickMode::Wink) ---
    /// A wink can be shorter than a deliberate blink needs to be, because the
    /// asymmetry requirement already rules out involuntary blinks.
    pub wink_min_close_ms: f64,
    /// Winks are often held longer than blinks, so this is generous.
    pub wink_max_close_ms: f64,
    /// How much more closed the winking eye must be than the other. This is
    /// what separates a wink from a blink: most people cannot wink without the
    /// other eye moving a little, so a plain "one eye shut, one open" test is
    /// too strict in practice.
    pub wink_asymmetry: f64,

    /// Window for a second gesture to mean double-click. Set to 0 to fire
    /// single clicks immediately and disable double-click.
    pub double_window_ms: f64,
    /// Dead time after any click.
    pub refractory_ms: f64,
    /// How far before gesture onset to look up the click position (ADR-0008).
    pub pre_blink_lookback_ms: f64,
    /// Use the geometric EAR fallback instead of blendshapes.
    pub use_geometric_fallback: bool,
    /// Resting openness ratio for the geometric fallback.
    pub rest_open_ratio: f64,
}

impl Default for BlinkConfig {
    fn default() -> Self {
        Self {
            mode: ClickMode::Blink,
            close_thresh: 0.55,
            open_thresh: 0.35,
            min_close_ms: 150.0,
            max_close_ms: 500.0,
            wink_min_close_ms: 120.0,
            wink_max_close_ms: 900.0,
            wink_asymmetry: 0.28,
            double_window_ms: 500.0,
            refractory_ms: 250.0,
            pre_blink_lookback_ms: 150.0,
            use_geometric_fallback: false,
            rest_open_ratio: 0.28,
        }
    }
}

/// Safety guards (ADR-0011). Defaults are deliberately conservative: every one
/// of these fails closed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GuardConfig {
    /// Minimum tracking confidence to drive the cursor.
    pub min_quality: f64,
    /// Continuous tracking required before control engages, ms.
    pub track_settle_ms: f64,
    /// A frame older than this suspends movement.
    pub max_frame_age_ms: f64,
    /// Dead time after enabling control, so toggling on cannot itself click.
    pub arming_ms: f64,
}

impl Default for GuardConfig {
    fn default() -> Self {
        Self {
            min_quality: 0.4,
            track_settle_ms: 300.0,
            max_frame_age_ms: 250.0,
            arming_ms: 300.0,
        }
    }
}

/// Yielding to a physical mouse or trackpad (ADR-0016).
///
/// This is a safety property as much as a convenience one: if the tracker is
/// misbehaving, grabbing the trackpad should take control back instantly,
/// without the user having to find a keyboard shortcut first.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TakeoverConfig {
    pub enabled: bool,
    /// How far the real cursor must diverge from where we last commanded it
    /// before we conclude something else moved it. Absorbs rounding and the
    /// occasional late frame.
    pub epsilon_px: f64,
    /// Gaze resumes after this long with no further physical movement.
    pub resume_after_ms: f64,
    /// When true, gaze does not resume on its own — the user must re-enable it
    /// explicitly. Safer, but more friction.
    pub require_manual_resume: bool,
}

impl Default for TakeoverConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            epsilon_px: 8.0,
            resume_after_ms: 1500.0,
            require_manual_resume: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EngineConfig {
    pub filter: FilterConfig,
    pub blink: BlinkConfig,
    pub guard: GuardConfig,
    pub takeover: TakeoverConfig,
    /// Pixels per degree of visual angle, for reporting calibration accuracy in
    /// familiar units. Default assumes ~110 PPI at ~600 mm viewing distance.
    pub px_per_degree: f64,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            filter: FilterConfig::default(),
            blink: BlinkConfig::default(),
            guard: GuardConfig::default(),
            takeover: TakeoverConfig::default(),
            px_per_degree: 45.0,
        }
    }
}
