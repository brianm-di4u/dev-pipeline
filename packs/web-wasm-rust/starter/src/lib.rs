//! A starting point: the rules live in Rust, compiled to WASM, and the page calls them.
use wasm_bindgen::prelude::*;

/// Scores a tap, without letting the score overflow.
#[wasm_bindgen]
pub fn add_point(score: u32) -> u32 {
    score.saturating_add(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tap_scores_a_point() {
        assert_eq!(add_point(0), 1);
    }

    #[test]
    fn the_score_never_overflows() {
        assert_eq!(add_point(u32::MAX), u32::MAX);
    }
}
