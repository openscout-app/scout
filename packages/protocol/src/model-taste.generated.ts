// Generated from model-taste.v1.json. Do not edit.

export const SCOUT_MODEL_TASTE_DATA = {
  "schemaVersion": "openscout.model-taste.v1",
  "revision": "2026-11-10.1",
  "factsReviewedAt": "2026-11-10",
  "opinionBasis": "Scout editorial preferences, carried forward from the existing routing policy. Fit weights are preferences, not benchmark scores.",
  "sources": [
    "https://platform.claude.com/docs/en/models/overview",
    "https://developers.openai.com/api/docs/models",
    "https://opencode.ai/docs/console/models/",
    "https://openrouter.ai/api/v1/models"
  ],
  "runtimes": {
    "fable": {
      "label": "Fable",
      "providerId": "claude",
      "harness": "claude",
      "effort": "max",
      "profile": "Fable",
      "capability": "Product taste, design iteration, and premise-level critique.",
      "caution": "Spends the premium shared Claude allowance; keep it off routine mechanical work.",
      "selector": {
        "family": "Fable"
      }
    },
    "opus": {
      "label": "Opus",
      "providerId": "claude",
      "harness": "claude",
      "effort": "high",
      "profile": "Opus",
      "capability": "Long-context synthesis, architecture, and coherent product reasoning.",
      "caution": "Premium shared Claude quota; avoid routine scans and repeated verification.",
      "selector": {
        "family": "Opus"
      }
    },
    "sonnet": {
      "label": "Sonnet",
      "providerId": "claude",
      "harness": "claude",
      "effort": "high",
      "profile": null,
      "capability": "Strong generalist implementation with fast turns.",
      "caution": "Shares Claude's allowance; a poor pick while that pool is guarded.",
      "selector": {
        "family": "Sonnet"
      }
    },
    "haiku": {
      "label": "Haiku",
      "providerId": "claude",
      "harness": "claude",
      "effort": "low",
      "profile": null,
      "capability": "Fast narrow scans and classification inside the Claude harness.",
      "caution": "Light reasoning; a poor fit for broad synthesis.",
      "selector": {
        "family": "Haiku"
      }
    },
    "astra": {
      "label": "GPT Astra",
      "providerId": "codex",
      "harness": "codex",
      "effort": "high",
      "profile": null,
      "capability": "Codex's most capable tier: hard reasoning, review, and research.",
      "caution": "The costliest Codex tier; use Sol for routine implementation.",
      "selector": {
        "tier": "astra"
      }
    },
    "sol": {
      "label": "GPT Sol",
      "providerId": "codex",
      "harness": "codex",
      "effort": "xhigh",
      "profile": null,
      "capability": "Load-bearing coding, multi-file refactors, debugging, and integration.",
      "caution": "Deep turns spend Codex quota quickly; keep them for work where failure is expensive.",
      "selector": {
        "tier": "sol"
      }
    },
    "luna": {
      "label": "GPT Luna",
      "providerId": "codex",
      "harness": "codex",
      "effort": "medium",
      "profile": null,
      "capability": "Inexpensive source mapping, test enumeration, and repeatable audit work.",
      "caution": "Keep it out of sole high-stakes judgment and final acceptance.",
      "selector": {
        "tier": "luna"
      }
    },
    "grok": {
      "label": "Grok",
      "providerId": "grok",
      "harness": "grok",
      "effort": null,
      "profile": "Grok",
      "capability": "Independent assumption checking, deletion pressure, and adversarial critique.",
      "caution": "Not the sole implementation authority; check conclusions against the repository.",
      "selector": {
        "family": "Grok"
      }
    },
    "kimi": {
      "label": "Kimi Code",
      "providerId": "kimi",
      "harness": "kimi",
      "effort": null,
      "profile": "Kimi",
      "capability": "Dense repository and study synthesis through the native Kimi harness.",
      "caution": "The harness picks the model and quota telemetry can be stale; probe before a large fan-out.",
      "selector": {}
    },
    "glm": {
      "label": "GLM",
      "providerId": "opencode",
      "harness": "opencode",
      "effort": null,
      "profile": "OpenCode",
      "capability": "Independent broad-context synthesis through OpenCode.",
      "caution": "OpenCode quota is not visible in Scout; start with a bounded canary.",
      "selector": {
        "family": "GLM"
      }
    },
    "minimax": {
      "label": "MiniMax",
      "providerId": "minimax",
      "harness": "opencode",
      "effort": null,
      "profile": "OpenCode",
      "capability": "Cost-effective structured evidence collection and comparison.",
      "caution": "Verify load-bearing conclusions with a stronger reviewer.",
      "selector": {
        "family": "MiniMax"
      }
    },
    "deepseek": {
      "label": "DeepSeek",
      "providerId": "opencode",
      "harness": "opencode",
      "effort": null,
      "profile": "OpenCode",
      "capability": "Code-level review from an independent model lineage.",
      "caution": "Quota is opaque; not the sole acceptance authority.",
      "selector": {
        "family": "DeepSeek"
      }
    },
    "devin": {
      "label": "Devin",
      "providerId": "devin",
      "harness": "devin",
      "effort": null,
      "profile": null,
      "capability": "Autonomous implementation in its own environment.",
      "caution": "Devin quota is not visible in Scout; review its changes before they land.",
      "selector": {
        "family": "SWE"
      }
    }
  },
  "roles": {
    "product_judgment": {
      "label": "Product judgment",
      "objective": "Strategic tradeoffs, UX prioritization, scope shaping, and high-level product decisions.",
      "strategy": "Prefer models with product taste and clear tradeoff reasoning.",
      "candidates": [
        {
          "runtime": "fable",
          "fit": 100,
          "rationale": "Product taste, fast design iteration, and clear UX direction."
        },
        {
          "runtime": "astra",
          "fit": 92,
          "rationale": "Technically grounded product decisions with execution realism."
        },
        {
          "runtime": "grok",
          "fit": 82,
          "rationale": "An unfiltered view of feature bloat and scope."
        }
      ]
    },
    "large_context_synthesis": {
      "label": "Large-context synthesis",
      "objective": "Repository-wide investigations, architectural archaeology, and multi-file synthesis.",
      "strategy": "Prefer large effective context windows, and keep premium pools for work that needs them.",
      "candidates": [
        {
          "runtime": "kimi",
          "fit": 100,
          "rationale": "Native long-context retrieval on its own allowance."
        },
        {
          "runtime": "opus",
          "fit": 96,
          "rationale": "Deep structural understanding across multi-package repositories."
        },
        {
          "runtime": "astra",
          "fit": 90,
          "rationale": "A very large window with strong reasoning over it."
        }
      ]
    },
    "adversarial_critique": {
      "label": "Adversarial critique",
      "objective": "Challenging design assumptions, finding UX and logic gaps, and applying deletion pressure.",
      "strategy": "Prefer a lineage other than the authors', so critique is independent rather than agreeable.",
      "candidates": [
        {
          "runtime": "grok",
          "fit": 100,
          "rationale": "A contrarian lineage, edge-case discovery, and premise challenge."
        },
        {
          "runtime": "fable",
          "fit": 94,
          "rationale": "Design critique and UX stress-testing."
        },
        {
          "runtime": "deepseek",
          "fit": 84,
          "rationale": "A third lineage for a second opinion."
        }
      ]
    },
    "evidence_inventory": {
      "label": "Evidence inventory",
      "objective": "Grep and AST inventory, reference tracing, log audit, and structured fact collection.",
      "strategy": "Prefer fast, inexpensive models with precise structured output.",
      "candidates": [
        {
          "runtime": "luna",
          "fit": 100,
          "rationale": "Low-cost source tracing, test inventory, and reference mapping."
        },
        {
          "runtime": "haiku",
          "fit": 94,
          "rationale": "Fast mechanical scans and categorization."
        },
        {
          "runtime": "minimax",
          "fit": 90,
          "rationale": "Cost-effective evidence indexing and pattern enumeration."
        }
      ]
    },
    "implementation": {
      "label": "Implementation",
      "objective": "Code creation, refactoring, type checking, unit tests, and bug fixing.",
      "strategy": "Prefer strong coding models with high instruction following.",
      "candidates": [
        {
          "runtime": "sol",
          "fit": 100,
          "rationale": "Accurate multi-file refactors and complex logic."
        },
        {
          "runtime": "sonnet",
          "fit": 92,
          "rationale": "Strong generalist coding with fast turns."
        },
        {
          "runtime": "devin",
          "fit": 84,
          "rationale": "Autonomous implementation in a separate environment."
        }
      ]
    },
    "code_review": {
      "label": "Code review",
      "objective": "Diff analysis, security audit, regression detection, and style conformity.",
      "strategy": "Prefer a reviewer from a different lineage than the implementer, sensitive to subtle bugs.",
      "candidates": [
        {
          "runtime": "opus",
          "fit": 100,
          "rationale": "Architectural consistency and subtle invariant violations, from outside the Codex lineage."
        },
        {
          "runtime": "astra",
          "fit": 95,
          "rationale": "Rigorous logic and boundary checking."
        },
        {
          "runtime": "deepseek",
          "fit": 87,
          "rationale": "An independent second opinion on code-level edge cases."
        }
      ]
    }
  }
} as const;
