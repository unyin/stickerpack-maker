//! Pack operations and Title / Short Name validation (SPEC §3, §7).

/// Validate a Title: free text, 1–64 characters after trimming (SPEC §7).
/// Returns the trimmed Title to store.
pub fn validate_title(title: &str) -> Result<String, String> {
    let trimmed = title.trim();
    let len = trimmed.chars().count();
    if len == 0 || len > 64 {
        return Err(format!(
            "Title must be 1–64 characters (got {len}); a Title is always required"
        ));
    }
    Ok(trimmed.to_string())
}

/// Validate a Short Name against Telegram's slug rules (SPEC §3/§7):
/// letters/digits/underscores, begins with a letter, no consecutive
/// underscores, at most 64 characters. Enforced in the core, not just the UI.
pub fn validate_short_name(short_name: &str) -> Result<(), String> {
    if short_name.is_empty() {
        return Err("Short Name must not be empty".to_string());
    }
    if short_name.chars().count() > 64 {
        return Err("Short Name must be at most 64 characters".to_string());
    }
    if !short_name.chars().next().unwrap().is_ascii_alphabetic() {
        return Err("Short Name must begin with a letter".to_string());
    }
    if !short_name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err("Short Name may only contain letters, digits, and underscores".to_string());
    }
    if short_name.contains("__") {
        return Err("Short Name must not contain consecutive underscores".to_string());
    }
    Ok(())
}

/// Auto-derive a Short Name from a Title (SPEC §3): lowercase, runs of
/// non-alphanumeric characters collapse to a single underscore, no leading
/// or trailing underscore. Titles without letters get a `pack` prefix so the
/// result always begins with a letter; the result is truncated to 64
/// characters and always passes `validate_short_name`.
pub fn auto_short_name(title: &str) -> String {
    let mut out = String::new();
    let mut pending_separator = false;
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_separator && !out.is_empty() {
                out.push('_');
            }
            pending_separator = false;
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() {
            pending_separator = true;
        }
    }
    if out.is_empty() {
        out.push_str("pack");
    } else if !out.starts_with(|c: char| c.is_ascii_alphabetic()) {
        out = format!("pack_{out}");
    }
    // Truncate to 64 chars; a trailing underscore from the cut is trimmed.
    // The construction never produces consecutive underscores.
    let truncated: String = out.chars().take(64).collect();
    truncated.trim_end_matches('_').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_name_accepts_telegram_slugs() {
        for good in ["a", "abc", "A_1", "My_Pack_2", &"x".repeat(64)] {
            assert!(validate_short_name(good).is_ok(), "rejected {good:?}");
        }
    }

    #[test]
    fn short_name_rejects_invalid_slugs() {
        for bad in [
            "",            // empty
            "1abc",        // must begin with a letter
            "_abc",        // must begin with a letter
            "a__b",        // no consecutive underscores
            "a b",         // space
            "a-b",         // hyphen
            "héllo",       // non-ASCII letter
            &"x".repeat(65), // too long
        ] {
            assert!(validate_short_name(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn title_is_trimmed_and_length_checked() {
        assert_eq!(validate_title("  My Pack  ").unwrap(), "My Pack");
        assert!(validate_title("").is_err());
        assert!(validate_title("   ").is_err());
        assert!(validate_title(&"x".repeat(64)).is_ok());
        assert!(validate_title(&"x".repeat(65)).is_err());
    }

    #[test]
    fn auto_short_name_derives_from_title() {
        assert_eq!(auto_short_name("My Cool Pack!"), "my_cool_pack");
        assert_eq!(auto_short_name("A  B"), "a_b");
        assert_eq!(auto_short_name("  Hello, World!  "), "hello_world");
        // No letters to start with: prefix so the result begins with a letter.
        assert_eq!(auto_short_name("123"), "pack_123");
        assert_eq!(auto_short_name("!!!"), "pack");
        assert_eq!(auto_short_name(""), "pack");
    }

    #[test]
    fn auto_short_name_is_always_valid() {
        let long = format!("{} tail", "word ".repeat(40));
        for title in [
            "My Cool Pack!",
            "123",
            "!!!",
            "",
            "Ünïcödé Tïtlé",
            "a__b",
            &long,
            &"x".repeat(300),
            &format!("{}_", "y".repeat(70)),
        ] {
            let short = auto_short_name(title);
            assert!(
                validate_short_name(&short).is_ok(),
                "auto_short_name({title:?}) = {short:?} is invalid"
            );
            assert!(short.chars().count() <= 64);
        }
    }
}