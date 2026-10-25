'use strict'

// Model presets shared by the plugin, the installer and the CLI. Both are base
// models: they have no speaker table and render whatever reference wav they are
// given, which is why the plugin always sends one.

const PRESETS = {
  '1.7-base': {
    id: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16',
    sizeGb: 4.3,
  },
  '0.6-base': {
    id: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',
    sizeGb: 2.3,
  },
}

const DEFAULT_PRESET = '1.7-base'

const presetOf = name => PRESETS[name] || PRESETS[DEFAULT_PRESET]

module.exports = { PRESETS, DEFAULT_PRESET, presetOf }
