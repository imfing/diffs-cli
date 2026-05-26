package appconfig

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadMissingConfigReturnsEmptyConfig(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "missing.toml"))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.UI.ColorScheme != "" || cfg.UI.WordWrap != nil {
		t.Fatalf("Load() = %+v, want empty config", cfg)
	}
}

func TestLoadConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(`
[ui]
color_scheme = "dark"
diff_theme = "github"
diff_style = "unified"
ui_font_family = '"Inter Variable", system-ui, sans-serif'
code_font_family = '"JetBrains Mono", ui-monospace, monospace'
word_wrap = true
line_numbers = false
line_backgrounds = true
`), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.UI.ColorScheme != "dark" || cfg.UI.DiffTheme != "github" || cfg.UI.DiffStyle != "unified" {
		t.Fatalf("unexpected string settings: %+v", cfg.UI)
	}
	if cfg.UI.UIFontFamily != `"Inter Variable", system-ui, sans-serif` {
		t.Fatalf("ui_font_family = %q", cfg.UI.UIFontFamily)
	}
	if cfg.UI.CodeFontFamily != `"JetBrains Mono", ui-monospace, monospace` {
		t.Fatalf("code_font_family = %q", cfg.UI.CodeFontFamily)
	}
	if cfg.UI.WordWrap == nil || !*cfg.UI.WordWrap {
		t.Fatalf("word_wrap = %v, want true", cfg.UI.WordWrap)
	}
	if cfg.UI.LineNumbers == nil || *cfg.UI.LineNumbers {
		t.Fatalf("line_numbers = %v, want false", cfg.UI.LineNumbers)
	}
	if cfg.UI.LineBackgrounds == nil || !*cfg.UI.LineBackgrounds {
		t.Fatalf("line_backgrounds = %v, want true", cfg.UI.LineBackgrounds)
	}
}

func TestLoadInvalidConfigReturnsError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("[ui\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("Load() succeeded, want error")
	}
}

func TestNormalizeUIConfigTrimsStringSettings(t *testing.T) {
	got := NormalizeUIConfig(UIConfig{
		ColorScheme:    " dark ",
		DiffTheme:      " github ",
		DiffStyle:      " unified ",
		UIFontFamily:   " ui-sans-serif ",
		CodeFontFamily: " ui-monospace ",
	})
	if got.ColorScheme != ColorSchemeDark || got.DiffTheme != DiffThemeGitHub || got.DiffStyle != DiffStyleUnified {
		t.Fatalf("NormalizeUIConfig() = %+v", got)
	}
	if got.UIFontFamily != "ui-sans-serif" || got.CodeFontFamily != "ui-monospace" {
		t.Fatalf("NormalizeUIConfig() font families = %+v", got)
	}
}

func TestUIOptionValidation(t *testing.T) {
	if !IsColorScheme(ColorSchemeSystem) || IsColorScheme("auto") {
		t.Fatal("unexpected color scheme validation")
	}
	if !IsDiffTheme(DiffThemePierre) || IsDiffTheme("missing") {
		t.Fatal("unexpected diff theme validation")
	}
	if !IsDiffStyle(DiffStyleSplit) || IsDiffStyle("side-by-side") {
		t.Fatal("unexpected diff style validation")
	}
}
