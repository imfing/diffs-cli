use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Debug, Default, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub ui: UiConfig,
}

#[derive(Debug, Default, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct UiConfig {
    #[serde(default)]
    pub color_scheme: String,
    #[serde(default)]
    pub diff_theme: String,
    #[serde(default)]
    pub diff_style: String,
    #[serde(default)]
    pub ui_font_family: String,
    #[serde(default)]
    pub code_font_family: String,
    pub word_wrap: Option<bool>,
    pub line_numbers: Option<bool>,
    pub line_backgrounds: Option<bool>,
}

pub fn default_path() -> anyhow::Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or_else(|| anyhow::anyhow!("HOME is not set"))?;
    Ok(PathBuf::from(home)
        .join(".config")
        .join("diffs")
        .join("config.toml"))
}

pub fn load_default() -> anyhow::Result<Config> {
    load(default_path()?)
}

pub fn load(path: impl Into<PathBuf>) -> anyhow::Result<Config> {
    let path = path.into();
    match fs::read_to_string(&path) {
        Ok(data) => Ok(toml::from_str(&data)?),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(err) => Err(err.into()),
    }
}

pub fn normalize_ui(mut ui: UiConfig) -> UiConfig {
    ui.color_scheme = ui.color_scheme.trim().to_string();
    ui.diff_theme = ui.diff_theme.trim().to_string();
    ui.diff_style = ui.diff_style.trim().to_string();
    ui.ui_font_family = ui.ui_font_family.trim().to_string();
    ui.code_font_family = ui.code_font_family.trim().to_string();
    ui
}

pub fn is_color_scheme(value: &str) -> bool {
    matches!(value, "dark" | "light" | "system")
}

pub fn is_diff_style(value: &str) -> bool {
    matches!(value, "split" | "unified")
}

pub fn is_diff_theme(value: &str) -> bool {
    matches!(
        value,
        "pierre"
            | "github"
            | "dark-plus"
            | "light-plus"
            | "one-dark-pro"
            | "one-light"
            | "monokai"
            | "night-owl"
            | "tokyo-night"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn load_missing_config_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = load(dir.path().join("missing.toml")).unwrap();
        assert!(cfg.ui.color_scheme.is_empty());
        assert!(cfg.ui.word_wrap.is_none());
    }

    #[test]
    fn load_full_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(
            br#"
[ui]
color_scheme = "dark"
diff_theme = "github"
diff_style = "unified"
ui_font_family = '"Inter Variable", system-ui, sans-serif'
code_font_family = '"JetBrains Mono", ui-monospace, monospace'
word_wrap = true
line_numbers = false
line_backgrounds = true
"#,
        )
        .unwrap();

        let cfg = load(&path).unwrap();
        assert_eq!(cfg.ui.color_scheme, "dark");
        assert_eq!(cfg.ui.diff_theme, "github");
        assert_eq!(cfg.ui.diff_style, "unified");
        assert_eq!(
            cfg.ui.ui_font_family,
            r#""Inter Variable", system-ui, sans-serif"#
        );
        assert_eq!(
            cfg.ui.code_font_family,
            r#""JetBrains Mono", ui-monospace, monospace"#
        );
        assert_eq!(cfg.ui.word_wrap, Some(true));
        assert_eq!(cfg.ui.line_numbers, Some(false));
        assert_eq!(cfg.ui.line_backgrounds, Some(true));
    }

    #[test]
    fn load_invalid_config_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "[ui\n").unwrap();
        assert!(load(&path).is_err());
    }

    #[test]
    fn normalize_ui_trims_strings() {
        let got = normalize_ui(UiConfig {
            color_scheme: " dark ".to_string(),
            diff_theme: " github ".to_string(),
            diff_style: " unified ".to_string(),
            ui_font_family: " ui-sans-serif ".to_string(),
            code_font_family: " ui-monospace ".to_string(),
            ..Default::default()
        });
        assert_eq!(got.color_scheme, "dark");
        assert_eq!(got.diff_theme, "github");
        assert_eq!(got.diff_style, "unified");
        assert_eq!(got.ui_font_family, "ui-sans-serif");
        assert_eq!(got.code_font_family, "ui-monospace");
    }

    #[test]
    fn ui_option_validation() {
        assert!(is_color_scheme("system"));
        assert!(!is_color_scheme("auto"));
        assert!(is_diff_theme("pierre"));
        assert!(!is_diff_theme("missing"));
        assert!(is_diff_style("split"));
        assert!(!is_diff_style("side-by-side"));
    }
}
