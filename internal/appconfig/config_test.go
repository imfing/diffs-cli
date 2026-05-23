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
