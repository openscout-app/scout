// Generated automatically from runtime-catalog.v1.json. Do not edit.

export const SCOUT_RUNTIME_CATALOG_DATA = {
  "schemaVersion": "openscout.runtime-catalog.v1",
  "revision": "2026-11-10.1",
  "harnesses": [
    {
      "id": "claude",
      "label": "Claude Code",
      "enabled": true,
      "default": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "defaultReasoningEffort": "medium",
      "presentation": {
        "short": "Claude",
        "monogram": "✳"
      },
      "models": [
        {
          "id": "claude-opus-5-5",
          "label": "Opus 5.5",
          "enabled": true,
          "default": true,
          "family": "Opus",
          "version": "5.5",
          "contextWindowTokens": 1000000,
          "presentation": {
            "detail": "Latest"
          }
        },
        {
          "id": "claude-opus-5",
          "label": "Opus 5",
          "enabled": true,
          "family": "Opus",
          "version": "5",
          "presentation": {
            "detail": "Deepest"
          }
        },
        {
          "id": "claude-fable-5-2",
          "label": "Fable 5.2",
          "enabled": true,
          "family": "Fable",
          "version": "5.2",
          "contextWindowTokens": 1000000
        },
        {
          "id": "claude-fable-5-1",
          "label": "Fable 5.1",
          "enabled": true,
          "family": "Fable",
          "version": "5.1",
          "contextWindowTokens": 1000000
        },
        {
          "id": "claude-fable-5",
          "label": "Fable 5",
          "enabled": true,
          "family": "Fable",
          "version": "5"
        },
        {
          "id": "claude-sonnet-5-5",
          "label": "Sonnet 5.5",
          "enabled": true,
          "family": "Sonnet",
          "version": "5.5",
          "contextWindowTokens": 1000000,
          "presentation": {
            "detail": "Balanced"
          }
        },
        {
          "id": "claude-sonnet-4-6",
          "label": "Sonnet 4.6",
          "enabled": true,
          "family": "Sonnet",
          "version": "4.6"
        },
        {
          "id": "claude-haiku-5-5",
          "label": "Haiku 5.5",
          "enabled": true,
          "family": "Haiku",
          "version": "5.5",
          "contextWindowTokens": 1000000,
          "presentation": {
            "detail": "Fast"
          }
        },
        {
          "id": "claude-haiku-4-5",
          "label": "Haiku 4.5",
          "enabled": true,
          "family": "Haiku",
          "version": "4.5"
        },
        {
          "id": "claude-opus-4-8",
          "label": "Opus 4.8",
          "enabled": true,
          "family": "Opus",
          "version": "4.8"
        },
        {
          "id": "claude-opus-4-7",
          "label": "Opus 4.7",
          "enabled": true,
          "family": "Opus",
          "version": "4.7"
        },
        {
          "id": "claude-sonnet-4-5",
          "label": "Sonnet 4.5",
          "enabled": true,
          "family": "Sonnet",
          "version": "4.5"
        }
      ]
    },
    {
      "id": "codex",
      "label": "Codex",
      "enabled": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "defaultReasoningEffort": "medium",
      "presentation": {
        "short": "Codex",
        "monogram": "◈"
      },
      "models": [
        {
          "id": "gpt-6-astra",
          "label": "6 Astra",
          "enabled": true,
          "default": true,
          "description": "Most capable for complex reasoning, coding, computer use, research, and document creation",
          "family": "GPT",
          "version": "6 Astra",
          "contextWindowTokens": 1050000,
          "reasoningEfforts": [
            "low",
            "medium",
            "high",
            "xhigh",
            "max"
          ],
          "defaultReasoningEffort": "low",
          "presentation": {
            "detail": "Most capable"
          }
        },
        {
          "id": "gpt-6.1-sol",
          "label": "6.1 Sol",
          "enabled": true,
          "description": "Complex coding, computer use, and professional work at a lower cost than Astra",
          "family": "GPT",
          "version": "6.1 Sol",
          "contextWindowTokens": 1050000,
          "reasoningEfforts": [
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra"
          ],
          "defaultReasoningEffort": "medium",
          "presentation": {
            "detail": "Latest"
          }
        },
        {
          "id": "gpt-6-sol",
          "label": "6 Sol",
          "enabled": true,
          "description": "Complex coding and agentic workflows",
          "family": "GPT",
          "version": "6 Sol",
          "contextWindowTokens": 272000,
          "reasoningEfforts": [
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra"
          ],
          "presentation": {
            "detail": "Coding"
          }
        },
        {
          "id": "gpt-6-luna",
          "label": "6 Luna",
          "enabled": true,
          "description": "Efficient focused coding and repeatable tasks",
          "family": "GPT",
          "version": "6 Luna",
          "contextWindowTokens": 272000,
          "reasoningEfforts": [
            "low",
            "medium",
            "high",
            "xhigh",
            "max"
          ],
          "presentation": {
            "detail": "Efficient"
          }
        },
        {
          "id": "gpt-5.6-sol",
          "label": "5.6 Sol",
          "enabled": true,
          "family": "GPT",
          "version": "5.6 Sol",
          "reasoningEfforts": [
            "low",
            "medium",
            "high",
            "xhigh",
            "ultra"
          ],
          "presentation": {
            "detail": "Frontier"
          }
        },
        {
          "id": "gpt-5.6-terra",
          "label": "5.6 Terra",
          "enabled": true,
          "family": "GPT",
          "version": "5.6 Terra",
          "reasoningEfforts": [
            "low",
            "medium",
            "high",
            "xhigh",
            "ultra"
          ],
          "presentation": {
            "detail": "Frontier"
          }
        },
        {
          "id": "gpt-5.6-luna",
          "label": "5.6 Luna",
          "enabled": true,
          "family": "GPT",
          "version": "5.6 Luna",
          "presentation": {
            "detail": "Efficient"
          }
        },
        {
          "id": "gpt-5.5",
          "label": "5.5",
          "enabled": true,
          "family": "GPT",
          "version": "5.5"
        },
        {
          "id": "gpt-5.5-mini",
          "label": "5.5 mini",
          "enabled": true,
          "family": "GPT",
          "version": "5.5 mini",
          "presentation": {
            "detail": "Fast"
          }
        }
      ]
    },
    {
      "id": "grok",
      "label": "Grok CLI",
      "enabled": true,
      "listed": false,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "defaultReasoningEffort": "high",
      "presentation": {
        "short": "Grok",
        "monogram": "✕"
      },
      "models": [
        {
          "id": "grok-4.6",
          "label": "Grok 4.6",
          "enabled": true,
          "default": true,
          "family": "Grok",
          "version": "4.6",
          "contextWindowTokens": 500000,
          "presentation": {
            "detail": "Latest"
          }
        },
        {
          "id": "grok-4.5",
          "label": "Grok 4.5",
          "enabled": true,
          "family": "Grok",
          "version": "4.5",
          "contextWindowTokens": 500000
        }
      ]
    },
    {
      "id": "grok-acp",
      "label": "Grok",
      "enabled": true,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "defaultReasoningEffort": "high",
      "presentation": {
        "short": "Grok",
        "monogram": "✕"
      },
      "models": [
        {
          "id": "grok-4.6",
          "label": "Grok 4.6",
          "enabled": true,
          "default": true,
          "family": "Grok",
          "version": "4.6",
          "contextWindowTokens": 500000,
          "presentation": {
            "detail": "Latest"
          }
        },
        {
          "id": "grok-4.5",
          "label": "Grok 4.5",
          "enabled": true,
          "family": "Grok",
          "version": "4.5",
          "contextWindowTokens": 500000
        }
      ]
    },
    {
      "id": "kimi",
      "label": "Kimi Code",
      "enabled": true,
      "reasoningEfforts": null,
      "presentation": {
        "short": "Kimi",
        "monogram": "◐"
      },
      "models": []
    },
    {
      "id": "flue",
      "label": "Flue",
      "enabled": true,
      "listed": false,
      "reasoningEfforts": null,
      "models": []
    },
    {
      "id": "cursor",
      "label": "Cursor CLI",
      "enabled": true,
      "reasoningEfforts": null,
      "models": []
    },
    {
      "id": "opencode",
      "label": "OpenCode",
      "enabled": true,
      "reasoningEfforts": null,
      "models": [
        {
          "id": "opencode-go/glm-5.2",
          "label": "GLM-5.2",
          "enabled": true,
          "default": true,
          "family": "GLM",
          "version": "5.2"
        },
        {
          "id": "opencode-go/glm-5.1",
          "label": "GLM-5.1",
          "enabled": true,
          "family": "GLM",
          "version": "5.1"
        },
        {
          "id": "opencode-go/kimi-k3",
          "label": "Kimi K3",
          "enabled": true,
          "family": "Kimi",
          "version": "K3"
        },
        {
          "id": "opencode-go/qwen3.8-max",
          "label": "Qwen3.8 Max",
          "enabled": true,
          "family": "Qwen",
          "version": "3.8 Max"
        },
        {
          "id": "opencode-go/minimax-m3",
          "label": "MiniMax M3",
          "enabled": true,
          "family": "MiniMax",
          "version": "M3"
        },
        {
          "id": "opencode-go/deepseek-v4-pro",
          "label": "DeepSeek V4 Pro",
          "enabled": true,
          "family": "DeepSeek",
          "version": "V4 Pro"
        },
        {
          "id": "opencode-go/grok-4.5",
          "label": "Grok 4.5",
          "enabled": true,
          "family": "Grok",
          "version": "4.5"
        },
        {
          "id": "opencode/nemotron-3-ultra-free",
          "label": "Nemotron 3 Ultra (free)",
          "enabled": true,
          "family": "Nemotron",
          "version": "3 Ultra Free"
        },
        {
          "id": "opencode/laguna-s-2.1-free",
          "label": "Laguna S 2.1 (free)",
          "enabled": true,
          "family": "Laguna",
          "version": "S 2.1 Free"
        }
      ]
    },
    {
      "id": "pi",
      "label": "Pi",
      "enabled": true,
      "allowCustomModels": true,
      "reasoningEfforts": [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "models": []
    },
    {
      "id": "devin",
      "label": "Devin",
      "enabled": true,
      "reasoningEfforts": null,
      "models": [
        {
          "id": "swe-2-high",
          "label": "SWE-2 High",
          "enabled": true,
          "default": true,
          "family": "SWE",
          "version": "2 High",
          "contextWindowTokens": 262000
        },
        {
          "id": "swe-2-medium",
          "label": "SWE-2 Medium",
          "enabled": true,
          "family": "SWE",
          "version": "2 Medium",
          "contextWindowTokens": 262000
        },
        {
          "id": "swe-2-max",
          "label": "SWE-2 Max",
          "enabled": true,
          "family": "SWE",
          "version": "2 Max",
          "contextWindowTokens": 262000
        }
      ]
    }
  ]
} as const;
