//! A starting point: rules live in Rust, and the page calls them through a command.

/// Scores a tap, without letting the score overflow.
#[tauri::command]
fn add_point(score: u32) -> u32 {
    score.saturating_add(1)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![add_point])
        .run(tauri::generate_context!())
        .expect("error while running the app");
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
