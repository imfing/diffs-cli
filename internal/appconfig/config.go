package appconfig

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/pelletier/go-toml/v2"
)

type Config struct {
	UI UIConfig `toml:"ui"`
}

type UIConfig struct {
	ColorScheme     string `toml:"color_scheme"`
	DiffTheme       string `toml:"diff_theme"`
	DiffStyle       string `toml:"diff_style"`
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

func LoadDefault() (Config, string, error) {
	path, err := DefaultPath()
	if err != nil {
		return Config{}, "", err
	}
	cfg, err := Load(path)
	return cfg, path, err
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
