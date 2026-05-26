package appconfig

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

const (
	ColorSchemeDark   = "dark"
	ColorSchemeLight  = "light"
	ColorSchemeSystem = "system"

	DiffStyleSplit   = "split"
	DiffStyleUnified = "unified"

	DiffThemePierre     = "pierre"
	DiffThemeGitHub     = "github"
	DiffThemeDarkPlus   = "dark-plus"
	DiffThemeLightPlus  = "light-plus"
	DiffThemeOneDarkPro = "one-dark-pro"
	DiffThemeOneLight   = "one-light"
	DiffThemeMonokai    = "monokai"
	DiffThemeNightOwl   = "night-owl"
	DiffThemeTokyoNight = "tokyo-night"
)

var (
	colorSchemes = []string{
		ColorSchemeDark,
		ColorSchemeLight,
		ColorSchemeSystem,
	}
	diffStyles = []string{
		DiffStyleSplit,
		DiffStyleUnified,
	}
	diffThemes = []string{
		DiffThemePierre,
		DiffThemeGitHub,
		DiffThemeDarkPlus,
		DiffThemeLightPlus,
		DiffThemeOneDarkPro,
		DiffThemeOneLight,
		DiffThemeMonokai,
		DiffThemeNightOwl,
		DiffThemeTokyoNight,
	}
)

type Config struct {
	UI UIConfig `toml:"ui"`
}

type UIConfig struct {
	ColorScheme     string `toml:"color_scheme"`
	DiffTheme       string `toml:"diff_theme"`
	DiffStyle       string `toml:"diff_style"`
	UIFontFamily    string `toml:"ui_font_family"`
	CodeFontFamily  string `toml:"code_font_family"`
	WordWrap        *bool  `toml:"word_wrap"`
	LineNumbers     *bool  `toml:"line_numbers"`
	LineBackgrounds *bool  `toml:"line_backgrounds"`
}

func DefaultPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "diffs", "config.toml"), nil
}

func LoadDefault() (Config, error) {
	path, err := DefaultPath()
	if err != nil {
		return Config{}, err
	}
	return Load(path)
}

func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Config{}, nil
	}
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := toml.Unmarshal(data, &cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func NormalizeUIConfig(ui UIConfig) UIConfig {
	ui.ColorScheme = strings.TrimSpace(ui.ColorScheme)
	ui.DiffTheme = strings.TrimSpace(ui.DiffTheme)
	ui.DiffStyle = strings.TrimSpace(ui.DiffStyle)
	ui.UIFontFamily = strings.TrimSpace(ui.UIFontFamily)
	ui.CodeFontFamily = strings.TrimSpace(ui.CodeFontFamily)
	return ui
}

func IsColorScheme(s string) bool {
	return slices.Contains(colorSchemes, s)
}

func IsDiffTheme(s string) bool {
	return slices.Contains(diffThemes, s)
}

func IsDiffStyle(s string) bool {
	return slices.Contains(diffStyles, s)
}
