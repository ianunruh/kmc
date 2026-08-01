// Package agent embeds the in-guest kmc-router-agent Python script.
package agent

import _ "embed"

// Script is the full source of kmc-router-agent.py (stdlib only).
//
//go:embed kmc-router-agent.py
var Script string
